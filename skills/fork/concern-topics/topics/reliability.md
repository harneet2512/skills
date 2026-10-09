# Reliability

**Protects:** When a dependency is slow, failing, rate limiting or returning ambiguous results, and when our own processes crash, restart or deploy mid-flow, every operation still ends in a known state: done once, cleanly failed and visible, or queued for a bounded retry. Failures stay contained instead of spreading, and the user is told the truth about what happened.
**Read when:** The plan calls another service or API (LLM, email, Slack, CRM, payments, internal services), consumes a queue or webhook, runs background jobs, has a multi-step flow, adds a retry, fallback, health check or "graceful" anything, or ships with a deploy that restarts workers. In code: `fetch(`, `axios`, `requests.`, `httpx`, `http.Client`, SDK clients, `retry`, `backoff`, `catch` around network calls, `receive_message`, `ack`, `SIGTERM`, `/health`, `setTimeout` loops, `while True:` workers.
**Prefix:** REL

## Design questions

1. For every outbound call: what is the timeout (connect and total), how was the number chosen, and what does the caller do when it fires?
2. What is the end-to-end deadline for the user's request, and do the inner timeouts fit inside it with room left for a useful error?
3. Which failures are retried, by which layer only, how many times, with what backoff and jitter, and is the operation idempotent (or made so with a key) before it is retried?
4. What caps the total retry volume when a dependency is down for everyone at once?
5. For each third-party API: what are its documented limits, how does it signal them (429, `Retry-After`, error codes), and what happens to work that cannot be sent now?
6. When a call times out after the other side may have done the work, how does the system find out what actually happened before acting again?
7. For each consumer: when is a message acknowledged relative to the commit of its effects, and what happens if processing takes longer than the visibility or ack timeout?
8. What happens to a message or job that fails every time, who is told, and how is it replayed after a fix?
9. If the process dies between any two steps of this flow, which state is persisted, and which job finds and finishes or reverts the half-done work?
10. On `SIGTERM` during a deploy, what happens to in-flight requests, claimed jobs and open transactions, and does it all finish inside the platform's grace period?
11. What do the health checks test, and could a single shared dependency failing mark every instance unhealthy at once?
12. When a dependency is down, what exactly does the user see, and is it honest (stale data labeled stale, actions queued labeled queued)?

## Categories

### REL-01 A timeout on every outbound call

**How it fails:** A call with no timeout waits as long as the remote side or the network keeps the connection open. Under a slow dependency, every request that touches it hangs, holding a worker, a thread, a database connection or a row lock, until the pool is exhausted and requests that never touch the dependency fail too. Many defaults are "no timeout" or very long: Python `requests` does not time out unless a timeout is set, and its docs warn code can hang for minutes or more [4]; Go's `http.Client` treats a zero `Timeout` as no timeout, and `http.DefaultClient` is a zero-value client [5]; Node's built-in `fetch` is built on undici, whose `headersTimeout` and `bodyTimeout` default to 300 seconds each [6].
**Seen in the wild:** No verified incident specific to a missing client timeout; the failure follows from the documented defaults above [4][5][6]. AWS describes choosing timeouts from the downstream latency percentile that matches an acceptable false-timeout rate (for example p99.9 for 0.1 percent) and setting both a connection and a request timeout [1].
**Spot it in a plan:** "call the API", "ask the LLM", "fetch from the CRM", no number next to it.
**Spot it in code:**
- Python: `requests.get(` / `requests.post(` without `timeout=`; `httpx.Client()` relying on defaults without a decision; SDK clients constructed without timeout options.
- Node: `fetch(` without `signal`; `axios` without `timeout`; SDK clients without `timeout`.
- Go: `http.Get(`, `http.DefaultClient`, `&http.Client{}` without `Timeout`, `context.Background()` passed to network calls.
- SQL: no `statement_timeout` on application roles (Postgres default is 0, disabled) [17].
**Build it right:** Wrap each dependency in one client module that sets connect and total timeouts from measured latency (p99.9 plus margin), so call sites cannot forget. Lint for raw `requests.*`, `http.Get` and `fetch(` outside those modules. Set a role-level `statement_timeout` for the application's Postgres role. For streaming or long calls (LLM streaming, file uploads), set an idle timeout between chunks plus an overall cap.

Dangerous:
```python
import requests

def fetch_contact(contact_id: str) -> dict:
    r = requests.get(f"{CRM_URL}/contacts/{contact_id}", headers=auth())   # may hang for minutes
    r.raise_for_status()
    return r.json()
```

Safe:
```python
import requests

_session = requests.Session()
CONNECT_S, READ_S = 3.05, 10          # read timeout from CRM p99.9 (measured 4.2 s) plus margin

def fetch_contact(contact_id: str) -> dict:
    r = _session.get(f"{CRM_URL}/contacts/{contact_id}", headers=auth(),
                     timeout=(CONNECT_S, READ_S))
    r.raise_for_status()
    return r.json()
# requests' read timeout is per gap between bytes, not wall clock [4]; for a hard cap on slow
# streaming bodies, also bound total time at the caller.
```

**Prove it:** Point the client at a fake server that accepts the connection and never responds (or a blackhole IP for connect). Assert the call fails within the configured timeout plus a small margin, and the request thread or task is released. Run a load test with the dependency stalled and assert unrelated endpoints keep their latency.
**Size for now:** Timeouts on every call are v1, no exceptions. Adaptive timeouts can wait.

### REL-02 Deadlines and timeout budgets across layers

