# Inbound events

Webhooks received, queue and stream consumers, event handlers.

### IN-01 Delivered twice
- **Ask:** What happens when the same event arrives again?
- **Right way:** Record processed event ids and skip repeats; some providers also send distinct events for the same change, so dedupe on the object id plus type where needed (S5).
- **Proof:** Test delivering the same event twice: one effect.

### IN-02 Out of order
- **Ask:** What if "updated" arrives before "created", or an old state arrives after a new one?
- **Right way:** Do not rely on order or timestamps; fetch the current object from the source when order matters, or compare versions (S5).
- **Proof:** Test delivering events in reverse order.

### IN-03 Never arrives
- **Ask:** What if an expected event is lost?
- **Right way:** Reconcile on a schedule against the source of truth; alert when expected events stop.
- **Proof:** A reconciliation job, and a test that it repairs a missed event.

### IN-04 Authentic
- **Ask:** Can anyone post a fake event to this endpoint?
- **Right way:** Verify the signature on the raw body with a constant-time compare; reject old timestamps to stop replays (S5).
- **Proof:** Tests with a bad signature, a modified body and a stale timestamp, all rejected.

### IN-05 Acknowledge fast, process later
- **Ask:** Does the handler do slow work before responding?
- **Right way:** Verify, persist, return 2xx, then process from a queue (S5).
- **Proof:** Handler response time measured with a slow downstream.

### IN-06 Poison messages
- **Ask:** What happens to an event that fails every time?
- **Right way:** Bounded retries with backoff, then a dead-letter store with an alert; one bad event never blocks the rest.
- **Proof:** Test with an always-failing event: it lands in dead-letter, others proceed.

### IN-07 Bursts
- **Ask:** What happens when thousands arrive at once (month start, backfill, provider replay)?
- **Right way:** Queue between receipt and processing; process at a controlled rate (S5).
- **Proof:** Load test or a stated peak with the queue's capacity.

### IN-08 Schema drift
- **Ask:** What if the provider adds fields, changes versions, or sends an unknown event type?
- **Right way:** Ignore unknown fields and types safely, log them; pin the provider API version.
- **Proof:** Test with an unknown event type and extra fields.
