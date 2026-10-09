# Cost

**Protects:** Every action has a known, bounded cost, attributed to the tenant that caused it, so that no bug, loop, abuser or single customer can produce a bill nobody planned for, and the unit economics of the product are a design input rather than a surprise.
**Read when:** The plan calls an LLM, a paid third-party API (SMS, email, enrichment, search), autoscaling compute, a queue or event trigger that can feed itself, an agent that reads and writes the same channel, verbose logging, cross-region or internet data transfer, or uses words like "for every message", "on each event", "re-run", "retry", "all tenants". In code: `messages.create`, `max_tokens`, `retry`, `while True`, `postMessage` in an event handler, `logger.debug(prompt)`, `max-instances`, SMS or email send calls.
**Prefix:** COST

## Design questions

1. What does one user action cost (tokens, API calls, compute), and what will a large tenant's busiest day cost? Written as a number. (COST-01)
2. Which fields record tokens and paid calls per action, and where are they stored? (COST-02)
3. Can any output of the system become its own input (a bot reading its own messages, a webhook that triggers itself, a queue consumer that publishes to its own topic)? What breaks the cycle? (COST-03)
4. What is the maximum number of paid attempts one failed action can make, across all retry layers? (COST-04)
5. How is every paid call attributed to a tenant, and can you produce last month's cost per tenant? (COST-05)
6. What stops one tenant (or one user) from consuming the shared rate limit or budget for everyone else? (COST-06)
7. What actually stops spending when a threshold is crossed, and how stale is the spend data that threshold reads? (COST-07)
8. For each LLM task, which is the cheapest model that passes its evals, and does it need to be synchronous at all? (COST-08)
9. Which part of each prompt is stable across calls, and is it placed first and cached? (COST-09)
10. How many GB of logs and egress does one action produce, and who reads the logs? (COST-10)
11. Which third-party quotas and rate limits does the feature consume, and what happens to other features when they run out? (COST-11)
12. Which resources are billed while idle, and what are the autoscaling maxima? (COST-12)
13. Which paid actions can an unauthenticated or untrusted party trigger? (COST-13)

## Categories

### COST-01 Cost is not a design input

**How it fails:** The feature is designed for behavior, then shipped. A month later finance asks why the bill tripled. The per-action cost was never estimated, so nobody knew that "summarize every thread" on a 5,000-person tenant is tens of thousands of LLM calls a day, or that the pricing plan does not cover it.
**Seen in the wild:** No verified incident specific to a missing estimate; the behavioral envelope's CORE-10 asks the same question ("Does the change add work per request, per user or per item that grows with scale?").
**Spot it in a plan:** No volumes. "For each message/event/user" with no count. Pricing decided independently of the feature.
**Spot it in code:** Per-item LLM or paid API calls inside handlers for high-volume events; no counters on paid calls.
**Build it right:** Add a cost table to the plan: action, expected volume per tenant per day (median and largest tenant), paid units per action (input tokens, output tokens, API calls), unit price, daily cost. Compare against what the tenant pays. Pick the design that fits, for example "summarize on request" instead of "summarize every thread", or batch overnight. Revisit with measured numbers after launch (COST-02).

Dangerous:
```markdown
On every new message in a connected channel, the bot classifies it and drafts a reply.
```

Safe:
```markdown
| Action | Largest tenant/day | Tokens in/out | Model | Est. $/day |
|---|---|---|---|---|
| classify message | 40,000 msgs | 600 / 20 | small model | computed from current price sheet |
| draft reply (only if classified "needs reply", ~5%) | 2,000 | 3,000 / 400 | mid model | computed |
Decision: classify with the small model in batches of 20; draft only on "needs reply".
Ceiling: per-tenant daily cap at 3x the largest expected day (COST-06).
```

**Prove it:** After a week in production, the measured cost per action and per tenant is within a stated factor of the estimate, or the estimate is updated in the plan.
**Size for now:** One table for the actions that call paid services. Detailed cost modeling for internal compute can wait.

### COST-02 Tokens and paid calls are not recorded per action

