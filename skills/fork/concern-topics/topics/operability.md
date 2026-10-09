# Operability

**Protects:** The team can tell, from data and without a customer reporting it, whether each user journey is working; can find out why when it is not; can turn off or roll back a bad change in minutes; and can answer "did user X get their reply?" for any specific request.
**Read when:** The plan adds a service, a background job or queue, a new user journey, a deploy or migration, a feature flag, a config value, an admin capability, or any async hop (webhook, queue, scheduled job, LLM call). In code: logger calls, metric names, `catch` blocks, queue producers and consumers, `process.env`/`os.environ` reads, migration files, flag checks, admin endpoints.
**Prefix:** OPS

## Design questions

1. Which id follows a request from the inbound event, through every queue and job, to the final outbound effect, and is it in every log line and span? (OPS-01)
2. Given a tenant, user and time, which query answers "did they get their reply, and if not, where did it stop"? (OPS-02)
3. Which SLI measures each user journey from the user's side, and what is its SLO? (OPS-03)
4. Which alerts page a human, are they on user-visible symptoms, and what will the human do when paged? (OPS-04)
5. Which dashboard does on-call open first, and does it show each journey's health, recent deploys and flags? (OPS-05)
6. Can one trace show the time spent in each service, queue and external call for a single request? (OPS-06)
7. For each page, where is the runbook, and can someone who did not write the feature follow it at 3 a.m.? (OPS-07)
8. How is this feature turned off in production without a deploy, and how long does that take to take effect? (OPS-08)
9. How does a change reach 100% of users: in what stages, watched by what, and what rolls it back automatically? (OPS-09)
10. What happens at startup if a config value is missing, malformed or contradictory, and what happens when config changes at runtime? (OPS-10)
11. Can the previous version of the code run against the database after this migration, and which locks does the migration take? (OPS-11)
12. Which admin and support actions change customer data or access, and where is the record of who did what? (OPS-12)
13. For each queue and job, what metric shows it is falling behind or failing, before users notice? (OPS-13)

## Categories

### OPS-01 Logs that cannot be joined across async hops

