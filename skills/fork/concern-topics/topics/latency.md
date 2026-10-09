# Latency

**Protects:** Each step of a user journey responds within a budget the user and the platform will accept, at the tail and not just on average, and slow dependencies degrade the experience instead of breaking it.
**Read when:** The plan has a user waiting on a response, a third-party platform with a response deadline (Slack, webhook providers, Pub/Sub, queues), an LLM call, a fan-out to several services or rows, a cache, a serverless or scale-to-zero runtime, or words like "real-time", "instant", "fast", "slow", "timeout". In code: `await` inside loops, HTTP clients without timeouts, `ack()` placement, `max_tokens`, `stream`, cache `get`/`set`, `min-instances`, `statement_timeout`.
**Prefix:** LAT

## Design questions

1. What is the latency budget for each journey step at p50 and p99, written as a number, and who set it (user expectation, platform deadline)? (LAT-01)
2. Which platform deadline applies to each inbound call (Slack 3 s, GitHub 10 s, Stripe "quickly", Pub/Sub ack deadline), and what is the slowest thing done before responding? (LAT-02)
3. After acknowledging, where does the remaining work run, and what guarantees it runs if the process is frozen, scaled to zero or restarted? (LAT-03)
4. Which percentiles are measured per step, and from what: histograms or averages? (LAT-04)
5. How many backends does one user request touch in parallel, and what is each one's p99? (LAT-05)
6. Which calls in this path are independent but issued one after another? (LAT-06)
7. Is an LLM call on the path where the user is waiting, and if so is it streamed, bounded by `max_tokens`, and sized to the smallest model that passes evals? (LAT-07)
8. What is the timeout on every outbound call, and do the timeouts add up to less than the step's budget? (LAT-08)
9. Where in the stack are retries done, how many, and do they fit inside the remaining deadline? (LAT-09)
10. What does a cold start cost on this runtime, how often does it happen, and is it in the path of a deadline? (LAT-10)
11. For each cache: what is the key, what invalidates it, how stale can it be, and what happens when many requests miss at once? (LAT-11)
12. What measurement shows where time goes today, before anyone optimizes? (LAT-12)

## Categories

### LAT-01 No budget per journey step

**How it fails:** Nobody writes down how long each step may take. Every component author adds "just one more call". The end-to-end time drifts from 800 ms to 6 s over a quarter, and nobody can say which change broke it because nothing was ever over a stated limit.
**Seen in the wild:** No verified incident; failure follows from unbounded composition of latencies. The SRE book recommends SLOs on percentiles of a user-facing indicator rather than on averages (Sources 1).
**Spot it in a plan:** "Should be fast." Latency mentioned only for the whole feature, or not at all. Multiple dependencies in one step with no per-call allotment.
**Spot it in code:** No latency histogram per step; timeouts set to library defaults; no deadline passed down the call chain.
**Build it right:** Put a table in the plan: journey step, p50 target, p99 target, hard deadline, and the allotment for each dependency inside it. Derive allotments from measured dependency latency (LAT-12). Enforce the hard deadline in code with a deadline object passed down (LAT-08) and alert when the step's p99 exceeds its target (OPS-03).

Dangerous:
```markdown
Step 2: bot replies with a summary. Should be quick.
```

Safe:
```markdown
| Step | p50 | p99 | Hard deadline | Inside it |
|---|---|---|---|---|
| 2a Slack ack | 150 ms | 800 ms | 3 s (Slack) | verify sig 5 ms, insert job 20 ms |
| 2b "working" message visible | 500 ms | 1.5 s | none | chat.update |
| 2c summary posted | 6 s | 20 s | 60 s then "taking longer" message | thread fetch 400 ms, LLM 5 s p50, post 300 ms |
```

**Prove it:** A dashboard or query showing each step's measured p50 and p99 next to its budget, from staging load or production.
**Size for now:** Budgets for the user-facing steps and the platform-deadline steps. Per-function budgets inside a service are not needed.

### LAT-02 Platform deadlines missed

