# Data integrity

**Protects:** Stored data stays true to the rules of the business and consistent with the outside world: every row satisfies its invariants, every fact has one owner, schema changes never corrupt or block live data, and drift between the system and its providers is detected and repaired rather than discovered by a customer.
**Read when:** The plan adds or changes a table, column, constraint, index or migration; writes to more than one table, store or service for one user action; publishes an event after a write; caches data; stores money, times, dates, names, emails or free text; copies data from a provider (CRM, billing, email, Slack) into our database; deletes or archives anything. In code: migration files, `ALTER TABLE`, `CREATE INDEX`, ORM model changes, `deleted_at`, `float`/`Number` for amounts, `timestamp` without zone, `new Date()` arithmetic, `cache.set`, `publish(` near `commit`, `UPDATE ... ` without `WHERE` batching.
**Prefix:** DI

## Design questions

1. For each rule the business states ("every order has a customer", "amounts are non-negative", "one active plan per account"), which database constraint enforces it, by name?
2. For each schema change, can the currently deployed code and the new code both run correctly against the schema at every step of the rollout and of a rollback?
3. Which lock does each migration statement take, on which table, for how long, and what is the `lock_timeout` if it has to wait?
4. For each user action that writes more than once, which writes share a transaction, and what is left behind if the process dies between any two of them?
5. When a write must also reach a queue, another service or a third-party API, what guarantees that both happen or neither, and how is a half-done state found and finished?
6. For each fact we store, who owns it (our database, Stripe, the CRM, Slack)? Which copies exist, how do they get updated, and how is disagreement detected?
7. For every cache: what invalidates it, what is the longest a reader can see stale data, and is that bound acceptable for this data (prices and permissions usually say no)?
8. How are instants, calendar dates, durations and user time zones each stored and computed?
9. How are amounts stored (type, scale, currency), where does rounding happen, and by which named rule?
10. Which text fields are identifiers or are compared for equality, and how are they normalized before storage and comparison?
11. What scheduled check would tell us, without a customer report, that an invariant broke or that our copy drifted from the provider?
12. When a row is "deleted", what happens to rows that reference it, to unique keys, and to the user's legal right to erasure?

## Categories

### DI-01 Invariants enforced in the database, not only in app code