**How it fails:** Timeouts are set per call but not as a budget. The API gateway gives up at 30 seconds, but the handler calls the CRM with a 30-second timeout, then the LLM with a 60-second timeout: the user gets a gateway error while the server keeps working (and keeps writing) for another minute, often finishing work nobody will see, or doing it twice when the client retries. Inner retries multiply the problem: three attempts of 10 seconds do not fit in a 15-second budget.
**Seen in the wild:** No verified incident; the failure follows from independent per-layer timeouts. AWS's guidance on choosing timeouts per call [1] presumes the caller's own deadline is larger than the sum of what it waits on.
**Spot it in a plan:** Several sequential calls in one request with no total time stated; "retry up to 3 times" inside a synchronous request.
**Spot it in code:** Hard-coded per-call timeouts that sum to more than the server or gateway timeout; Go code that creates `context.Background()` inside a handler instead of using `r.Context()`; Python handlers with no overall `asyncio.timeout` (3.11+) or equivalent [8]; work that keeps running after the client disconnected.
**Build it right:** Set one deadline at the edge (slightly below the gateway or client timeout) and propagate it: Go `context.WithTimeout(r.Context(), ...)` passed to every call; Python `asyncio.timeout()` around the handler body [8]; Node an `AbortSignal` passed down. Each call uses `min(own timeout, remaining budget)`. If the remaining budget cannot fit another attempt, do not retry; return a clear error or switch to an asynchronous flow (accept, enqueue, notify).

Dangerous:
```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx := context.Background()                       // ignores client disconnect and gateway deadline
    c, _ := crm.GetContact(ctx, id)                   // client timeout 30 s
    s, _ := llm.Summarize(ctx, c)                     // client timeout 60 s
    json.NewEncoder(w).Encode(s)
}
```

Safe:
```go
func handler(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second) // gateway gives up at 30 s
    defer cancel()
    c, err := crm.GetContact(ctx, id)                 // client honors ctx and its own 5 s cap
    if err != nil {
        writeErr(w, err)
        return
    }
    if dl, _ := ctx.Deadline(); time.Until(dl) < 8*time.Second {
        enqueueSummary(id)                            // not enough budget: go async, tell the user
        w.WriteHeader(http.StatusAccepted)
        return
    }
    s, err := llm.Summarize(ctx, c)
    if err != nil {
        writeErr(w, err)
        return
    }
    json.NewEncoder(w).Encode(s)
}
```

**Prove it:** Add latency to the first dependency so it consumes most of the budget; assert the handler returns a defined response before the gateway timeout and that the second call is never started. Disconnect the client mid-request; assert downstream calls are cancelled (the fake dependency sees the connection close).
**Size for now:** Edge deadline plus context propagation is v1 for request paths with more than one outbound call. Deadline headers propagated across internal services can wait until there are internal services.

### REL-03 Retry only what is safe: idempotency, backoff, jitter

**How it fails:** A retry wrapper retries every error, including non-idempotent operations, so a timeout on "send email" or "create charge" becomes two emails or two charges (REL-07). It also retries permanent errors (400, 401, 404, validation), wasting the budget and delaying the real error. Retries without delay hammer a struggling dependency; retries with fixed delays from many clients synchronize into waves. AWS's position is that APIs with side effects are not safe to retry unless they provide idempotency, and that jitter spreads retries in time [1]; Stripe's guidance is the same: exponential backoff with random jitter, and idempotency keys so retries are safe [3].
**Seen in the wild:** Cloudflare's 12 September 2025 dashboard and API outage began with a dashboard bug that called an internal API repeatedly; retries made it worse, and when the service restarted every dashboard re-authenticated at once (a thundering herd). One follow-up was adding random delays to spread out retries [10].
**Spot it in a plan:** "retry on failure", "retry 3 times", without saying which failures or how the operation is made idempotent.
**Spot it in code:** Retry decorators (`tenacity`, `p-retry`, `axios-retry`, `backoff`) with default "retry on any exception"; retries around POST without an idempotency key; `sleep(1)` constant delays; retry loops without a cap on attempts or total time.
**Build it right:** Classify errors once per dependency: retryable (connection reset, timeout on an idempotent call, 429, 502, 503, 504) versus permanent (other 4xx, validation, auth). Retry only idempotent operations, or operations made idempotent by a key that stays the same across attempts. Use capped exponential backoff with full jitter, a small attempt limit, and the deadline from REL-02. Retry at one layer only (REL-04).

Dangerous:
```ts
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= 5) throw e; await sleep(1000); }   // every error, fixed delay, no key
  }
}
await withRetry(() => email.send({ to, subject, body }));
```

Safe:
```ts
const RETRYABLE = new Set([429, 502, 503, 504]);

async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  { attempts = 4, baseMs = 200, capMs = 5_000, signal }: { attempts?: number; baseMs?: number; capMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await fn(i); }
    catch (e: any) {
      const retryable = e.code === "ECONNRESET" || e.name === "TimeoutError" || RETRYABLE.has(e.status);
      if (!retryable || i + 1 >= attempts || signal?.aborted) throw e;
      const delay = Math.random() * Math.min(capMs, baseMs * 2 ** i);   // full jitter
      await sleep(delay, signal);
    }
  }
}
// The key is fixed per logical message, so a retried send is deduplicated by the provider.
const key = `welcome:${userId}`;
await withRetry(() => email.send({ to, subject, body }, { idempotencyKey: key }), { signal });
```

**Prove it:** Fake dependency returns 503 twice then 200: one effect, three attempts, delays within the jitter bounds. Returns 400: one attempt, error surfaced. Times out after accepting a send: the retry carries the same key and the provider (or fake) records one message.
**Size for now:** One retry helper per codebase with error classification is v1. Hedged requests and adaptive concurrency limits wait.

### REL-04 Retry amplification, storms and budgets