**How it fails:** The provider invoice shows one number per month. When it spikes, nobody can say which feature, prompt change or tenant caused it. A prompt change that doubled context length goes unnoticed for weeks.
**Seen in the wild:** No verified incident; Anthropic returns `input_tokens`, `output_tokens`, `cache_creation_input_tokens` and `cache_read_input_tokens` on every response (Sources 1), so the data exists per call if the application keeps it.
**Spot it in a plan:** No mention of usage logging or a cost ledger.
**Spot it in code:** LLM responses whose `usage` field is discarded; paid API calls with no counter; conversation context passed in full on every turn with no size check.
**Build it right:** Wrap every paid client in one module that records, per call: tenant, feature, model, input, output and cache tokens, latency, and correlation id, into a ledger table or metrics. Alert on per-action token count drift (for example p95 input tokens up 50% week over week). Cap context growth in multi-turn flows (truncate or summarize older turns).

Dangerous:
```python
resp = client.messages.create(model=MODEL, max_tokens=1024, messages=history)
return resp.content[0].text
```

Safe:
```python
resp = client.messages.create(model=MODEL, max_tokens=1024, messages=trim(history, max_tokens=12_000))
u = resp.usage
ledger.record(tenant_id=ctx.tenant_id, feature="reply_draft", model=MODEL,
              input=u.input_tokens, output=u.output_tokens,
              cache_write=u.cache_creation_input_tokens or 0,
              cache_read=u.cache_read_input_tokens or 0,
              correlation_id=ctx.correlation_id)
return resp.content[0].text
```

**Prove it:** Query the ledger for yesterday grouped by tenant and feature, and reconcile its total with the provider's usage report within a few percent.
**Size for now:** A ledger table written by one wrapper. A cost analytics product can wait.

### COST-03 Runaway loops