**How it fails:** A rule lives only in application validation. Then a second code path (an admin script, a backfill, a new endpoint, a webhook handler, a teammate's raw SQL fix) writes without that validation, or two concurrent requests both pass it (CONC-10). Orders without customers, negative quantities, overlapping bookings and statuses spelled three ways accumulate silently and surface months later as broken reports or wrong invoices.
**Seen in the wild:** No verified incident; the failure follows from the fact that only database constraints apply to every writer. The Postgres docs show how a partial unique index enforces a rule on a subset of rows that application checks cannot enforce under concurrency [10].
**Spot it in a plan:** "the API validates that", "the UI only allows", "we never set it to null", rules stated in prose with no matching constraint in the schema section.
**Spot it in code:** Columns nullable by default in ORM models; `status text` with no CHECK or enum; foreign-key-shaped columns (`customer_id`) with no `REFERENCES`; validation decorators (Zod, Pydantic, Joi) with no matching DDL; Prisma `String` for fields that have a closed set of values.
**Build it right:** For each rule, the strongest mechanism that fits: `NOT NULL`, `CHECK`, `REFERENCES` with an explicit `ON DELETE`, `UNIQUE` (including partial and expression indexes), exclusion constraints for non-overlap, enum types or lookup tables for closed sets. Keep app validation too, for good error messages, but treat the constraint as the guarantee. Map constraint violation SQLSTATEs (`23502` not null, `23503` foreign key, `23505` unique, `23514` check, `23P01` exclusion) to clear API errors in one place.

Dangerous:
```sql
CREATE TABLE bookings (
  id        bigserial PRIMARY KEY,
  room_id   bigint,
  starts_at timestamp,
  ends_at   timestamp,
  status    text
);  -- overlaps, nulls, orphan rooms, 'confirmd' all accepted
```

Safe:
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- lets GiST handle "room_id WITH ="
CREATE TABLE bookings (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id bigint NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
  during  tstzrange NOT NULL CHECK (NOT isempty(during)),
  status  text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled')),
  EXCLUDE USING gist (room_id WITH =, during WITH &&) WHERE (status <> 'cancelled')
);
```

**Prove it:** For each rule, a test that performs the violating write with raw SQL (not through the API) and asserts the database rejects it with the expected SQLSTATE. Run two overlapping bookings concurrently and assert one fails with `23P01`.
**Size for now:** All of the above are v1 work and cost almost nothing at creation time. Adding them later to a large table is a migration project (DI-04), which is the strongest argument for doing it now.

### DI-02 Expand and contract: schema changes during a rolling deploy

**How it fails:** During a rolling deploy (and after a rollback), old and new versions of the code run against the same database. A migration that renames or drops a column, changes a type, or makes a column required breaks whichever version does not expect it: old instances throw on a missing column, new instances write rows the old code cannot read, and a rollback leaves the new schema in place with old code that cannot use it.
**Seen in the wild:** No verified incident; the failure follows from running two code versions against one schema, which every rolling deploy does. GoCardless's write-up on zero-downtime migrations recommends splitting schema changes into smaller steps for related reasons [3].
**Spot it in a plan:** "rename the column", "change the type", "drop the old field", "make it required", all in the same release that changes the code.
**Spot it in code:** `RENAME COLUMN`, `DROP COLUMN`, `ALTER COLUMN ... TYPE`, `SET NOT NULL` in the same PR as the code that stops using or starts requiring the field; ORM models that select every column by default (`SELECT *` breaks on drop only if the code maps every column strictly).
**Build it right:** Every breaking change becomes a sequence of releases, each backward compatible with the one before: (1) expand: add the new column or table, nullable, no code reads it; (2) dual write: code writes both old and new; (3) backfill old rows (DI-05); (4) switch reads to the new column; (5) stop writing the old one; (6) contract: drop it in a later release, after a rollback past step 4 is no longer plausible. Enforce with review: a migration that drops or renames must reference the release where the code stopped using it.

Dangerous:
```sql
-- Shipped together with code that reads users.full_name.
ALTER TABLE users RENAME COLUMN name TO full_name;
-- Old instances still serving traffic: ERROR: column "name" does not exist
```

Safe:
```sql
-- Release 1 (expand):   ALTER TABLE users ADD COLUMN full_name text;
-- Release 1 code:       writes name AND full_name; reads name.
-- Backfill:             batched UPDATE users SET full_name = name WHERE full_name IS NULL (DI-05).
-- Release 2 code:       reads full_name; still writes both (so a rollback to Release 1 is safe).
-- Release 3 code:       writes full_name only.
-- Release 4 (contract): ALTER TABLE users DROP COLUMN name;
```

**Prove it:** In CI, run the previous release's test suite against the schema after the new migrations. Any failure means the migration is not backward compatible. For each contract step, show the release where the last reader was removed.
**Size for now:** Required from the first customer, because rolling deploys and rollbacks exist from day one. Tooling such as automated migration linters can wait; a checklist item in the PR template is enough.

### DI-03 Locking DDL and the lock queue in Postgres

**How it fails:** Most `ALTER TABLE` forms take an `ACCESS EXCLUSIVE` lock unless the docs say otherwise [1], and `ACCESS EXCLUSIVE` conflicts with every other lock, including plain `SELECT` [11]. A plain `CREATE INDEX` blocks inserts, updates and deletes on the table for the entire build [2]. Even a migration that would take milliseconds is dangerous if it has to wait: while it waits for a long-running query to finish, every later query that conflicts with it queues behind it. Postgres waits for locks indefinitely by default (`lock_timeout` is 0, meaning disabled) [7], so a 10-second analytics query plus a 1 ms `ALTER` can stall all traffic for 10 seconds.
**Seen in the wild:** GoCardless had about 15 seconds of API outage when a migration that added foreign keys waited for a lock on a busy parent table that a long-running read was holding; queries queued behind the waiting lock and API clients timed out. Their recommendation is to set `lock_timeout` in migration scripts [3].
**Spot it in a plan:** "add an index", "add a foreign key", "small migration, runs instantly", migrations run automatically at deploy with no timeout.
**Spot it in code:** `CREATE INDEX` without `CONCURRENTLY` on tables that take writes; migration runners with no `lock_timeout`; `ALTER TABLE` on hot tables; ORM migrations that wrap every migration in a transaction (which makes `CONCURRENTLY` impossible, since it cannot run in a transaction block [2]).
**Build it right:** (1) Set `lock_timeout` (for example 2 to 5 seconds) and a `statement_timeout` for every migration session, and retry the migration on timeout rather than letting it queue. (2) Build indexes with `CREATE INDEX CONCURRENTLY`, in a migration that is not wrapped in a transaction (Django `atomic = False`, Rails `disable_ddl_transaction!`, or your runner's equivalent). It does two table scans and waits for existing transactions, so it takes longer [2]. (3) If it fails, it leaves an `INVALID` index that still costs write overhead; drop it and retry, or `REINDEX INDEX CONCURRENTLY` [2]. For a unique index, the docs warn the invalid index can keep enforcing uniqueness [2]. (4) Keep long transactions off the primary (analytics on a replica) so DDL can get its lock. Postgres 17 added `transaction_timeout` as another backstop [8].

Dangerous:
```sql
-- Blocks every write to orders until the build finishes; waits forever for its lock.
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
```

Safe:
```sql
-- Migration runs outside a transaction block.
SET lock_timeout = '3s';
SET statement_timeout = '30min';
CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_customer_id_idx ON orders (customer_id);

-- After any failure, find and drop leftovers before retrying:
SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- DROP INDEX CONCURRENTLY orders_customer_id_idx;
```

**Prove it:** In staging with production-like data, open a transaction that holds a conflicting lock (`BEGIN; SELECT * FROM orders LIMIT 1;` is enough for `ACCESS EXCLUSIVE` to wait), then run the migration. With `lock_timeout` it must fail within the timeout while ordinary queries keep succeeding; without it, watch `pg_stat_activity` fill with waiting queries. Time the real migration on a production-sized copy.
**Size for now:** `lock_timeout` and `CONCURRENTLY` are v1 habits; they cost nothing. Online schema change tools and migration orchestration platforms are not needed until tables are large enough that even concurrent builds and validations take hours.

### DI-04 Adding NOT NULL, foreign keys and checks to existing tables

**How it fails:** `ALTER TABLE ... SET NOT NULL` scans the whole table under an `ACCESS EXCLUSIVE` lock to prove there are no nulls [1]. Adding a validated `CHECK` or foreign key also scans existing rows while holding a lock that blocks writes. On a large table this is minutes of downtime. Separately, adding a column with a default rewrote the whole table before Postgres 11; since 11 a non-volatile default is stored in metadata and needs no rewrite [4][1], but a volatile default (a random UUID, `clock_timestamp()`) still forces a rewrite.
**Seen in the wild:** No verified incident; the failure follows from the documented lock and scan behavior of `ALTER TABLE` in Postgres 18 [1].
**Spot it in a plan:** "make the column required", "add a foreign key to the existing table", "add a check constraint", "add a column with a default UUID".
**Spot it in code:** `SET NOT NULL`, `ADD CONSTRAINT ... CHECK (...)`, `ADD CONSTRAINT ... FOREIGN KEY` without `NOT VALID` on existing tables; `ADD COLUMN ... DEFAULT gen_random_uuid()` or `DEFAULT now()` on large tables.
**Build it right:** Two steps: add the constraint as `NOT VALID` (only new and updated rows are checked), then `VALIDATE CONSTRAINT`, which takes only a `SHARE UPDATE EXCLUSIVE` lock on the table (plus `ROW SHARE` on the referenced table for a foreign key) and does not block normal reads and writes [1]. For NOT NULL: on Postgres 12 to 17, add `CHECK (col IS NOT NULL) NOT VALID`, validate it, then `SET NOT NULL`, which skips the scan when a valid CHECK proves no nulls (the optimization arrived in 12 [5]; the Postgres 18 docs describe the CHECK case [1]), then drop the CHECK. On Postgres 18, not-null constraints themselves can be added `NOT VALID` and validated later [6]. Always under `lock_timeout` (DI-03).

Dangerous:
```sql
ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;            -- full scan, ACCESS EXCLUSIVE
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (id);               -- validates every row while locked
```

Safe:
```sql
SET lock_timeout = '3s';
-- Foreign key (any supported version):
ALTER TABLE orders ADD CONSTRAINT orders_customer_fk
  FOREIGN KEY (customer_id) REFERENCES customers (id) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_fk;

-- NOT NULL on Postgres 12 to 17:
ALTER TABLE orders ADD CONSTRAINT orders_customer_id_nn
  CHECK (customer_id IS NOT NULL) NOT VALID;
ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_nn;
ALTER TABLE orders ALTER COLUMN customer_id SET NOT NULL;            -- scan skipped
ALTER TABLE orders DROP CONSTRAINT orders_customer_id_nn;

-- NOT NULL on Postgres 18:
-- ALTER TABLE orders ADD CONSTRAINT orders_customer_id_nn NOT NULL customer_id NOT VALID;
-- ALTER TABLE orders VALIDATE CONSTRAINT orders_customer_id_nn;
```

**Prove it:** On a production-sized copy, run the migration while a load generator does inserts and updates; record the longest write latency during the migration. A pause longer than your `lock_timeout` means a step took a blocking lock for longer than planned. Confirm with `SELECT convalidated FROM pg_constraint WHERE conname = '...'` that the constraint ended validated.
**Size for now:** Use the two-step form on any table that takes writes in production, regardless of size; it is the same amount of SQL. Tables with a few thousand rows can take the one-step form if you accept a sub-second lock.

### DI-05 Backfills

**How it fails:** A backfill runs as one giant `UPDATE` in one transaction: it holds row locks on millions of rows, blocks concurrent writers, bloats the table, lags replicas, and if it fails at 90 percent it rolls back everything. Or it runs as a script that is not idempotent, so a rerun after a crash double-applies a transformation (`amount = amount * 100` twice). Or it starts before the code writes the new column, so new rows keep arriving unfilled and the backfill never converges.
**Seen in the wild:** No verified incident; the failure follows from transaction and locking semantics (long transactions hold their row locks until commit, and other writers wait indefinitely for row locks by default) [11].
**Spot it in a plan:** "run a one-off script to fill the column", "migrate the data in the migration", no mention of batches, resumption or verification.
**Spot it in code:** Data-changing `UPDATE` or `INSERT ... SELECT` statements inside schema migrations; loops that load every row into memory (SCALE-12); transformations that read and write the same column; no `WHERE new_col IS NULL` guard.
**Build it right:** Order matters: deploy dual-writing code first (DI-02), then backfill only rows that still need it. Batch by primary key with keyset pagination (SCALE-03), commit per batch, sleep between batches to cap load, and make each batch idempotent (write to a new column, or guard with a predicate that excludes already-done rows). Record progress so a rerun resumes. Finish with a verification query that counts rows still not migrated; it must reach zero before the contract step.

Dangerous:
```python
# One transaction, every row, not idempotent if rerun on a partly-converted column.
conn.execute("UPDATE orders SET total = total * 100")
conn.commit()
```

Safe:
```python
# Writes a new column; reruns skip finished rows; each batch commits on its own.
last_id = 0
while True:
    with conn.transaction():
        rows = conn.execute("""
            WITH batch AS (
              SELECT id FROM orders
               WHERE id > %s AND total_cents IS NULL
               ORDER BY id
               LIMIT 1000)
            UPDATE orders o
               SET total_cents = round(o.total * 100)
              FROM batch
             WHERE o.id = batch.id
            RETURNING o.id""", (last_id,)).fetchall()
    if not rows:
        break
    last_id = max(r[0] for r in rows)
    time.sleep(0.2)                      # cap load; tune from replica lag and p99 latency
(remaining,) = conn.execute(
    "SELECT count(*) FROM orders WHERE total_cents IS NULL").fetchone()
assert remaining == 0, remaining
```

**Prove it:** Run the backfill on a production-sized copy while a load test runs; record write p99 and replica lag. Kill it halfway and rerun; the final verification count must be zero and spot-checked rows must be converted exactly once.
**Size for now:** A batched, resumable script with a verification query is enough for tables up to tens of millions of rows. A backfill framework with checkpoint tables and dashboards can wait until backfills are frequent.

### DI-06 Multi-step writes without a transaction

**How it fails:** One user action does several writes (create the order, insert its line items, decrement stock, write an audit row) as separate autocommitted statements. A crash, a thrown exception, a timeout or a deploy between them leaves an order with no items or stock decremented for an order that does not exist. In Node with `pg`, a classic version: `pool.query('BEGIN')` followed by `pool.query(...)` can run each statement on a different pooled connection, so there is no transaction at all; node-postgres docs say to use the same client for every statement in a transaction and not to use `pool.query` for transactions [15].
**Seen in the wild:** No verified incident; the failure follows from autocommit semantics and from the node-postgres pooling behavior its docs warn about [15].
**Spot it in a plan:** "create X, then create Y, then update Z" for one action with no word on atomicity.
**Spot it in code:** Several `await db.query` or ORM `create` calls in one handler without `BEGIN`/`$transaction`/`atomic()`/`session.begin()`; `pool.query("BEGIN")`; transactions that include HTTP calls (which hold locks and connections for the length of the call, and cannot be rolled back anyway).
**Build it right:** Wrap the unit of work in one transaction on one connection, using the stack's helper (`pool.connect()` then `client.query` in Node, `with conn.transaction()` in psycopg, `db.BeginTx` in Go, `prisma.$transaction`). Keep network calls out of the transaction: do the database part atomically, then the external part with an idempotency key, and record its result in a second transaction (DI-07, CONC-09).

Dangerous:
```ts
await pool.query("BEGIN");                                // may run on connection A
const { rows: [o] } = await pool.query(
  "INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", [customerId]); // connection B
for (const it of items) {
  await pool.query("INSERT INTO order_items (order_id, sku, qty) VALUES ($1, $2, $3)",
    [o.id, it.sku, it.qty]);
}
await pool.query("COMMIT");
```

Safe:
```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const { rows: [o] } = await client.query(
    "INSERT INTO orders (customer_id) VALUES ($1) RETURNING id", [customerId]);
  for (const it of items) {
    await client.query(
      "INSERT INTO order_items (order_id, sku, qty) VALUES ($1, $2, $3)", [o.id, it.sku, it.qty]);
  }
  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
} finally {
  client.release();
}
```

**Prove it:** Inject a failure after the second item insert (a test hook or a fault-injecting repository) and assert no order row exists. With the dangerous version, the order persists.
**Size for now:** Transactions around every multi-write action are a v1 requirement. Sagas and distributed transactions are not needed while the writes live in one database.

### DI-07 Dual writes: database plus queue, database plus external API

**How it fails:** The code commits a row and then publishes an event (or calls an API). If the process dies between the two, the event is lost and downstream never learns. If it publishes first and the commit then fails, downstream acts on something that does not exist. Retrying either step blindly duplicates. The same shape appears with "save to DB, then send to Slack", "save, then index in search", "save, then sync to the CRM".
**Seen in the wild:** No verified incident; the failure is the problem the transactional outbox pattern exists to solve: without two-phase commit, a service cannot atomically update its database and send a message to a broker [9].
**Spot it in a plan:** "after saving, we publish an event", "then we notify the other service", "we write to our DB and to the CRM".
**Spot it in code:** `commit()` followed by `publish(`, `sqs.send`, `kafka.produce`, `fetch(` to another service, or the same calls before commit; event publishing inside ORM `after_save` hooks that run before the transaction commits.
**Build it right:** Transactional outbox: in the same transaction as the business change, insert a row into an `outbox` table describing the message. A relay process claims unsent outbox rows (`FOR UPDATE SKIP LOCKED`, CONC-05), publishes them, and marks them sent. The relay can publish a message more than once (crash after publish, before marking), so consumers must be idempotent (CONC-04) [9]. For calls to third-party APIs, the outbox row is the durable intent: the worker calls the API with an idempotency key derived from the outbox id and records the provider's id; a reconciliation job resolves rows stuck in "sending" (REL-10).

Dangerous:
```python
with conn.transaction():
    order_id = create_order(conn, cart)
# Crash here and the event is gone for good.
broker.publish("order.created", {"order_id": order_id})
```

Safe:
```python
with conn.transaction():
    order_id = create_order(conn, cart)
    conn.execute(
        "INSERT INTO outbox (topic, payload) VALUES (%s, %s)",
        ("order.created", Json({"order_id": order_id})))

# Relay (separate process, any number of instances):
def relay_once(conn):
    with conn.transaction():
        rows = conn.execute("""
            SELECT id, topic, payload FROM outbox
             WHERE sent_at IS NULL ORDER BY id LIMIT 100
             FOR UPDATE SKIP LOCKED""").fetchall()
        for id_, topic, payload in rows:
            broker.publish(topic, payload, message_id=str(id_))   # consumers dedupe on message_id
            conn.execute("UPDATE outbox SET sent_at = now() WHERE id = %s", (id_,))
```

**Prove it:** Kill the app between commit and publish in the dangerous version: the event is missing. In the safe version, kill the relay after `publish` and before the update; on restart the message is published again and the consumer's effect still happens once. Alert on the age of the oldest unsent outbox row.
**Size for now:** An outbox table plus a polling relay is enough for v1 and needs no new infrastructure. Change-data-capture tools (logical decoding pipelines) can wait until polling load or latency is a measured problem. The relay above holds row locks while publishing; keep batches small and publish timeouts short (REL-01).

### DI-08 Soft delete and referential integrity

**How it fails:** Rows get a `deleted_at` instead of being deleted. Then: unique constraints still count deleted rows, so a user who deleted their account cannot sign up again with the same email; every query must remember `WHERE deleted_at IS NULL`, and the one that forgets shows deleted data (or another tenant's "deleted" record in a search); foreign keys still point at deleted parents, so children of a deleted project stay live; and "delete my data" requests are not actually honored.
**Seen in the wild:** No verified incident; the failure follows from constraint semantics. Unique indexes count every row unless they are partial, which is why the Postgres docs show partial unique indexes for "unique among a subset" rules [10].
**Spot it in a plan:** "we soft delete so we can restore", "archive instead of delete", with no word on uniqueness, children or erasure requests.
**Spot it in code:** `deleted_at` columns with plain `UNIQUE` constraints; ORM default scopes (which raw SQL and reporting queries bypass); `ON DELETE CASCADE` on tables that are never hard deleted (so the cascade never fires); no job that purges soft-deleted rows after a retention period.
**Build it right:** Decide per table whether soft delete is needed at all; often an audit log plus hard delete is simpler and honors erasure. Where soft delete stays: make unique indexes partial (`WHERE deleted_at IS NULL`); expose live rows through a view or row-level security policy so forgetting the filter is impossible for app queries; define what happens to children (soft delete them in the same transaction, or block the delete); and run a purge job that hard deletes after the retention window, with `ON DELETE` behavior on foreign keys chosen for that purge.

Dangerous:
```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL UNIQUE,      -- deleted users block re-signup forever
  deleted_at timestamptz
);
-- Every query must remember the filter; reports and admin tools forget.
SELECT * FROM users WHERE lower(email) = lower($1);
```

Safe:
```sql
CREATE TABLE users (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email      text NOT NULL,
  deleted_at timestamptz
);
CREATE UNIQUE INDEX users_email_live_key ON users (lower(email)) WHERE deleted_at IS NULL;
CREATE VIEW live_users AS SELECT * FROM users WHERE deleted_at IS NULL;
-- App role reads live_users; a purge job hard deletes rows where deleted_at < now() - interval '30 days'.
```

**Prove it:** Delete a user, then sign up again with the same email: must succeed. Search, list and export endpoints must not return the deleted user (seed one and grep responses). Run the purge job and assert the row and its children are gone.
**Size for now:** Default to hard delete plus an audit log in v1; add soft delete only where a restore feature is a stated requirement.

### DI-09 Time and time zones

**How it fails:** A `timestamp` (without time zone) column stores whatever wall-clock time it was given and silently ignores any zone in the input [11], so values written by servers in different zones, or by a library that sends local time, cannot be compared. "Today" computed in server time puts a user's 11 pm action on the wrong day. Fixed offsets (`-05:00`) stored instead of zone names go wrong after the next daylight saving change. Date arithmetic done by hand (add 1 to the year, add 24 hours for "tomorrow") breaks on leap days and DST transitions. Python's `datetime.utcnow()` returns a naive datetime that many methods treat as local time, and it is deprecated since Python 3.12 [16].
**Seen in the wild:** On 29 February 2012 Microsoft Azure had a major outage because a component computed a certificate's valid-to date by taking the current date and adding one to the year, producing 29 February 2013, which does not exist, so certificate creation failed [13].
**Spot it in a plan:** "store the time", "send at 9 am", "daily report", "expires in one year", "end of month", no zone named.
**Spot it in code:** `timestamp` or `timestamp without time zone` in DDL; Prisma `DateTime` mapped to `timestamp(3)`; `new Date().toISOString().slice(0, 10)` as the user's date; `setFullYear(getFullYear() + 1)`; `+ 86400` for "next day"; `datetime.utcnow()`, `datetime.now()` without `tz`; `BETWEEN` on timestamps (inclusive at both ends, so midnight rows land in two days [12]).
**Build it right:** Instants as `timestamptz` (stored as UTC internally, converted on output [11]); calendar dates as `date`; the user's zone as an IANA name (`America/New_York`). Compute local dates and schedules with a real zone library (`zoneinfo` in Python, `Temporal` or Luxon in JS, `time.LoadLocation` in Go), and define what happens for nonexistent and repeated local times. Use half-open ranges (`>= start AND < end`) [12]. Never do calendar arithmetic by hand.

Dangerous:
```python
from datetime import datetime, timedelta
expires = datetime.utcnow().replace(year=datetime.utcnow().year + 1)   # ValueError on Feb 29
report_day = datetime.now().date()                                     # server's zone, not the user's
```

Safe:
```python
from datetime import datetime, UTC                # UTC constant: Python 3.11+
from zoneinfo import ZoneInfo
from dateutil.relativedelta import relativedelta

now = datetime.now(UTC)
expires = now + relativedelta(years=1)            # Feb 29 -> Feb 28 of next year, by a defined rule
report_day = now.astimezone(ZoneInfo(user.tz_name)).date()
# SQL: created_at timestamptz NOT NULL; filter with created_at >= $start AND created_at < $end
```

**Prove it:** Freeze time at 2028-02-29T12:00Z and run expiry logic; at 23:30 local in `America/Los_Angeles` and check the "today" bucket; schedule "9 am" across a DST boundary in the user's zone. Run the test suite with the process `TZ` set to `Pacific/Kiritimati` and to `UTC`; results must match.
**Size for now:** `timestamptz` everywhere and zone names on users are v1. Business calendars and holiday handling wait until a feature needs them.

### DI-10 Money and numeric precision

**How it fails:** Binary floating point cannot represent most decimal fractions exactly; the Python docs show `1.1 + 2.2` printing as `3.3000000000000003` and `0.1 + 0.1 + 0.1 - 0.3` not equal to zero [14]. Sums of float amounts drift by cents, comparisons fail, and invoices disagree with the payment provider. Rounding happens in several places with different rules. In Node, Postgres `bigint` values arrive as strings from node-postgres because JavaScript numbers cannot hold every 64-bit integer [18], and code that does `Number(row.amount_minor)` or `parseFloat` loses precision silently past 2^53. Amounts without a currency get added across currencies. Postgres's `money` type is discouraged in favor of `numeric` [12].
**Seen in the wild:** No verified incident; the failure follows from documented binary floating-point behavior [14] and from the node-postgres decision to return int8 as strings [18].
**Spot it in a plan:** "price", "total", "discount", "tax", "balance", "credits" with no type or rounding rule stated.
**Spot it in code:** `float`, `double precision`, `real`, `money` columns for amounts; JS `number` for money with `*`, `/` or `toFixed`; `parseFloat` on amounts; Python `float(...)` on amounts; `round()` sprinkled through code; JSON APIs that send `12.30` as a number.
**Build it right:** Store integer minor units (`bigint amount_minor` plus `char(3) currency`) or `numeric(p, s)` with a fixed scale. In application code use integers, `Decimal` (Python), `big.Int`/`decimal` libraries (Go) or `bigint`/a decimal library (JS). Send amounts over APIs as strings or integer minor units. Put rounding in one function with a named rule; note Python's `Decimal` default context rounds `ROUND_HALF_EVEN` [14], which may not be the rule your finance or tax team uses, so pass `rounding=` explicitly. Add CHECK constraints for sign and currency codes.

Dangerous:
```ts
const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);   // price is a float like 19.99
const tax = Math.round(subtotal * 0.0825 * 100) / 100;
await db.query("INSERT INTO invoices (total) VALUES ($1)", [subtotal + tax]);  // double precision column
```

Safe:
```ts
// price_minor and total_minor are bigint in Postgres; node-postgres returns them as strings.
const subtotal = items.reduce((s, i) => s + BigInt(i.price_minor) * BigInt(i.qty), 0n);
const tax = roundHalfUp(subtotal * 825n, 10_000n);   // 8.25 percent, one named rounding rule
await db.query(
  "INSERT INTO invoices (total_minor, currency) VALUES ($1, $2)",
  [(subtotal + tax).toString(), "USD"]);

