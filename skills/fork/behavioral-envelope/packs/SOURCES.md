# Sources

Sources the packs cite (S1 is a summary of the standard, not the standard itself). Dated entries were checked on that date; re-check them when a pack item depends on a provider rule that may change.

| ID | Source | What the packs take from it |
|---|---|---|
| S1 | [ISO/IEC 25010:2023, product quality model](https://quality.arc42.org/articles/iso-25010-update-2023) (via arc42 summary, checked 2026-10-08) | The quality characteristics the core pack spans, including safety, interaction capability and flexibility added or renamed in 2023 |
| S2 | [WCAG 2.2, SC 1.4.3 Contrast (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) (checked 2026-10-08) | Text contrast at least 4.5:1, large text at least 3:1, ratios not rounded |
| S3 | [WCAG 2.2](https://www.w3.org/TR/WCAG22/) | Non-text contrast, focus visible, keyboard access, reflow |
| S4 | [Stripe, Idempotent requests](https://docs.stripe.com/api/idempotent_requests) (checked 2026-10-08) | Client-generated idempotency keys, stored result replayed on retry, parameters compared, keys pruned after 24 hours, no personal data in keys |
| S5 | [Stripe, Receive events in your webhook endpoint](https://docs.stripe.com/webhooks) (checked 2026-10-08) | Duplicate deliveries, no ordering guarantee, signature on the raw body, replay tolerance, fast 2xx then async processing, retries for up to three days |
| S6 | [Google, Email sender guidelines and FAQ](https://support.google.com/a/answer/14229414) (checked 2026-10-08) | SPF and DKIM, DMARC, alignment, PTR, TLS, RFC 5322, user-reported spam rate below 0.1% and never at or above 0.3%, RFC 8058 one-click unsubscribe for marketing mail, unsubscribes processed within 48 hours |
| S7 | [Google SRE book, Monitoring Distributed Systems](https://sre.google/sre-book/monitoring-distributed-systems/) (checked 2026-10-08) | Four golden signals (latency, traffic, errors, saturation), alert on symptoms, every page actionable |
| S8 | [OWASP Top 10 for LLM Applications](https://genai.owasp.org/llm-top-10/) | Prompt injection, sensitive information disclosure, excessive agency, misinformation, unbounded consumption |
| S9 | [OWASP Top 10](https://owasp.org/Top10/) and [OWASP ASVS](https://owasp.org/www-project-application-security-verification-standard/) | Broken access control, injection, authentication, security misconfiguration |
| S10 | Kleppmann, *Designing Data-Intensive Applications* (O'Reilly) | Exactly-once effects through idempotence, ordering, unreliable clocks, transactions and isolation |
| S11 | Nygard, *Release It!* (Pragmatic Bookshelf) | Timeouts, circuit breakers, bulkheads, steady state (logs and data that grow until the disk fills), slow responses |
| S12 | [RFC 8058, One-click unsubscribe](https://www.rfc-editor.org/rfc/rfc8058) | `List-Unsubscribe` and `List-Unsubscribe-Post` headers |
| S13 | [The Twelve-Factor App](https://12factor.net/) | Config in the environment, dev and prod parity, disposable processes |
| S14 | [IANA time zone database](https://www.iana.org/time-zones) | Named time zones and their daylight saving rules, which change over time (so keep the zone name, not a fixed offset) |
