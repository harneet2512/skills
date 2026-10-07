# Review checks

Hand these to the reviewer on top of the repo's standards. Each one caught a real bug while this loop was in use. Report one only where the diff makes it live.

- **Time leakage**: anything computed as of time T that reads data from after T. Watch for wall-clock time used where event or replay time was meant.
- **Trusting a model's own labels**: an LLM output classified by the same LLM is not ground truth. Check the label against the data.
- **Destructive commands on non-empty state**: reset, truncate, drop, or a down-migration run against a database or shared store that holds real rows.
- **Exactly-once side effects**: messages, emails, posts, payments. A retry must not send twice (idempotency key, outbox table, or a uniqueness constraint).
- **NULL at the boundary**: a nullable column or field scanned into a non-nullable type.
- **Runaway retries**: retries without a bound or backoff, no breaker when a dependency is down, no budget on paid calls, rate limits ignored.
- **Mocks in a proof path**: a test that passes only against a mock proves nothing about the integration it claims to prove.