function roundHalfUp(n: bigint, d: bigint): bigint {   // n >= 0
  return (n + d / 2n) / d;
}
```

**Prove it:** Table tests on edge values: 0.1 + 0.2 in minor units, half-cent cases for the chosen rule, negative refunds, amounts above 2^53 minor units round-tripped through the API and database unchanged. A reconciliation test that sums 10,000 line items and compares to the provider's total to the cent.
**Size for now:** Integer minor units and one rounding function are v1. Multi-currency conversion, FX rate snapshots and ledger tables arrive with the feature that needs them.

### DI-11 Text encoding and Unicode normalization

**How it fails:** The same visible string can be stored as different code point sequences (precomposed `é` versus `e` plus a combining accent), so uniqueness checks and lookups miss duplicates, and two accounts appear to have the same name. Compatibility characters (superscripts, full-width letters, ligatures) map to plain letters under NFKC, so a canonicalization step that is applied once at signup and again later can turn one identifier into another. Length limits counted in bytes truncate in the middle of a multi-byte character.
**Seen in the wild:** In 2013 Spotify found that attackers could hijack accounts by registering a lookalike username such as `ᴮᴵᴳᴮᴵᴿᴰ`: canonicalizing it once gave `BIGBIRD` (no collision), but the password reset path canonicalized again, producing `bigbird` and resetting the victim's password. The canonicalization function was not idempotent for input outside Unicode 3.2, and the behavior had changed between Python 2.4 and 2.5; Spotify fixed it by rejecting any name whose canonical form changes when canonicalized again [17].
**Spot it in a plan:** "usernames are unique", "match by name", "dedupe contacts by email", "search by name", identifiers typed by users.
**Spot it in code:** Unique indexes on raw user-entered text; `.lower()` as the only normalization (Python's `casefold()` handles more cases); comparisons on un-normalized strings; `substring` or `slice` on byte buffers; a canonicalization function applied in more than one place.
**Build it right:** Decide per field. Display text: store as entered, normalized to NFC. Identifiers (usernames, slugs, tenant keys): define one canonical function (for example NFKC [22], then `casefold`, then an allowlist of characters), apply it at one boundary, store the canonical form in its own column with a unique index, and reject input where `canon(canon(x)) != canon(x)`. Emails: lowercase the domain; treat the local part as the provider does, and do not invent rules. Limit lengths in characters (code points or grapheme clusters, decided explicitly), not bytes.

Dangerous:
```python
def register(username: str):
    db.execute("INSERT INTO users (username) VALUES (%s)", (username.lower(),))