**How it fails:** When a dependency degrades for everyone, retries multiply load exactly when it can least absorb it. Each layer that retries independently multiplies the next: AWS gives the example of five layers each retrying, which raises load on the database 243 times [1]. Client retries keep a recovering service pinned down, and caches that empty during the incident send even more traffic to the source.
**Seen in the wild:** In AWS's 7 December 2021 us-east-1 event, an automated scaling activity triggered unexpected behavior from many clients inside the internal network; the surge of connection activity overwhelmed networking devices, delays caused more connection attempts and retries, and a latent issue prevented clients from backing off as designed [9]. Slack's 22 February 2022 incident write-up also notes that automated retries added load while the system was overloaded [22].
**Spot it in a plan:** Retries at the client, the API, the worker and the SDK, each described separately; "the SDK retries automatically" plus our own retry wrapper.
**Spot it in code:** Retry loops in a function that is itself called from a retried job; SDKs with built-in retries (check each client's docs for its default) wrapped in another retry; queue redelivery plus in-handler retries plus HTTP client retries.
**Build it right:** Pick one layer to retry, usually the one closest to the user intent or the queue, and set the others to zero (configure SDK `maxRetries`). Add a retry budget per dependency: a token bucket where successes add a fraction of a token and each retry spends one, so retries are allowed at a bounded fraction of normal traffic and stop when the dependency is broadly failing (AWS describes this local token bucket approach [1]). Combine with circuit breaking (REL-06).

Dangerous:
```python
@retry(stop=stop_after_attempt(5))                 # job-level retry
def sync_account(account_id):
    for page in crm.list_contacts(account_id):     # SDK also retries 3 times internally
        upsert(page)
# Plus the queue redelivers the job 5 times: up to 75 calls per page during an outage.
```

Safe:
```python
import threading, time

class RetryBudget:
    """Retries allowed up to ~10% of successful calls, plus a small floor."""
    def __init__(self, ratio=0.1, floor=10):
        self.tokens, self.ratio, self.max = floor, ratio, floor * 5
        self.lock = threading.Lock()
    def on_success(self):
        with self.lock:
            self.tokens = min(self.max, self.tokens + self.ratio)
    def try_spend(self) -> bool:
        with self.lock:
            if self.tokens >= 1:
                self.tokens -= 1
                return True
            return False

crm = CrmClient(max_retries=0, timeout=10)         # SDK retries off: one layer owns retries
budget = RetryBudget()

def call_crm(fn, *args):
    for attempt in range(3):
        try:
            out = fn(*args)
            budget.on_success()
            return out
        except RetryableError:
            if attempt == 2 or not budget.try_spend():
                raise                               # budget empty: fail fast, let the queue back off
            time.sleep(random.uniform(0, 0.2 * 2 ** attempt))
```

**Prove it:** Make the fake CRM fail 100 percent of calls and drive normal job traffic. Count calls reaching the fake per logical operation: it must stay near 1 plus the budgeted fraction, not attempts multiplied across layers. Restore the fake and assert throughput recovers without a spike above the normal rate times a small factor.
**Size for now:** "Retry at one layer, SDK retries off or counted" is v1. A per-process token bucket is cheap and worth it for any dependency that every request touches. Fleet-wide retry coordination waits.

### REL-05 Rate limits: honor 429 and Retry-After

**How it fails:** A provider rate limits (HTTP 429, or a provider-specific error) and the client treats it as a generic failure: it retries immediately, retries on a fixed schedule, or drops the work. Immediate retries extend the penalty and can get the app throttled harder; dropped work is silent data loss (a message never sent, a sync that skipped a page). RFC 6585 defines 429 and says the response may include `Retry-After` saying how long to wait [11].
**Seen in the wild:** No verified incident; the failure follows from documented provider behavior. Slack returns `HTTP 429 Too Many Requests` with a `Retry-After` header (for example `Retry-After: 30`) and asks the app to pause that method for that workspace for that long; other methods and other workspaces are not affected [12]. `chat.postMessage` documents a `ratelimited` error telling the caller to use `Retry-After`, and allows about one message per second per channel [13]. Gmail recommends truncated exponential backoff for time-based quota errors [14].
**Spot it in a plan:** "post to Slack for each event", "send each email", any per-item call to a third party without a limit stated; see SCALE-09 for sizing.
**Spot it in code:** HTTP clients that do not read `Retry-After`; one global backoff for all methods and tenants (over-throttles) or no backoff; rate-limit errors caught and logged at debug level; work dropped on 429.
**Build it right:** Treat 429 as "not now", never "failed". Read `Retry-After` (seconds or an HTTP date) and schedule the work after it, keyed by the provider's limit scope (Slack: method plus workspace plus app [12]). Do the waiting in a queue, not in a sleeping request handler. Cap total delay and surface "delayed" to the user if it grows. Pace proactively below the documented limit so 429s are rare.

Dangerous:
```ts
for (const msg of messages) {
  const res = await slack.chat.postMessage({ channel, text: msg });   // 429 thrown; loop aborts
}
```

Safe:
```ts
// Worker sends one queued message; the queue persists the rest.
async function sendQueued(job: SlackJob) {
  const pausedUntil = await limits.pausedUntil(job.teamId, "chat.postMessage");
  if (pausedUntil > Date.now()) return queue.retryAt(job, pausedUntil);
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${await tokenFor(job.teamId)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel: job.channel, text: job.text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 429) {
    const secs = Number(res.headers.get("Retry-After") ?? "30");
    const until = Date.now() + secs * 1000 + Math.random() * 1000;
    await limits.pause(job.teamId, "chat.postMessage", until);   // scope: method + workspace
    return queue.retryAt(job, until);                            // not a failure, not dropped
  }
  const body = await res.json();
  if (!body.ok) throw new SlackError(body.error);                // classify permanent vs transient
  await markSent(job.id, body.ts);
}
```

**Prove it:** Fake Slack returns 429 with `Retry-After: 5` for one workspace. Assert no call to that method for that workspace for 5 seconds, other workspaces continue, and every message is eventually sent exactly once. Assert a metric records the throttle.
**Size for now:** Honoring `Retry-After` and queuing third-party sends are v1. A shared distributed rate limiter across many workers waits until one process's pacing is not enough; then a Postgres or Redis token bucket per (provider, scope) suffices.

### REL-06 Circuit breaking, bulkheads and load shedding

**How it fails:** A dependency is down or very slow. Every request still tries it, waits for the full timeout, and holds a worker meanwhile. Concurrency piles up behind the slow dependency until the whole service is saturated, and features that do not use the dependency fail too. When the dependency recovers, the backlog of waiting clients hits it all at once.
**Seen in the wild:** In Cloudflare's 12 September 2025 incident, a failure in the service that authorizes API calls caused API requests to fail with 5xx errors; dashboard retries and a thundering herd on restart kept destabilizing it [10]. Discord's message storage write-up describes unbounded concurrency against a hot partition turning into cascading latency across the node [23].
**Spot it in a plan:** A dependency on the request path of many features; "if the API is down, we retry"; no limit on concurrent calls.
**Spot it in code:** Unbounded `Promise.all` over items that each call a dependency; goroutines spawned per request with no semaphore; no failure-rate tracking per dependency; thread pools shared between fast and slow dependencies.
**Build it right:** Bulkhead first: cap concurrent calls per dependency (a semaphore sized from the dependency's capacity and your latency budget) and fail fast when the cap is reached, rather than queueing in memory. Add a circuit breaker for dependencies that fail hard: after a run of failures, stop calling for a cool-down, then let a few probes through. Return a defined degraded response (REL-14) while open. Expose breaker state and rejections as metrics.

Dangerous:
```go
func enrich(ctx context.Context, ids []string) []Profile {
    out := make([]Profile, len(ids))
    var wg sync.WaitGroup
    for i, id := range ids {                         // 5,000 ids: 5,000 concurrent calls
        wg.Add(1)
        go func(i int, id string) { defer wg.Done(); out[i], _ = vendor.Get(ctx, id) }(i, id)
    }
    wg.Wait()
    return out
}
```

Safe:
```go
var vendorSlots = make(chan struct{}, 20)            // vendor tolerates ~20 concurrent calls

var errSaturated = errors.New("vendor saturated")

func vendorGet(ctx context.Context, id string) (Profile, error) {
    select {
    case vendorSlots <- struct{}{}:
        defer func() { <-vendorSlots }()
    case <-ctx.Done():
        return Profile{}, ctx.Err()
    case <-time.After(200 * time.Millisecond):       // do not queue long: shed load instead
        return Profile{}, errSaturated
    }
    if breaker.Open() {                               // tripped by consecutive failures; half-opens after cool-down
        return Profile{}, ErrVendorUnavailable
    }
    p, err := vendor.Get(ctx, id)
    breaker.Record(err)
    return p, err
}
```

**Prove it:** Make the fake vendor hang. Assert concurrent in-flight calls never exceed the cap, requests to unrelated endpoints keep normal latency, and after N failures calls stop reaching the vendor until the cool-down. Restore the vendor and assert traffic ramps through probes rather than a burst.
**Size for now:** A per-dependency concurrency cap and timeouts are v1. A full breaker is worth it for dependencies on hot paths; for rarely used ones, timeouts plus the cap are enough. Service meshes are not needed for this.

### REL-07 Timeout after success: ambiguous outcomes

**How it fails:** The request reached the provider and succeeded, but the response was lost: the connection dropped, our timeout fired a moment too early, or our process died before reading it. From our side it looks like a failure. Retrying without an idempotency key duplicates the effect (a second charge, a second email, a second Slack message); treating it as failed and telling the user "it did not work" is also wrong, because it did. Stripe describes this exact case: the call can succeed while the connection breaks before the server can tell the client [3]. AWS describes the same ambiguity and the client request token that resolves it [2].
**Seen in the wild:** No verified incident; the failure mode is described by Stripe and AWS as the reason idempotency keys exist [3][2].
**Spot it in a plan:** "if the call fails, show an error and let the user retry"; "on timeout, retry".
**Spot it in code:** `catch` blocks after a side-effecting call that set status `failed`; retries of POSTs without a stable key; no state between "requested" and "confirmed".
**Build it right:** Model three outcomes, not two: succeeded, failed, unknown. On timeout or connection loss after the request was sent, record `unknown`, not `failed`. Resolve unknowns by (1) retrying with the same idempotency key when the provider supports keys, which returns the original result instead of repeating the effect [2][3]; or (2) querying the provider by our own reference (a client reference, metadata, or a search) before deciding; or (3) leaving it to the reconciliation sweeper (REL-10). Tell the user "processing" while unknown.

Dangerous:
```python
try:
    psp.charge(amount_minor=total, currency="USD", customer=cust)      # no key
    order.status = "paid"
except requests.Timeout:
    order.status = "payment_failed"          # the charge may have succeeded
    notify_user("Payment failed, please try again")                     # user pays twice
```

Safe:
```python
key = f"order-charge:{order.id}"             # stable across every attempt for this order
try:
    charge = psp.charge(amount_minor=total, currency="USD", customer=cust,
                        idempotency_key=key, metadata={"order_id": order.id})
    order.mark_paid(charge["id"])
except (requests.Timeout, requests.ConnectionError):
    order.mark_payment_unknown()             # sweeper retries with the same key or looks it up
    notify_user("We are confirming your payment")
except psp.CardDeclined as e:
    order.mark_payment_failed(e.code)        # definite failure: safe to tell the user
```

**Prove it:** Fake provider that performs the effect and then drops the connection before responding. Assert the order ends `paid` after the sweeper runs, the provider recorded exactly one charge, and the user never saw "failed".
**Size for now:** The three-outcome model and stable keys are v1 for money and outbound messages. For read-only calls, a plain retry is fine.

### REL-08 At-least-once consumption: acknowledge after commit

**How it fails:** A consumer deletes or acknowledges a message as soon as it receives it, then crashes before finishing: the work is lost. Or it acknowledges after doing external effects but before committing its own database state, so a crash repeats the effect on redelivery. Or processing takes longer than the visibility timeout (SQS default 30 seconds, maximum 12 hours [16]), so the message becomes visible again and a second consumer processes it while the first is still running. Standard queues also deliver duplicates on their own [15].
**Seen in the wild:** No verified incident; the failure follows from documented queue semantics: SQS standard queues are at-least-once and may deliver more than one copy [15], and a received message reappears when its visibility timeout ends [16].
**Spot it in a plan:** "the worker reads the message and processes it", with no word on when it is acknowledged or how long processing takes.
**Spot it in code:** `delete_message` or `ack()` before the handler; auto-ack consumer settings; visibility timeouts left at default for jobs that call LLMs or slow APIs; no `change_message_visibility` heartbeat for long jobs.
**Build it right:** Acknowledge only after the effects are durably committed. Make the handler idempotent (CONC-04) because a crash after commit and before ack causes redelivery. Set the visibility timeout above the p99.9 processing time, and extend it with a heartbeat for long jobs. Long-poll to reduce empty receives.

Dangerous:
```python
msgs = sqs.receive_message(QueueUrl=Q, MaxNumberOfMessages=10).get("Messages", [])
for m in msgs:
    sqs.delete_message(QueueUrl=Q, ReceiptHandle=m["ReceiptHandle"])   # gone before work is done
    handle(json.loads(m["Body"]))                                       # crash: work lost
```

Safe:
```python
msgs = sqs.receive_message(QueueUrl=Q, MaxNumberOfMessages=10, WaitTimeSeconds=20,
                           VisibilityTimeout=120).get("Messages", [])
for m in msgs:
    with heartbeat(lambda: sqs.change_message_visibility(
            QueueUrl=Q, ReceiptHandle=m["ReceiptHandle"], VisibilityTimeout=120),
            every_s=60):
        handle_idempotently(json.loads(m["Body"]), message_id=m["MessageId"])  # commits its effects
    sqs.delete_message(QueueUrl=Q, ReceiptHandle=m["ReceiptHandle"])           # only after commit
```

**Prove it:** Kill the worker after `handle` commits and before delete: the message is redelivered and the effect still happens once. Make `handle` sleep longer than the visibility timeout without the heartbeat: observe a second delivery (the bug); with the heartbeat: no second delivery.
**Size for now:** Ack-after-commit and idempotent handlers are v1. FIFO queues and exactly-once processing features are optional; idempotent handlers are needed either way.

### REL-09 Poison messages and dead-letter queues

**How it fails:** One message fails every time (malformed payload, a deleted referenced record, a bug for one customer's data, a permanently invalid token). Without a cap, it is retried forever: it wastes capacity, fills logs, and in ordered queues or single-consumer setups it blocks everything behind it. With a cap but no dead-letter store, it is silently dropped. With a dead-letter store nobody watches, it is dropped slowly.
**Seen in the wild:** No verified incident; the failure follows from queue semantics. SQS dead-letter queues exist for messages that are not processed successfully; `maxReceiveCount` sets how many receives happen before a message moves there, and AWS recommends setting the DLQ retention longer than the source queue's [24].
**Spot it in a plan:** "failed jobs are retried", with no maximum, no dead-letter destination and no owner for it.
**Spot it in code:** Queues without a redrive policy; job tables with no `attempts` column; `except Exception: requeue()`; dead-letter queues with no alarm; no tool to replay dead letters.
**Build it right:** Bounded attempts with backoff; classify permanent errors and dead-letter them immediately instead of retrying. Dead-letter with the error, attempt count and payload. Alarm on dead-letter depth greater than zero (or a small threshold) with a named owner. Build a replay command that re-enqueues selected dead letters after a fix; replay relies on idempotent handlers.

Dangerous:
```ts
worker.on("job", async (job) => {
  try { await handle(job); }
  catch (e) { await queue.add(job.name, job.data); }    // forever, at full speed, no record
});
```

Safe:
```ts
// Postgres-backed jobs table (CONC-05). One statement records the failure and schedules the next try.
async function fail(jobId: number, err: unknown, permanent: boolean) {
  await db.query(
    `UPDATE jobs
        SET status = CASE WHEN $3 OR attempts >= 6 THEN 'dead' ELSE 'pending' END,
            run_at = now() + make_interval(secs => least(3600, 10 * power(2, attempts)) * (0.5 + random())),
            last_error = $2, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId, String(err).slice(0, 2000), permanent]);
}
// Alert: SELECT count(*) FROM jobs WHERE status = 'dead' AND updated_at > now() - interval '1 hour'
// Replay: UPDATE jobs SET status = 'pending', attempts = 0, run_at = now() WHERE id = ANY($1)
```

**Prove it:** Enqueue one job whose handler always throws, among 100 good ones. Assert the 100 complete on time, the bad one reaches `dead` after the configured attempts with its error recorded, the alert fires, and the replay command re-runs it after the handler is fixed.
**Size for now:** Attempt caps, a dead state with an alert, and a replay script are v1. A dead-letter browsing UI waits.

### REL-10 Crash between steps: recovery and reconciliation

**How it fails:** A flow has several steps across systems: claim the record, call the provider, record the result, notify the user. The process dies (deploy, OOM kill, node failure) between two of them. Without a recovery path, the record sits in `sending` forever, the user is never notified, or a naive restart repeats step two. Because the crash also kills the code that would have logged the problem, nothing alerts.
**Seen in the wild:** Buttondown's incident 0016 involved a malfunctioning database on one of its sending servers; about 70,000 messages ended in an uncertain state, some marked pending that had been sent and some marked sent that had not. The team said they could not trust their sources of truth, isolated the server, and resent only the emails they were certain had not gone out; about 13,000 subscribers saw delays, missing mail or duplicates [21].
**Spot it in a plan:** Multi-step flows described only on the happy path; intermediate statuses with no timeout.
**Spot it in code:** Status values like `processing`, `sending`, `syncing` with no job that looks for old ones; no `*_started_at` timestamp on those states; restart logic that re-runs from step one.
**Build it right:** Model the flow as states with timestamps (CONC-09). For each intermediate state, a sweeper finds rows older than a deadline and resolves them by asking the source of truth what happened (query the provider by idempotency key or our reference), then moves the row forward or back. Effects use idempotency keys so a resumed step does not repeat. Alert on the count of rows stuck past the deadline, separately from errors.

Dangerous:
```sql
-- Rows stuck here after a crash stay forever; nothing looks at them.
UPDATE messages SET status = 'sending' WHERE id = $1 AND status = 'queued';
```

Safe:
```python
STUCK_AFTER = "10 minutes"