**How it fails:** An inbound request from a platform does real work before responding. On a slow day it crosses the platform's deadline. The platform shows the user an error, or marks the delivery failed and retries it, so the work runs twice and the next delivery queues behind it. For Pub/Sub, a handler that runs past the ack deadline gets the same message redelivered while it is still working.
**Seen in the wild:** Slack requires acknowledging interactions within 3 seconds and shows the user an error otherwise (Sources 2). GitHub expects a 2XX within 10 seconds and marks slower deliveries failed (Sources 3). Stripe says to return 2xx before any complex logic that could cause a timeout (Sources 4). Pub/Sub's ack deadline defaults to 10 seconds (range 10 to 600 seconds) and an unacknowledged message is sent again after it (Sources 5).
**Spot it in a plan:** "On webhook, we fetch X, call the LLM, and update Y." Any inbound platform call whose handler does more than validate and persist.
**Spot it in code:** Webhook handlers with several `await`s before `res.status(200)`; Bolt `ack()` after other awaits; Pub/Sub handlers doing long work with default flow control and no deadline extension settings.
**Build it right:** Ack-then-work: verify the signature, persist the event (or enqueue it) with its provider id as an idempotency key, respond, then process from the queue. For Pub/Sub, keep processing under the ack deadline or configure the client library's ack extension settings, and make the handler idempotent because redelivery can happen anyway (Sources 5).

Dangerous:
```ts
app.post("/webhooks/github", verifySig, async (req, res) => {
  const pr = await github.pulls.get(req.body.pull_request.number);
  const review = await llm.review(pr);              // 10-40 s
  await github.issues.createComment({ body: review });
  res.sendStatus(200);
});
```

Safe:
```ts
app.post("/webhooks/github", verifySig, async (req, res) => {
  const deliveryId = req.header("X-GitHub-Delivery")!;
  await db.query(
    `INSERT INTO inbound_events (provider, delivery_id, payload)
     VALUES ('github', $1, $2) ON CONFLICT (provider, delivery_id) DO NOTHING`,
    [deliveryId, req.body],
  );
  res.sendStatus(202);
  // a worker polls inbound_events (or is notified) and does the slow part
});
```

**Prove it:** Inject 5 s of latency into the LLM client on staging and deliver a webhook: the response is still under 500 ms and the work completes later exactly once.
**Size for now:** Every platform-facing endpoint is ack-then-work from day one. It costs a table and a worker.

### LAT-03 Ack-then-work done unsafely

**How it fails:** The handler responds and then continues with `void doWork()` in the same process. On a request-billed serverless runtime the CPU is withdrawn after the response, so the work stalls or never runs. On a normal server, a deploy or crash between response and completion loses it, and since the platform already got its 200 it never retries. The user waits forever.
**Seen in the wild:** Cloud Run's request-based billing allocates CPU only during request processing, and Google points to instance-based billing or Cloud Tasks for background work (Sources 6). No verified incident cited.
**Spot it in a plan:** "Respond immediately and process in the background" with no durable queue named.
**Spot it in code:** `res.send(...); await work()`; `void promise` or `.catch(() => {})` after the response; `setImmediate`/`process.nextTick` work; Python `BackgroundTasks` for anything that must not be lost; `threading.Thread(...).start()` in a handler.
**Build it right:** Persist the intent before acknowledging (database row or durable queue message), then acknowledge. A worker with retries and a dead-letter path does the work. In-process background tasks are acceptable only for work whose loss is harmless (a metrics flush).

Dangerous:
```python
@app.post("/slack/commands")
async def command(req: Request, background: BackgroundTasks):
    form = await req.form()
    background.add_task(run_summary, form["channel_id"], form["text"])  # lost on restart
    return {"response_type": "ephemeral", "text": "On it"}
```

Safe:
```python
@app.post("/slack/commands")
async def command(req: Request):
    form = await req.form()
    await jobs.enqueue(                      # durable: Postgres table or managed queue
        kind="summary",
        idempotency_key=form["trigger_id"],
        payload={"channel": form["channel_id"], "text": form["text"],
                 "response_url": form["response_url"]},
    )
    return {"response_type": "ephemeral", "text": "On it"}
```

**Prove it:** Accept a request on staging, then kill the process 100 ms after the response. The work still completes after restart.
**Size for now:** A Postgres-backed job table with a polling worker is enough for an enterprise v1. A dedicated queue service can wait for throughput that needs it.

### LAT-04 Averages hide the tail

