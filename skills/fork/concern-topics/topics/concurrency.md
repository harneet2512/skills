# Concurrency

**Protects:** Every piece of shared state ends up in the state that some serial order of the operations would have produced, no matter how requests, workers, retries and redeliveries interleave. No lost updates, no double effects, no limit exceeded because two actors checked at the same time.
**Read when:** The plan says "if it does not exist, create it", "check the balance, then charge", "only one", "at most N", "mark as processed", "claim the next job", "lock", "dedupe", "retry", "webhook", "worker", "queue", "cron", "multiple instances", "autoscale", "double click", "optimistic", "version". The code reads a row and writes it back, keeps state in a module-level `Map`, `dict` or global, awaits between a check and a write, uses `SELECT` followed by `INSERT` or `UPDATE`, takes a Redis lock, or runs more than one copy of a process.
**Prefix:** CONC

## Design questions

1. For each piece of shared state this step writes, who are all the actors that can write it at the same time (other requests, other instances, workers, cron, webhooks, admin tools, the same user in another tab)?
2. Which writes depend on a value read earlier? Where exactly does the guard live that keeps that value true until the write commits: a conditional `UPDATE`, a row lock, a unique constraint, a version check, or serializable isolation?
3. Which rules say "at most", "only one" or "never below zero"? Which database object enforces each one, by name?
4. If the same request, message or event arrives twice, possibly at the same instant on two instances, how many side effects happen, and which key makes the second one a no-op?
5. Which status fields change, and is each transition a single atomic `UPDATE ... WHERE status = <expected>` whose row count decides who won?
6. If a lock or lease is used, what happens when its holder pauses longer than the lease? What does the protected resource check to reject the stale holder?
7. Which transactions run at which isolation level, and which of them retry on SQLSTATE `40001` and `40P01`? Is the retried unit the whole transaction, with no side effects inside it?
8. What state lives in process memory (caches, maps, counters, in-flight sets, mutexes), and what breaks when there are two processes or one restarts?
9. Which code path awaits (I/O, a timer, a lock) between reading state and acting on it, and what can another task change during that await?
10. Which consumer assumes events arrive in order, or that a newer event never arrives before an older one? What makes a stale event harmless?

### The safety argument

Before building any step that writes shared state, write this table in the design. It turns "be careful about races" into a claim a reviewer can check and a test can attack.

| Shared state | Actors that write it | Interleaving that breaks it | Guard | Where the guard is enforced | Test that attacks it |
|---|---|---|---|---|---|
| `accounts.credits` for one account | API request, nightly top-up job, refund webhook | Two debits read 10, both write 10 minus cost | Conditional decrement `WHERE credits >= $cost` | Single SQL statement in `billing/credits.ts` | 50 parallel debits against a balance that covers 10; expect exactly 10 succeed and balance 0 |
| `invoices.status` | Send button, scheduled sender, retry worker | Two senders both see `draft` and both email the customer | `UPDATE ... WHERE status = 'draft' RETURNING` claims the transition | Invoice state module, CHECK constraint on allowed values | Fire send twice concurrently; expect one provider call |

Rules for filling it in:

- **Actors** includes every copy: if the API runs on three instances, that is three actors per endpoint. A retry is another actor. A redelivered message is another actor.
- **Interleaving** names the specific schedule, step by step (A reads, B reads, A writes, B writes). If you cannot name one, say why: for example, "only one statement touches this row and it is atomic".
- **Guard** is a mechanism that holds across processes. "We check first", a `setTimeout`, a disabled button, an in-process mutex and "it is fast" are not guards.
- **Where enforced** is one place. If three call sites each implement the guard, the fourth will not.
- Any row with an empty "Test" cell is an open risk and goes on the plan's risk list.

## Categories

### CONC-01 Lost update on read-modify-write

**How it fails:** Two actors read the same row, each computes a new value from what it read, and each writes the result back. The second write silently replaces the first. A counter loses increments, a balance loses a debit, a JSON settings column loses one user's change because another user saved the whole object. In Postgres at the default READ COMMITTED level, wrapping the read and the write in one transaction does not help: the plain `SELECT` takes no lock, so both transactions read the old value and both writes succeed one after the other [1].
**Seen in the wild:** No verified incident specific to a counter; the failure follows from documented READ COMMITTED semantics, where a plain `SELECT` sees a snapshot as of the start of that statement and does not block concurrent writers [1]. The Flexcoin loss in CONC-02 is the same read-then-write shape applied to a balance [3].
**Spot it in a plan:** "load the record, update the field, save"; "increment the counter"; "update the user's settings object"; "recalculate the total and store it"; an ORM `save()` of a whole entity after editing one field.
**Spot it in code:**
- TS/Node: `SELECT` followed by `UPDATE ... SET col = $1` where `$1` was computed in JS; Prisma `findUnique` then `update({ data: { n: row.n + 1 } })`; TypeORM or Sequelize `entity.x += 1; await entity.save()`.
- Python: Django `obj.count += 1; obj.save()`; SQLAlchemy `row.balance -= amt; session.commit()` without `with_for_update()` or a version column.
- Go: `QueryRow("SELECT ...").Scan(&v)` then `Exec("UPDATE ... SET v = $1", v+1)`.
- Any JSON or JSONB column written as a whole object from application memory.
**Build it right:** Strongest first. (1) Push the computation into one SQL statement so the database does the read and the write under the row lock: `SET n = n + 1`, `SET credits = credits - $1 WHERE credits >= $1`. Postgres re-evaluates the `WHERE` against the latest committed row version if another transaction updated it first [1]. (2) If the new value really needs application logic, use a version column (CONC-07) or `SELECT ... FOR UPDATE` in the same transaction. (3) For JSON documents, update individual keys with `jsonb_set` or move hot fields into their own columns. Keep all writes to the field in one owning module so nobody adds a read-modify-write path later.

Dangerous:
```ts
// Two concurrent calls both read credits = 10 and both write 10 - cost.
const { rows: [acct] } = await db.query(
  "SELECT credits FROM accounts WHERE id = $1", [accountId]);
if (acct.credits < cost) throw new InsufficientCredits(accountId);
await db.query("UPDATE accounts SET credits = $1 WHERE id = $2",
  [acct.credits - cost, accountId]);
```

Safe:
```ts
// One statement: the row lock plus WHERE re-evaluation make the check and the write atomic.
const { rows } = await db.query(
  `UPDATE accounts
      SET credits = credits - $1
    WHERE id = $2 AND credits >= $1
    RETURNING credits`,
  [cost, accountId]);
if (rows.length === 0) throw new InsufficientCredits(accountId);
```