def sweep_stuck_sends(conn):
    rows = conn.execute(f"""
        SELECT id, provider_key FROM messages
         WHERE status = 'sending' AND sending_started_at < now() - interval '{STUCK_AFTER}'
         ORDER BY sending_started_at LIMIT 200
         FOR UPDATE SKIP LOCKED""").fetchall()
    for msg_id, key in rows:
        found = email_provider.find_by_idempotency_key(key)   # or search by our message id
        if found:
            conn.execute("UPDATE messages SET status = 'sent', provider_id = %s "
                         "WHERE id = %s AND status = 'sending'", (found.id, msg_id))
        else:
            conn.execute("UPDATE messages SET status = 'queued', attempts = attempts + 1 "
                         "WHERE id = %s AND status = 'sending'", (msg_id,))  # resend reuses key
    metrics.gauge("messages.stuck_sending", len(rows))
```

**Prove it:** Kill the worker (`kill -9`) at each step boundary in turn. After the sweeper runs, every message is in a terminal state, the fake provider recorded exactly one send per message, and the stuck gauge returned to zero.
**Size for now:** One sweeper per multi-step flow and a stuck-count alert are v1. A durable workflow engine waits until flows have many steps or long waits.

### REL-11 Graceful shutdown and in-flight work

**How it fails:** On deploy or scale-in, the platform sends `SIGTERM`, waits a grace period, then `SIGKILL`s. In Kubernetes the default grace period is 30 seconds, and the pod is removed from Service endpoints as termination begins [18]; that removal reaches proxies and load balancers on their own schedule, so a little traffic can still arrive after `SIGTERM`. A process with no handler dies immediately: in-flight HTTP requests are cut, claimed jobs stay claimed until their lease expires (CONC-05), transactions roll back mid-flow, and buffered logs and metrics are lost. A handler that waits for a 10-minute job ignores the grace period and gets killed anyway.
**Seen in the wild:** No verified incident; the failure follows from the documented termination sequence: `SIGTERM`, a default 30-second grace period that runs in parallel with the `preStop` hook, then `SIGKILL` [18].
**Spot it in a plan:** Long-running jobs, websockets or streaming responses on instances that deploy several times a day; no mention of shutdown.
**Spot it in code:** No `SIGTERM` handler; `process.exit()` in handlers; workers whose loop cannot be told to stop after the current item; jobs longer than the grace period with no checkpointing; HTTP servers closed without draining.
**Build it right:** On `SIGTERM`: fail readiness so no new traffic is routed, stop accepting new connections, let in-flight requests finish, tell workers to stop claiming and finish (or checkpoint and release) the current item, release leases explicitly so another worker can pick up immediately, close pools, flush telemetry, and exit before the grace period ends. Set the grace period from the real p99 of request and job duration; jobs longer than that must checkpoint and be resumable.

Dangerous:
```ts
const server = app.listen(8080);
startWorkerLoop();          // no SIGTERM handler: deploys cut requests and abandon claimed jobs
```

Safe:
```ts
const server = app.listen(8080);
const worker = startWorkerLoop();           // exposes stop(): finish current job, claim no more
let shuttingDown = false;
app.get("/ready", (_req, res) => res.sendStatus(shuttingDown ? 503 : 200));

