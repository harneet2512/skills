# Integrations and auth

Third-party APIs, OAuth connections, API keys, SDKs.

### INT-01 Token expiry and refresh
- **Ask:** What happens when the access token expires, the refresh fails, or the user revokes access?
- **Right way:** Refresh before expiry; on failure mark the connection broken and alert the owner; never fail silently.
- **Proof:** Test with an expired token and with a revoked refresh token.

### INT-02 Least scope
- **Ask:** Does the integration request more permission than this feature needs?
- **Right way:** Request the narrowest scopes; add scopes only when a feature needs them.
- **Proof:** Scope list in the contract, each justified.

### INT-03 Their rate limits
- **Ask:** What happens when the provider throttles, per user or per app?
- **Right way:** Respect `Retry-After`, back off with jitter, spread work per account; budget calls per sync.
- **Proof:** Test with a 429 response.

### INT-04 Their outages and slowness
- **Ask:** What does the product do when the provider is down or slow?
- **Right way:** Timeouts, circuit breaker, a degraded mode the user can see (S11).
- **Proof:** Test with the provider timing out.

### INT-05 Pagination and partial sync
- **Ask:** Does a sync handle many pages, and resume after failing on page 37?
- **Right way:** Store a cursor; make each page's processing idempotent.
- **Proof:** Test failing mid-sync then resuming.

### INT-06 Their data is untrusted
- **Ask:** Is data from the provider validated before use?
- **Right way:** Parse at the boundary; tolerate missing and extra fields; never execute or render it unescaped.
- **Proof:** Test with malformed provider responses.

### INT-07 Secrets
- **Ask:** Where do keys and tokens live, who can read them, and are they in logs?
- **Right way:** Kept out of code, in the environment or a secret store (S13); encrypted at rest, separate keys per environment, never logged.
- **Proof:** Search of code and logs shows no secrets.

### INT-08 Version pinning
- **Ask:** Will a provider API or SDK change break this without warning?
- **Right way:** Pin API and SDK versions; read deprecation notices; contract tests on what you rely on.
- **Proof:** Pinned version in config.

### INT-09 Two-way sync loops and conflicts
- **Ask:** If data syncs both ways, can our write trigger their event that triggers our write again, and who wins when both sides change the same field?
- **Right way:** Record the origin and last-synced value of each field and drop echoes; a per-field conflict rule decided from each system's own change history, not wall clocks compared across systems; guard against a bad batch mass-deleting or blanking records.
- **Proof:** Tests for an echo, a same-field conflict, and a reconcile that would delete more than a threshold.