**How it fails:** The dashboard shows mean latency of 300 ms and everyone is happy. One request in a hundred takes 8 s, and an active user who makes 50 requests a session hits it most sessions. Means also move little when a small set of tenants degrades badly.
**Seen in the wild:** The SRE book warns that a 100 ms average can hide requests taking seconds and recommends latency histograms; its SLO chapter says high percentiles such as the 99th show plausible worst case where averages hide it (Sources 1, 7).
**Spot it in a plan:** "Average response time under X."
**Spot it in code:** Gauges or summaries recording a mean; `avg(duration)` in dashboard queries; logs with durations but no histogram metric.
**Build it right:** Record latency as a histogram per step with buckets around the budget, and chart p50, p95, p99. Slice by tenant for the top tenants. Alert on percentile against budget, not on mean.

Dangerous:
```sql
SELECT date_trunc('hour', at) AS h, avg(duration_ms) FROM request_log GROUP BY 1;
```

Safe:
```sql
SELECT date_trunc('hour', at) AS h,
       percentile_cont(0.5)  WITHIN GROUP (ORDER BY duration_ms) AS p50,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99,
       count(*) AS n
FROM request_log
WHERE route = 'summarize'
GROUP BY 1 ORDER BY 1;
```

**Prove it:** The step's dashboard shows p99 and p50 separately, and a deliberately slowed 1% of requests on staging moves p99 visibly while the mean barely moves.
**Size for now:** p50 and p99 per user-facing step. Per-tenant percentiles for the largest tenants only.

### LAT-05 Fan-out multiplies the tail

**How it fails:** One user request fans out to many backends (one call per connected integration, per document chunk, per shard) and waits for all. Each backend is "fast at p99", but the request waits for the slowest of many, so the request's typical latency becomes the backends' tail latency.
**Seen in the wild:** "The Tail at Scale" shows that if each server has a 1 second p99 and a request needs 100 of them in parallel, 63% of user requests take more than one second; a hedged request after 10 ms cut a p99.9 from 1,800 ms to 74 ms with about 2% extra requests (Sources 8).
**Spot it in a plan:** "Query all connected sources and merge." Per-item calls to an external API for a list view.
**Spot it in code:** `Promise.all(items.map(callRemote))`; `asyncio.gather(*[... for x in big_list])`; `errgroup` over unbounded slices.
**Build it right:** Bound the fan-out (batch APIs, fewer larger calls). Give each branch a deadline below the step's budget and return partial results with a visible "some sources did not respond" state (UJ-04) rather than waiting for the slowest. Hedge only idempotent reads, and only after the branch's p95.

Dangerous:
```ts
const results = await Promise.all(sources.map((s) => s.search(query)));
return merge(results);
```

Safe:
```ts
const settled = await Promise.allSettled(
  sources.map((s) => s.search(query, { signal: AbortSignal.timeout(1200) })),
);
const ok = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
return { results: merge(ok), missing: sources.length - ok.length };
```

**Prove it:** Make one of N sources slow on staging: the request returns at the branch deadline with partial results and a visible note.
**Size for now:** Per-branch deadlines and partial results. Hedged requests only after measurement shows a tail problem worth the extra load.

### LAT-06 Sequential calls that should be parallel

**How it fails:** Independent calls are written one after another, often `await` inside a loop or an ORM lazy load per row (N+1). The latency is the sum instead of the max. Ten 200 ms calls make a 2 s step.
**Seen in the wild:** No verified incident; failure follows from sequential `await` semantics in JavaScript and Python.
**Spot it in a plan:** "For each X, fetch Y."
**Spot it in code:** `for (...) { await ... }`; `for x in xs: await ...`; ORM attribute access inside a loop over query results (Django without `select_related`/`prefetch_related`, SQLAlchemy default lazy loading); Go loops calling a client without goroutines.
**Build it right:** Issue independent calls concurrently with a concurrency limit, or replace per-item calls with one batched query. In SQL, fetch related rows with a join or `WHERE id = ANY($1)`. Keep a limit so parallelism does not exhaust connection pools or third-party rate limits.

Dangerous:
```python
async def enrich(user_ids):
    out = []
    for uid in user_ids:
        out.append(await crm.get_contact(uid))   # 200 ms each, sequential
    return out
```

Safe:
```python
async def enrich(user_ids, limit=8):
    sem = asyncio.Semaphore(limit)
    async def one(uid):
        async with sem:
            return await asyncio.wait_for(crm.get_contact(uid), timeout=1.5)
    return await asyncio.gather(*(one(u) for u in user_ids), return_exceptions=True)
```

**Prove it:** A test that counts outbound calls or SQL statements for a list of 50 items (for example a query counter asserting at most 2 queries), plus a timing on staging before and after.
**Size for now:** Fix N+1 and obvious sequential loops on user-facing paths. Leave batch jobs alone unless they miss their window.