process.on("SIGTERM", async () => {
  shuttingDown = true;                       // readiness fails; endpoints update shortly after
  const hardStop = setTimeout(() => process.exit(1), 25_000).unref();  // inside the 30 s grace period
  await new Promise((r) => setTimeout(r, 5_000));          // let routing catch up
  await Promise.all([
    new Promise<void>((r) => server.close(() => r())),     // stop accepting, wait for in-flight
    worker.stop(),                                         // finish or release the current lease
  ]);
  await pool.end();
  await telemetry.flush();
  clearTimeout(hardStop);
  process.exit(0);
});
```

**Prove it:** Under steady load, run a rolling restart (or send `SIGTERM` to one instance). Assert zero 5xx responses from the load generator, every claimed job either completed or was picked up by another worker within seconds, and the process exited before `SIGKILL`.
**Size for now:** A `SIGTERM` handler with drain and lease release is v1 for any service that deploys while serving users. Connection draining tuned per protocol (websockets, streaming) waits for those features.

### REL-12 Deploys and restarts mid-flow

**How it fails:** Work that outlives one process meets a different version of the code: a job enqueued by version N is run by version N+1 that renamed a payload field; a multi-day email sequence step references a template that was removed; a workflow resumes with a state value the new code does not handle; a job type is deleted while thousands of its jobs are still queued. Old and new workers also run side by side during a rolling deploy, so both versions must handle both payload shapes.
**Seen in the wild:** No verified incident; the failure follows from rolling deploys running two code versions at once, the same reason schema changes need expand and contract (DI-02).
**Spot it in a plan:** Queued or scheduled work (sequences, reminders, retries with long backoff) and a change to its payload, its handler or its states.
**Spot it in code:** Job payload types changed in a PR without a version field or a compatible reader; job handlers removed while the job type can still be in queues; `switch` on states with a `default` that throws.
**Build it right:** Treat job payloads and persisted workflow states as public contracts. Add fields as optional; carry a `v` field; keep readers for old versions until queues have drained (check the oldest queued item of that type); remove a job type in two releases (stop enqueuing, then remove the handler after drain). Feature-flag behavior changes so in-flight items can keep the old path.

Dangerous:
```python
# v2 renamed "user_id" to "account_id" and deployed while v1 jobs are still queued.
def handle_send_digest(payload):
    send_digest(payload["account_id"])          # KeyError on every queued v1 job