**Prove it:** Seed a balance that covers exactly 10 debits. Fire 50 debits concurrently from separate connections (`Promise.all` over a pool of at least 10 connections, or `xargs -P 50 curl`). Assert exactly 10 succeed, 40 get the insufficient-credit error, and the final balance is 0. Run it 20 times; one flaky pass is a failure.
**Size for now:** Single-statement atomic updates cost nothing and belong in v1 everywhere a number or status changes. Hot-row contention (thousands of increments per second to one row) is a scale problem; see SCALE-06 before sharding a counter.

### CONC-02 Check-then-act across rows (limits, quotas, balances)

**How it fails:** The rule spans several rows: "at most 5 seats per plan", "no more than 3 active exports per user", "sum of allocations never exceeds the budget". Code counts or sums, decides the rule holds, then inserts. Two requests count 4 at the same moment, both insert, and the org now has 6 seats. A transaction does not fix this at READ COMMITTED or REPEATABLE READ, because neither insert conflicts with a row the other one locked; this is write skew [1].
**Seen in the wild:** Flexcoin, a Bitcoin exchange, shut down in March 2014 after an attacker sent many simultaneous transfer requests; each one checked the sending balance before any of them had debited it, which let the sender move coins it did not have, and about 896 BTC was lost [3].
**Spot it in a plan:** "if the user has fewer than N", "check the quota before creating", "ensure the total does not exceed", "only if no other active one exists" (when "one" is really "N").
**Spot it in code:** `SELECT count(*)` or `SELECT sum(...)` followed by `INSERT` in the same function; ORM `.count()` then `.create()`; `if len(existing) >= limit`.
**Build it right:** (1) Serialize the writers on a parent row: lock the row that owns the limit (`SELECT ... FROM orgs WHERE id = $1 FOR UPDATE`), then count and insert in the same transaction. Every code path that inserts must take the same lock, so put it in one function. (2) Keep a counter column on the parent and change it with a conditional update (`SET seats_used = seats_used + 1 WHERE seats_used < seat_limit`), with a CHECK constraint `seats_used <= seat_limit`. (3) Run the transaction at SERIALIZABLE and retry on `40001` (CONC-08). (4) For "at most one", use a partial unique index instead (CONC-10).

Dangerous:
```python
# psycopg 3, READ COMMITTED. Two requests both count 4 and both insert.
with conn.transaction():
    (n,) = conn.execute(
        "SELECT count(*) FROM seats WHERE org_id = %s", (org_id,)).fetchone()
    if n >= seat_limit:
        raise SeatLimitReached(org_id)
    conn.execute(
        "INSERT INTO seats (org_id, user_id) VALUES (%s, %s)", (org_id, user_id))
```

Safe:
```python
# The org row lock serializes every seat insert for this org.
with conn.transaction():
    (limit,) = conn.execute(
        "SELECT seat_limit FROM orgs WHERE id = %s FOR UPDATE", (org_id,)).fetchone()
    (n,) = conn.execute(
        "SELECT count(*) FROM seats WHERE org_id = %s", (org_id,)).fetchone()
    if n >= limit:
        raise SeatLimitReached(org_id)
    conn.execute(
        "INSERT INTO seats (org_id, user_id) VALUES (%s, %s)", (org_id, user_id))
```

**Prove it:** With a limit of 5 and 4 seats used, start 20 concurrent "add seat" requests for different users. Assert exactly one succeeds and the count is 5. Then grep for every `INSERT INTO seats` in the codebase; each must go through the locking function.
**Size for now:** A parent-row lock is fine up to hundreds of writes per second per parent, which covers almost every enterprise v1. Do not reach for distributed locks or SERIALIZABLE everywhere until a measured contention problem exists.

### CONC-03 Double submit and double click

**How it fails:** The user clicks "Pay", "Send" or "Create" twice, the browser retries a POST after a flaky network, or a mobile client resubmits on reconnect. The server sees two independent requests and creates two orders, sends two emails, or moves money twice. A disabled button only narrows the window in one client; it does nothing for retries, two tabs or a script.
**Seen in the wild:** In 2015 a researcher found that sending two identical Starbucks gift card balance-transfer requests at nearly the same time could get both recorded, turning a $5 transfer into $10 of credit [4].
**Spot it in a plan:** "the button is disabled after click", "the client will not send it twice", a POST that creates something with no client-supplied identifier.
**Spot it in code:** POST handlers that `INSERT` with only a server-generated id; no `Idempotency-Key` header or request id in the API schema; front-end code where the only guard is `setSubmitting(true)`.
**Build it right:** The client mints one key per user intent (when the form renders, not when the button is clicked) and sends it with every attempt. The server stores it under a unique constraint scoped to the account, in the same transaction as the created row, and returns the original result when it sees the key again (CONC-11 has the full contract). Keep the disabled button as UX on top, never as the guard.

Dangerous:
```ts
// Express. Each click creates a new order.
app.post("/orders", async (req, res) => {
  const order = await orders.create({ accountId: req.user.accountId, items: req.body.items });
  res.status(201).json(order);
});
```

Safe:
```ts
// Client: const intentKey = useMemo(() => crypto.randomUUID(), []); sent as Idempotency-Key.
// Schema: UNIQUE (account_id, client_key) on orders.
app.post("/orders", async (req, res) => {
  const key = req.get("Idempotency-Key");
  if (!key) return res.status(400).json({ error: "Idempotency-Key required" });
  const { rows } = await db.query(
    `INSERT INTO orders (account_id, client_key, items)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, client_key) DO NOTHING
     RETURNING *`,
    [req.user.accountId, key, JSON.stringify(req.body.items)]);
  if (rows.length) return res.status(201).json(rows[0]);
  const { rows: [existing] } = await db.query(
    "SELECT * FROM orders WHERE account_id = $1 AND client_key = $2",
    [req.user.accountId, key]);
  return res.status(200).json(existing);
});
```

**Prove it:** Send the same POST with the same key 10 times in parallel. Expect one row, one 201 and nine 200 responses carrying the same order id. Then send the same key with a different body and expect a rejection if the full CONC-11 contract is in place.
**Size for now:** A unique `(account_id, client_key)` column on the created table is enough for v1 when the request creates one row. Add the separate idempotency-key table from CONC-11 when a request causes external side effects.

### CONC-04 Duplicate delivery from queues and webhooks