### LAT-07 Synchronous LLM call where the user waits

**How it fails:** A request handler calls an LLM, waits for the full completion, then returns. Generation takes 5 to 40 seconds depending on output length. Proxies and platform deadlines cut it off, the user sees nothing until the end, and a long `max_tokens` makes the worst case worse.
**Seen in the wild:** Anthropic documents streaming as the way to keep long requests alive and notes that its SDKs require streaming for large `max_tokens` values to avoid HTTP timeouts; its latency guide separates time to first token from total latency and recommends choosing a faster model, limiting output length and streaming (Sources 9, 10).
**Spot it in a plan:** "Call the model and return the answer" in a request path; chat UX with no partial output.
**Spot it in code:** `messages.create(` (non-streaming) inside a web handler; large `max_tokens`; no timeout on the client; LLM call before a Slack `ack()`.
**Build it right:** Where the user is watching (web chat), stream tokens to the client and show the first token quickly. Where the platform has a deadline (Slack, webhooks), move the call to a job (LAT-02) and update the message when done, optionally in chunks. Bound `max_tokens` to what the answer needs. Use the smallest model that passes the task's evals (COST-08). Set a client timeout that fits the step's hard deadline, and design the "taking longer than usual" state.

Dangerous:
```python
@app.post("/ask")
def ask(q: Question):
    msg = client.messages.create(model=MODEL, max_tokens=8000,
                                 messages=[{"role": "user", "content": q.text}])
    return {"answer": msg.content[0].text}
```

Safe:
```python
@app.post("/ask")
def ask(q: Question):
    def gen():
        with client.messages.stream(model=MODEL, max_tokens=1024,
                                    messages=[{"role": "user", "content": q.text}]) as stream:
            for text in stream.text_stream:
                yield f"data: {json.dumps({'t': text})}\n\n"
        yield "event: done\ndata: {}\n\n"
    return StreamingResponse(gen(), media_type="text/event-stream")
```

**Prove it:** Measure time to first visible output and total time at p50 and p99 on staging with realistic prompts; kill the upstream mid-stream and confirm the UI shows an error state, not a frozen partial answer.
**Size for now:** Streaming for interactive chat, jobs for platform-triggered calls, a bounded `max_tokens`. Speculative or cached answers can wait.

### LAT-08 Timeouts missing or outside the budget

**How it fails:** An outbound call has no timeout. The dependency hangs, the request holds a worker, a connection and a database transaction until something else gives up. Or every layer has its own 30 s default, so a 3 s budget is guarded by timeouts ten times larger.
**Seen in the wild:** The Python `requests` docs state that by default requests do not time out unless a timeout is set explicitly and may hang for minutes; PostgreSQL's `statement_timeout` and `lock_timeout` default to 0, which disables them (Sources 11, 12). AWS recommends deriving timeouts from the downstream service's latency percentiles, such as p99.9 for a 0.1% false-timeout rate (Sources 13).
**Spot it in a plan:** No timeout values. "Retry on failure" without a deadline.
**Spot it in code:** `requests.get(url)` with no `timeout=`; `fetch(url)` without `signal`; `http.Client{}` without `Timeout` in Go; database pools with no `statement_timeout`; LLM clients with default timeouts.
**Build it right:** Every outbound call has a timeout set from measured latency, and the sum along the critical path fits the step's hard deadline. Pass a deadline down (Go `context.WithTimeout`, `AbortSignal` in Node, a remaining-time value in Python) so inner calls use what is left, not a fresh full timeout. Set `statement_timeout` per role or per transaction for request paths.

Dangerous:
```go
resp, err := http.Get(crmURL + "/contacts/" + id) // default client: no timeout
```

Safe:
```go
ctx, cancel := context.WithTimeout(r.Context(), 800*time.Millisecond)
defer cancel()
req, _ := http.NewRequestWithContext(ctx, http.MethodGet, crmURL+"/contacts/"+id, nil)
resp, err := httpClient.Do(req) // httpClient has Timeout set as a backstop
```

```sql
ALTER ROLE app_web SET statement_timeout = '2s';
ALTER ROLE app_web SET lock_timeout = '500ms';
```