```

Safe:
```python
def handle_send_digest(payload):
    v = payload.get("v", 1)
    if v == 1:
        account_id = account_for_user(payload["user_id"])   # keep until no v1 jobs remain
    elif v == 2:
        account_id = payload["account_id"]
    else:
        raise PermanentJobError(f"unknown digest payload version {v}")  # dead-letter, alert
    send_digest(account_id)
# Removal check: SELECT count(*) FROM jobs WHERE type = 'send_digest' AND payload->>'v' IS NULL;
```

**Prove it:** Enqueue jobs with the previous release, deploy the new release, and drain: every job succeeds. In CI, keep fixture payloads from each released version and run the current handlers against them.
**Size for now:** Version fields and drain checks are v1 wherever work is queued for more than a few seconds. A schema registry waits until several teams publish to the same queues.

### REL-13 Health checks that test the right thing

**How it fails:** Two opposite mistakes. Shallow: `/health` returns 200 as long as the process runs, so an instance whose connection pool is exhausted, or whose credentials expired, keeps receiving traffic and failing every request. Deep: `/health` checks every dependency, so when one shared dependency (the database, a third-party API) has a blip, every instance fails its check at once and the load balancer or orchestrator removes or restarts the whole fleet, turning a partial outage into a total one. AWS describes dependency health checks as able to cause cascading failure across a fleet and describes load balancers that fail open (route to all) when every target is unhealthy [19].
**Seen in the wild:** Buttondown's March 2026 incident: the database hit its configured connection ceiling and the health check did not detect it; the follow-up was to make the health check run a real query, noting that a health check that cannot detect the most common failure mode is not much of a health check [20]. Slack's 4 January 2021 outage shows the other side: automation marked instances unhealthy because they could not reach backends over a degraded network, and the load balancers' panic mode, which spreads requests across all instances when many fail checks, helped [25].
**Spot it in a plan:** "add a health endpoint", with no statement of what it checks or what acts on it.
**Spot it in code:** `/health` handlers that return a constant; health handlers that call third-party APIs; the same endpoint used for Kubernetes liveness (restarts the container) and readiness (removes from routing); health checks without short timeouts.
**Build it right:** Separate the checks by who acts on them. Liveness (restart me): only "the process is not wedged", never dependencies. Readiness (route to me): can this instance do its own work: it can get a connection from its own pool and run `SELECT 1` within a short timeout, its config and credentials loaded. Do not fail readiness for shared third-party outages; degrade instead (REL-14). End-to-end checks of real dependencies belong in alerting and synthetic monitoring, not in routing. Configure fail-open behavior where the platform supports it.

Dangerous:
```go
http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
    if err := db.Ping(); err != nil { w.WriteHeader(500); return }       // no timeout
    if _, err := crm.Ping(r.Context()); err != nil { w.WriteHeader(500); return }  // CRM blip kills fleet
    w.WriteHeader(200)
})  // also wired as liveness: a DB blip restarts every pod
```

Safe:
```go
http.HandleFunc("/livez", func(w http.ResponseWriter, _ *http.Request) {
    w.WriteHeader(http.StatusOK)                        // process is serving; nothing else
})
http.HandleFunc("/readyz", func(w http.ResponseWriter, r *http.Request) {
    if shuttingDown.Load() {
        w.WriteHeader(http.StatusServiceUnavailable)
        return
    }
    ctx, cancel := context.WithTimeout(r.Context(), 500*time.Millisecond)
    defer cancel()
    var one int
    if err := db.QueryRowContext(ctx, "SELECT 1").Scan(&one); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)    // this instance cannot get a working connection
        return
    }
    w.WriteHeader(http.StatusOK)                        // third-party APIs are not checked here
})
```

**Prove it:** Exhaust one instance's pool (hold all connections in a test) and assert its readiness fails within one check interval while others stay ready. Make the CRM return 500s and assert no instance becomes unready or restarts. Make the database unreachable for everyone and assert pods are not restart-looped by liveness.
**Size for now:** Separate liveness and readiness, with readiness doing a real query on the instance's own pool, is v1. Synthetic end-to-end probes for key journeys are cheap and also v1 if a third party sits on the main journey.

### REL-14 Dependency failure visible to the user

**How it fails:** When a dependency fails, code catches the error and returns something that looks like a normal result: an empty list (the user thinks they have no contacts), a zero balance, a default plan, "message sent" because the request was queued. Users act on false information, support cannot tell what happened, and the failure never shows in error metrics. The opposite failure is a raw 500 for a non-essential widget that takes down the whole page.
**Seen in the wild:** Cloudflare's 12 September 2025 incident was contained by design: the failing component was in the control plane, so the data plane and cached content kept running and most users were affected only when changing configuration or using the dashboard [10]. That separation is the goal; the anti-pattern is hiding a failure as a valid empty answer.
**Spot it in a plan:** "if the API fails, fall back to an empty state", "show default values", "just hide the section".
**Spot it in code:** `catch { return [] }`, `except Exception: return None` on data paths, `?? 0` on balances, success toasts shown on enqueue rather than on completion, no distinct UI state for "unavailable" or "stale".
**Build it right:** For each dependency on a user journey, write the degraded behavior: serve the last known value labeled with its age; disable the action with a reason; accept and queue the action and show "pending" until confirmed; or fail the page section, not the page. Never represent "unknown" as a valid value. Count every fallback served as a metric so degraded mode is visible to operators.

Dangerous:
```ts
async function getContacts(accountId: string) {
  try { return await crm.listContacts(accountId); }
  catch { return []; }               // UI shows "No contacts yet" during a CRM outage
}
```

Safe:
```ts
type Contacts =
  | { state: "fresh"; items: Contact[] }
  | { state: "stale"; items: Contact[]; asOf: Date; reason: string }
  | { state: "unavailable"; reason: string };