**How it fails:** The system's output becomes its own input. A Slack bot that answers messages in a channel sees its own reply as a new message and answers again. Two bots answer each other. A webhook handler updates the object that fired the webhook. A queue consumer republishes to the topic it consumes. Each turn is cheap; the loop runs all night.
**Seen in the wild:** A startup's test of a recursive crawler on Cloud Run and Firestore ran up just under $72,000 in about two hours, with 116 billion Firestore reads, a $7 budget alert that did not stop spending, and Cloud Run max instances defaulting to 1,000 (Sources 2). AWS Lambda now detects recursive loops through SQS, SNS, S3 and EventBridge and stops the chain after about 16 invocations, citing unexpected charges (Sources 3). GitHub Actions does not start new workflow runs from events caused by `GITHUB_TOKEN` to prevent accidental recursion (Sources 4).
**Spot it in a plan:** A bot that both reads and writes the same channel. "When X is updated, update X." Consumers that publish follow-up events to the same stream. Two integrations syncing the same object in both directions.
**Spot it in code:** Slack `message` handlers with no check of `bot_id` or the app's own user id; webhook handlers that call the provider's update API on the same object; `publish(topic)` inside a consumer of `topic`.
**Build it right:** Ignore your own output at the entry point: in Slack, drop events from your own bot (Bolt's `ignoreSelf` middleware filters events originating from the app, Sources 5) and from other bots unless explicitly allowed. Mark outbound writes with an origin marker and skip events carrying it. Carry a hop count or causation id on events and refuse beyond a small depth. Cap per-conversation turns for agents. Put a per-tenant rate limit on the paid action as a backstop (COST-06).

Dangerous:
```ts
app.message(async ({ message, say }) => {
  const reply = await agent.respond((message as any).text);
  await say({ text: reply, thread_ts: (message as any).ts });
});
```

Safe:
```ts
app.message(async ({ message, context, say }) => {
  const m = message as GenericMessageEvent;
  if (m.subtype || m.bot_id || m.user === context.botUserId) return;   // not a human message
  const turns = await convo.incrementTurns(m.channel, m.thread_ts ?? m.ts);
  if (turns > 20) return;                                             // agent turn cap per thread
  if (!(await limits.take(context.teamId!, "agent_reply"))) return;  // per-tenant backstop
  const reply = await agent.respond(m.text ?? "");
  await say({ text: reply, thread_ts: m.thread_ts ?? m.ts, metadata: { event_type: "agent_reply", event_payload: { origin: "self" } } });
});
```

**Prove it:** In a staging workspace, have the bot post into a channel it listens to and add a second bot that echoes; the conversation stops within the stated cap and the ledger shows bounded calls.
**Size for now:** Self and bot filtering, a hop or turn cap, and a per-tenant rate limit. Graph-based loop detection across services is not needed.

### COST-04 Unbounded retries cost money

**How it fails:** A failed LLM step is retried by the SDK, by the app's retry decorator and by the queue's redelivery, and each retry re-runs the whole multi-step agent from the start. A poison message that always fails is retried forever, paying for tokens each time. Retries also continue after a monthly spend cap is reached, failing every time.
**Seen in the wild:** Anthropic documents that a spend-limit 429 carries no `retry-after` header and that retrying, including the SDK's automatic retries, fails until access resumes; it is distinguished by `error.details.error_code` of `enforced_spend_limit_reached` (Sources 6). AWS describes retry amplification across layers (Sources 7).
**Spot it in a plan:** "Retry until it succeeds." No dead-letter queue. Multi-step agents with no checkpointing.
**Spot it in code:** `while True: try ... except: continue`; queue subscriptions with no max delivery attempts; retry decorators with no stop condition; agents that restart from step one on any exception.
**Build it right:** Bound attempts end to end (one retry layer, max deliveries, then dead-letter with an alert). Classify errors: do not retry validation errors, content policy errors or spend-limit errors. Checkpoint multi-step work so a retry resumes from the failed step instead of paying again for completed ones. Record attempts in the ledger.

Dangerous:
```python
def handle(msg):
    while True:
        try:
            return run_agent(msg)          # 6 LLM calls; restarts from scratch on any error
        except Exception:
            time.sleep(1)
```

Safe:
```python
NON_RETRYABLE = {"invalid_request_error", "enforced_spend_limit_reached", "permission_error"}

def handle(msg, attempt: int):
    try:
        return run_agent(msg, resume_from=checkpoints.load(msg.id))
    except ApiError as e:
        code = e.error_code or e.type
        if code in NON_RETRYABLE or attempt >= 3:
            dead_letter(msg, reason=code)  # alerting on DLQ depth (OPS-13)
            return None
        raise                               # single retry layer: the queue redelivers with backoff
```

**Prove it:** Inject a permanent failure on step 4 of 6 on staging: the ledger shows steps 1 to 3 paid once, step 4 at most three times, and one dead-letter entry.
**Size for now:** Max attempts, error classification and a dead-letter queue. Fine-grained checkpointing only for flows with several paid steps.

### COST-05 No per-tenant cost attribution

**How it fails:** The bill is known in total but not per customer. One tenant using an expensive feature heavily makes the whole product look unprofitable, or a cheap plan is subsidizing it, and nobody can tell which. Sales cannot price the enterprise plan.
**Seen in the wild:** No verified incident; Anthropic's Usage and Cost API groups usage by API key, workspace and model, with data typically available within about 5 minutes (Sources 8), so separate workspaces or keys per environment or large tenant give a provider-side cross-check, but the per-tenant split inside a shared key must come from the application.
**Spot it in a plan:** Shared API key for all tenants and no ledger. Pricing plans with no usage dimension.
**Spot it in code:** Paid calls without `tenant_id` in scope; background jobs that lose tenant context.
**Build it right:** Every paid call goes through the wrapper from COST-02 and requires a tenant id (make it a required parameter, not optional). Jobs carry tenant id in the payload. Produce a monthly cost per tenant report from the ledger and reconcile it against the provider's report. Consider separate provider workspaces or keys for the largest tenants or for internal use, which also enables provider-side limits.

Dangerous:
```ts
export async function complete(prompt: string) {
  return anthropic.messages.create({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] });
}
```

Safe:
```ts
export async function complete(ctx: { tenantId: string; feature: Feature; correlationId: string }, prompt: string) {
  const res = await anthropic.messages.create({ model: MODEL, max_tokens: 1024, messages: [{ role: "user", content: prompt }] });
  await ledger.record({ ...ctx, model: MODEL, usage: res.usage });
  return res;
}
```

```sql
SELECT tenant_id, feature, sum(cost_usd) AS cost
FROM llm_ledger
WHERE at >= date_trunc('month', now()) - interval '1 month'
  AND at <  date_trunc('month', now())
GROUP BY 1, 2 ORDER BY cost DESC;
```

**Prove it:** The report above runs, and its total matches the provider's cost report for the same period within a stated tolerance.
**Size for now:** Ledger plus a monthly query. Real-time per-tenant billing only if pricing is usage-based.

### COST-06 One tenant spends everyone's budget

**How it fails:** All tenants share one provider key and its rate and spend limits. One tenant's bulk import or a looping integration consumes the tokens per minute, and every other tenant gets 429s. Or it reaches the organization's monthly spend limit and the product stops for everyone until the next month.
**Seen in the wild:** Anthropic enforces organization rate limits and monthly spend caps per usage tier, lets you set workspace limits below them, and returns 429 with `retry-after` for rate limits (Sources 6). No verified incident cited.
**Spot it in a plan:** No per-tenant limits. "Unlimited" plans for features with per-call cost.
**Spot it in code:** No rate limiter keyed by tenant before paid calls; bulk jobs that run at full speed.
**Build it right:** A per-tenant token bucket (and daily cap) in front of paid calls, sized from COST-01 with headroom, enforced in the wrapper. Bulk and background work goes through a separate, lower-priority lane so interactive traffic keeps capacity. When a tenant hits its cap, show a clear state ("daily AI limit reached, resets at ...") rather than a generic error, and alert if any tenant is near cap.

Dangerous:
```python
def summarize(tenant_id, text):
    return llm.complete(text)
```

Safe:
```sql
-- daily per-tenant cap, enforced atomically before the call
INSERT INTO tenant_usage_daily (tenant_id, day, units)
VALUES ($1, current_date, $2)
ON CONFLICT (tenant_id, day)
DO UPDATE SET units = tenant_usage_daily.units + EXCLUDED.units
WHERE tenant_usage_daily.units + EXCLUDED.units <= $3   -- the tenant's daily cap
RETURNING units;
-- the caller rejects any single request with $2 > $3 before running this
-- no row returned: cap reached, do not call the provider
```

**Prove it:** On staging, drive one tenant past its cap while another tenant runs normal traffic: the first sees the cap message, the second sees no 429s.
**Size for now:** Per-tenant daily caps and a separate lane for bulk work. Per-user limits inside a tenant only if abuse appears.

### COST-07 Budget alerts that do not stop anything

**How it fails:** The team sets a cloud budget alert and believes spending is capped. The alert is an email, arrives hours after the spend because billing data lags, and goes to a mailbox nobody watches at night. By morning the damage is done.
**Seen in the wild:** Google Cloud states that alerts-only budgets do not cap usage or spending, that the first notification can take several hours, and that there is a delay between usage and cost reporting (Sources 9). In the $72,000 Cloud Run incident, a $7 budget did not stop spending and billing data took about a day to sync (Sources 2).
**Spot it in a plan:** "We have a budget alert" as the cost control.
**Spot it in code:** Budget configuration with only email recipients; no in-app circuit breaker.
**Build it right:** Treat provider budgets as a late backstop. Put the fast control in your own code, driven by your own ledger (COST-02), which is current to the second: a global and per-tenant spend circuit breaker that stops non-essential paid work when spend in the last hour exceeds a threshold, plus a page to on-call. Use provider-side hard limits where they exist (for example a workspace spend limit). Wire budget notifications to a channel someone watches, or to automation.

Dangerous:
```yaml
# billing budget: notify finance@ at 50%, 90%, 100%. That is the whole plan.
```

Safe:
```ts
// checked by the paid-call wrapper, refreshed every minute from the ledger
const spendLastHour = await ledger.sumCostSince(Date.now() - 3600_000);
if (spendLastHour > config.globalHourlyBreakerUsd) {
  await flags.set("paid_features.nonessential", false);   // kill switch (OPS-08)
  await pager.trigger("llm-spend-breaker", { spendLastHour });
}
```

**Prove it:** On staging, set the breaker threshold low and generate traffic: non-essential paid calls stop within a minute and a page fires.
**Size for now:** One global breaker and per-tenant caps, plus provider spend limits. Forecasting can wait.

### COST-08 One expensive model for every task

**How it fails:** The largest model is used for everything, including classification, routing and extraction that a smaller model handles equally well. Synchronous calls are used for work that nobody waits for. Cost per action is several times higher than needed.
**Seen in the wild:** No verified incident; Anthropic's latency guide recommends choosing the model per use case (Sources 10), and its Message Batches API charges 50% of standard prices with most batches completing within an hour and all within 24 hours (Sources 11).
**Spot it in a plan:** A single model constant. Nightly or bulk processing via the synchronous API.
**Spot it in code:** One `MODEL` constant used everywhere; loops of `messages.create` in cron jobs.
**Build it right:** Per task, keep a small eval set (inputs with expected outputs or a grading rubric). Run candidate models through it and pick the cheapest that passes the bar; re-run on model changes. Route non-interactive bulk work to a batch API. Record the chosen model per task in config, not scattered constants.

Dangerous:
```python
for ticket in tickets_from_last_night:
    label = client.messages.create(model=LARGEST_MODEL, max_tokens=500, messages=[...])
```

Safe:
```python
batch = client.messages.batches.create(requests=[
    {"custom_id": str(t.id),
     "params": {"model": TASK_MODELS["ticket_label"], "max_tokens": 20, "messages": label_prompt(t)}}
    for t in tickets_from_last_night
])
# TASK_MODELS["ticket_label"] chosen by evals/ticket_label.jsonl; results matched by custom_id
```

**Prove it:** The eval report in the PR shows the chosen model's score next to the larger model's, and the ledger shows the cost per action drop after the switch.
**Size for now:** Evals for the two or three highest-volume LLM tasks. Automatic model routing can wait.

### COST-09 Prompts that cannot be cached

**How it fails:** A long, stable system prompt and tool definitions are sent on every call at full price. Or caching is enabled, but a timestamp or user name near the top of the system prompt changes every call, so nothing ever hits the cache and every call pays the cache write premium too.
**Seen in the wild:** Anthropic prices cache writes at 1.25 times base input price for the 5 minute TTL and 2 times for 1 hour, and cache reads at 0.1 times for most models; a change at the tools, system or messages level invalidates that level and everything after it, cache hits require identical prefixes, and prompts below a per-model minimum length are silently not cached (Sources 1).
**Spot it in a plan:** Large static instructions or reference documents sent with every call.
**Spot it in code:** f-strings that put `datetime.now()`, request ids or user names at the start of the system prompt; tool lists built in nondeterministic order; `cache_read_input_tokens` always 0 in the ledger.
**Build it right:** Order prompts from most stable to least stable: tools, then fixed system instructions, then tenant-level context, then the conversation, then the volatile bits (time, user name) at the end. Mark the cache breakpoint after the stable part. Keep tool definitions byte-identical (sorted, deterministic serialization). Monitor cache read ratio per feature in the ledger.

Dangerous:
```python
system = f"Today is {datetime.now().isoformat()}. You are helping {user.name}.\n" + LONG_INSTRUCTIONS
client.messages.create(model=MODEL, system=system, tools=random_order_tools(), messages=msgs, max_tokens=800)
```

Safe:
```python
system = [
    {"type": "text", "text": LONG_INSTRUCTIONS, "cache_control": {"type": "ephemeral"}},
]
msgs = [{"role": "user", "content": f"(Context: today is {date.today()}, user is {user.name})\n{question}"}]
client.messages.create(model=MODEL, system=system, tools=SORTED_TOOLS, messages=msgs, max_tokens=800)
```

**Prove it:** Two consecutive calls on staging: the second shows `cache_read_input_tokens` greater than zero. The ledger's cache read ratio for the feature is above a stated target.
**Size for now:** Cache the stable system prompt and tools for the highest-volume features. Multi-breakpoint layouts can wait.

### COST-10 Log volume and egress

**How it fails:** Full prompts, completions and request bodies are logged at info level for every call. Logs grow by gigabytes a day, ingestion and retention costs exceed the compute bill, and the logs now hold customer data that needs protection (OPS-12, personal data rules). Separately, large payloads move across regions or out to the internet on every request.
**Seen in the wild:** AWS's CloudWatch pricing examples use $0.50 per GB of ingested logs (Sources 12), and AWS bills data transfer out to the internet beyond a 100 GB monthly free allowance (Sources 13). No verified incident cited.
**Spot it in a plan:** "Log everything for debugging." Services and databases in different regions. Serving files through the application instead of from storage.
**Spot it in code:** `logger.info(prompt)`, `console.log(JSON.stringify(req.body))`, debug level in production config; cross-region endpoints in config; files proxied through app servers.
**Build it right:** Log structured events with ids, sizes and outcomes, not bodies (OPS-01). Keep full payloads only when needed, in storage with a short retention and access control, or sample them. Set retention per log group. Keep compute, database and storage in one region. Estimate GB per action in the COST-01 table.

Dangerous:
```ts
logger.info({ prompt, completion, body: req.body }, "llm call");
```

Safe:
```ts
logger.info({
  event: "llm.call", tenantId, feature, model, correlationId,
  inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
  promptChars: prompt.length, latencyMs,
}, "llm call");
if (sampler.keep(tenantId, 0.01)) await payloadStore.put(correlationId, { prompt, completion }, { ttlDays: 7 });
```

**Prove it:** Log volume per 1,000 actions measured on staging and written next to the estimate; a search for a known prompt string in production logs returns nothing.
**Size for now:** Structured logs without bodies, retention set, a sampled payload store if debugging needs it.

### COST-11 Third-party quotas consumed as if free

**How it fails:** A feature calls a third-party API per event. It hits the provider's rate limit, gets throttled, and the throttling affects every other feature that uses the same app credentials, or the provider bills overage. In Slack, posting per event to a busy channel runs into per-channel posting limits.
**Seen in the wild:** Slack applies rate limits per API method per workspace per app, with `chat.postMessage` generally allowing about 1 message per second per channel, and newly created commercially distributed apps not approved for the Marketplace face tighter limits on `conversations.history` and `conversations.replies` from 29 May 2025 (Sources 14, 15). No verified incident cited.
**Spot it in a plan:** "Fetch the history for each thread", "post an update for each event".
**Spot it in code:** Calls to rate-limited methods in loops; no handling of 429 or `Retry-After`; no shared limiter across workers.
**Build it right:** List each quota the feature uses with its limit and the feature's expected consumption. Use a shared limiter (keyed by provider, method, workspace) across workers. Prefer bulk and incremental APIs, and cache what changes rarely (LAT-11). Honor `Retry-After`. Reserve headroom for interactive features by giving background sync a lower share.

Dangerous:
```python
for thread in threads:
    replies = slack.conversations_replies(channel=ch, ts=thread.ts)   # per thread, all workers at once
```

Safe:
```python
limiter = SharedLimiter(redis, key=f"slack:{team_id}:conversations.replies", rate=QUOTA.per_minute * 0.5)
for thread in threads_changed_since(cursor):          # incremental, not all threads
    limiter.acquire()
    try:
        replies = slack.conversations_replies(channel=ch, ts=thread.ts, limit=200)
    except SlackApiError as e:
        if e.response.status_code == 429:
            time.sleep(int(e.response.headers.get("Retry-After", "30")))
            continue
        raise
```

**Prove it:** Run a sync for a large staging workspace while exercising interactive features: no 429s reach the interactive paths, and sync throughput stays under the share.
**Size for now:** A quota table and a shared limiter for the one or two providers you call most. A generic quota service can wait.

### COST-12 Paying for idle and over-provisioned resources

**How it fails:** Minimum instances, provisioned concurrency and always-on workers are set high "to be safe" and bill around the clock. Or autoscaling maxima are left at defaults, so a bug or traffic spike scales to hundreds of instances.
**Seen in the wild:** In the $72,000 incident, Cloud Run's max instances default of 1,000 and concurrency of 80 let the recursion scale; the founder said values of 2 and 1 would likely have prevented the bill (Sources 2). Cloud Run bills minimum instances even when idle, at a lower rate under request-based billing (Sources 16).
**Spot it in a plan:** No maximum instance count. "Keep it warm" without a number.
**Spot it in code:** Missing `maxScale` / `max_instance_count` / reserved concurrency; high `minScale` on non-deadline services; preview environments that never shut down.
**Build it right:** Set explicit maximum instances on every autoscaled service, sized to expected peak with headroom and to what downstream dependencies (database connections, provider quotas) can take. Keep minimum instances only where a deadline needs them (LAT-10). Expire preview and test environments automatically.

Dangerous:
```yaml
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "5"
        # no maxScale: platform default applies
```

Safe:
```yaml
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"    # only for the ack service (LAT-10)
        autoscaling.knative.dev/maxScale: "20"   # about 2x peak; 20 x pool size stays under the DB connection limit
```

**Prove it:** Drive load beyond the maximum on staging: instance count stops at the configured maximum and excess requests queue or are rejected in a defined way.
**Size for now:** Explicit maxima everywhere, minimum instances only on deadline services. Rightsizing analysis after three months of data.

### COST-13 Untrusted input triggers paid actions

**How it fails:** A public sign-up form sends an SMS verification code, a public chat widget calls an LLM, an inbound email address triggers an LLM summary. Attackers or scripts trigger them in bulk. The bill grows with no customer behind it.
**Seen in the wild:** Twilio describes SMS pumping fraud: attackers abuse phone number fields on sign-up or login forms to trigger messages to number ranges where they share revenue with a mobile operator; signs include spikes to blocks of adjacent numbers and verifications that never complete, and mitigations include disabling countries you do not serve (Sources 17).
**Spot it in a plan:** Paid actions reachable before authentication, or by anyone who can send an email or join a public channel.
**Spot it in code:** SMS, email or LLM calls in unauthenticated routes; no rate limit by IP, phone prefix or account; no CAPTCHA or proof of work on public forms.
**Build it right:** Put paid actions behind authentication where possible. Where they must be public, rate limit by several keys (IP, device, phone number prefix, destination country), allowlist countries you serve, require a challenge after a threshold, and cap total daily spend for the public path with an alert. Monitor completion rates (verifications sent vs completed).

Dangerous:
```ts
app.post("/signup/send-code", async (req, res) => {
  await sms.send(req.body.phone, `Your code is ${newCode()}`);
  res.sendStatus(204);
});
```

Safe:
```ts
app.post("/signup/send-code", rateLimit({ key: (r) => r.ip, perHour: 5 }), async (req, res) => {
  const phone = parsePhone(req.body.phone);
  if (!phone || !ALLOWED_COUNTRIES.has(phone.country)) return res.status(400).json({ error: "unsupported_number" });
  if (!(await limits.take(`sms:prefix:${phone.e164.slice(0, -3)}`, { perHour: 10 }))) return res.sendStatus(429);
  if (!(await limits.take("sms:public:daily_usd", { cost: SMS_COST[phone.country], cap: 50 }))) {
    await pager.trigger("public-sms-cap");
    return res.sendStatus(503);
  }
  await sms.send(phone.e164, `Your code is ${await codes.issue(phone.e164)}`);
  res.sendStatus(204);
});
```

**Prove it:** Script 500 requests to the public endpoint from varied IPs to sequential numbers in one prefix: sends stop at the prefix limit and the daily cap pages on-call.
**Size for now:** Authentication in front of paid actions, plus rate limits and a daily cap on any public path. Fraud scoring services when volume justifies them.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "Tokens are cheap" | Cheap times every event times every tenant is not cheap, and loops multiply it | Estimate per action and per tenant (COST-01) |
| "We have a budget alert" | Budget alerts are delayed and usually do not cap spend | Breaker in your own code from your own ledger (COST-07) |
| "The bot will never answer itself" | Event subscriptions deliver your own messages unless filtered | Filter self and bots, cap turns (COST-03) |
| "Retries make it reliable" | Retrying a paid multi-step flow pays again each time, and some errors never succeed | Bound attempts, classify errors, checkpoint (COST-04) |
| "Use the best model to be safe" | For many tasks a smaller model scores the same on evals | Pick per task with evals (COST-08) |
| "Logging everything helps debugging" | It costs per GB and stores customer data | Log ids and sizes, sample payloads (COST-10) |
| "Customers won't abuse it" | Bots find public endpoints that cost money | Authenticate or limit and cap public paid paths (COST-13) |
| "We'll optimize cost later" | Pricing and architecture set now determine whether later is possible | Cost table in the plan (COST-01) |

## Attack recipes

1. **Echo loop.** In a staging Slack workspace, make the bot listen to a channel it posts in, and add a second bot that echoes every message. More than the stated turn cap of replies, or ledger calls still growing after a minute, means COST-03 failed.
2. **Webhook ping-pong.** Configure the integration so its write-back changes the object that fires the webhook. More than one processing per external change means COST-03 failed.
3. **Poison message.** Enqueue a job that fails permanently at step 4 of a 6-step agent. Steps 1 to 3 billed more than once, or attempts beyond the stated maximum, means COST-04 failed.
4. **Noisy neighbor.** Drive one tenant to 10x its expected volume while another runs normal traffic. Any 429 or cap message for the second tenant means COST-06 failed.
5. **Breaker test.** Lower the global hourly spend threshold on staging and generate paid traffic. Non-essential calls still made a minute after crossing it, or no page, means COST-07 failed.
6. **Cache miss check.** Make two identical calls to a cached feature. `cache_read_input_tokens` of zero on the second means COST-09 failed.
7. **Log grep.** Send a request containing a unique marker string, then search production log storage for it. Any hit means COST-10 failed.
8. **Pump the form.** Script requests to the public SMS or LLM endpoint across many IPs and sequential numbers. Sends beyond the prefix limit or the daily cap means COST-13 failed.
9. **Scale ceiling.** Load test beyond peak. Instance count above the configured maximum means COST-12 failed.

## Sources

1. Anthropic, "Prompt caching." https://platform.claude.com/docs/en/build-with-claude/prompt-caching
2. The Register, coverage of Milkie Way's $72,000 Cloud Run and Firebase bill, 10 December 2020. https://www.theregister.com/2020/12/10/google_cloud_over_run/
3. AWS Lambda Developer Guide, "Use Lambda recursive loop detection to prevent infinite loops." https://docs.aws.amazon.com/lambda/latest/dg/invocation-recursion.html
4. GitHub Docs, "Triggering a workflow" (events triggered by `GITHUB_TOKEN`). https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow
5. Slack Bolt for JavaScript reference, `ignoreSelf`. https://docs.slack.dev/tools/bolt-js/reference/variables/ignoreSelf
6. Anthropic, "Rate limits" (spend limits, workspace limits, 429 behavior). https://platform.claude.com/docs/en/api/rate-limits
7. Amazon Builders' Library, "Timeouts, retries, and backoff with jitter." https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter
8. Anthropic, "Usage and Cost API." https://platform.claude.com/docs/en/build-with-claude/usage-cost-api
9. Google Cloud Billing, "Create, edit, or delete budgets and budget alerts." https://docs.cloud.google.com/billing/docs/how-to/budgets
10. Anthropic, "Reducing latency." https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency
11. Anthropic, "Batch processing." https://platform.claude.com/docs/en/build-with-claude/batch-processing
12. Amazon CloudWatch pricing (worked examples). https://aws.amazon.com/cloudwatch/pricing/
13. Amazon EC2 On-Demand pricing, Data Transfer section. https://aws.amazon.com/ec2/pricing/on-demand/
14. Slack API reference, `chat.postMessage`. https://docs.slack.dev/reference/methods/chat.postMessage
15. Slack Developer Docs, "Rate limits." https://docs.slack.dev/apis/web-api/rate-limits
16. Google Cloud, Cloud Run "Set minimum instances." https://docs.cloud.google.com/run/docs/configuring/min-instances
17. Twilio, "What is SMS pumping fraud?" https://www.twilio.com/docs/glossary/what-is-sms-pumping-fraud