**Prove it:** Point a dependency at a blackhole (a port that accepts and never responds) on staging: the request fails at its budget with a defined user-facing state, and no workers stay stuck.
**Size for now:** Timeouts on every outbound call and database role. Full deadline propagation across services when there is more than one hop.

### LAT-09 Retries that blow the budget

**How it fails:** A client retries three times with exponential backoff, each attempt with a 10 s timeout, inside a step whose budget is 3 s. Or several layers each retry, multiplying load on a struggling dependency and pushing latency further out.
**Seen in the wild:** AWS's Builders' Library describes a five-deep stack with three retries per layer multiplying load on the bottom layer by about 243, and recommends retrying at a single point in the stack, a local token bucket for retries, and jitter on backoff (Sources 13).
**Spot it in a plan:** "Retry on failure" at several layers. Retries inside a synchronous request path.
**Spot it in code:** SDK default retries plus an app-level `retry` decorator plus a queue redelivery; `tenacity` / `p-retry` without a stop condition based on elapsed time.
**Build it right:** Pick one layer to retry. In a synchronous path, retry only if the remaining deadline allows another full attempt, and only idempotent operations. Use jittered backoff and a retry budget. Push long retry schedules into the job queue, not the request.

Dangerous:
```ts
const res = await pRetry(() => crm.get(id), { retries: 5 }); // inside a 3 s Slack-bound path
```

Safe:
```ts
async function withDeadline<T>(fn: (s: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
  let attempt = 0;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining < 300) throw new DeadlineExceeded();
    try {
      return await fn(AbortSignal.timeout(Math.min(800, remaining)));
    } catch (e) {
      if (!isRetryable(e) || ++attempt >= 2) throw e;
      await sleep(Math.random() * 100 * 2 ** attempt); // full jitter
    }
  }
}
```

**Prove it:** Make the dependency fail 50% of requests on staging: the step still returns within its hard deadline, and dependency request rate rises by at most the retry budget.
**Size for now:** One retry layer and deadline-aware retries on synchronous paths. Adaptive retry budgets can wait.

### LAT-10 Cold starts in a deadline path

**How it fails:** A scale-to-zero service receives the first Slack interaction of the morning. Container start, runtime boot, loading a large model client and opening database connections take several seconds. The 3 s ack deadline is missed and the user sees an error, on exactly the first impression of the day.
**Seen in the wild:** AWS documents Lambda cold starts as typically under 1% of invocations, lasting from under 100 ms to over 1 second, with an Init phase limited to 10 seconds, and recommends provisioned concurrency for predictable start times (Sources 14). Cloud Run's minimum instances keep containers warm to avoid slow start times, at the cost of billing for those instances (Sources 15).
**Spot it in a plan:** Serverless or scale-to-zero for a platform-facing endpoint. Low traffic with a strict deadline.
**Spot it in code:** Heavy imports or client construction at module load in a function that serves acks; `min-instances` 0 on the ack service; large container images.
**Build it right:** Keep the ack endpoint small and separate from heavy workers, so its cold start is short. Set minimum instances (or provisioned concurrency) to at least one for services that must meet a platform deadline. Lazy-load heavy clients in workers, not in the ack path. Measure cold start time explicitly.

Dangerous:
```yaml
# cloud run service handling Slack interactions and running the LLM pipeline
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "0"
```

Safe:
```yaml
# small ack service: verifies, enqueues, responds
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/minScale: "1"
# heavy worker service runs separately and may scale to zero
```

**Prove it:** Scale the ack service to zero on staging, wait, then send a Slack interaction: the ack still lands under 3 s. Record cold start time.
**Size for now:** One warm instance for deadline-bound endpoints. Snapshot-based start (such as SnapStart) only if measurement shows it is needed.

### LAT-11 Caching with wrong invalidation

**How it fails:** A cache added for speed serves stale data after the source changed: a revoked permission still allowed, a renamed channel still shown, a price from last week. Or the key omits the tenant and one tenant sees another's data. Or a hot key expires and every request goes to the database at once.
**Seen in the wild:** In September 2010 Facebook's system for correcting invalid cached configuration values hit a value that was invalid in the persistent store itself; every client deleted its cache key and queried the database, creating a feedback loop that only stopped when the site was taken offline (Sources 16).
**Spot it in a plan:** "We will cache X" with no invalidation rule, no staleness bound, no tenant in the key.
**Spot it in code:** `cache.set(key, value)` with no TTL; keys built without tenant id; writes to the source that do not touch the cache; `@lru_cache` on functions that read mutable data.
**Build it right:** For each cache write down: key (including tenant and every input that changes the value), TTL as the maximum acceptable staleness, and the events that delete it. Invalidate on write in the same module that owns the data. Never cache authorization decisions longer than the revocation SLA. Protect hot keys with request coalescing so one miss triggers one load.