async function getContacts(accountId: string): Promise<Contacts> {
  try {
    const items = await crm.listContacts(accountId);
    await snapshot.save(accountId, items);
    return { state: "fresh", items };
  } catch (e) {
    metrics.increment("fallback.contacts", { reason: errorClass(e) });
    const last = await snapshot.load(accountId);
    return last
      ? { state: "stale", items: last.items, asOf: last.savedAt, reason: "CRM unavailable" }
      : { state: "unavailable", reason: "CRM unavailable" };   // UI renders a banner, not "empty"
  }
}
```

**Prove it:** Make each dependency fail in turn and walk the main journeys in a browser: every screen states what is missing, no screen shows an empty or zero state as if it were real, and the fallback metric increments.
**Size for now:** Explicit unavailable and stale states for the main journey are v1. Elaborate offline modes wait.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "The library has a sensible default timeout." | Several common clients default to none or to minutes [4][5][6]. | Set connect and total timeouts explicitly, in one client module. |
| "Retrying makes it more reliable." | Retries of non-idempotent calls duplicate effects; retries at every layer multiply load [1]. | Retry idempotent operations at one layer, with jitter and a budget. |
| "A timeout means it failed." | The work may have succeeded and only the response was lost [3][2]. | Record "unknown" and resolve with the same idempotency key or a lookup. |
| "429s are rare, we will just retry." | Immediate retries extend throttling; dropped work is silent loss [11][12]. | Queue, honor `Retry-After` per scope, pace below the limit. |
| "We will ack early to keep the queue moving." | A crash after ack loses the work. | Ack after commit; idempotent handler. |
| "Failed jobs get retried, that covers it." | A poison job retried forever wastes capacity; capped and dropped is silent loss. | Attempt cap, dead-letter with alert, replay tool. |
| "Deploys are quick, nothing is in flight." | Every deploy kills processes mid-request and mid-job. | `SIGTERM` drain, lease release, resumable jobs. |
| "A deep health check catches more problems." | One shared dependency failing can take the whole fleet out of rotation [19]. | Readiness checks the instance's own resources; dependencies go to alerting. |
| "Returning an empty list is a graceful fallback." | The user acts on a false answer and nobody sees an error. | Explicit stale or unavailable states, counted in metrics. |

## Attack recipes

1. **Blackhole a dependency.** Point one dependency at a host that accepts TCP and never answers (`nc -l` without responding, or a toxiproxy `timeout` toxic). Requests touching it must fail within their timeout; unrelated endpoints must keep their p99. A hang or a global latency rise means REL-01 or REL-06 failed.
2. **Budget squeeze.** Add latency to the first call in a multi-call request so it uses 90 percent of the deadline. If the server still starts the next call, or responds after the gateway gave up, REL-02 failed.
3. **Count calls in an outage.** Make a dependency return 503 for every call, run normal traffic for five minutes, and count requests reaching it per logical operation. More than about 1 plus the retry budget means REL-04 failed.
4. **Throttle one tenant.** Have the fake Slack return 429 with `Retry-After: 10` for one workspace. Any call to that method for that workspace within 10 seconds, any throttling of other workspaces, or any message never sent means REL-05 failed.
5. **Succeed then drop.** Use a fake provider that performs the effect and then resets the connection. More than one effect, or a user-facing "failed", means REL-07 failed.
6. **Kill between commit and ack.** `kill -9` a consumer immediately after its commit. If the redelivered message produces a second effect, REL-08 (and CONC-04) failed.
7. **Poison pill.** Enqueue one message that always throws among normal traffic. If normal messages are delayed, if the bad one retries without bound, or if no alert fires when it is dead-lettered, REL-09 failed.
8. **Kill at every step.** For a multi-step flow, inject a crash at each step boundary across runs. Any record stuck in an intermediate state after the sweeper interval, or any duplicate external effect, means REL-10 failed.
9. **Deploy under load.** Run a rolling restart during a load test. Any 5xx, any job left claimed until lease expiry, or any `SIGKILL` in the container logs means REL-11 failed. Enqueue jobs with the previous release before the deploy; any failure on them means REL-12 failed.
10. **Fail the shared dependency.** Make the third-party API used on the main journey return 500s. If instances become unready or restart, REL-13 failed; if any screen shows empty or zero data as if real, REL-14 failed.

## Sources

1. AWS Builders' Library, "Timeouts, retries, and backoff with jitter". https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/
2. AWS Builders' Library, "Making retries safe with idempotent APIs". https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
3. Stripe Blog, post on idempotency keys and retries. https://stripe.com/blog/idempotency
4. Requests documentation, "Advanced Usage: Timeouts". https://requests.readthedocs.io/en/latest/user/advanced/#timeouts
5. Go standard library, `net/http` package documentation (`Client.Timeout`, `DefaultClient`). https://pkg.go.dev/net/http
6. undici documentation, "Client" (`headersTimeout`, `bodyTimeout`, `connectTimeout` defaults). https://raw.githubusercontent.com/nodejs/undici/main/docs/docs/api/Client.md
7. Node.js documentation, "Global objects" (`fetch`, `AbortSignal.timeout`, added in v17.3.0 and v16.14.0). https://nodejs.org/api/globals.html#fetch
8. Python documentation, "Coroutines and Tasks" (`asyncio.timeout`, `TaskGroup`, added in 3.11). https://docs.python.org/3/library/asyncio-task.html
9. AWS, "Summary of the AWS Service Event in the Northern Virginia (US-EAST-1) Region" (December 2021). https://aws.amazon.com/message/12721/
10. Cloudflare Blog, "Deep dive into Cloudflare's Sept 12 dashboard and API outage" (2025). https://blog.cloudflare.com/deep-dive-into-cloudflares-sept-12-dashboard-and-api-outage/
11. RFC 6585, "Additional HTTP Status Codes", section 4 (429 Too Many Requests). https://www.rfc-editor.org/rfc/rfc6585#section-4
12. Slack changelog, "Great rate limits" (2018; tiers, 429 and `Retry-After`). https://docs.slack.dev/changelog/2018/03/01/great-rate-limits
13. Slack API reference, `chat.postMessage` (rate limits and errors). https://docs.slack.dev/reference/methods/chat.postMessage
14. Google for Developers, "Usage limits" for the Gmail API. https://developers.google.com/workspace/gmail/api/reference/quota
15. Amazon SQS Developer Guide, "Amazon SQS standard queues". https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html
16. Amazon SQS Developer Guide, "Amazon SQS message quotas" (visibility timeout, message size, retention). https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
17. PostgreSQL 18 documentation, "Client Connection Defaults" (`statement_timeout`, `lock_timeout`). https://www.postgresql.org/docs/current/runtime-config-client.html
18. Google Cloud Blog, "Kubernetes best practices: terminating with grace". https://cloud.google.com/blog/products/containers-kubernetes/kubernetes-best-practices-terminating-with-grace
19. AWS Builders' Library, "Implementing health checks". https://aws.amazon.com/builders-library/implementing-health-checks/
20. Buttondown, "Public postmortem: database connection exhaustion" (incident 0024). https://buttondown.com/blog/incident-0024
21. Buttondown, "Public postmortem: external events backlog" (incident 0016). https://buttondown.com/blog/incident-0016
22. Slack Engineering, "Slack's Incident on 2-22-22". https://slack.engineering/slacks-incident-on-2-22-22/
23. Discord Blog, "How Discord Stores Trillions of Messages". https://discord.com/blog/how-discord-stores-trillions-of-messages
24. Amazon SQS Developer Guide, "Using dead-letter queues in Amazon SQS". https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html
25. Slack Engineering, "Slack's Outage on January 4th 2021". https://slack.engineering/slacks-outage-on-january-4th-2021/