**How it fails:** At-least-once delivery means the same message or event arrives more than once: the provider retries after a slow 2xx, a consumer crashes after doing the work but before acknowledging, or the broker simply delivers a copy. Two copies can arrive at the same instant on two consumer instances, so a "have I seen this?" check without an atomic guard lets both through.
**Seen in the wild:** No verified incident; the failure follows from documented delivery semantics. Stripe states that webhook endpoints "might occasionally receive the same event more than once", and that sometimes two separate Event objects are generated for one change, to be deduplicated on the object id plus event type [5]. Amazon SQS standard queues state that "more than one copy of a message might be delivered" [6].
**Spot it in a plan:** "when we receive the webhook we send the email"; "the consumer processes each message"; no mention of a processed-events record.
**Spot it in code:** Handlers that act on `event.data` without first recording `event.id`; dedupe implemented as `SELECT ... WHERE event_id = $1` then later `INSERT`; dedupe sets held in memory or in Redis with `GET` then `SET` instead of an atomic `SET NX`.
**Build it right:** Record the event id under a primary key in the same transaction as the database effect, and let the insert decide who proceeds. For effects outside the database (email, Slack, a third-party API), the inbox row only stops duplicate processing; the external call still needs its own idempotency key (CONC-11) or an outbox (DI-07), because the process can crash between the call and the commit.

Dangerous:
```python
@app.post("/webhooks/billing")
def billing_webhook():
    event = verify_and_parse(request)          # signature check elided
    if db.execute("SELECT 1 FROM processed_events WHERE id = %s",
                  (event["id"],)).fetchone():
        return "", 200
    apply_payment(event["data"]["object"])     # runs twice if two copies race
    db.execute("INSERT INTO processed_events (id) VALUES (%s)", (event["id"],))
    return "", 200
```

Safe:
```python
@app.post("/webhooks/billing")
def billing_webhook():
    event = verify_and_parse(request)
    with conn.transaction():
        claimed = conn.execute(
            "INSERT INTO processed_events (id, type) VALUES (%s, %s) "
            "ON CONFLICT (id) DO NOTHING RETURNING id",
            (event["id"], event["type"])).fetchone()
        if claimed is None:
            return "", 200                     # a copy already did (or is doing) the work
        apply_payment(conn, event["data"]["object"])   # DB writes only, same transaction
    return "", 200
```

