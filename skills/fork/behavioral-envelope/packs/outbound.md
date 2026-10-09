# Outbound messages

Email, SMS, push, Slack or chat messages, outbound webhooks: anything that leaves the system and reaches a person or another system. Once sent, it cannot be taken back.

### OUT-01 Sent once
- **Ask:** If the send is retried (timeout, crash, queue redelivery, user double-click), does the recipient get it twice?
- **Right way:** One idempotency key per logical message, persisted before the provider call and passed to the provider when it supports one (the same pattern S4 documents for payments). Record the provider's message id after success.
- **Proof:** Test with an injected timeout after the provider accepted, then a retry: exactly one provider send.

### OUT-02 Sent is not delivered
- **Ask:** Does the system distinguish queued, sent (provider accepted), delivered, bounced, complained and failed?
- **Right way:** Store each state from the provider's events; never show "delivered" on provider acceptance.
- **Proof:** Test that a bounce event moves the message to bounced.

### OUT-03 Right recipient
- **Ask:** Could this go to the wrong person (stale address, merged contact, shared inbox, test data in production)?
- **Right way:** Resolve the recipient at send time from the owner record; block sends to test or internal-only addresses from production paths.
- **Proof:** Test with a changed and a merged contact.

### OUT-04 Must not send
- **Ask:** Who must never receive this (unsubscribed, bounced, complained, existing customer, another owner's contact, do-not-contact)?
- **Right way:** Check suppression lists at send time, not only when queued.
- **Proof:** Test that a contact unsubscribed after queuing gets nothing.

### OUT-05 Sending identity and deliverability
- **Ask:** Is the sending domain authenticated and aligned, and does it stay under spam thresholds?
- **Right way:** SPF and DKIM, a DMARC record, From domain aligned, TLS, valid PTR, a Gmail spam rate kept below 0.1 percent and never reaching 0.3 percent (S6).
- **Proof:** DNS records checked; a test send's headers show SPF, DKIM and DMARC pass.

### OUT-06 Unsubscribe
- **Ask:** For marketing or sequence mail, can the recipient leave in one click, and is it honored fast?
- **Right way:** RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers (S12); process within 48 hours (S6), ideally immediately.
- **Proof:** Header present in a test send; unsubscribe stops the next scheduled message.

### OUT-07 Replies stop the sequence
- **Ask:** When the recipient replies, does the automated sequence stop, and are auto-replies told apart from real ones?
- **Right way:** Thread with `In-Reply-To` and `References`; detect replies before each scheduled step; classify out-of-office separately.
- **Proof:** Test where a reply arrives before step two: step two never sends.

### OUT-08 Send time
- **Ask:** Is "send at 9am" in the recipient's time zone, and correct across daylight saving changes?
- **Right way:** Store the instant in UTC computed from the recipient's named zone (S14). See `jobs-time`.
- **Proof:** Test scheduling across a daylight saving boundary.

### OUT-09 Provider limits
- **Ask:** What happens at the provider's or mailbox's rate and daily limits?
- **Right way:** Throttle per sender; on 429 or quota errors, back off and reschedule, never drop silently.
- **Proof:** Test with the provider returning a rate-limit error.

### OUT-10 Content is true and safe
- **Ask:** Can the message contain wrong facts, another customer's data, or unescaped user input?
- **Right way:** Render from verified fields only; escape template variables; for generated text see `llm`.
- **Proof:** Test rendering with hostile and missing fields.

### OUT-11 Internal stays internal
- **Ask:** Can an internal note, draft or system field leak into the outgoing message?
- **Right way:** Separate internal and external fields by type; build outgoing content from an allowlist.
- **Proof:** Test that internal notes never appear in a rendered message.