Dangerous:
```ts
async function getChannelName(channelId: string) {
  const hit = await redis.get(`chan:${channelId}`);
  if (hit) return hit;
  const name = await slack.conversations.info({ channel: channelId }).then((r) => r.channel!.name!);
  await redis.set(`chan:${channelId}`, name);   // no TTL, no tenant, never invalidated
  return name;
}
```

Safe:
```ts
const inflight = new Map<string, Promise<string>>();
async function getChannelName(teamId: string, channelId: string) {
  const key = `chan:v1:${teamId}:${channelId}`;
  const hit = await redis.get(key);
  if (hit) return hit;
  if (!inflight.has(key)) {
    inflight.set(key, (async () => {
      const r = await slack.conversations.info({ channel: channelId });
      await redis.set(key, r.channel!.name!, { EX: 600 }); // 10 min max staleness
      return r.channel!.name!;
    })().finally(() => inflight.delete(key)));
  }
  return inflight.get(key)!;
}
// channel_rename event handler: await redis.del(`chan:v1:${teamId}:${channelId}`)
```

**Prove it:** Change the source on staging and read through the cache: the new value appears within the stated bound. Expire a hot key under load: database queries for it stay at one per instance.
**Size for now:** Caches only where measurement shows the need, each with key, TTL and invalidation written down. A shared cache library can wait.

### LAT-12 Optimizing without measuring

**How it fails:** Engineers guess where time goes and optimize the wrong thing (rewriting a 5 ms function while a 2 s sequential loop sits next door). Or a latency regression ships and no one notices because there is no per-step timing.
**Seen in the wild:** No verified incident; the SRE book's monitoring chapter recommends bucketed latency histograms to see where requests actually fall (Sources 7).
**Spot it in a plan:** "We will make it faster by ..." with no current numbers.
**Spot it in code:** No spans or timings around external calls; benchmarks on empty databases.
**Build it right:** Instrument each step and each external call with a span or a timing (OPS-06). Measure on realistic data sizes and from the user's side (time to visible feedback). Optimize the largest contributor first, then re-measure. Keep a latency check in CI or staging for the main journeys.

Dangerous:
```python
def handle(req):
    a = fetch_thread(req)
    b = summarize(a)
    post(b)
```

Safe:
```python
def handle(req):
    with tracer.start_as_current_span("fetch_thread"):
        a = fetch_thread(req)
    with tracer.start_as_current_span("llm.summarize") as s:
        b = summarize(a)
        s.set_attribute("llm.output_tokens", b.usage.output_tokens)
    with tracer.start_as_current_span("slack.post"):
        post(b)
```

**Prove it:** A trace of one real request on staging shows the breakdown by step, and the optimization's before and after numbers are in the PR.
**Size for now:** Spans on external calls and per-step histograms. Continuous profiling can wait.

### LAT-13 Per-request setup cost

**How it fails:** Each request constructs a new HTTP client, opens a new TLS connection, or opens a new database connection. Setup dominates small requests, and under load the database runs out of connections.
**Seen in the wild:** No verified incident; failure follows from connection setup costs (TCP and TLS handshakes, PostgreSQL backend process per connection).
**Spot it in a plan:** Serverless functions talking directly to PostgreSQL with no pooler.
**Spot it in code:** `new Client()` / `psycopg.connect(` / `httpx.Client()` / `new Anthropic()` inside a handler; `requests.get` (no session) in hot loops.
**Build it right:** Create clients and pools once per process and reuse them with keep-alive. Put a connection pooler in front of PostgreSQL when the number of processes can exceed what the database allows. Size pools from the database's connection limit divided by instances.

Dangerous:
```ts
export async function handler(evt: Event) {
  const db = new pg.Client(process.env.DATABASE_URL);
  await db.connect();
  const r = await db.query("SELECT ...");
  await db.end();
  return r.rows;
}
```

Safe:
```ts
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
export async function handler(evt: Event) {
  const r = await pool.query("SELECT ...");
  return r.rows;
}
```