**Prove it:** Deliver the same signed event twice within 50 ms to two different instances. Assert one row in `processed_events` and one effect. Then kill the handler after `apply_payment` but before commit and redeliver; assert the effect happens exactly once.
**Size for now:** A `processed_events` table with a primary key and a retention job (delete rows older than the provider's retry window plus a margin; Stripe retries for up to three days in live mode [5]) is enough. Exactly-once brokers and stream-processing frameworks are not needed for v1.

### CONC-05 Concurrent workers on the same job

**How it fails:** Several workers poll the same jobs table or run the same scheduled task. Each selects "the next pending job", and two of them pick the same row before either marks it running. The job runs twice. The same thing happens when a cron entry runs on every instance (SCALE-13) or when a job's lease expires while it is still running and another worker reclaims it.
**Seen in the wild:** GitHub reported in 2010 that "Monday morning's billing batch processed twice", charging customers twice; the void batch then missed some users, who were refunded by hand [14]. The post does not give the cause, but the visible effect is exactly what an unguarded batch run looks like.
**Spot it in a plan:** "workers pick up pending jobs", "the scheduler runs every minute", "scale workers horizontally", no word on how a job is claimed.
**Spot it in code:** `SELECT ... WHERE status = 'pending' LIMIT n` followed by a separate `UPDATE ... SET status = 'running'`; claim logic with no `FOR UPDATE SKIP LOCKED` or conditional `UPDATE`; lease or visibility timeouts shorter than the job's real run time.
**Build it right:** Claim with one atomic statement that both selects and marks, and returns only what this worker won. In Postgres, `FOR UPDATE SKIP LOCKED` in a subquery lets many workers claim disjoint rows without blocking each other; the docs call out queue-like tables as its intended use [9]. Give every claim a lease (`locked_until`) longer than the slowest real run, renew it for long jobs, and have the final status update check that this worker still holds the lease. Jobs must still be idempotent, because a lease can expire under a live worker (CONC-06).

Dangerous:
```go
rows, _ := db.QueryContext(ctx,
    `SELECT id, payload FROM jobs WHERE status = 'pending' ORDER BY run_at LIMIT 10`)
// ...scan ids...
for _, j := range jobs {
    db.ExecContext(ctx, `UPDATE jobs SET status = 'running' WHERE id = $1`, j.ID)
    process(j) // another worker selected the same ids a moment ago
}
```

Safe:
```go
rows, err := db.QueryContext(ctx, `
    UPDATE jobs
       SET status = 'running', locked_by = $1,
           locked_until = now() + interval '5 minutes', attempts = attempts + 1
     WHERE id IN (
           SELECT id FROM jobs
            WHERE (status = 'pending' AND run_at <= now())
               OR (status = 'running' AND locked_until < now())
            ORDER BY run_at
            LIMIT 10
            FOR UPDATE SKIP LOCKED)
    RETURNING id, payload`, workerID)
if err != nil {
    return err
}
defer rows.Close()
// Finish with: UPDATE jobs SET status = 'done' WHERE id = $1 AND locked_by = $2
// and treat 0 rows affected as "lost the lease": do not report success.
```

**Prove it:** Insert 1,000 jobs whose handler records `(job_id, worker_id)` into a table with no unique constraint. Run 8 workers until the queue drains. Assert 1,000 rows and no duplicate `job_id`. Then make one job sleep past its lease and assert the reclaim path runs it again and the job's effect is still applied once.
**Size for now:** A Postgres table with `SKIP LOCKED` handles thousands of jobs per minute and is the right v1 queue when the data already lives in Postgres. Move to a dedicated broker when measured throughput or fan-out needs it, not before.

### CONC-06 Distributed locks: lease expiry and fencing

**How it fails:** A process takes a lock with a timeout (Redis `SET NX PX`, a lease row, an advisory lock held by a session), then pauses: a long GC, a slow network call, a laptop going to sleep in a dev environment, a container being throttled. The lease expires, a second process takes the lock and writes, then the first process wakes up and writes too, believing it still holds the lock. Two writers, one lock.
**Seen in the wild:** Martin Kleppmann's analysis walks through this exact schedule: client 1 gets the lease, pauses, the lease expires, client 2 gets the lease and writes, client 1 resumes and writes. His fix is a fencing token: a number that increases on every grant, sent with every write, and checked by the storage, which rejects any token lower than one it has already seen. He notes that a lock service that only issues random values cannot provide this [2].
**Spot it in a plan:** "take a Redis lock so only one worker syncs this account", "use Redlock", "advisory lock around the job", a lock protecting a call to a third-party API.
**Spot it in code:** `SET key value NX PX`, `redlock`, `pg_try_advisory_lock` (session level) held across network calls, any lock acquire with no token passed to the protected write.
**Build it right:** First ask whether a lock is needed at all; a conditional update, a unique constraint or `SKIP LOCKED` claim (CONC-05, CONC-09, CONC-10) is usually simpler and has no expiry problem. If a lock is needed for efficiency only (avoid duplicate work, where duplicates are harmless), a simple lease is fine. If it is needed for correctness, the protected resource must check a fencing token. When the resource is a third-party API that cannot check tokens, a lock cannot make the call safe; make the call idempotent with the provider's idempotency key instead. Postgres session-level advisory locks ignore transaction rollback [11], and with PgBouncer in transaction pooling they are not supported at all (SCALE-07).

Dangerous:
```ts
const ok = await redis.set(`lock:sync:${accountId}`, workerId, { NX: true, PX: 30_000 });
if (!ok) return;
const changes = await crm.fetchChanges(cursor);   // may take longer than 30 s
await db.query("UPDATE sync_state SET cursor = $1 WHERE account_id = $2",
  [changes.nextCursor, accountId]);               // may run after another worker took over
```

Safe:
```ts
// Lease row with a fencing counter. The protected table remembers the highest fence it accepted.
const { rows } = await db.query(
  `UPDATE leases
      SET holder = $1, expires_at = now() + interval '30 seconds', fence = fence + 1
    WHERE name = $2 AND (holder IS NULL OR expires_at < now())
    RETURNING fence`,
  [workerId, `sync:${accountId}`]);
if (rows.length === 0) return;
const fence = rows[0].fence;
const changes = await crm.fetchChanges(cursor);
const res = await db.query(
  `UPDATE sync_state SET cursor = $1, last_fence = $2
    WHERE account_id = $3 AND last_fence <= $2`,
  [changes.nextCursor, fence, accountId]);
if (res.rowCount === 0) throw new LostLease(accountId);  // a newer holder already wrote
```

**Prove it:** Run two workers; inject a sleep longer than the lease into the first worker between fetch and write. Assert the second worker's write lands and the first worker's write is rejected with `LostLease`, and the cursor never moves backwards.
**Size for now:** Most v1 systems need zero distributed locks. Use a lease only to avoid duplicate work, and keep correctness in the database. Do not adopt Redlock or a consensus service for v1.

### CONC-07 Optimistic versus pessimistic concurrency control

**How it fails:** Two users edit the same record in two browser tabs. Both load version 3, both save; the second save overwrites the first with no warning (last write wins). The opposite mistake: a pessimistic `SELECT ... FOR UPDATE` held while the code calls an LLM or a payment API, so every other request for that row queues behind a multi-second network call, and connection pools drain. Postgres waits for row locks indefinitely unless a timeout is set, which the docs warn makes long-open transactions a bad idea [11].
**Seen in the wild:** No verified incident; the failure follows from documented lock-wait semantics [11] and from the lost-update behavior in CONC-01 [1].
**Spot it in a plan:** "users can edit the document", "the admin and the customer can both change the order", "lock the row while we process".
**Spot it in code:** Update endpoints that accept a full object and write it with no `version` or `updated_at` check; `FOR UPDATE` in a transaction that also contains `fetch`, `requests.`, `http.Client` or SDK calls; ORMs without `version_id_col` (SQLAlchemy) or equivalent on user-edited entities.
**Build it right:** Optimistic for user-facing edits and low contention: carry a version number to the client, write with `WHERE id = $1 AND version = $2`, and on zero rows return 409 with the current state so the user can merge. Pessimistic for short, high-contention critical sections entirely inside the database (CONC-02's parent-row lock). Never hold a row lock across a network call; split the work into a claim transaction, the external call, and a finish transaction (CONC-09). Set `lock_timeout` for request paths so a stuck lock fails fast instead of hanging the request.

Dangerous:
```sql
-- The form posts the whole object; whoever saves last wins silently.
UPDATE documents SET title = $1, body = $2, updated_at = now() WHERE id = $3;
```

Safe:
```sql
-- The client sends back the version it loaded.
UPDATE documents
   SET title = $1, body = $2, version = version + 1, updated_at = now()
 WHERE id = $3 AND version = $4
RETURNING version;
-- 0 rows: someone else saved first. Return 409 with the current row; do not retry blindly.
```

**Prove it:** Load the same document in two sessions, save from both. Assert the second save gets 409 and the stored body equals the first save. For pessimistic paths, add a test that holds the lock in one connection and asserts the second request fails within `lock_timeout` instead of hanging.
**Size for now:** A `version integer` column on every user-editable entity is cheap and belongs in v1. Real-time collaborative editing (CRDTs, operational transforms) is a product decision, not a default.

### CONC-08 Postgres isolation level pitfalls

**How it fails:** Teams assume "it is in a transaction, so it is safe". At READ COMMITTED (the Postgres default) each statement takes a fresh snapshot, so two `SELECT`s in one transaction can disagree, and an `UPDATE` that waited for a lock re-checks its `WHERE` against the new row version, which the docs show can make a `DELETE` skip a row that matched both before and after a concurrent update [1]. At REPEATABLE READ, write skew is still possible (two transactions each read a set, each write a different row, the combination breaks the rule). At SERIALIZABLE and REPEATABLE READ, Postgres aborts conflicting transactions with SQLSTATE `40001`, and the docs say applications must be prepared to retry them, retrying the whole transaction from the start [1]. Code that sets SERIALIZABLE but has no retry turns races into user-visible 500s; code that retries only the failing statement is wrong.
**Seen in the wild:** No verified incident; the behavior is specified in the Postgres 18 documentation, including the READ COMMITTED `DELETE` example and the retry requirement [1].
**Spot it in a plan:** "we will use serializable isolation" with no retry design; "the transaction makes it atomic" for a rule that spans rows.
**Spot it in code:** `ISOLATION LEVEL SERIALIZABLE` or `REPEATABLE READ` with no handler for `40001`; generic retry decorators that retry on any exception; transactions that call external APIs or send messages (side effects that a retry would repeat); Python `SerializationFailure` or Node error `code === '40001'` absent from the codebase.
**Build it right:** Pick the level per transaction and write it in the safety argument. Default to READ COMMITTED plus single-statement guards, row locks or constraints. Where a rule spans rows and a parent lock is awkward, use SERIALIZABLE with one shared retry wrapper that re-runs the whole transaction function, retries on `40001` and `40P01` (deadlock) with bounded attempts and jitter, and forbids side effects inside the function. Declare read-only transactions `READ ONLY`; the docs note read-only transactions at REPEATABLE READ never have serialization conflicts [1].

Dangerous:
```python
# Rule: at least one on-call engineer per shift. Two engineers go off call at once.
with conn.transaction():
    conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
    (n,) = conn.execute(
        "SELECT count(*) FROM on_call WHERE shift_id = %s AND active", (shift,)).fetchone()
    if n > 1:
        conn.execute("UPDATE on_call SET active = false "
                     "WHERE shift_id = %s AND user_id = %s", (shift, me))
# Both see n = 2, each deactivates a different row: write skew, zero on call.
```

Safe:
```python
import random, time
from psycopg import errors

def run_serializable(conn, fn, attempts=5):
    """fn(conn) must only touch the database: no emails, no HTTP, no queue publishes."""
    for i in range(attempts):
        try:
            with conn.transaction():
                conn.execute("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE")
                return fn(conn)
        except (errors.SerializationFailure, errors.DeadlockDetected):
            if i == attempts - 1:
                raise
            time.sleep(random.uniform(0, 0.02 * 2 ** i))

def go_off_call(conn, shift, me):
    def tx(c):
        (n,) = c.execute("SELECT count(*) FROM on_call WHERE shift_id = %s AND active",
                         (shift,)).fetchone()
        if n <= 1:
            raise LastOnCall(shift)
        c.execute("UPDATE on_call SET active = false WHERE shift_id = %s AND user_id = %s",
                  (shift, me))
    run_serializable(conn, tx)
```

**Prove it:** Two connections, a barrier so both have run the `SELECT` before either updates, then both commit. At REPEATABLE READ the test shows zero on call (the bug reproduces). With the wrapper, one transaction gets `40001`, retries, sees one on call, and raises `LastOnCall`. Count retries in a metric so production shows how often it happens.
**Size for now:** One retry wrapper and a decision per transaction is enough. Do not switch the whole database default to SERIALIZABLE in v1 unless every transaction path has the retry wrapper.

### CONC-09 State transitions as atomic conditional updates

**How it fails:** Code reads a record's status, checks it in application code, does work, then writes the new status. Two actors (a user click and a scheduled job, or two retries) both see `draft`, both send the invoice, both write `sent`. Or a cancel lands between the check and the send, and the cancelled invoice still goes out. Status columns with free-form text also accept impossible values (`'snet'`) or impossible jumps (`paid` back to `draft`).
**Seen in the wild:** No verified incident; the failure follows from the same READ COMMITTED semantics as CONC-01, and the fix relies on the documented `WHERE` re-evaluation for concurrent `UPDATE`s [1].
**Spot it in a plan:** "when the user clicks send, if the invoice is a draft we email it and mark it sent"; status diagrams with no word on who wins a race.
**Spot it in code:** `if (invoice.status === 'draft')` followed by an `await` and then an update; status columns typed as `text` with no CHECK or enum; updates of the form `SET status = $1 WHERE id = $2` with no expected-status predicate.
**Build it right:** Make every transition one statement: `UPDATE ... SET status = 'sending' WHERE id = $1 AND status = 'draft' RETURNING ...`. The row count decides the winner; losers stop. For transitions that involve an external effect, use an intermediate claimed state (`sending`), do the effect with an idempotency key derived from the record id, then move `sending` to `sent` with another conditional update. A sweeper finds rows stuck in `sending` past a deadline and resolves them by asking the provider (REL-10). Enforce allowed values with an enum or CHECK constraint, and keep all transitions in one module that owns the state machine.

Dangerous:
```ts
const inv = await invoices.get(id);
if (inv.status !== "draft") return;
await mailer.send(renderInvoice(inv));               // two callers both get here
await db.query("UPDATE invoices SET status = 'sent' WHERE id = $1", [id]);
```

Safe:
```ts
const { rows: [inv] } = await db.query(
  `UPDATE invoices SET status = 'sending', sending_started_at = now()
    WHERE id = $1 AND status = 'draft'
    RETURNING *`, [id]);
if (!inv) return;                                    // someone else claimed it, or it was cancelled
await mailer.send(renderInvoice(inv), { idempotencyKey: `invoice-send:${inv.id}` });
await db.query(
  "UPDATE invoices SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'sending'",
  [id]);
// Schema: status invoice_status NOT NULL (enum: draft, sending, sent, cancelled, failed)
```

**Prove it:** Fire "send" from the API and the scheduler at the same moment 100 times; assert one mail per invoice. Fire "cancel" and "send" concurrently; assert either cancelled with no mail or sent with the cancel rejected, never both. Crash the worker after `mailer.send` and assert the sweeper resolves the row without a second mail.
**Size for now:** Conditional updates and an enum are v1 requirements. A workflow engine is not; add one when flows span many steps and days and the hand-rolled sweeper becomes the bug source.

### CONC-10 Unique constraints as concurrency control

**How it fails:** "Create the user if the email is not taken", "create the Slack channel mapping if none exists", "one active subscription per account". Code checks with a `SELECT`, finds nothing, and inserts. Two concurrent requests both find nothing and both insert: duplicate users, two subscriptions, two mappings. Even under SERIALIZABLE, the Postgres docs warn that unique violations can still appear after an explicit existence check, so the application must handle them [1].
**Seen in the wild:** No verified incident; the behavior is documented: the Postgres 18 isolation docs describe unique violations under concurrent SERIALIZABLE inserts after a check [1], and `INSERT ... ON CONFLICT DO UPDATE` is documented to guarantee an atomic insert-or-update outcome even under high concurrency [10].
**Spot it in a plan:** "if it does not exist, create it", "find or create", "only one active X per Y", "emails are unique (we check at signup)".
**Spot it in code:** `get_or_create` on a column with no unique constraint; `findFirst` then `create`; `SELECT` then `INSERT` with the same key; uniqueness rules that exist only in validation code; case-sensitive unique indexes on emails.
**Build it right:** Put the rule in a unique index, including partial unique indexes for "only one active" rules (`CREATE UNIQUE INDEX ... WHERE status = 'active'`, a pattern the Postgres docs show for "only one successful entry per subject" [12]) and expression indexes for case-insensitive keys (`lower(email)`). Then write with `INSERT ... ON CONFLICT` and treat SQLSTATE `23505` as a normal, expected outcome mapped to a clear response. Note that `ON CONFLICT DO NOTHING ... RETURNING` returns no row for the conflicting key, so follow it with a `SELECT` when the caller needs the existing row [10].

Dangerous:
```go
var id int64
err := db.QueryRowContext(ctx,
    `SELECT id FROM users WHERE email = $1`, email).Scan(&id)
if errors.Is(err, sql.ErrNoRows) {
    err = db.QueryRowContext(ctx,
        `INSERT INTO users (email) VALUES ($1) RETURNING id`, email).Scan(&id)
}
```

Safe:
```go
// Migration: CREATE UNIQUE INDEX users_email_key ON users (lower(email));
err := db.QueryRowContext(ctx, `
    INSERT INTO users (email) VALUES ($1)
    ON CONFLICT ((lower(email))) DO NOTHING
    RETURNING id`, email).Scan(&id)
if errors.Is(err, sql.ErrNoRows) {
    err = db.QueryRowContext(ctx,
        `SELECT id FROM users WHERE lower(email) = lower($1)`, email).Scan(&id)
}
```

**Prove it:** Fire 20 concurrent signups with `Alice@x.com` and `alice@x.com`. Assert one row. Then try to bypass the API with a raw insert; the database must reject it.
**Size for now:** Every "only one" rule gets a unique index in v1. This is the cheapest concurrency control there is.

### CONC-11 Idempotency keys for operations with side effects

**How it fails:** A client retries a request that charges a card, sends a message, or provisions a resource, because the first response was lost. Without a key, the server runs it again. With a naive key (a Redis `GET` then `SET` after the work, or a key stored only after the side effect succeeds), two concurrent retries both pass the check, or a crash between the side effect and the key write makes the next retry repeat the effect. A key reused with a different payload silently returns the wrong cached result.
**Seen in the wild:** No verified incident; the failure mode is documented by AWS, which describes a caller that gets no response after a successful call and cannot tell whether to retry, and recommends a caller-provided request id that returns a semantically equivalent response for every retry and a validation error when the parameters differ [13]. Stripe's idempotency design (Brandur Leach) stores keys in Postgres under a unique `(user_id, idempotency_key)` index, with `locked_at` to turn away concurrent duplicates and recovery points so a retry resumes after a crash [8].
**Spot it in a plan:** An API that creates charges, sends, bookings or provisioning with no idempotency story; "the client should not retry".
**Spot it in code:** Keys checked in a cache with TTL and no atomic claim; keys written after the side effect; no request-hash comparison; no state for "in progress".
**Build it right:** An `idempotency_keys` table with a unique `(account_id, key)`, the request method, path and a hash of the parameters, a `locked_at`, a `recovery_point` and the stored response. Flow: insert the key first (atomic claim); if it exists with a different hash return 422; if it is locked and fresh return 409; if it is finished return the stored response. Do database work in transactions that also advance the recovery point; call external services with a key derived from yours, so a resumed attempt does not repeat the external effect [8]. Expire keys after a stated window that is longer than any client's retry horizon.

Dangerous:
```python
def create_charge(account_id, key, params):
    if redis.get(f"idem:{key}"):                     # two retries both see None
        return json.loads(redis.get(f"idem:{key}"))
    charge = psp.charge(params)                      # crash here: key never stored
    redis.set(f"idem:{key}", json.dumps(charge), ex=86400)
    return charge
```

Safe:
```python
def create_charge(conn, account_id, key, params):
    h = sha256(canonical_json(params))
    with conn.transaction():
        row = conn.execute(
            "INSERT INTO idempotency_keys (account_id, key, request_hash, locked_at) "
            "VALUES (%s, %s, %s, now()) ON CONFLICT (account_id, key) DO NOTHING "
            "RETURNING id", (account_id, key, h)).fetchone()
    if row is None:
        existing = load_key(conn, account_id, key)
        if existing.request_hash != h:
            raise Unprocessable("key reused with different parameters")
        if existing.response is not None:
            return existing.response
        if existing.locked_at > now() - LOCK_TTL:
            raise Conflict("request in progress")
        # stale lock: this attempt takes over (re-lock with a conditional update, elided)
    charge = psp.charge(params, idempotency_key=f"{account_id}:{key}")  # provider dedupes too
    with conn.transaction():
        conn.execute("UPDATE idempotency_keys SET response = %s, locked_at = NULL "
                     "WHERE account_id = %s AND key = %s",
                     (Json(charge), account_id, key))
    return charge
```

**Prove it:** (1) Same key, same body, 10 concurrent requests: one provider call, the rest 409 or the stored response. (2) Same key, different body: 422. (3) Kill the process after `psp.charge` returns and before the final update; retry; assert one charge at the provider (check the provider's dashboard or sandbox API).
**Size for now:** Required in v1 for any endpoint that moves money or sends something outside the system. Endpoints that only create one database row can use CONC-03's unique column instead.

### CONC-12 In-process state across multiple instances

**How it fails:** Code keeps shared truth in process memory: a `Map` of "jobs in progress", an in-memory dedupe set, a per-user rate limit counter, an `async-mutex` around "sync this account", a cached feature flag or permission. It works with one instance. With two instances behind a load balancer (or after a restart, or in serverless where every invocation can be a new process), each instance has its own copy: the mutex does not exclude, the dedupe set misses, the rate limit is multiplied by the instance count, and a permission revoked on one instance is still cached on the other.
**Seen in the wild:** No verified incident; the failure follows from process isolation itself. The Python FAQ's "When in doubt, use a mutex" advice covers threads in one process only [7]; nothing in a language runtime coordinates separate processes.
**Spot it in a plan:** "keep a map of active syncs", "cache it in memory", "rate limit in middleware", "we only run one instance" (true today, false after the first autoscale event).
**Spot it in code:** Module-level `const inFlight = new Map()`, `new Mutex()`, `lru-cache` holding authorization data, Python module globals and `functools.lru_cache` on functions that read mutable data, Go package-level `sync.Mutex` guarding business invariants.
**Build it right:** Shared truth lives in the database (or Redis with atomic operations), never in process memory. In-process memory is fine for pure caches of immutable data, or data where staleness for a bounded TTL is acceptable and written down; set the TTL to the staleness you can tolerate, and invalidate permission and billing caches explicitly or not at all. In-process locks are fine for protecting in-process data structures only.

Dangerous:
```ts
import { Mutex } from "async-mutex";
const locks = new Map<string, Mutex>();
export async function syncAccount(id: string) {
  const m = locks.get(id) ?? locks.set(id, new Mutex()).get(id)!;
  await m.runExclusive(() => doSync(id));   // instance B has its own Map and runs concurrently
}
```

Safe:
```ts
// Claim in the database; every instance sees the same row.
export async function syncAccount(id: string, workerId: string) {
  const { rowCount } = await db.query(
    `UPDATE accounts SET syncing_by = $2, sync_lease_until = now() + interval '2 minutes'
      WHERE id = $1 AND (sync_lease_until IS NULL OR sync_lease_until < now())`,
    [id, workerId]);
  if (rowCount === 0) return;               // another instance is syncing
  try { await doSync(id); }                 // doSync must be idempotent: leases can expire
  finally {
    await db.query(
      "UPDATE accounts SET sync_lease_until = NULL WHERE id = $1 AND syncing_by = $2",
      [id, workerId]);
  }
}
```

**Prove it:** Run two instances locally (two ports behind a simple proxy, or two containers). Trigger the operation on both at once; assert one execution. Restart one instance mid-operation; assert no state was lost that the other needed.
**Size for now:** Assume at least two instances from day one; a rolling deploy alone gives you two for a while. A shared Redis is optional; Postgres is usually enough.

### CONC-13 Async interleavings and threads in one process

**How it fails:** In Node and Python asyncio, code between two `await`s is not interrupted, which tempts people to think async code has no races. But every `await` is a point where other tasks run. `if (!cache.has(k)) { v = await fetchToken(); cache.set(k, v) }` lets 50 concurrent requests all miss and all refresh the token, multiplying load on the provider and, where the provider rotates refresh tokens, leaving some callers with a token that no longer works. `balance = balance - x` across an await loses updates exactly like CONC-01. With Python threads, the GIL makes single bytecode operations atomic, but compound operations are not: the Python FAQ lists `i = i+1` and `D[x] = D[x] + 1` as not atomic [7]. Free-threaded CPython builds (PEP 703) remove even the GIL's incidental protection, and the FAQ does not say the atomic list still holds there [7].
**Seen in the wild:** No verified incident; the failure follows from documented semantics, see the Python FAQ's list of non-atomic operations [7]. The async variant follows from cooperative scheduling: other tasks run while one is suspended at an `await`.
**Spot it in a plan:** "cache the token and refresh when it expires", "keep a running total in memory", "it is single-threaded so it is safe".
**Spot it in code:**
- Node: a `has`/`get` check, then `await`, then `set`; module-level counters mutated inside async functions; `Promise.all` over operations that write the same object.
- Python asyncio: the same check, `await`, act shape; shared dicts mutated across awaits.
- Python threads: `+=` on shared ints or dict values from `ThreadPoolExecutor` workers; `if key not in d: d[key] = expensive()`.
- Go: maps written from multiple goroutines without a mutex (run tests with `-race`).
**Build it right:** Single-flight: store the in-flight promise (or `asyncio.Task`), not the result, so concurrent callers await the same refresh. Protect in-process shared structures with `threading.Lock`, `asyncio.Lock` or `sync.Mutex`, and never hold them across slow I/O unless the I/O is what you are deduplicating. Remember all of these are per process (CONC-12). In Go, run the test suite with `go test -race` in CI.

Dangerous:
```ts
let token: { value: string; exp: number } | undefined;
export async function getToken() {
  if (!token || token.exp < Date.now()) {
    token = await oauth.refresh();          // 50 concurrent callers each refresh
  }
  return token.value;
}
```

Safe:
```ts
let token: { value: string; exp: number } | undefined;
let refreshing: Promise<{ value: string; exp: number }> | undefined;
export async function getToken() {
  if (token && token.exp - 60_000 > Date.now()) return token.value;
  refreshing ??= oauth.refresh().finally(() => { refreshing = undefined; });
  token = await refreshing;                 // everyone awaits the same refresh
  return token.value;
}
```

Python threads, same idea:
```python
import threading
_lock = threading.Lock()
_counts: dict[str, int] = {}

def record(key: str) -> None:
    with _lock:                                  # D[x] = D[x] + 1 is not atomic [7]
        _counts[key] = _counts.get(key, 0) + 1
```

**Prove it:** Call `getToken()` 100 times with `Promise.all` against a fake OAuth server that counts refreshes; assert one refresh. For threads, run 16 threads doing 100,000 increments each and assert the exact total. For Go, `go test -race ./...` must be clean.
**Size for now:** Single-flight for token refresh and per-process locks are v1 basics. Cross-instance token refresh coordination (store the token in the database with a lease) is needed only if the provider revokes old tokens on refresh; check the provider's docs.

### CONC-14 Ordering assumptions

**How it fails:** A consumer applies events in arrival order and assumes that is the order they happened. A `subscription.updated` carrying `past_due` arrives after the one carrying `active` even though it happened first; the account is suspended although it paid. Two workers process events for the same entity in parallel, and the slower one writes last. Timestamps do not save you: Stripe's `created` is in seconds, so distinct events can share a timestamp, and Stripe says not to use it to order events or detect duplicates [5]. SQS standard queues may deliver out of order [6].
**Seen in the wild:** No verified incident; the failure follows from documented delivery semantics. Stripe states it does not guarantee delivery in the order events are generated and tells integrators not to depend on order [5].
**Spot it in a plan:** "we update our copy from the webhook payload"; "process events in order"; "last write wins".
**Spot it in code:** Handlers that copy fields from the event payload straight onto the row; ordering by `created_at` from the event; multiple consumers on one queue with no per-entity partitioning; FIFO queues used without a per-entity message group.
**Build it right:** Prefer refetching the current object from the source of truth when an event arrives, and store that (the event is a hint that something changed). If you must apply the payload, store a monotonic version from the source (a sequence number, a version field, or the provider's `updated` field only if it is strictly increasing per object) and apply with `WHERE stored_version < incoming_version`. For your own queues, partition by entity id (SQS FIFO message group, Kafka key) so one entity's events are processed serially.

Dangerous:
```python
def on_subscription_updated(event):
    sub = event["data"]["object"]
    db.execute("UPDATE subscriptions SET status = %s WHERE provider_id = %s",
               (sub["status"], sub["id"]))     # an older event arriving late wins
```

Safe:
```python
def on_subscription_updated(event):
    provider_id = event["data"]["object"]["id"]
    current = provider.subscriptions.retrieve(provider_id)   # source of truth, now
    db.execute(
        "UPDATE subscriptions SET status = %s, synced_at = now() WHERE provider_id = %s",
        (current["status"], provider_id))
```

**Prove it:** Deliver `updated(active)` and `updated(past_due)` in reverse order, and also concurrently to two workers. Assert the stored state matches the provider's current state in every run.
**Size for now:** Refetch-on-event is simple and correct for v1 volumes. Watch the provider's read rate limit (SCALE-09); if refetching would exceed it, switch to versioned apply.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "It is in a transaction, so it is atomic." | At READ COMMITTED a plain `SELECT` takes no lock and sees a per-statement snapshot; read-then-write in one transaction still loses updates [1]. | Single-statement conditional updates, row locks, constraints, or SERIALIZABLE with retry. |
| "Node is single-threaded, so there are no races." | Every `await` lets other tasks run, and there is more than one process in production. | Treat each `await` between check and act as a race window; guard in the database. |
| "The GIL makes it thread-safe." | The GIL makes single bytecodes atomic; `i = i+1` and `D[x] = D[x] + 1` are listed as not atomic [7]. | Use a lock for compound operations. |
| "We disable the button after the first click." | Retries, second tabs, mobile reconnects and scripts all bypass a disabled button. | Idempotency key per user intent, enforced by a unique constraint. |
| "The provider sends each webhook once." | Stripe and SQS document duplicate delivery and no ordering guarantee [5][6]. | Dedupe on event id in the same transaction as the effect; refetch or version-check for order. |
| "We take a Redis lock, so only one worker runs." | Leases expire under paused holders; without a fencing check at the resource, two writers proceed [2]. | Avoid the lock (claim rows atomically) or fence every protected write. |
| "Collisions are rare, it is a tiny window." | Retries, bursts and batch jobs make windows hit; attackers widen them on purpose (Flexcoin, Starbucks) [3][4]. | Write the safety argument; if you cannot name the guard, there is none. |
| "We use SERIALIZABLE, so we are covered." | Postgres aborts conflicting transactions with `40001`; without a whole-transaction retry, users see errors [1]. | One retry wrapper, no side effects inside the transaction. |
| "We only run one instance." | Rolling deploys, autoscaling, serverless and a second region all create more. | Assume two or more from day one. |

## Attack recipes

1. **Parallel debit.** Seed a balance that covers exactly N operations. Fire 5N concurrent requests from 5N connections (`seq 500 | xargs -P 100 -I{} curl -s -X POST .../debit`). Any final balance other than 0, or more than N successes, means CONC-01 or CONC-02 failed.
2. **Double click at the wire.** Capture one POST in the browser's network tab, "Copy as cURL", and replay it 10 times in parallel, with and without the `Idempotency-Key` header. More than one created row means CONC-03 failed; a 2xx without the header on a side-effecting endpoint means the key is optional and CONC-11 is not enforced.
3. **Webhook twin.** Deliver the same signed webhook twice within 50 ms, to two different instances (bypass the load balancer by hitting instance IPs). More than one row in the effect table or more than one outbound send means CONC-04 failed.
4. **Reverse order.** Replay two real `*.updated` events for one object in reverse order. If the stored state differs from the provider's current state, CONC-14 failed.
5. **Worker pile-up.** Start 8 workers against 1,000 jobs whose handler logs `(job_id, worker_id)` to an unconstrained table. Any duplicate `job_id` means CONC-05 failed. Then pause one worker (`kill -STOP`) past its lease and resume it (`kill -CONT`); if its late write lands, CONC-06 failed.
6. **Barrier race for write skew.** In a test, open two connections, run the read part of the transaction in both, wait on a barrier, then run both writes and commit. If the invariant breaks, CONC-02 or CONC-08 failed for that transaction.
7. **Two-instance mutex check.** Run two app instances, trigger the "exclusive" operation on both simultaneously. If both run, CONC-12 failed.
8. **Token stampede.** Expire the cached OAuth token, then make 100 concurrent requests that need it. More than one refresh call at the fake provider means CONC-13 failed.
9. **Serialization retry visibility.** Under SERIALIZABLE, run a contention test and grep logs for SQLSTATE `40001` surfacing as HTTP 500. Any user-visible `40001` means the retry wrapper in CONC-08 is missing or bypassed.
10. **Constraint bypass.** For every "only one" or "at most N" rule in the safety argument, attempt the violating write with raw SQL. If the database accepts it, the rule is enforced only in app code (CONC-10, CONC-02).

## Sources

1. PostgreSQL 18 documentation, "Transaction Isolation". https://www.postgresql.org/docs/current/transaction-iso.html
2. Martin Kleppmann, "How to do distributed locking" (2016). https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
3. Hacking, Distributed, "Another One Bites the Dust: Flexcoin" (2014). https://hackingdistributed.com/2014/04/06/another-one-bites-the-dust-flexcoin
4. Bruce Schneier, "Race Condition Exploit in Starbucks Gift Cards" (2015). https://www.schneier.com/blog/archives/2015/05/race_condition_.html
5. Stripe documentation, "Receive Stripe events in your webhook endpoint" (duplicate events, event ordering, retries). https://docs.stripe.com/webhooks
6. Amazon SQS Developer Guide, "Amazon SQS standard queues". https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html
7. Python documentation, Library and Extension FAQ, "What kinds of global value mutation are thread-safe?". https://docs.python.org/3/faq/library.html#what-kinds-of-global-value-mutation-are-thread-safe
8. Brandur Leach, "Implementing Stripe-like Idempotency Keys in Postgres". https://brandur.org/idempotency-keys
9. PostgreSQL 18 documentation, "SELECT" (locking clause, `SKIP LOCKED`). https://www.postgresql.org/docs/current/sql-select.html
10. PostgreSQL 18 documentation, "INSERT" (`ON CONFLICT`). https://www.postgresql.org/docs/current/sql-insert.html
11. PostgreSQL 18 documentation, "Explicit Locking" (lock waits, advisory locks). https://www.postgresql.org/docs/current/explicit-locking.html
12. PostgreSQL 18 documentation, "Partial Indexes" (partial unique index example). https://www.postgresql.org/docs/current/indexes-partial.html
13. AWS Builders' Library, "Making retries safe with idempotent APIs". https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/
14. GitHub Blog, "Revenge of the Double Billing" (2010). https://github.blog/2010-08-04-revenge-of-the-double-billing/