# "Ａｌｉｃｅ" (full-width) and "alice" both register; later code that applies NFKC merges them.
```

Safe:
```python
import unicodedata, re
ALLOWED = re.compile(r"[a-z0-9_.-]{3,32}")

def canon(name: str) -> str:
    return unicodedata.normalize("NFKC", name).casefold()

def register(username: str):
    c = canon(username)
    if canon(c) != c or not ALLOWED.fullmatch(c):
        raise InvalidUsername(username)
    db.execute("INSERT INTO users (username, username_canon) VALUES (%s, %s)",
               (unicodedata.normalize("NFC", username), c))   # UNIQUE (username_canon)
```

**Prove it:** Register `alice`, then try `Alice`, `ａｌｉｃｅ` (full-width), `ᴬᴸᴵᶜᴱ`, and `alice` with a combining character; each must be rejected or map to the same canonical row. Fuzz `canon` with random Unicode and assert it is idempotent.
**Size for now:** One canonical function for identifiers and NFC for display text are v1. Confusable-character detection across scripts (the Unicode security mechanisms) can wait unless impersonation is a real threat for the product.

### DI-12 One owner per fact: duplicated sources of truth

**How it fails:** The same fact lives in two places that are both written: the plan is stored in our `accounts.plan` and in the billing provider; a contact's email is edited in our UI and in the CRM; an order total is stored and also derivable from line items. Each place gets updated by different paths at different times, they disagree, and different features read different copies. Support sees "Pro", the invoice says "Free", and nobody can say which is right.
**Seen in the wild:** No verified incident; the failure follows from having two writable copies with no ownership rule. Stripe's webhook guidance to fetch the current object from the API when events arrive out of order [19] is a recognition that the provider, not the local copy, owns the object.
**Spot it in a plan:** "we store the plan locally too", "sync the contact both ways", "keep a running total", "denormalize for speed", two systems both described as editable.
**Spot it in code:** Fields updated both from our UI handlers and from provider webhooks; stored totals or counts updated in some code paths and not others; two-way sync jobs with "last write wins".
**Build it right:** Write down the owner of each fact in the design (one system per field, not per record). Other copies are caches: they are only written by the sync from the owner, they record `synced_at` and the owner's version, and user edits go to the owner (call the provider's API), with our copy updated from the result or the next webhook. Derived values (totals, counts) are computed by a view or query, or maintained in the same transaction as their inputs with a reconciliation check (DI-14). Two-way sync needs explicit per-field ownership or a conflict rule written down.

Dangerous:
```ts
// UI handler writes our copy; the billing webhook also writes it. They race and disagree.
app.post("/plan", async (req, res) => {
  await db.query("UPDATE accounts SET plan = $1 WHERE id = $2", [req.body.plan, req.user.accountId]);
  await billing.subscriptions.update(req.user.subscriptionId, { price: priceFor(req.body.plan) });
  res.sendStatus(204);
});
```

Safe:
```ts
// Billing provider owns the plan. We request the change there; our copy is written only by sync.
app.post("/plan", async (req, res) => {
  const sub = await billing.subscriptions.update(
    req.user.subscriptionId, { price: priceFor(req.body.plan) },
    { idempotencyKey: `plan-change:${req.user.accountId}:${req.get("Idempotency-Key")}` });
  await syncSubscription(sub);        // same function the webhook handler calls
  res.sendStatus(202);
});
```

**Prove it:** Change the plan from the provider's dashboard directly; our copy must converge within the sync window. Fail the provider call in the UI path; our copy must not change. The reconciliation job (DI-14) must report zero mismatches after both tests.
**Size for now:** The ownership table in the design doc is free and is v1. Generic sync frameworks wait; one `syncX(ownerObject)` function per synced type is enough.

### DI-13 Cache invalidation correctness

**How it fails:** A cache holds a copy of database data and serves it after the database changed. Classic races: a reader misses the cache, reads the old row, the writer updates the row and deletes the cache key, then the reader writes its old value into the cache, where it stays until the TTL. Caches populated inside a transaction that later rolls back serve data that never existed. Keys that omit the tenant or the user leak data across accounts. And error handling can turn a cache into an amplifier: treating an error from the database as "the value is invalid, delete it" sends every client to the database at once.
**Seen in the wild:** On 23 September 2010 Facebook was down for about 2.5 hours. An automated system that fixed invalid cached configuration values saw an invalid value in the persistent store; every client tried to fix it by querying the database cluster; overloaded databases returned errors, which clients read as invalid values, deleting more cache keys and sending more traffic, a feedback loop that stopped only when traffic to the cluster was cut [20].
**Spot it in a plan:** "cache it in Redis", "cache permissions", "cache the price", no stated staleness bound or invalidation trigger.
**Spot it in code:** `cache.set` before `COMMIT`; invalidation in some write paths and not others; cache keys built without tenant id; infinite TTLs; `catch` blocks that delete or overwrite cache entries on any error.
**Build it right:** Write the staleness bound per cached item in the design; if it must be zero (permissions after revocation, prices at checkout, balances), do not cache it, or read through to the database for that decision. Invalidate after commit, from the module that owns the write (one place), and keep a TTL as a backstop. To defeat the stale-fill race, use versioned keys (include `updated_at` or a version column in the key) or let only the writer populate the cache. Include tenant and user scope in every key. On errors from the source, serve stale or fail; never treat an error as data.

Dangerous:
```ts
async function getProject(id: string) {
  const hit = await redis.get(`project:${id}`);            // no tenant in key
  if (hit) return JSON.parse(hit);
  const p = await db.one("SELECT * FROM projects WHERE id = $1", [id]);
  await redis.set(`project:${id}`, JSON.stringify(p));     // no TTL; can store a stale read forever
  return p;
}
async function renameProject(id: string, name: string) {
  await redis.del(`project:${id}`);                        // deleted before the write commits
  await db.query("UPDATE projects SET name = $1 WHERE id = $2", [name, id]);
}
```

Safe:
```ts
async function getProject(tenantId: string, id: string) {
  const { rows: [v] } = await db.query(
    "SELECT version FROM projects WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  if (!v) return null;
  const key = `t:${tenantId}:project:${id}:v${v.version}`;  // a stale fill lands on an old version key
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit);
  const p = await db.one("SELECT * FROM projects WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  await redis.set(key, JSON.stringify(p), { EX: 300 });
  return p;
}
async function renameProject(tenantId: string, id: string, name: string) {
  await db.query(
    "UPDATE projects SET name = $1, version = version + 1 WHERE tenant_id = $2 AND id = $3",
    [name, tenantId, id]);                                  // committed; old keys simply age out
}
```

This version still pays one indexed lookup per read; it is worth it only when the cached value is expensive to build. If the row itself is cheap, do not cache it.

**Prove it:** Interleave a slow reader and a writer with a test hook (pause the reader between DB read and cache set, run the writer, resume): the next read must return the new name. Revoke a permission and assert the next request is denied. Make the database return errors and assert cache keys are not deleted and the database sees bounded traffic.
**Size for now:** Most v1 products do not need an application cache at all; Postgres with the right indexes is fast. Add a cache only for a measured hot path, with the staleness bound written down.

### DI-14 Reconciliation and invariant checks in production

**How it fails:** Constraints cannot express every rule (sums across tables, agreement with a provider, "every paid invoice has a payment"). Bugs, partial failures, missed webhooks and manual fixes break those rules silently. Without a scheduled check, drift is discovered by a customer, an auditor or a month-end close, long after the logs that would explain it have expired.
**Seen in the wild:** In October 2025 Buttondown sent duplicate emails for about eight minutes across five newsletters because of a rate-limiting bug; an alert on total events far above the subscriber count helped catch it, and the follow-up added an explicit check for the invariant that was violated ("M was larger than N") plus other sanity checks in the sending pipeline [21].
**Spot it in a plan:** Data copied from a provider, money, counts, anything "kept in sync"; no mention of how drift would be noticed.
**Spot it in code:** Sync code with no matching reconciliation job; no queries that assert cross-table rules; alerts only on errors, never on wrong-but-successful outcomes.
**Build it right:** For each rule that constraints cannot enforce, write an invariant query that returns violating rows, run it on a schedule, and alert when it returns anything. For each synced fact (DI-12), a reconciliation job compares our copy with the owner (paginated through the provider's list API, within its rate limits) and either repairs automatically (when the owner is unambiguous) or opens a ticket. Record every repair. Track "rows checked" as well as "violations" so a job that silently checks nothing is visible.

Dangerous:
```sql
-- Nothing runs this. The first person to notice is the customer.
-- (no reconciliation)
```

Safe:
```sql
-- Invariant: every invoice marked paid has a succeeded payment covering it.
SELECT i.id, i.total_minor, coalesce(sum(p.amount_minor), 0) AS paid_minor
  FROM invoices i
  LEFT JOIN payments p ON p.invoice_id = i.id AND p.status = 'succeeded'
 WHERE i.status = 'paid'
   AND i.updated_at < now() - interval '15 minutes'     -- skip in-flight rows
 GROUP BY i.id, i.total_minor
HAVING coalesce(sum(p.amount_minor), 0) <> i.total_minor;
-- Scheduled every hour; any row pages the owner. Emit rows_checked as a metric too.
```

**Prove it:** Seed a violation in staging (an invoice marked paid without a payment, a subscription whose local status differs from the provider sandbox) and assert the job reports it within one run, and that the repair path fixes the provider-owned case. Stop the job and assert the "last successful run" alert fires.
**Size for now:** A handful of invariant queries on a cron with alerting is v1 for anything involving money or provider sync. A general data-quality platform waits until there are dozens of checks.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "The app validates it, so the database does not need to." | Every other writer (scripts, new endpoints, concurrent requests) bypasses app validation. | Constraint in the database; app validation only for messages. |
| "It is a tiny migration, it runs instantly." | It can wait on a lock and stall every query queued behind it [3]. | `lock_timeout` on every migration; `CONCURRENTLY` and `NOT VALID` forms. |
| "We will deploy code and schema together." | Rolling deploys and rollbacks run old code against new schema. | Expand, dual write, backfill, switch, contract. |
| "We commit and then publish; crashes are rare." | Deploys restart processes mid-request every release; the gap will be hit. | Transactional outbox and idempotent consumers [9]. |
| "Floats are fine, we round at the end." | Binary floats cannot represent most decimal amounts; rounding at the end hides drift until it does not [14]. | Integer minor units or `numeric`; one named rounding rule. |
| "All our servers run in UTC." | `timestamp` ignores zones in input, users are not in UTC, and libraries send local times [11]. | `timestamptz`, zone names, a real zone library. |
| "We soft delete, so nothing is ever lost." | Uniqueness, children, filters and erasure requests all break unless designed for. | Partial unique indexes, a live view, a purge job; or hard delete plus audit log. |
| "The cache TTL is short, staleness does not matter." | Permissions, prices and balances are wrong for the whole TTL; stale fills can outlive it. | Name the bound per item; do not cache decisions that must be fresh. |
| "We would notice if the data drifted." | Wrong-but-successful outcomes raise no errors. | Scheduled invariant and reconciliation queries with alerts. |

## Attack recipes

1. **Raw-SQL bypass.** For every business rule listed in the design, attempt the violating write directly in `psql` as the application role. If it succeeds, DI-01 failed for that rule.
2. **Old code, new schema.** Check out the previous release, point it at a database migrated to the new release, and run its test suite. Any failure means DI-02 failed.
3. **Lock queue stall.** In staging, hold `BEGIN; SELECT 1 FROM <table> LIMIT 1;` open in one session, run the migration in another, and run a read load in a third. If reads stall for longer than the migration's `lock_timeout`, DI-03 failed.
4. **Write latency under migration.** Run the full migration set against a production-sized copy while a write load runs. A write pause longer than a few seconds means a step in DI-03 or DI-04 took a blocking lock.
5. **Crash between writes.** Add a fault-injection hook that throws after the Nth database write in a handler; iterate N over every write. Any persisted partial state means DI-06 failed; any lost or duplicated downstream message means DI-07 failed.
6. **Kill the relay.** `kill -9` the outbox relay right after a publish and before the row is marked; restart. The consumer must apply the effect once (DI-07, CONC-04).
7. **Leap day and DST clock.** Run the suite with a frozen clock at `2028-02-29T23:30:00-08:00` and at both DST transitions in `America/New_York`, with `TZ` set to an unusual zone. Any difference from expected values means DI-09 failed.
8. **Money round trip.** Send `9007199254740993` minor units and `0.1 + 0.2` worth of line items through the API, database and back. Any changed digit means DI-10 failed.
9. **Unicode twins.** Register `alice`, then `ａｌｉｃｅ`, `ᴬᴸᴵᶜᴱ`, and `alice` plus U+0301. More than one account, or a reset flow that resolves one to another, means DI-11 failed.
10. **Seeded drift.** Change a synced field directly at the provider (sandbox dashboard) and mark one invoice paid without a payment. If the reconciliation and invariant jobs do not report both within one run, DI-12 or DI-14 failed.

## Sources

1. PostgreSQL 18 documentation, "ALTER TABLE" (lock levels, `SET NOT NULL`, `ADD COLUMN` defaults, `NOT VALID`, `VALIDATE CONSTRAINT`). https://www.postgresql.org/docs/current/sql-altertable.html
2. PostgreSQL 18 documentation, "CREATE INDEX" (building indexes concurrently, invalid indexes). https://www.postgresql.org/docs/current/sql-createindex.html
3. GoCardless, "Zero-downtime Postgres migrations: the hard parts". https://gocardless.com/blog/zero-downtime-postgres-migrations-the-hard-parts/
4. PostgreSQL 11 release notes (`ADD COLUMN` with non-null default without rewrite). https://www.postgresql.org/docs/11/release-11.html
5. PostgreSQL 12 release notes (`SET NOT NULL` avoiding table scans). https://www.postgresql.org/docs/12/release-12.html
6. EDB, "Changes to NOT NULL in Postgres 18". https://www.enterprisedb.com/blog/changes-not-null-postgres-18
7. PostgreSQL 18 documentation, "Client Connection Defaults" (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`, `transaction_timeout`). https://www.postgresql.org/docs/current/runtime-config-client.html
8. PostgreSQL 17 release notes (`transaction_timeout`). https://www.postgresql.org/docs/17/release-17.html
9. Chris Richardson, microservices.io, "Pattern: Transactional outbox". https://microservices.io/patterns/data/transactional-outbox.html
10. PostgreSQL 18 documentation, "Partial Indexes". https://www.postgresql.org/docs/current/indexes-partial.html
11. PostgreSQL 18 documentation, "Date/Time Types" and "Explicit Locking". https://www.postgresql.org/docs/current/datatype-datetime.html and https://www.postgresql.org/docs/current/explicit-locking.html
12. PostgreSQL Wiki, "Don't Do This" (`timestamp`, `money`, `BETWEEN`). https://wiki.postgresql.org/wiki/Don%27t_Do_This
13. Microsoft Azure Blog, "Summary of Windows Azure Service Disruption on Feb 29th, 2012". https://azure.microsoft.com/en-us/blog/summary-of-windows-azure-service-disruption-on-feb-29th-2012/
14. Python documentation, "decimal: Decimal fixed-point and floating-point arithmetic". https://docs.python.org/3/library/decimal.html
15. node-postgres documentation, "Transactions". https://node-postgres.com/features/transactions
16. Python documentation, "datetime" (`utcnow` deprecation in 3.12). https://docs.python.org/3/library/datetime.html#datetime.datetime.utcnow
17. Spotify Engineering, "Creative usernames and Spotify account hijacking" (2013). https://engineering.atspotify.com/2013/6/creative-usernames
18. pg-types package documentation (int8 returned as strings). https://www.npmjs.com/package/pg-types
19. Stripe documentation, "Receive Stripe events in your webhook endpoint" (event ordering, retrieving current objects). https://docs.stripe.com/webhooks
20. Facebook Engineering, "More Details on Today's Outage" (2010). https://engineering.fb.com/2010/09/23/uncategorized/more-details-on-today-s-outage/
21. Buttondown, "Public postmortem: duplicate sends" (incident 0021, 2025). https://buttondown.com/blog/incident-0021
22. Python documentation, "unicodedata". https://docs.python.org/3/library/unicodedata.html