**Prove it:** Load test at expected peak on staging and record connection counts and p99; setup time no longer appears as a separate span per request.
**Size for now:** Process-level clients and pools. A dedicated pooler when instance count times pool size approaches the database limit.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "Average latency is fine" | Averages hide the requests users remember | Track p99 against a budget (LAT-04) |
| "The model is just slow" | Model choice, output length and streaming are all design choices | Bound tokens, stream, pick the smallest passing model (LAT-07) |
| "We respond right after, in the background" | Background work in the request process is lost on restart or CPU throttling | Persist then acknowledge (LAT-03) |
| "The library has a default timeout" | Several common clients default to none | Set an explicit timeout from measured latency (LAT-08) |
| "Retries make it reliable" | Retries in a synchronous path spend the deadline and multiply load | One retry layer, deadline-aware (LAT-09) |
| "Cold starts are rare" | They land on the first request after quiet periods, which is a user's first impression | Keep deadline-bound endpoints warm and small (LAT-10) |
| "We'll cache it" | A cache without invalidation is a correctness bug with a delay | Key, TTL and invalidation written down (LAT-11) |
| "We know where the time goes" | Guesses are often wrong | Trace first (LAT-12) |

## Attack recipes

1. **Slow LLM.** Add 5 s latency to the LLM client on staging and trigger the Slack action and the webhook. A Slack error shown to the user, or a webhook response over 1 s, means LAT-02 failed.
2. **Kill after ack.** Kill the process 100 ms after a 200 is returned for an event. Work that never completes after restart means LAT-03 failed.
3. **Blackhole dependency.** Route a dependency to a host that accepts connections and never answers. Requests that do not fail at their budget, or workers stuck afterwards, mean LAT-08 failed.
4. **Flaky dependency.** Make a dependency fail 50% of calls. Step latency beyond the hard deadline, or dependency traffic more than double, means LAT-09 failed.
5. **One slow branch.** Make one of N fan-out sources sleep 10 s. A response that waits for it means LAT-05 failed.
6. **Cold morning.** Scale the ack service to zero, wait past the idle timeout, send an interaction. An ack over 3 s means LAT-10 failed.
7. **Stale cache.** Rename a channel or revoke a permission, then read through the cached path. The old value beyond the stated staleness bound means LAT-11 failed.
8. **N+1 count.** Run the list endpoint with 50 items and count SQL statements and outbound calls. Count proportional to items means LAT-06 failed.

## Sources

1. Google SRE Book, "Service Level Objectives." https://sre.google/sre-book/service-level-objectives/
2. Slack Developer Docs, "Handling user interaction." https://docs.slack.dev/interactivity/handling-user-interaction
3. GitHub Docs, "Best practices for using webhooks." https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
4. Stripe Docs, "Receive Stripe events in your webhook endpoint." https://docs.stripe.com/webhooks
5. Google Cloud, Pub/Sub "Subscription properties" (ack deadline). https://docs.cloud.google.com/pubsub/docs/subscription-properties
6. Google Cloud, Cloud Run "Billing settings" (CPU allocation). https://docs.cloud.google.com/run/docs/configuring/billing-settings
7. Google SRE Book, "Monitoring Distributed Systems." https://sre.google/sre-book/monitoring-distributed-systems/
8. Jeffrey Dean and Luiz André Barroso, "The Tail at Scale," Communications of the ACM, 2013. https://cacm.acm.org/research/the-tail-at-scale/
9. Anthropic, "Streaming Messages." https://platform.claude.com/docs/en/build-with-claude/streaming
10. Anthropic, "Reducing latency." https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency
11. Requests documentation, "Advanced Usage: Timeouts." https://requests.readthedocs.io/en/latest/user/advanced/
12. PostgreSQL documentation, "Client Connection Defaults" (`statement_timeout`, `lock_timeout`). https://www.postgresql.org/docs/current/runtime-config-client.html
13. Amazon Builders' Library, "Timeouts, retries, and backoff with jitter." https://builder.aws.com/content/3EumjoZascWd1oZiEgL8ORlv3qE/timeouts-retries-and-backoff-with-jitter
14. AWS Lambda Developer Guide, "Lambda execution environment lifecycle." https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html
15. Google Cloud, Cloud Run "Set minimum instances." https://docs.cloud.google.com/run/docs/configuring/min-instances
16. "More details on today's outage," Facebook Engineering, 23 September 2010. https://engineering.fb.com/2010/09/23/uncategorized/more-details-on-today-s-outage/
