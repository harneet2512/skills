# Data

Schemas, migrations, writes, transactions, ORMs, backups.

### DATA-01 Existing rows
- **Ask:** What do rows written before this change look like to the new code?
- **Right way:** Handle old shapes, or backfill in a separate, resumable step before relying on the new shape.
- **Proof:** Test reading an old-shape row; backfill run on a copy of real-sized data.

### DATA-02 Migration safety at size
- **Ask:** Does the migration lock a large table, rewrite it, or run longer than a deploy allows?
- **Right way:** Expand then contract: add nullable, backfill in batches, then enforce. Never rename or drop in the same deploy that stops using it.
- **Proof:** Migration timed on a production-sized copy.

### DATA-03 Rollback of the schema
- **Ask:** Can the previous app version run against the new schema during deploy and after a rollback?
- **Right way:** Keep schema changes backward compatible for one release.
- **Proof:** Old version's tests run against the new schema.

### DATA-04 Invariants enforced by the database
- **Ask:** Which rules must never break (uniqueness, required, references, allowed states)?
- **Right way:** Enforce with constraints, not only application code (S10).
- **Proof:** Test that a violating write is rejected by the database.

### DATA-05 Transactions and isolation
- **Ask:** Do two concurrent writers lose an update or read a half-done state?
- **Right way:** Transaction around the unit of work; row locks or optimistic version checks where read-then-write happens (S10). No network or LLM calls inside a transaction.
- **Proof:** Concurrency test with two writers.

### DATA-06 Second source of truth
- **Ask:** Is the same fact now stored in two places that can disagree?
- **Right way:** One owner; others derive or cache with invalidation.
- **Proof:** Name the owner in the contract; test the derived copy updates.

### DATA-07 Query cost at scale
- **Ask:** Does a new query scan a table, or run once per item?
- **Right way:** Index for the access path; batch instead of N+1.
- **Proof:** Query plan, or query count in a test with many items.

### DATA-08 Backups restore
- **Ask:** Is the changed data covered by backups, and has a restore been tested?
- **Right way:** Backups plus a periodic restore drill; backups and restore are separate features.
- **Proof:** Date of the last successful restore test, or a Later item to run one.

### DATA-09 Growth
- **Ask:** Does this data grow without bound (logs, events, history)?
- **Right way:** Retention or archival policy; alert before storage fills (S11).
- **Proof:** Growth estimate and the retention rule.
