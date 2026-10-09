# Scale

**Protects:** The system keeps its latency, correctness and cost targets at ten times today's real load, for an enterprise product with real customers: hundreds of tenants, some of them large, not billions of users. Work grows with what the user asked for, not with the size of the table, the number of followers, or the number of instances.
**Read when:** The plan lists items, syncs data from a provider, sends to many recipients, adds a query, a list endpoint, an export, a report, a background job, a webhook consumer, a cron, a cache, or a new deployment target (serverless, more instances, a second worker type). In code: loops that call the database or an API, `.all()`, `findMany()` without `take`, `OFFSET`, `SELECT *` without `LIMIT`, `Promise.all(items.map(...))`, `new Pool(` inside a handler, `setInterval`/`node-cron`/`schedule` inside the web process, `readFileSync`/`json.load` on user data, a counter column updated per request.
**Prefix:** SCALE

## Design questions

1. What are today's numbers for this path (requests per second at peak, rows per tenant for the largest tenant, items per sync, recipients per send), and what are they at 10x? Where did each number come from?
2. How many queries and outbound calls does one request make, and does that count grow with the number of items shown or processed?
3. Is every list query bounded by a `LIMIT` the server enforces, and does pagination use a key rather than an offset?
4. Which index serves each new query, and what does `EXPLAIN (ANALYZE, BUFFERS)` show on production-sized data for the largest tenant?
5. For each event, how many downstream calls, messages or queries does it trigger, and what is the worst case (the largest channel, account or audience)?
6. Which single rows or keys receive writes from many requests at once (counters, "last seen", a tenant's settings row, a sequence)?
7. How many database connections can exist at peak (instances times pool size, or concurrent functions times connections), and how does that compare to `max_connections` minus reserved slots?
8. If producers outrun consumers for an hour, what grows, what alerts, and does one tenant's backlog delay everyone else?
9. Which third-party limits cap this path (per method, per workspace, per user, per day), and how long does the largest tenant's job take within them?
10. Which payloads (messages, requests, responses, webhooks, files) can exceed a platform size limit, and what happens when they do?
11. Which loops do one network round trip per item where a batch call exists?
12. What is the peak memory of each job for the largest tenant, and is any step loading a whole table, file or API result set into memory?
13. What breaks when there are two instances, ten instances, or zero (scaled to zero): in-memory state, schedulers, sessions, local files?

## Categories

### SCALE-01 Size from real numbers: the 10x rule

**How it fails:** Capacity is assumed instead of measured. Tests run against a database with ten rows and a load of one user. The largest tenant (often 50 to 100 times the median) is not in the test data. The first big customer, a month-start burst or a backfill hits limits nobody wrote down: file descriptors, autoscaling group caps, quotas, a provisioning service that itself depends on the thing that is failing. The opposite failure is real too: designing sharding, multi-region and event sourcing for a scale no customer has, and shipping late with more moving parts to break.
**Seen in the wild:** During Slack's 4 January 2021 outage, Slack tried to add 1,200 servers to its web tier in about 15 minutes; the provisioning service hit the Linux open-files limit and an AWS quota, and broken instances filled the pre-configured autoscaling group size limits, which blocked healthy capacity [1]. Limits that are invisible at normal load decided the outcome at 10x.
**Spot it in a plan:** "should scale fine", "we can add servers", no numbers; or the reverse, "we need Kafka and sharding" with no numbers either.
**Spot it in code:** Load tests with a handful of virtual users; fixtures with tiny tables; hard-coded pool sizes, worker counts and batch sizes with no comment on where they came from; no record of the largest tenant's row counts.
**Build it right:** For each journey, write today's peak and the largest tenant's volume, then test at 10x of both: 10x request rate against data seeded to 10x the largest tenant. Find the first thing that breaks and decide whether it needs fixing now (it breaks below 10x) or gets a written trigger ("revisit when the largest tenant passes 2 million contacts"). List the hard ceilings you depend on (connection limits, provider quotas, autoscaling maximums, file descriptor limits, function concurrency quotas) with their current values.

Dangerous:
```js
// k6: five users, empty database, 30 seconds. Passing this says nothing about production.
export const options = { vus: 5, duration: "30s" };
export default function () { http.get(`${__ENV.BASE}/api/contacts`); }
```

Safe:
```js
// k6 against staging seeded to 10x the largest tenant (e.g. 2M contacts, 40M activities).
import http from "k6/http";
export const options = {
  scenarios: {
    tenx: {
      executor: "constant-arrival-rate",
      rate: 400, timeUnit: "1s",          // today's peak is 40 rps on this endpoint
      duration: "10m", preAllocatedVUs: 200, maxVUs: 800,
    },
  },
  thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(99)<800"] },
};
export default function () {
  http.get(`${__ENV.BASE}/api/contacts?limit=50`, { headers: { Authorization: `Bearer ${__ENV.TOKEN}` } });
}
```

**Prove it:** The load test above passes its thresholds, and the report names the first limit hit when the rate is pushed further (a pool, a CPU, a quota). The design doc has the numbers table and the written triggers.
**Size for now:** This category is the size rule for all the others: build for 10x today, document the trigger for the next step, and do not build for 1,000x.

### SCALE-02 N+1 queries

**How it fails:** Code loads a list, then for each item loads a related record, one query per item. A page of 50 orders makes 51 queries; an export of 20,000 orders makes 20,001. Each query is fast in isolation, so profiling a single request on test data shows nothing, but latency grows linearly with list size and the database spends its time on round trips. ORMs make this invisible because attribute access issues queries lazily.
**Seen in the wild:** No verified incident; the failure follows from lazy loading. The Django documentation warns that retrieving parts of one set of data with many queries, especially in a loop, is less efficient than one query, and points to `select_related()` and `prefetch_related()` [2].
**Spot it in a plan:** "show each order with its customer and last activity", "for each contact, look up the company".
**Spot it in code:**
- Django: attribute access to a foreign key inside a loop over a queryset without `select_related`/`prefetch_related`.
- SQLAlchemy: relationship access in a loop with default lazy loading.
- Prisma/TypeORM: `findMany` followed by per-item `findUnique` in `map` or `for`.
- GraphQL resolvers per field with no batching loader.
- Any `await` on a query inside a `for` loop.
**Build it right:** Fetch related data in one query (join) or one query per relation (`IN (...)` / `= ANY($1)`), using the ORM's eager loading or a batching loader (DataLoader in GraphQL). Assert query counts in tests so regressions fail CI (Django `assertNumQueries`, or a query counter in your test DB wrapper).

Dangerous:
```python
# Django: 1 query for orders, then 1 per order for the customer.
orders = Order.objects.filter(account=account).order_by("-created_at")[:50]
rows = [{"id": o.id, "customer": o.customer.name} for o in orders]
```

Safe:
```python
orders = (Order.objects.filter(account=account)
          .select_related("customer")                 # joined in the same query
          .order_by("-created_at")[:50])
rows = [{"id": o.id, "customer": o.customer.name} for o in orders]

# Test:
# with self.assertNumQueries(1):
#     list_orders(account)
```

**Prove it:** A test that renders the list with 1 item and with 200 items asserts the same query count. Production query logs or APM traces for the endpoint show a constant number of queries per request.
**Size for now:** Query-count assertions on list endpoints are v1. Caching layers to hide N+1 are not a fix.

### SCALE-03 Unbounded queries and pagination

**How it fails:** A list endpoint returns every row (`SELECT * FROM events WHERE account_id = $1`), which is fine for a new tenant and fatal for the largest one: huge responses, timeouts, memory spikes (SCALE-12). Adding `OFFSET` pagination helps at first, but the database still produces and discards every skipped row, so page 2,000 is slow, and when rows are inserted between requests, offset pages shift and clients see duplicates or skip rows [3]. Sync jobs that page with offsets through a changing table silently miss records.
**Seen in the wild:** No verified incident; the failure follows from how `OFFSET` is defined: the database sorts, then drops the first N rows, so cost grows with N, and new rows between page requests produce duplicates [3].
**Spot it in a plan:** "list all", "export", "sync everything", "page through", "infinite scroll", no maximum page size.
**Spot it in code:** Queries without `LIMIT`; `OFFSET $n` with large possible `n`; `limit` taken from the request without a server cap; ORM `.all()` passed to a serializer; Prisma `skip`; no stable tiebreaker in `ORDER BY` (ordering by a non-unique column alone).
**Build it right:** Every list query has a server-enforced maximum page size. Use keyset (seek) pagination: order by a unique, indexed key (often `(created_at, id)`), return an opaque cursor holding the last row's key, and select rows after it [3]. Back it with a matching composite index (SCALE-04). Exports and syncs iterate with keysets in batches, not one giant query. Offset pagination is acceptable only for small, bounded admin lists where jumping to page N matters.

Dangerous:
```sql
-- Page 2,000 of a large tenant scans and discards 100,000 rows; inserts shift pages.
SELECT * FROM activities
 WHERE account_id = $1
 ORDER BY created_at DESC
 LIMIT 50 OFFSET $2;
```

Safe:
```sql
-- Index: CREATE INDEX CONCURRENTLY activities_acct_created_id
--          ON activities (account_id, created_at DESC, id DESC);
-- Cursor = (created_at, id) of the last row on the previous page; first page omits the predicate.
SELECT id, kind, created_at, summary
  FROM activities
 WHERE account_id = $1
   AND (created_at, id) < ($2, $3)
 ORDER BY created_at DESC, id DESC
 LIMIT 50;      -- server caps the client's requested limit at 100
```

**Prove it:** Seed the largest tenant at 10x. Measure page 1 and the last page with `EXPLAIN (ANALYZE, BUFFERS)`: similar buffers and time. Insert rows while a client pages through and assert no duplicates or gaps in the IDs it received.
**Size for now:** Server page caps and keyset pagination on any list that can grow with customer data are v1. Search engines and precomputed aggregates wait for a feature that needs them.

### SCALE-04 Missing indexes, checked with EXPLAIN

**How it fails:** A new query filters or sorts on columns no index covers. On test data the planner does a sequential scan in microseconds; on a 50-million-row table it reads the whole table on every request, saturates I/O, and slows every other query. Multi-tenant tables are a common trap: an index on `created_at` does not help `WHERE account_id = $1 ORDER BY created_at`, because the tenant filter is not leading. The reverse also costs: every extra index slows writes and uses memory.
**Seen in the wild:** No verified incident; the failure follows from planner behavior documented in the Postgres `EXPLAIN` docs, which note that the planner will often choose a sequential scan on small tables even when an index exists [4], which is why plans on test data hide the problem.
**Spot it in a plan:** A new filter, sort or lookup ("find contacts by domain", "sort by last activity") with no index named.
**Spot it in code:** New `WHERE`, `ORDER BY` or `JOIN` columns in a PR with no migration adding an index; foreign key columns without indexes (Postgres does not create an index on the referencing columns automatically [20]); `LIKE '%term%'` on large tables; functions on indexed columns (`WHERE lower(email) = $1` with an index on `email`).
**Build it right:** For each new query, name the index that serves it in the PR, with the tenant column leading for tenant-scoped queries and the sort columns after it. Check the plan on production-sized data with `EXPLAIN (ANALYZE, BUFFERS)`; `ANALYZE` actually runs the statement, so wrap data-modifying statements in a transaction and roll back [4]. Compare estimated and actual rows; large mismatches mean stale statistics or a misleading test [4]. Create indexes `CONCURRENTLY` (DI-03). Watch `pg_stat_statements` in production for the top queries by total time.

Dangerous:
```sql
-- Only index is on (id). Fine on 1,000 rows; a full scan per request on 50M rows.
SELECT id, email FROM contacts
 WHERE account_id = $1 AND lower(email_domain) = lower($2)
 ORDER BY last_activity_at DESC
 LIMIT 20;
```

Safe:
```sql
CREATE INDEX CONCURRENTLY contacts_acct_domain_activity
  ON contacts (account_id, lower(email_domain), last_activity_at DESC);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, email FROM contacts
 WHERE account_id = 42 AND lower(email_domain) = lower('example.com')
 ORDER BY last_activity_at DESC
 LIMIT 20;
-- Expect: Index Scan using contacts_acct_domain_activity, small "Buffers: shared hit=",
-- no Sort node, and actual rows close to estimated rows.
```

**Prove it:** Attach the `EXPLAIN (ANALYZE, BUFFERS)` output from a production-sized copy (largest tenant) to the PR. In CI, a check can run key queries against a seeded database and fail if the plan contains `Seq Scan` on large tables.
**Size for now:** An index per access path and a plan check per new query are v1. Partitioning waits until a single table's maintenance (vacuum, index builds) becomes the problem.

### SCALE-05 Fan-out amplification

**How it fails:** One input triggers N downstream actions, and N is set by customer data: one message to a channel with 10,000 members, one deal update notifying every watcher, one cache miss that queries every shard, one webhook that triggers a sync of a whole account. Average N looks small; the largest customer's N dominates load, hits third-party limits (SCALE-09) and creates bursts that queue behind everyone else's work. Retries multiply it again (REL-04).
**Seen in the wild:** In Slack's 22 February 2022 incident, membership data for group DMs was sharded by user, so even one channel missing from cache meant running a query on every shard; as cache hit rates fell, database read load grew faster than the miss rate, and the database could not refill the cache [5].
**Spot it in a plan:** "notify everyone who follows", "for each member", "sync on every change", "broadcast", an event handler that loops over a relation.
**Spot it in code:** Event handlers with a loop over recipients that does network calls inline; `Promise.all(recipients.map(send))`; queries without a shard or tenant key that a router must scatter; triggers on every row change of a busy table.
**Build it right:** Compute the fan-out factor for the worst current customer and at 10x, and write it in the design. Move fan-out off the request path into queued jobs that process recipients in batches with a concurrency cap. Coalesce: many changes to one object within a window become one downstream action (debounce per key). Prefer one bulk call over N single calls where the provider supports it. Fair-share the queue by tenant so one large fan-out does not starve others (SCALE-08).

Dangerous:
```ts
// On every deal update, notify every watcher inline, one API call each.
async function onDealUpdated(deal: Deal) {
  const watchers = await db.watchers.findMany({ where: { dealId: deal.id } });  // could be 5,000
  await Promise.all(watchers.map((w) => slack.chat.postMessage({ channel: w.dmChannel, text: summary(deal) })));
}
```

Safe:
```ts
// Coalesce updates per deal for 60 s, then fan out from a queue at a bounded rate.
async function onDealUpdated(deal: Deal) {
  await db.query(
    `INSERT INTO pending_notifications (deal_id, due_at) VALUES ($1, now() + interval '60 seconds')
     ON CONFLICT (deal_id) DO NOTHING`, [deal.id]);          // many updates, one notification
}
// Job (runs when due): page through watchers by keyset, 200 per job, and enqueue
// one send per watcher into the per-workspace paced queue from REL-05.
```

**Prove it:** Seed one deal with 10x the largest real watcher count and update it 100 times in a minute. Assert one notification per watcher, request latency for the update stays flat, other tenants' jobs keep their queue age, and no 429 storm appears at the fake provider.
**Size for now:** Off-request fan-out, coalescing per key and a stated worst-case N are v1. Precomputed fan-out (write-time timelines) waits for a feed-like product with measured need.

### SCALE-06 Hot rows and hot partitions

**How it fails:** Many concurrent writes target one row or one key: an `accounts.usage_count` incremented on every API call, a `last_seen_at` on a shared org row, a global sequence table, a "settings" row every request updates. Each write takes the row lock, so writes to that row are serialized; at high rates requests queue on the lock, hold connections while they wait, and drain the pool (SCALE-07). Partitioned stores have the same problem per partition key: the biggest tenant or channel gets all the traffic.
**Seen in the wild:** Discord describes hot partitions in its message store: many concurrent reads on a large server's channel concentrated on one partition; the high traffic led to unbounded concurrency and cascading latency, and their fix included request coalescing so concurrent requests for the same row query the database once [6].
**Spot it in a plan:** "track usage per account in a counter", "update last active on every request", "global counter", "per-tenant settings updated on each event".
**Spot it in code:** `UPDATE ... SET n = n + 1 WHERE id = $1` on a per-tenant or global row inside request handlers; `last_seen_at` updates on every request; partition or shard keys equal to tenant id where one tenant dominates.
**Build it right:** Avoid writing a shared row per request. Options, simplest first: (1) write append-only events (`usage_events`) and roll them up periodically, with reads summing the rollup plus recent events; (2) throttle writes like `last_seen_at` to at most once per N minutes per user (`WHERE last_seen_at < now() - interval '5 minutes'`); (3) split one counter into K slot rows and sum on read; (4) coalesce concurrent identical reads in the service (single-flight, CONC-13). For partitioned stores, choose keys that spread the largest tenant.

Dangerous:
```sql
-- Every API request from every user of the account takes this one row lock.
UPDATE accounts SET api_calls_this_month = api_calls_this_month + 1 WHERE id = $1;
```

Safe:
```sql
-- Request path: append-only, no shared row lock.
INSERT INTO usage_events (account_id, kind, at) VALUES ($1, 'api_call', now());

-- Every minute: roll up and delete in one transaction.
WITH moved AS (
  DELETE FROM usage_events WHERE at < now() - interval '10 seconds' RETURNING account_id
)
INSERT INTO usage_rollup (account_id, month, api_calls)
SELECT account_id, date_trunc('month', now()), count(*) FROM moved GROUP BY account_id
ON CONFLICT (account_id, month) DO UPDATE SET api_calls = usage_rollup.api_calls + EXCLUDED.api_calls;
-- Read: rollup plus count(*) of remaining usage_events for the account.
```

The rollup attributes events to the current month at rollup time; at a month boundary, group by `date_trunc('month', at)` instead if exact month attribution matters.

**Prove it:** Drive 10x peak request rate for the largest tenant. With the dangerous version, `pg_stat_activity` shows many sessions waiting on a tuple or transactionid lock for that row and p99 rises; with the safe version, no lock waits and the rollup total equals the number of requests sent.
**Size for now:** Avoid per-request writes to shared rows in v1; append-and-rollup is simple. Distributed counters and dedicated stream processors wait.

### SCALE-07 Connection pool exhaustion

**How it fails:** Postgres has a hard connection ceiling (`max_connections`, typically 100 by default [7]), and each connection costs server memory. Total demand is instances times pool size, plus workers, cron jobs, migrations, admin sessions and monitoring. Serverless multiplies it: each concurrent function instance opens its own connections, and AWS Lambda's default regional concurrency quota is 1,000 [18], so a burst can try to open thousands of connections. When the ceiling is hit, new requests fail, and in the worst case the operator cannot even connect to kill queries. Slow queries and transactions held open across network calls make it worse by holding connections longer.
**Seen in the wild:** Buttondown had two outages on 31 March 2026, about 20 minutes in total, when the database hit its configured connection ceiling; during the second one, saturation blocked even the connection needed to kill queries, so they restarted the database. Follow-ups included reserved administrative connections, connection alerts, and a health check that runs a real query [10]. In an earlier Buttondown incident, excessive connection attempts from too many worker threads contributed to a sending server's database malfunction [11].
**Spot it in a plan:** "deploy the API as serverless functions" with Postgres; "scale workers to 50"; no connection budget.
**Spot it in code:** `new Pool()` or `psycopg.connect` inside the request handler or function body; pool `max` values chosen without multiplying by instance count; transactions that span HTTP calls; no `idle_in_transaction_session_timeout`; PgBouncer in transaction mode with code that uses `SET`, `LISTEN`, session-level advisory locks or SQL `PREPARE`, none of which transaction pooling supports [8].
**Build it right:** Write the connection budget: for every process type, instances (at max scale) times pool size, summed, must stay below `max_connections` minus reserved superuser and admin slots, with headroom. Create pools once per process (module scope), keep them small, and set acquire timeouts so requests fail fast instead of queueing forever. Put a pooler (PgBouncer in transaction mode, or the platform's equivalent) in front of Postgres for serverless or many-instance deployments; protocol-level named prepared statements in transaction mode need PgBouncer 1.21 or later with `max_prepared_statements` set [9][8]. Keep transactions short and free of network calls (DI-06). Alert on connections used versus the ceiling.

Dangerous:
```ts
// AWS Lambda handler: a new pool (up to 10 connections) per invocation, never closed.
import { Pool } from "pg";
export const handler = async (event: APIGatewayProxyEvent) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  const { rows } = await pool.query("SELECT * FROM projects WHERE account_id = $1", [accountId(event)]);
  return { statusCode: 200, body: JSON.stringify(rows) };
};
```

Safe:
```ts
// One small pool per execution environment, reused across invocations, via PgBouncer (transaction mode).
import { Pool } from "pg";
const pool = new Pool({
  connectionString: process.env.PGBOUNCER_URL,
  max: 2,                          // budget: 300 reserved concurrency x 2 = 600 client conns to PgBouncer,
  idleTimeoutMillis: 10_000,       // which multiplexes onto default_pool_size = 40 server connections
  connectionTimeoutMillis: 2_000,  // fail fast when saturated instead of queueing
});
export const handler = async (event: APIGatewayProxyEvent) => {
  const { rows } = await pool.query(
    "SELECT id, name FROM projects WHERE account_id = $1 LIMIT 100", [accountId(event)]);
  return { statusCode: 200, body: JSON.stringify(rows) };
};
// Postgres: ALTER ROLE app SET idle_in_transaction_session_timeout = '30s';
```

**Prove it:** Load test at 10x concurrency and watch `SELECT count(*) FROM pg_stat_activity` against the ceiling: it must plateau at the budget. Hold a transaction open in a test request and confirm the idle-in-transaction timeout ends it. Confirm an admin can still connect during the test (reserved slots).
**Size for now:** A written connection budget, module-scope pools and an alert are v1. A pooler is v1 for serverless or more than a handful of instances; otherwise it waits.

### SCALE-08 Queue backpressure and backlog

**How it fails:** Producers enqueue faster than consumers process: a month-start burst, a provider replaying webhooks, a large tenant's import. The queue absorbs it (that is its job), but nothing notices that the oldest message is now three hours old, scheduled sends go out late, and a backlog from one tenant delays every other tenant's work behind it. Unbounded in-memory queues inside a process grow until the process is killed. Stripe notes that webhook deliveries spike at the beginning of the month when subscriptions renew, and recommends processing them from an asynchronous queue at a rate your system can support [12].
**Seen in the wild:** Buttondown's incident 0016 started with a sending server slowing until most sends timed out; alerts flagged an unusual backlog of email, and about 13,000 subscribers saw delays, missing mail or duplicates while the backlog was drained [11].
**Spot it in a plan:** "put it on a queue" with no throughput number, no alert and no fairness rule.
**Spot it in code:** Alerts on queue length only (length without rate says nothing about delay); a single FIFO queue shared by all tenants for bulk and interactive work; in-process arrays used as buffers; producers with no reaction to backlog.
**Build it right:** Measure and alert on the age of the oldest unprocessed item per queue, against a target per kind of work (interactive: seconds; bulk: minutes). Separate interactive and bulk work into different queues or priorities. Fair-share by tenant: claim jobs round-robin across tenants or cap concurrent jobs per tenant. Size consumers from the measured per-item cost and the 10x arrival rate. When the backlog exceeds what can be cleared within the target, slow producers (reject or defer bulk imports with a clear message) rather than letting delay grow without bound. Never buffer unbounded work in process memory.

Dangerous:
```python
# One queue for everything; the largest tenant's 2M-row import blocks everyone's alerts.
def claim(conn):
    return conn.execute("""
        SELECT id, payload FROM jobs WHERE status = 'pending'
         ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED""").fetchone()
```

Safe:
```python
# Per-tenant cap on running jobs; interactive work first; age exported for alerting.
def claim(conn, max_per_tenant=4):
    return conn.execute("""
        SELECT j.id, j.payload FROM jobs j
         WHERE j.status = 'pending' AND j.run_at <= now()
           AND (SELECT count(*) FROM jobs r
                 WHERE r.tenant_id = j.tenant_id AND r.status = 'running') < %s
         ORDER BY j.priority DESC, j.run_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED""", (max_per_tenant,)).fetchone()

def export_queue_age(conn):
    (age,) = conn.execute("""
        SELECT coalesce(extract(epoch FROM now() - min(run_at)), 0)
          FROM jobs WHERE status = 'pending' AND run_at <= now()""").fetchone()
    metrics.gauge("jobs.oldest_pending_age_seconds", age)   # alert: > 300 for priority >= 5
```

The per-tenant cap is a soft limit (two workers can both see 3 running and both claim); that is acceptable for fairness. Index `jobs (status, priority DESC, run_at)` and `jobs (tenant_id, status)`.

**Prove it:** Enqueue 100,000 bulk jobs for one tenant, then enqueue interactive jobs for ten other tenants. Assert the interactive jobs complete within their target while the bulk backlog drains, and the age alert fires for the bulk queue when its target is exceeded.
**Size for now:** Age-based alerting and separation of interactive from bulk work are v1. Per-tenant fairness becomes v1 the day one tenant is 10x the median, which in enterprise products is usually from the start.

### SCALE-09 Third-party rate limits are the real ceiling

**How it fails:** Our servers can scale; the provider's limits cannot. The feature works in the demo workspace and then takes hours, or fails, for the largest customer because the provider allows a fixed number of calls per method, per workspace, per user or per minute. Examples from current documentation: Slack's Web API tiers allow roughly 1+, 20+, 50+ and 100+ requests per minute per method per workspace per app (tiers 1 to 4) [13]; `chat.postMessage` allows about one message per second per channel, with workspace-level limits of several hundred per minute [14]; since 29 May 2025, new non-Marketplace commercially distributed Slack apps (and new installs of existing ones) get 1 request per minute for `conversations.history` and `conversations.replies`, with at most 15 objects per request [15]. The Gmail API allows 6,000 quota units per user per minute and 1,200,000 per project per minute, with `messages.send` costing 100 units and `messages.get` 20 [16], so one user can send at most 60 messages a minute through the API on quota alone.
**Seen in the wild:** No verified outage; the ceilings are documented by the providers [13][14][15][16]. The Slack 2025 change is a concrete case of a ceiling moving under existing designs: a channel history backfill of 10,000 messages at 15 messages per request and 1 request per minute takes about 11 hours for an app subject to the new limits [15].
**Spot it in a plan:** "sync all channels", "import the mailbox", "send to everyone", "real-time" anything backed by a third-party API, with no calculation against its limits.
**Spot it in code:** Per-item API calls in loops; no per-scope pacing; no record of which Slack app distribution type or Gmail project quota applies; batch sizes larger than the provider allows.
**Build it right:** For every provider call on a journey, write the limit, its scope (per method, workspace, user, project), the cost per item, and the resulting time for the largest tenant at 10x. If the result is unacceptable, change the design: incremental sync (history IDs, change cursors, events) instead of full scans, batch endpoints, fewer fields, or a product promise that matches the ceiling ("import completes within a day"). Pace each scope with a token bucket set below the documented limit, and honor 429s as in REL-05. Track quota usage as a metric.

Dangerous:
```python
# Gmail: full re-read of the mailbox every sync. 50,000 messages x 20 units = 1,000,000 units:
# about 167 minutes of one user's 6,000-units-per-minute quota, every time.
for msg_id in list_all_message_ids(user):
    msg = gmail.users().messages().get(userId="me", id=msg_id).execute()
    upsert(msg)
```

Safe:
```python
# Incremental sync from the stored historyId (history.list costs 2 units [16]),
# paced per user below the per-user quota.
bucket = TokenBucket(rate_per_min=4_000, key=f"gmail:{user.id}")   # headroom under 6,000
start = user.gmail_history_id
page_token = None
while True:
    bucket.take(2)
    resp = gmail.users().history().list(userId="me", startHistoryId=start,
                                        pageToken=page_token).execute()
    for h in resp.get("history", []):
        for added in h.get("messagesAdded", []):
            bucket.take(20)
            upsert(gmail.users().messages().get(userId="me", id=added["message"]["id"]).execute())
    page_token = resp.get("nextPageToken")
    if not page_token:
        user.gmail_history_id = resp["historyId"]
        break
# If startHistoryId is too old, the API returns an error and a paced full resync is needed;
# plan for that path's duration too.
```

**Prove it:** A spreadsheet or doc table: provider, method, documented limit, scope, units per item, largest tenant volume at 10x, resulting duration. A test against a fake provider that enforces the documented limits asserts the job finishes in the computed time without dropping items.
**Size for now:** The limits table and per-scope pacing are v1 for any integration-heavy product. Requesting quota increases or Marketplace approval is a business task to start early, because it is slow.

### SCALE-10 Payload and message size limits

**How it fails:** Something that is small for most customers is large for one: a webhook body with 5,000 line items, a job payload carrying a whole document, an LLM prompt with a full thread, a response listing every record. It hits a platform limit and fails, often deep in a pipeline and only for the largest tenant: Amazon SQS messages max out at 1 MiB (larger payloads go to S3 through the extended client) [17]; AWS Lambda accepts 6 MB request and response payloads for synchronous invocation and 1 MB for asynchronous [18]. Framework body-size defaults (for example JSON body parsers) reject large requests with errors that look like client bugs.
**Seen in the wild:** No verified incident; the failure follows from the documented limits [17][18].
**Spot it in a plan:** "send the record in the message", "include the full thread", "return all items".
**Spot it in code:** Job or message payloads built from unbounded collections; `JSON.stringify(entireObject)` into a queue; synchronous function invocations returning large lists; no size check before send.
**Build it right:** Messages carry identifiers, not documents (the claim-check pattern): store the body in the database or object storage and send a reference. Bound collections in payloads and responses (paginate, SCALE-03). Check size before sending and fail with a clear error, never truncate silently. Know the limits on every hop (queue, function, gateway, provider) and write the smallest one in the design.

Dangerous:
```ts
// The largest tenant's export manifest is 3 MB: SendMessage fails above 1 MiB.
await sqs.send(new SendMessageCommand({
  QueueUrl: EXPORT_QUEUE,
  MessageBody: JSON.stringify({ accountId, rows: allRows }),
}));
```

Safe:
```ts
const key = `exports/${accountId}/${exportId}.json`;
await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: JSON.stringify(allRows) }));
const body = JSON.stringify({ accountId, exportId, s3Key: key });   // small, bounded
if (Buffer.byteLength(body) > 256 * 1024) throw new Error("export message unexpectedly large");
await sqs.send(new SendMessageCommand({ QueueUrl: EXPORT_QUEUE, MessageBody: body }));
```

(If `allRows` is itself too large to hold in memory, stream it to storage instead; see SCALE-12.)

**Prove it:** Run the pipeline with a payload generated at 10x the largest tenant's size; every hop succeeds or fails with a clear, logged size error, and no data is truncated.
**Size for now:** Reference-not-document messages and size checks are v1. Chunked or streaming protocols wait for a feature that needs them.

### SCALE-11 Batch versus per-item work

**How it fails:** A loop does one network round trip per item: one `INSERT` per row of an import, one API call per contact where a bulk endpoint exists, one cache `GET` per key. At 100 items nobody notices; at 100,000 the job runs for hours, holds connections, and burns provider quota (SCALE-09). Round-trip latency, not work, dominates the time.
**Seen in the wild:** No verified incident; the cost follows from round trips, and the Django documentation recommends bulk methods (`bulk_create`, `bulk_update`, multi-object `add`) to reduce the number of SQL statements [2].
**Spot it in a plan:** "import the CSV", "update each record", "sync each contact".
**Spot it in code:** `INSERT`, `save()`, `create()` or API calls inside a loop over input rows; `for key in keys: redis.get(key)`; `executemany` with tiny batches over a high-latency link.
**Build it right:** Batch to the largest size that keeps transactions short and stays under provider and payload limits: multi-row `INSERT ... VALUES`, `INSERT ... SELECT FROM unnest($1::...[])`, `COPY` for large loads, ORM bulk methods, provider batch endpoints, `MGET`/pipelines. Commit per batch so a failure does not lose everything and locks are not held long (DI-05). Keep idempotency per item (upsert on a natural key) so a retried batch is safe.

Dangerous:
```python
# 200,000 rows, one round trip and one autocommitted transaction each.
for row in csv.DictReader(f):
    conn.execute("INSERT INTO contacts (account_id, email, name) VALUES (%s, %s, %s)",
                 (account_id, row["email"], row["name"]))
```

Safe:
```python
# psycopg 3: COPY into a staging table, then one idempotent upsert per batch.
def import_batch(conn, account_id, rows):
    with conn.transaction():
        conn.execute("CREATE TEMP TABLE IF NOT EXISTS stage_contacts "
                     "(email text, name text) ON COMMIT DELETE ROWS")
        with conn.cursor().copy("COPY stage_contacts (email, name) FROM STDIN") as copy:
            for r in rows:
                copy.write_row((r["email"], r["name"]))
        conn.execute("""
            INSERT INTO contacts (account_id, email, name)
            SELECT DISTINCT ON (lower(email)) %s, email, name FROM stage_contacts
            ON CONFLICT (account_id, (lower(email))) DO UPDATE SET name = EXCLUDED.name
        """, (account_id,))

for batch in chunked(csv.DictReader(f), 5_000):
    import_batch(conn, account_id, batch)
```

The `ON CONFLICT (account_id, (lower(email)))` target requires a matching unique index on `(account_id, lower(email))`.

**Prove it:** Import a file at 10x the largest real import; record wall time and database round trips (from `pg_stat_statements` calls). Kill the import halfway and rerun; the final row count equals the distinct emails and no duplicates exist.
**Size for now:** Batching for imports, syncs and bulk updates is v1. Dedicated bulk-load infrastructure waits.

### SCALE-12 Memory growth from loading everything

**How it fails:** A job or request loads a whole result set, file or API listing into memory: `list(Model.objects.all())`, `await findMany()` without `take`, `json.load` of an export, `readFileSync` of an upload, accumulating every page of a provider listing before processing. Memory grows with the largest tenant's data, not with the work per step, and the process is OOM-killed (which, mid-job, triggers REL-10's crash-between-steps problems). In languages with garbage collection, the process may also slow badly before dying.
**Seen in the wild:** No verified incident; the failure follows from documented ORM behavior. The Django documentation notes that a `QuerySet`'s result caching can use a large amount of memory when there are many objects, and that `iterator()` may help [2].
**Spot it in a plan:** "load all contacts and compute", "read the file and process", "fetch all pages then save".
**Spot it in code:** `list(...)`, `.all()`, `findMany()` without limits in jobs; `readFileSync`/`await file.text()` on user uploads; `json.load`/`JSON.parse` of large files; arrays that accumulate every page of an API listing; in-memory sorts of unbounded data.
**Build it right:** Stream or iterate in bounded chunks end to end: server-side cursors or keyset batches from the database (`iterator(chunk_size=...)` in Django), streaming parsers for files (CSV readers over a stream, line-delimited JSON), process-as-you-page for provider listings, and push sorting and aggregation into SQL. Set container memory limits and alert on usage near the limit, so growth is seen before it is a kill.

Dangerous:
```python
# Loads every activity for the tenant (tens of millions for the largest) into memory.
activities = list(Activity.objects.filter(account=account))
write_csv(response, activities)
```

Safe:
```python
qs = (Activity.objects.filter(account=account)
      .order_by("id")
      .values_list("id", "kind", "created_at", "summary"))
writer = csv.writer(stream)                       # stream = a file in object storage, or a streaming response
for row in qs.iterator(chunk_size=2_000):         # bounded memory regardless of tenant size
    writer.writerow(row)
```

**Prove it:** Run the job for a tenant seeded at 10x the largest; record peak RSS (for example `/usr/bin/time -v` or container metrics). Peak memory must be roughly the same as for a small tenant.
**Size for now:** Streaming for exports, imports and syncs is v1. Distributed processing frameworks wait.

### SCALE-13 Horizontal scaling assumptions

**How it fails:** Code assumes exactly one long-lived process. With two or more instances (or serverless): in-memory sessions log users out when the load balancer picks another instance; in-memory caches and rate limits diverge (CONC-12); files written to local disk are missing on the next request; and schedulers started inside the web process run on every instance, so the daily digest goes out once per instance. With scale to zero, in-process timers never fire. Sticky sessions hide some of this until an instance is replaced.
**Seen in the wild:** GitHub reported in 2010 that a billing batch processed twice, charging customers twice [19]; the post does not give the cause, but a scheduled batch with no single-run guard is the shape that produces it. The general failure follows from process isolation, as in CONC-12.
**Spot it in a plan:** "run a cron in the app", "store the session", "save the upload to disk then process", "scale to N instances" with no word on shared state.
**Spot it in code:** `node-cron`, `setInterval`, APScheduler or `time.Ticker` schedulers started at web server boot; in-memory session stores; writes to local paths like `/tmp/uploads` read by a later request; WebSocket state held per instance without a shared bus.
**Build it right:** Sessions in a shared store (database, Redis) or stateless signed tokens; uploads to object storage; caches and limits per CONC-12. Scheduled work runs from one scheduler (the platform's cron, a single scheduler process) or claims each run slot atomically so any number of instances can try and exactly one wins. Each run is idempotent so a retried slot does not double the effect.

Dangerous:
```ts
// Started in every web instance at boot: 4 instances send 4 digests.
import cron from "node-cron";
cron.schedule("0 8 * * *", () => sendDailyDigests());
```

Safe:
```ts
// Any instance (or the platform scheduler) may fire; one run per slot wins in the database.
// Table: cron_runs (job text, slot timestamptz, started_at timestamptz, PRIMARY KEY (job, slot))
async function runSlot(job: string, slot: Date, fn: () => Promise<void>) {
  const { rowCount } = await db.query(
    `INSERT INTO cron_runs (job, slot, started_at) VALUES ($1, $2, now())
     ON CONFLICT (job, slot) DO NOTHING`, [job, slot]);
  if (rowCount === 0) return;                    // another instance owns this slot
  await fn();                                    // sendDailyDigests must itself be idempotent per user
  await db.query("UPDATE cron_runs SET finished_at = now() WHERE job = $1 AND slot = $2", [job, slot]);
}
// Slot = the scheduled instant truncated to the schedule (e.g. today 08:00 in UTC).
// Alert when a slot has started_at but no finished_at after its deadline (JOB-01, REL-10).
```

**Prove it:** Run four instances and trigger the schedule on all of them: one `cron_runs` row and one digest per user. Kill the instance during the run and confirm the stuck-slot alert fires and the recovery path finishes without duplicates. Restart instances during a user session; the user stays logged in and an upload in progress completes.
**Size for now:** Shared sessions, object storage for files and single-winner schedules are v1, because rolling deploys alone create multiple instances. A dedicated workflow scheduler waits.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "It is fast on my machine." | Test data is tiny; the planner may even pick a different plan on small tables [4]. | Seed 10x the largest tenant; check `EXPLAIN (ANALYZE, BUFFERS)`. |
| "We can add servers if it gets slow." | Database connections, provider quotas, row locks and autoscaling caps do not grow with servers [1][7]. | Find the real ceiling with the 10x test and write it down. |
| "The ORM handles it." | Lazy loading issues one query per item; result caching holds everything in memory [2]. | Eager loading, query-count tests, iterators. |
| "Offset pagination is fine." | Cost grows with the offset and pages shift as rows are inserted [3]. | Keyset pagination with a unique sort key and an index. |
| "Serverless scales for us." | Each concurrent function opens its own database connections; the default concurrency quota is 1,000 per region [18]. | Connection budget, module-scope pools, a pooler. |
| "The provider's API is fast, so the sync is fast." | Per-method, per-workspace and per-user limits set the time, not latency [13][15][16]. | Compute duration at the documented limit for the largest tenant. |
| "Most customers are small." | Enterprise products are defined by their largest customers, who arrive with the first big deal. | Size every path for the largest tenant at 10x. |
| "We will build for millions from the start." | Unneeded sharding and pipelines add failure modes and delay delivery. | Build for 10x today with written triggers for the next step. |
| "It is only one cron job." | Started in the web process, it runs once per instance. | One scheduler or an atomic run-slot claim; idempotent runs. |

## Attack recipes

1. **Largest tenant times ten.** Clone the largest tenant's data shape into staging and multiply it by 10 (synthetic rows with realistic distributions). Run the main journeys and every scheduled job. Any endpoint over its latency target, job over its time target, or OOM kill means SCALE-01, SCALE-03, SCALE-04 or SCALE-12 failed for that path.
2. **Count queries.** Enable statement logging (or `pg_stat_statements` reset and read) and render each list page with 1 item and with 500. If the query count differs, SCALE-02 failed.
3. **Deep page.** Request the last page of the largest list via the API. If its latency is far above page 1, or if inserting rows between page requests yields duplicate IDs across pages, SCALE-03 failed.
4. **Plan check.** For every query added in the change, run `EXPLAIN (ANALYZE, BUFFERS)` on the 10x dataset. A `Seq Scan` on a large table, a `Sort` over many rows for a `LIMIT 20` query, or estimates off by orders of magnitude mean SCALE-04 failed.
5. **Max fan-out.** Trigger the event with the largest real audience times ten (a channel, a deal, an account). If request latency rises, other tenants' queue age rises past target, or the fake provider sees 429 storms, SCALE-05 or SCALE-08 failed.
6. **Hot row hammer.** Drive 10x peak traffic from one tenant and query `pg_locks` joined to `pg_stat_activity` for waits. Lock waits on a single row means SCALE-06 failed.
7. **Connection flood.** Scale to the maximum instance count (or fire the reserved concurrency of functions at once) and watch `pg_stat_activity` count. Reaching `max_connections`, or an admin being unable to connect, means SCALE-07 failed.
8. **Provider ceiling.** Point the integration at a fake that enforces the provider's documented limits exactly (for Slack history: 1 request per minute, 15 objects). If the job drops items, errors out, or takes longer than the duration written in the design, SCALE-09 failed.
9. **Oversized payload.** Generate the largest plausible object (10x the biggest real one) and push it through every hop. Any silent truncation, or a failure without a clear size error, means SCALE-10 failed.
10. **Four instances, one schedule.** Run four instances with the scheduler enabled and fast-forward to the schedule time. More than one run, or more than one digest per user, means SCALE-13 failed.

## Sources

1. Slack Engineering, "Slack's Outage on January 4th 2021". https://slack.engineering/slacks-outage-on-january-4th-2021/
2. Django documentation (6.1), "Database access optimization". https://docs.djangoproject.com/en/stable/topics/db/optimization/
3. Markus Winand, Use The Index, Luke, "No Offset" (keyset pagination). https://use-the-index-luke.com/no-offset
4. PostgreSQL 18 documentation, "Using EXPLAIN". https://www.postgresql.org/docs/current/using-explain.html
5. Slack Engineering, "Slack's Incident on 2-22-22". https://slack.engineering/slacks-incident-on-2-22-22/
6. Discord Blog, "How Discord Stores Trillions of Messages". https://discord.com/blog/how-discord-stores-trillions-of-messages
7. PostgreSQL 18 documentation, "Connections and Authentication" (`max_connections`). https://www.postgresql.org/docs/current/runtime-config-connection.html
8. PgBouncer documentation, "Features" (pool modes, features unsupported in transaction pooling). https://www.pgbouncer.org/features.html
9. PgBouncer changelog (1.21.0, 2023-10-16: protocol-level named prepared statements). https://www.pgbouncer.org/changelog.html
10. Buttondown, "Public postmortem: database connection exhaustion" (incident 0024). https://buttondown.com/blog/incident-0024
11. Buttondown, "Public postmortem: external events backlog" (incident 0016). https://buttondown.com/blog/incident-0016
12. Stripe documentation, "Receive Stripe events in your webhook endpoint" (handle events asynchronously). https://docs.stripe.com/webhooks
13. Slack changelog, "Great rate limits" (2018; tier definitions, 429 and `Retry-After`). https://docs.slack.dev/changelog/2018/03/01/great-rate-limits
14. Slack API reference, `chat.postMessage` (rate limits). https://docs.slack.dev/reference/methods/chat.postMessage
15. Slack changelog, "Rate limit changes for non-Marketplace apps" (29 May 2025). https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
16. Google for Developers, Gmail API "Usage limits" (quota units per user and per project, per-method costs). https://developers.google.com/workspace/gmail/api/reference/quota
17. Amazon SQS Developer Guide, "Amazon SQS message quotas" (1 MiB maximum, extended client). https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-messages.html
18. AWS Lambda Developer Guide, "Lambda quotas" (payload sizes, default concurrency). https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html
19. GitHub Blog, "Revenge of the Double Billing" (2010). https://github.blog/2010-08-04-revenge-of-the-double-billing/
20. PostgreSQL 18 documentation, "Constraints" (foreign keys do not create an index on referencing columns). https://www.postgresql.org/docs/current/ddl-constraints.html
