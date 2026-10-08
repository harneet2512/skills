# Money and numbers

Prices, amounts, currency, payments, invoices, quantities, rounding, trading and any number where being slightly wrong costs money.

### MON-01 No floating point for money
- **Ask:** Are amounts held as binary floats anywhere (code, JSON, database)?
- **Right way:** Integer minor units or a decimal type end to end; currency stored with every amount.
- **Proof:** Test summing values such as 0.1 and 0.2 yields the exact expected amount.

### MON-02 Rounding rule
- **Ask:** Where does rounding happen, by which rule, and does it match the business or legal rule?
- **Right way:** One rounding function with a named rule, applied at a defined step.
- **Proof:** Table test of edge values (half cents, negatives).

### MON-03 Exactly once
- **Ask:** Can a charge, refund, payout or order happen twice on retry?
- **Right way:** Idempotency key per financial operation (S4); a unique constraint on the operation id.
- **Proof:** Test retrying after a timeout produces one operation.

### MON-04 Current values
- **Ask:** Can the decision use a stale price, rate or balance?
- **Right way:** Read with a freshness bound; reject or re-quote when stale; lock the value used in the record.
- **Proof:** Test with a stale price.

### MON-05 Latency where it matters
- **Ask:** Does the path have a latency budget, and is it measured end to end?
- **Right way:** Name the budget; measure median and tail on the real path; no hidden network calls in the hot path.
- **Proof:** Before and after latency with run count and range.

### MON-06 Reconciliation
- **Ask:** Does the internal ledger agree with the provider or exchange?
- **Right way:** Scheduled reconciliation with alerts on mismatch; append-only ledger entries.
- **Proof:** Reconciliation job and a test with a seeded mismatch.

### MON-07 Limits and kill switch
- **Ask:** What stops a bug from moving a large amount of money quickly?
- **Right way:** Per-operation and per-period limits; a manual kill switch.
- **Proof:** Test that an over-limit operation is refused.

### MON-08 Orders already in flight
- **Ask:** Does the next decision count orders or payments that are open, partly filled or pending, or does it act on the same need twice?
- **Right way:** Effective position or balance = settled plus open and partial; cancel or replace stale open orders before placing new ones.
- **Proof:** Test where an open partial order exists when the next cycle runs.
