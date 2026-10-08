# API

HTTP routes, handlers, RPC methods, any interface another program calls.

### API-01 Who may call it
- **Ask:** Is authentication required, and is authorization checked for this specific resource and tenant?
- **Right way:** Check access per object, not just "logged in"; deny by default (S9).
- **Proof:** Tests calling as another user and another tenant get 403 or 404.

### API-02 Input validation
- **Ask:** Are types, sizes, ranges and formats validated before use?
- **Right way:** Schema validation at the edge with clear 4xx errors; parameterized queries only (S9).
- **Proof:** Tests with malformed, oversized and injection-shaped input.

### API-03 Retries are safe
- **Ask:** If a client retries a write after a timeout, does it apply twice?
- **Right way:** Accept an idempotency key on writes; store the first result and replay it; reject reuse with different parameters (S4).
- **Proof:** Test sending the same key twice gets one effect and the same response.

### API-04 Errors are a contract
- **Ask:** Do callers get stable status codes and error shapes they can act on?
- **Right way:** 4xx for caller mistakes, 5xx for server faults, one error shape, no stack traces or internals leaked.
- **Proof:** Tests asserting status and body for each error path.

### API-05 Existing callers keep working
- **Ask:** Does any field, type, default or status change break a current caller?
- **Right way:** Additive changes only, or version the interface and migrate callers.
- **Proof:** Contract or snapshot test of the old response shape still passing.

### API-06 Unbounded results
- **Ask:** Can a request return or process an unbounded number of items?
- **Right way:** Paginate with a stable cursor; cap page size.
- **Proof:** Test with more items than one page.

### API-07 Rate limits and abuse
- **Ask:** What stops one caller from exhausting the service?
- **Right way:** Per-caller limits with 429 and `Retry-After`; expensive endpoints limited tighter.
- **Proof:** Test exceeding the limit gets 429 with a retry hint.

### API-08 Timeouts on everything it calls
- **Ask:** Does every downstream call have a timeout, and is the total under the caller's timeout?
- **Right way:** Explicit timeouts and a budget; fail fast rather than pile up (S11).
- **Proof:** Test with a slow dependency returns within budget.

### API-09 Long work off the request path
- **Ask:** Does the handler do work that can exceed a normal request time?
- **Right way:** Accept, enqueue, return a job id; report status separately.
- **Proof:** Live run under realistic input size shows response time.

### API-10 Fetching URLs the caller supplies
- **Ask:** Does the server fetch a URL, host or file path that came from the request?
- **Right way:** Allowlist schemes and hosts; block private and metadata addresses after DNS resolution; no redirects to blocked hosts (server-side request forgery, S9).
- **Proof:** Tests with `http://169.254.169.254`, `localhost` and a redirect to a private address, all refused.

### API-11 Cross-site requests
- **Ask:** If auth uses cookies, can another site trigger this write from the user's browser?
- **Right way:** CSRF tokens or `SameSite` cookies plus an origin check on state-changing requests (S9).
- **Proof:** Test of a cross-origin write without a token, refused.