**How it fails:** A Slack event arrives, is enqueued, processed by a worker, which calls an LLM and posts a reply. Each step logs, but with no shared id, as free text. When a customer says "the bot never answered", engineers grep by timestamp and channel name across four services and guess.
**Seen in the wild:** No verified incident cited; OpenTelemetry describes context propagation as what lets traces, metrics and logs be correlated across process and network boundaries, with W3C Trace Context as the default propagator, and notes that for protocols without a metadata field the context must be placed somewhere both sides agree on (Sources 1).
**Spot it in a plan:** Queues, webhooks or scheduled jobs between the trigger and the outcome, with no mention of correlation.
**Spot it in code:** `console.log("processing " + x)` (unstructured); queue messages without a correlation or trace field; workers that start a new trace for each message; log lines without tenant id.
**Build it right:** Assign a correlation id at the first entry point (or adopt the provider's event id), put it in the job payload or message attributes along with the trace context, and bind it to the logger and the active span in every consumer. Log in structured form (JSON) with a fixed set of fields: `ts`, `level`, `event`, `tenant_id`, `correlation_id`, `trace_id`, plus event-specific fields. Enforce through one logging module, not convention.

Dangerous:
```ts
await queue.publish("summaries", { channel, ts });
// worker
console.log("summarizing " + msg.channel);
```

Safe:
```ts
import { context, propagation } from "@opentelemetry/api";

const carrier: Record<string, string> = {};
propagation.inject(context.active(), carrier);
await queue.publish("summaries", { channel, ts, tenantId, correlationId, otel: carrier });

// worker
const parent = propagation.extract(context.active(), msg.otel);
await context.with(parent, async () => {
  const log = logger.child({ tenantId: msg.tenantId, correlationId: msg.correlationId });
  log.info({ event: "summary.started", channel: msg.channel });
  // ...
});
```

**Prove it:** Trigger one request on staging and retrieve every log line from every service for it by a single `correlation_id` query, in order.
**Size for now:** Correlation id and trace context through every async hop, structured logs. Log-based analytics pipelines can wait.

### OPS-02 Cannot answer "did user X get their reply?"

**How it fails:** Support asks whether a specific user got their summary yesterday at 14:05. Logs have been sampled or rotated, metrics are aggregates, and the only evidence is the user's word. Silent failures (the job succeeded but `chat.postMessage` returned `not_in_channel`) are invisible.
**Seen in the wild:** No verified incident cited; failure follows from relying on aggregate metrics and short-retention logs for per-request questions. The SRE book's distinction between "what is broken" and "why" (Sources 2) applies here per request, not just per service.
**Spot it in a plan:** No durable record of each request's outcome. "We can check the logs."
**Spot it in code:** Outbound calls whose response is not checked or not stored (`ok: false` ignored); job tables deleted on completion; no outcome field.
**Build it right:** Keep an outcome ledger: one row per user-initiated request with tenant, user, surface, correlation id, timestamps per stage (received, started, model done, delivered), final status from a closed set, and the external id of the delivered effect (Slack `ts`, email message id). Write it from the owning module at each stage. Retain it for as long as support needs (for example 90 days). Give support a read-only lookup.

Dangerous:
```python
slack.chat_postMessage(channel=ch, text=summary, thread_ts=ts)
```

Safe:
```python
resp = slack.chat_postMessage(channel=ch, text=summary, thread_ts=ts)
db.execute("""
  UPDATE request_outcomes
     SET status = 'delivered', delivered_at = now(), external_ref = %s
   WHERE correlation_id = %s AND status <> 'delivered'
""", (resp["ts"], ctx.correlation_id))
# SlackApiError is caught by the job runner, which sets status='failed', failure_reason=e.response['error']
```

```sql
SELECT received_at, status, failure_reason, delivered_at, external_ref
FROM request_outcomes
WHERE tenant_id = $1 AND user_id = $2
  AND received_at BETWEEN $3 AND $4
ORDER BY received_at;
```

**Prove it:** Run the query above for a staging request that succeeded and one where delivery was forced to fail; both have a row with the correct status and reason.
**Size for now:** An outcome table for each user-initiated journey. A full event-sourced history is not needed.

### OPS-03 Metrics that do not map to user journeys

**How it fails:** Dashboards show CPU, memory, HTTP 5xx rate and queue length. The bot can be failing to post every reply (a revoked token, a changed Slack scope) while all of those look healthy, because the failure is a 200 from your API and an error from someone else's.
**Seen in the wild:** The SRE book recommends choosing SLIs from what users care about rather than what is easy to measure, and expressing them as distributions (Sources 3).
**Spot it in a plan:** Monitoring described as "standard metrics" or "APM". No SLO.
**Spot it in code:** Metrics only from framework middleware; no metric emitted at the journey's success point.
**Build it right:** For each journey from the user-journey map (UJ-14), define an SLI as good events over valid events measured as close to the user as possible ("replies posted within 30 s of the request / requests"), and an SLO with a window. Emit it from the outcome ledger or the success point. Slice by tenant for the largest tenants.

Dangerous:
```ts
app.use(promMiddleware()); // http_requests_total, http_request_duration_seconds. Done.
```

Safe:
```ts
const journey = new client.Counter({
  name: "journey_outcomes_total",
  help: "User journey outcomes",
  labelNames: ["journey", "outcome"],          // outcome: ok | slow | failed
});
// at delivery: journey.inc({ journey: "thread_summary", outcome: latencyMs <= 30_000 ? "ok" : "slow" });
// on handled failure: journey.inc({ journey: "thread_summary", outcome: "failed" });
// SLI = ok / (ok + slow + failed); SLO 99% over 28 days
```

**Prove it:** Revoke the Slack token for a staging tenant: the journey SLI drops within minutes while HTTP 5xx stays flat.
**Size for now:** One SLI and SLO per main journey. Per-tenant SLOs only for contractual commitments.

### OPS-04 Alerts on causes, noisy pages, or no alerts

**How it fails:** On-call is paged for high CPU on one host at 3 a.m., with no user impact, and learns to ignore pages. Meanwhile the real failure (replies not posting) has no alert at all. Or errors are emailed to a list that nobody treats as an alert.
**Seen in the wild:** On 1 August 2012 Knight Capital's router sent more than 4 million orders in the first 45 minutes of trading and the firm lost more than $460 million; before the open, an internal system sent 97 automated emails referencing the error; the SEC noted they were not designed as alerts and staff did not act on them (Sources 4). The SRE book says every page should be actionable and require intelligence, and distinguishes symptoms from causes (Sources 2).
**Spot it in a plan:** Alert list made of resource thresholds. Errors "sent to Slack" or email.
**Spot it in code:** Alert rules on `cpu`, `memory`, single error counts; no alert on the journey SLI; `catch` blocks that only email.
**Build it right:** Page on symptoms: journey SLO burn rate, using a multiwindow, multi-burn-rate scheme (for a 99.9% SLO the SRE workbook suggests paging on 14.4x burn over 1 hour with a 5 minute short window, and 6x over 6 hours with 30 minutes) and ticket on slow burns (Sources 5). Keep cause-level signals (CPU, queue depth) on dashboards and as non-paging warnings. Every paging alert links a runbook (OPS-07). Review pages monthly and delete or fix the ones that led to no action.

Dangerous:
```yaml
- alert: HighCPU
  expr: avg(rate(process_cpu_seconds_total[5m])) > 0.8
  labels: { severity: page }
```

Safe:
```yaml
- alert: ThreadSummarySLOFastBurn
  expr: |
    (
      sum(rate(journey_outcomes_total{journey="thread_summary",outcome!="ok"}[1h]))
      / sum(rate(journey_outcomes_total{journey="thread_summary"}[1h]))
    ) > (14.4 * 0.01)
    and
    (
      sum(rate(journey_outcomes_total{journey="thread_summary",outcome!="ok"}[5m]))
      / sum(rate(journey_outcomes_total{journey="thread_summary"}[5m]))
    ) > (14.4 * 0.01)
  labels: { severity: page }
  annotations:
    runbook: https://runbooks.internal/thread-summary
```
(The `0.01` is the error budget for the 99% SLO from OPS-03.)

**Prove it:** Inject failures on staging until the burn threshold is crossed: one page fires, with a runbook link, and it resolves within minutes of the failure stopping.
**Size for now:** One fast-burn page and one slow-burn ticket per journey SLO. A full alert taxonomy can wait.

### OPS-05 No dashboard that answers "is it working right now?"

**How it fails:** During an incident, on-call opens five tools, each with dozens of default panels, none showing the journeys or what changed recently. Time is lost establishing basic facts: which journey, since when, which tenants, after which deploy.
**Seen in the wild:** No verified incident cited; the SRE book names latency, traffic, errors and saturation as the four golden signals for a user-facing system (Sources 2), and Slack's deploy process advances each stage only when charts stay stable and no alerts are outstanding (Sources 6), which assumes such charts exist.
**Spot it in a plan:** No dashboard named. "We'll use the default APM views."
**Spot it in code:** No deploy or flag-change annotations emitted.
**Build it right:** One first-look dashboard per product area: each journey SLI and latency percentiles, traffic, error breakdown by reason, saturation of the main constraint (queue age, DB connections, provider rate limit headroom), top tenants by error, and annotations for deploys and flag changes. Link it from every runbook and alert.

Dangerous:
```text
Dashboard "service-x": 40 auto-generated panels (GC pauses, heap, per-endpoint p95, ...)
```

Safe:
```text
Dashboard "Slack assistant: first look"
Row 1: journey SLI (thread_summary, ask_command), p50/p99 vs budget, requests/min
Row 2: failures by reason (llm_timeout, slack_not_in_channel, token_revoked), top 10 tenants by failures
Row 3: queue oldest message age, DLQ depth, LLM 429 rate, DB connections in use
Annotations: deploys (version), flag changes (name, actor), provider status incidents
```

**Prove it:** In a game day, someone unfamiliar with the feature uses only the dashboard to say which journey is broken, since when and for whom, within five minutes.
**Size for now:** One dashboard per product area. Per-team dashboards later.

### OPS-06 No tracing across services and external calls

**How it fails:** A request is slow or fails intermittently, and logs from each service show nothing wrong in isolation. Without a trace, nobody can see that 4 s of the 6 s were spent waiting in a queue, or that one external call retried three times.
**Seen in the wild:** No verified incident cited; failure follows from per-service logs lacking causal links, which context propagation provides (Sources 1).
**Spot it in a plan:** More than one hop with no tracing mentioned.
**Spot it in code:** No tracer setup; HTTP clients and queue clients not instrumented; LLM calls without spans.
**Build it right:** Initialize OpenTelemetry (or the vendor equivalent) in every service, with automatic instrumentation for HTTP, database and queue clients, and manual spans around LLM calls and other major steps with attributes for model, token counts, tenant and outcome. Propagate context through queues (OPS-01). Sample by keeping all errors and slow traces plus a percentage of the rest.

Dangerous:
```python
def run(job):
    thread = fetch_thread(job)
    summary = llm(thread)
    post(summary)
```

Safe:
```python
tracer = trace.get_tracer("summarizer")

def run(job):
    ctx = propagate.extract(job.otel)
    with tracer.start_as_current_span("job.summarize", context=ctx) as span:
        span.set_attributes({"tenant.id": job.tenant_id, "correlation.id": job.correlation_id})
        thread = fetch_thread(job)                # instrumented HTTP client creates child span
        with tracer.start_as_current_span("llm.call") as s:
            summary = llm(thread)
            s.set_attributes({"llm.model": MODEL, "llm.output_tokens": summary.usage.output_tokens})
        post(summary)
```

**Prove it:** One staging request produces a single trace spanning the ingress service, the queue wait, the worker, the LLM call and the Slack post.
**Size for now:** Tracing on the main journeys with error and slow-trace retention. Full sampling of all traffic is not needed.

### OPS-07 Runbooks missing, and on-call that burns people out

**How it fails:** An alert fires; the person on call did not build the feature, there is no runbook, and the only expert is asleep. Or there are runbooks, but they are stale and reference dashboards that no longer exist. Pages are frequent enough that on-call becomes something people avoid.
**Seen in the wild:** The SEC found Knight Capital lacked written guidance for responding to technology incidents (Sources 4). The SRE book caps on-call at 25% of an engineer's time and at most two incidents per 12-hour shift, and recommends clear escalation paths and defined incident procedures (Sources 7).
**Spot it in a plan:** New alerts without runbooks. On-call rotation not named.
**Spot it in code:** Alert rules without a `runbook` annotation; runbooks not in the repository.
**Build it right:** Every paging alert links a runbook stored with the code: what the alert means for users, the first-look dashboard, how to confirm, safe mitigations in order (flip the kill switch, roll back, scale, contact the provider), how to verify recovery, and who to escalate to. Review runbooks in the same PR as the feature. Track pages per shift and fix the source of repeated ones.

Dangerous:
```yaml
annotations:
  summary: "summarizer errors"
```

Safe:
```markdown
# Runbook: ThreadSummarySLOFastBurn
Impact: users asking for thread summaries in Slack get no reply or a late one.
Look: dashboard "Slack assistant: first look", rows 1 and 2.
Confirm: failures by reason. If `token_revoked` for one tenant only, this is not an outage: notify the tenant owner (support macro "reconnect").
Mitigate, in order:
1. If it started with a deploy (annotation), roll back: `deploy rollback summarizer`.
2. If `llm_timeout` or LLM 5xx dominates, set flag `summaries.use_fallback_model` on.
3. If still failing, set flag `summaries.enabled` off; the bot replies "Summaries are temporarily unavailable".
Verify: SLI back above 99% for 15 minutes.
Escalate: #team-assistant, then the feature owner listed in CODEOWNERS.
```

**Prove it:** A game day where someone who did not build the feature resolves an injected failure using only the runbook.
**Size for now:** A runbook per paging alert and a two-person rotation for business-critical journeys. A follow-the-sun rotation when customers span time zones.

### OPS-08 No kill switch, or flags that need a deploy

**How it fails:** A new feature misbehaves in production (posting wrong replies, spending too much, hammering a provider). The only way to stop it is a code revert and full deploy, which takes 30 minutes. Or a flag exists but is read once at startup, so changing it requires a restart. Or old flags pile up and one is accidentally reused with different meaning.
**Seen in the wild:** After its 18 November 2025 outage, Cloudflare listed enabling more global kill switches for features as a follow-up (Sources 8). The feature toggles article on martinfowler.com describes ops toggles and long-lived kill switches, warns against needing a release to flip an ops toggle, and recommends expiry dates and removal tasks for toggles (Sources 9).
**Spot it in a plan:** New risky behavior with no "how do we turn this off".
**Spot it in code:** `const ENABLED = process.env.FEATURE_X === "true"` at module scope; flags without owners or expiry; flags checked in only some code paths.
**Build it right:** Each risky feature gets an ops flag that is read at decision time from a flag service or database with a short cache (seconds), defaults to the safe state if the flag store is unreachable, and is checked at a single choke point (the entry handler or the paid-call wrapper). Off must produce a defined user-facing state, not an error. Record flag changes with actor and time (OPS-12) and annotate dashboards. Give release flags an owner and an expiry date; remove them after full rollout.

Dangerous:
```ts
const SUMMARIES_ON = process.env.SUMMARIES_ON === "true"; // read once at boot
export async function onMention(evt: MentionEvent) {
  if (SUMMARIES_ON) await summarize(evt);
}
```

Safe:
```ts
export async function onMention(evt: MentionEvent) {
  const on = await flags.bool("summaries.enabled", { tenantId: evt.teamId, default: false, maxAgeMs: 5000 });
  if (!on) return say(evt, "Summaries are temporarily unavailable.");
  await summarize(evt);
}
```

**Prove it:** On staging, flip the flag off during traffic: within the cache interval no new work starts, users see the defined message, and the flag change appears on the dashboard.
**Size for now:** A database-backed flag table with a small cache, per-tenant overrides and an audit row per change. A commercial flag service when the number of flags or teams grows.

### OPS-09 Big-bang rollouts with manual rollback

**How it fails:** A change goes to 100% of traffic at once. A defect that would have shown in a small slice hits every customer, and rollback depends on someone noticing and acting.
**Seen in the wild:** Slack deploys about 12 times a day, through staging, dogfood and a canary taking about 2% of production traffic, then 10, 25, 50, 75 and 100 percent, rolling back immediately on an error spike (Sources 6). AWS deployments start with one box, bake for hours between waves, and roll back automatically when high-severity alarms fire (Sources 10). CrowdStrike's July 2024 root cause analysis committed to staged deployment of its rapid response content through rings with bake time and to giving customers control over when updates deploy (Sources 11).
**Spot it in a plan:** "Deploy on Friday." No canary or stage. Config or content changes that bypass the code pipeline.
**Spot it in code:** Pipelines with a single production step; no health gate between stages; config pushed globally by a script.
**Build it right:** Stage every production change, code and config: internal tenants first (dogfood), then a small percentage or a few low-risk tenants, then increasing steps, with a bake period sized to traffic. Gate each step on the journey SLIs and error rates of the canary compared with the rest (the SRE workbook notes a 20% error rate on a 5% canary shows as only about 1% overall, so compare populations separately, Sources 12). Roll back automatically when the gate fails. Make rollback a tested, one-command path.

Dangerous:
```yaml
deploy:
  - run: kubectl set image deploy/summarizer app=summarizer:${SHA}
```

Safe:
```yaml
deploy:
  - stage: dogfood     # internal tenants only via tenant routing
    gate: { slo_burn_rate_max: 2, min_requests: 200, bake: 30m }
  - stage: canary-5    # 5% of tenants, hashed
    gate: { compare_to_baseline: [error_rate, p99_latency], bake: 1h }
  - stage: 25
  - stage: 100
on_gate_failure: rollback_to_previous   # automatic, then page
```

**Prove it:** Ship a deliberately broken build to staging through the pipeline: it stops at the first gate and rolls back without a human.
**Size for now:** Dogfood plus one canary step plus automatic rollback on SLI regression. Region waves and cell-based rollouts when there are multiple regions or cells.

### OPS-10 Config that is not validated

**How it fails:** A missing environment variable becomes `undefined` and the service starts, then fails on the first request that needs it, hours later. A malformed or oversized generated config file is pushed everywhere and crashes every instance at once. A timeout of `0` means "no timeout" in one library and "fail immediately" in another.
**Seen in the wild:** On 18 November 2025 a database permissions change made a generated Cloudflare Bot Management feature file more than double in size, beyond a preallocated limit of 200 features; the file was pushed to every machine and the proxy panicked, causing widespread 5xx errors. Cloudflare's follow-ups include hardening ingestion of its own generated config files as if they were user input (Sources 8).
**Spot it in a plan:** New config values or generated files distributed to the fleet with no validation step.
**Spot it in code:** `process.env.X` read where used; `os.environ.get("X")` with no check; `unwrap()` / unchecked parsing of config; config files loaded without schema.
**Build it right:** Parse all config at startup into a typed object with a schema (required fields, ranges, enums, cross-field rules) and refuse to start on failure, so the bad version never takes traffic and the deploy gate (OPS-09) catches it. For runtime-reloaded or generated config, validate before activating, keep the last known good version on failure, and roll config out in stages like code.

Dangerous:
```ts
const timeoutMs = Number(process.env.LLM_TIMEOUT_MS);  // NaN if unset
const slackSecret = process.env.SLACK_SIGNING_SECRET;  // undefined: verification may be skipped
```

Safe:
```ts
import { z } from "zod";
const Config = z.object({
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000),
  SLACK_SIGNING_SECRET: z.string().min(16),
  DATABASE_URL: z.string().url(),
  SUMMARIES_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(1024),
});
export const config = Config.parse(process.env); // throws at boot: the process exits, deploy gate fails
```

**Prove it:** Start the service on staging with each required variable removed and with an out-of-range value: it refuses to start with a clear message. Push an invalid runtime config: instances keep the last good version and an alert fires.
**Size for now:** Schema validation at startup for all services. Staged config rollout when config is pushed outside the deploy pipeline.

### OPS-11 Deploys with unsafe migrations

**How it fails:** A migration adds a column with a volatile default or a constraint that scans the table, taking an `ACCESS EXCLUSIVE` lock on a large table; every query queues behind it and the app goes down. Or the new code and migration ship together, the code is rolled back, and the old code cannot run against the new schema (a dropped or renamed column).
**Seen in the wild:** PostgreSQL's `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock unless noted; adding a column with a volatile default rewrites the whole table, while `ADD CONSTRAINT ... NOT VALID` followed by `VALIDATE CONSTRAINT` validates under a weaker `SHARE UPDATE EXCLUSIVE` lock (Sources 13). `lock_timeout` defaults to 0, which disables it, so a migration waiting for a lock can wait indefinitely (Sources 14); while it waits, later queries that need conflicting locks queue behind it. No verified incident cited.
**Spot it in a plan:** Column renames or drops in the same release as code changes. Constraints added to large tables. "Run the migration, then deploy."
**Spot it in code:** `RENAME COLUMN`, `DROP COLUMN`, `ADD COLUMN ... DEFAULT clock_timestamp()`/`gen_random_uuid()`, `ALTER COLUMN TYPE`, `ADD CONSTRAINT` without `NOT VALID`, `CREATE INDEX` without `CONCURRENTLY`; migrations without `lock_timeout`.
**Build it right:** Expand and contract: first add (nullable column, new table, `NOT VALID` constraint, index `CONCURRENTLY`), deploy code that writes both and reads the new, backfill in batches, validate, and only in a later release remove the old. Every migration sets a short `lock_timeout` and is retried, so it fails fast instead of blocking traffic. The previous code version must work with the new schema, so rollback (OPS-09) stays safe. Lint migrations in CI for the dangerous patterns.

Dangerous:
```sql
ALTER TABLE messages ADD COLUMN thread_key uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE messages ADD CONSTRAINT messages_tenant_fk FOREIGN KEY (tenant_id) REFERENCES tenants(id);
ALTER TABLE messages RENAME COLUMN body TO text;
```

Safe:
```sql
SET lock_timeout = '2s';
ALTER TABLE messages ADD COLUMN thread_key uuid;                     -- no rewrite, brief lock
ALTER TABLE messages ADD CONSTRAINT messages_tenant_fk
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) NOT VALID;          -- no scan
-- separate step, after deploy:
ALTER TABLE messages VALIDATE CONSTRAINT messages_tenant_fk;         -- SHARE UPDATE EXCLUSIVE
-- backfill thread_key in batches of 5,000 rows; rename handled by adding `text`,
-- dual-writing, switching reads, and dropping `body` in a later release
```

**Prove it:** Run the migration on a staging copy with production-like row counts while a load generator runs queries: p99 stays within budget and no query waits more than the lock timeout. Roll the code back one version after migrating: the app still works.
**Size for now:** Expand and contract, `lock_timeout`, and a CI lint for dangerous statements. Online schema change tooling only for tables too large for these techniques.

### OPS-12 Admin and support actions without an audit trail

**How it fails:** A support engineer impersonates a user, changes a tenant's plan, or disables a security setting. A customer later asks who changed it and when. There is no record, or the record is a mutable column that the next change overwrites.
**Seen in the wild:** No verified incident cited; the OWASP Logging Cheat Sheet lists user administration, privilege changes and use of administrative privileges among events to log, with when, where, who and what, and recommends tamper detection and restricted access for those logs (Sources 15).
**Spot it in a plan:** Admin panels, impersonation, support tools, flag changes, tenant config changes with no audit mentioned.
**Spot it in code:** Admin endpoints that `UPDATE` without inserting an audit row; `updated_by` columns as the only record; impersonation sessions that look like the user's own.
**Build it right:** An append-only audit table written in the same transaction as the change, from the module that owns admin actions: actor (and impersonated user), tenant, action, target, before and after values, reason, request and correlation id, time. Revoke `UPDATE` and `DELETE` on it for the application role. Show customers their tenant's audit log where contracts require it. Flag changes and kill switch use (OPS-08) go here too.

Dangerous:
```python
@admin.post("/tenants/{tid}/plan")
def set_plan(tid, body, admin=Depends(require_admin)):
    db.execute("UPDATE tenants SET plan = %s WHERE id = %s", (body.plan, tid))
```

Safe:
```python
@admin.post("/tenants/{tid}/plan")
def set_plan(tid, body, admin=Depends(require_admin)):
    with db.transaction():
        before = db.fetchval("SELECT plan FROM tenants WHERE id = %s FOR UPDATE", (tid,))
        db.execute("UPDATE tenants SET plan = %s WHERE id = %s", (body.plan, tid))
        db.execute("""INSERT INTO audit_log (actor_id, tenant_id, action, target, before, after, reason, correlation_id)
                      VALUES (%s, %s, 'tenant.plan.set', %s, %s, %s, %s, %s)""",
                   (admin.id, tid, tid, json.dumps(before), json.dumps(body.plan), body.reason, ctx.correlation_id))
```

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM app_role;
```

**Prove it:** Perform each admin action on staging and find its audit row; attempt an `UPDATE` on `audit_log` as the application role and see it rejected.
**Size for now:** Append-only audit table for admin, support and flag actions. Shipping audit logs to a separate immutable store when a customer or certification requires it.

### OPS-13 Async work falls behind silently

**How it fails:** A queue consumer crashes or slows down. Producers keep enqueuing and the HTTP layer looks healthy, but messages wait for hours. Failed messages go to a dead-letter queue that nobody watches. Users experience "the bot stopped answering" and the system's dashboards are green.
**Seen in the wild:** No verified incident cited; queue services expose the needed signals directly, for example Amazon SQS's `ApproximateAgeOfOldestMessage` ("the age of the oldest unprocessed message in the queue") (Sources 16).
**Spot it in a plan:** Queues or scheduled jobs with no lag metric or DLQ alert.
**Spot it in code:** Consumers without metrics; DLQs configured but not alarmed; cron jobs with no "last success" timestamp.
**Build it right:** For each queue, alert on age of oldest message against the journey's latency budget (a symptom close to the user), and on DLQ depth above zero for queues where any loss matters. For scheduled jobs, record last successful run and alert when it is older than the schedule plus a margin. Include these on the first-look dashboard (OPS-05) and in runbooks with redrive instructions.

Dangerous:
```sql
-- job table, no visibility
SELECT count(*) FROM jobs WHERE status = 'queued';  -- looked at by hand when someone complains
```

Safe:
```sql
-- exported as metrics every 30 s
SELECT kind,
       count(*) FILTER (WHERE status = 'queued')                                   AS queued,
       coalesce(extract(epoch FROM now() - min(enqueued_at) FILTER (WHERE status = 'queued')), 0) AS oldest_age_s,
       count(*) FILTER (WHERE status = 'dead')                                     AS dead
FROM jobs GROUP BY kind;
-- alerts: oldest_age_s > journey budget for 5 min (page); dead > 0 (ticket, or page for payments)
```

**Prove it:** Stop the consumer on staging: the age alert fires within the stated time. Push a poison message: it lands in the dead-letter state and a ticket or page is created.
**Size for now:** Oldest-age and DLQ alerts on every queue, last-success alerts on every scheduled job. Autoscaling consumers on lag later.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "We can grep the logs" | Unstructured logs without a shared id across hops cannot be joined reliably | Correlation id and structured logs (OPS-01) |
| "Our error rate is low" | Aggregate HTTP errors miss failures that happen after a 200 and per-tenant breakage | Journey SLIs from the user's side and an outcome ledger (OPS-02, OPS-03) |
| "Alert on everything to be safe" | Noisy pages get ignored, which is how real ones are missed | Page on SLO burn, dashboard the causes (OPS-04) |
| "We can revert if needed" | A revert plus a full deploy takes too long during an incident, and may be unsafe after a migration | Runtime kill switch and expand/contract migrations (OPS-08, OPS-11) |
| "It passed staging" | Staging lacks production traffic, data sizes and tenants | Staged rollout with automatic rollback (OPS-09) |
| "Config is not code" | Bad config takes the whole fleet down at once | Validate at startup and stage config changes (OPS-10) |
| "Only our staff use the admin panel" | Staff actions are exactly what customers and auditors ask about | Append-only audit in the same transaction (OPS-12) |
| "The queue will catch up" | Nobody knows it is behind until users complain | Alert on age of oldest message (OPS-13) |

## Attack recipes

1. **Trace one request.** Trigger a Slack mention on staging, then query logs by its correlation id. Missing lines from any service or job means OPS-01 failed.
2. **Silent delivery failure.** Remove the bot from the target channel so `chat.postMessage` returns `not_in_channel`. No `failed` row with that reason in the outcome table, or no SLI drop, means OPS-02 or OPS-03 failed.
3. **Burn the budget.** Inject failures into 20% of summaries for 10 minutes. No page, or a page without a runbook link, means OPS-04 or OPS-07 failed. Then run CPU to 90% with no user impact: a page means OPS-04 failed.
4. **Kill switch drill.** Flip the feature flag off during traffic. New work still starting after the stated cache interval, or a user-facing error instead of the defined message, means OPS-08 failed.
5. **Bad build.** Push a build that fails 10% of requests through the pipeline. Reaching more than the canary stage, or needing a human to roll back, means OPS-09 failed.
6. **Bad config.** Start a service with a required variable missing, and push a malformed runtime config. A service that starts, or instances that adopt the bad config, means OPS-10 failed.
7. **Lock under load.** Run the migration against a production-sized copy with load. Query waits beyond `lock_timeout`, or the previous code version failing after migration, means OPS-11 failed.
8. **Who changed it?** Change a tenant's plan through the admin API, then try to `UPDATE audit_log` as the app role. No audit row, or a successful update, means OPS-12 failed.
9. **Stalled consumer.** Stop a queue consumer for longer than the journey's budget. No alert on oldest message age means OPS-13 failed.

## Sources

1. OpenTelemetry, "Context propagation." https://opentelemetry.io/docs/concepts/context-propagation/
2. Google SRE Book, "Monitoring Distributed Systems." https://sre.google/sre-book/monitoring-distributed-systems/
3. Google SRE Book, "Service Level Objectives." https://sre.google/sre-book/service-level-objectives/
4. U.S. Securities and Exchange Commission, press release 2013-222 on Knight Capital. https://www.sec.gov/newsroom/press-releases/2013-222
5. Google SRE Workbook, "Alerting on SLOs." https://sre.google/workbook/alerting-on-slos/
6. Slack Engineering, "Deploys at Slack." https://slack.engineering/deploys-at-slack/
7. Google SRE Book, "Being On-Call." https://sre.google/sre-book/being-on-call/
8. Cloudflare blog, post-incident report for the 18 November 2025 outage. https://blog.cloudflare.com/18-november-2025-outage/
9. martinfowler.com, "Feature Toggles (aka Feature Flags)." https://martinfowler.com/articles/feature-toggles.html
10. Amazon Builders' Library, "Automating safe, hands-off deployments." https://builder.aws.com/content/3ErTKQOTKc5NIw031UePBPxTQ6I/automating-safe-hands-off-deployments
11. CrowdStrike, "Channel File 291 Incident Root Cause Analysis," 6 August 2024. https://www.crowdstrike.com/wp-content/uploads/2024/08/Channel-File-291-Incident-Root-Cause-Analysis-08.06.2024.pdf
12. Google SRE Workbook, "Canarying Releases." https://sre.google/workbook/canarying-releases/
13. PostgreSQL documentation, "ALTER TABLE." https://www.postgresql.org/docs/current/sql-altertable.html
14. PostgreSQL documentation, "Client Connection Defaults." https://www.postgresql.org/docs/current/runtime-config-client.html
15. OWASP Cheat Sheet Series, "Logging Cheat Sheet." https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
16. Amazon SQS Developer Guide, "Available CloudWatch metrics for Amazon SQS." https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html
