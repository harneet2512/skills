# Review: inbox-assist

The first adversarial review, 2026-10-08: seven topic attackers on the app as built, each required to reproduce its findings (the run is described in `feature-loop/bench/scorecard-2026-10-08.md`). The 13 planted bugs of the mutant benchmark were planted in copies and are not in this app, so they are not listed. The 14 issues below are the real ones the attackers found in the app itself; each was reproduced, fixed and kept as the scenario or unit test named in its resolution. The other attacker findings were PLAUSIBLE or duplicates and none was blocking.

## Findings

| ID | Axis | Category | Severity | Status | Resolution |
|---|---|---|---|---|---|
| F1 | reliability | REL-07 | HIGH | CONFIRMED | fixed, scenario 26 (a Gmail 200 with a truncated body was read as success and mail was skipped silently) |
| F2 | reliability | REL-11 | MEDIUM | CONFIRMED | fixed, scenario 27 (shutdown did not drain in-flight requests) |
| F3 | multi-tenancy | TEN-09 | HIGH | CONFIRMED | fixed, scenario 28 (one tenant's flood of slow drafts delayed sends and other tenants) |
| F4 | reliability | CONC-11 | MEDIUM | CONFIRMED | fixed, scenario 29 (a lost `chat.postMessage` response produced a duplicate DM) |
| F5 | multi-tenancy | TEN-11 | MEDIUM | CONFIRMED | fixed, scenario 30 (a mailbox freed by an uninstall could never be connected again) |
| F6 | data integrity | DI-12 | HIGH | CONFIRMED | fixed, scenario 31 (a reinstall with a new mailbox kept the old mailbox's history id) |
| F7 | security | COMP-02 | HIGH | CONFIRMED | fixed, scenario 32 (uninstall kept customer data and never revoked the Google token) |
| F8 | multi-tenancy | TEN-14 | HIGH | CONFIRMED | fixed, scenario 33 (revoking a member's user token disconnected the whole workspace) |
| F9 | AI behavior | AI-11 | MEDIUM | CONFIRMED | fixed, scenario 34 (the model provider's Retry-After was ignored) |
| F10 | data integrity | DI-11 | HIGH | CONFIRMED | fixed, scenario 35 (an unknown charset in a header killed the job, the user never heard) |
| F11 | security | SEC-07 | CRITICAL | CONFIRMED | fixed, scenario 36 (an RFC 2047 display name could override the From address, so the reply went elsewhere) |
| F12 | latency and cost | COST-13 | HIGH | CONFIRMED | fixed, scenario 37 (no per-tenant draft budget: a mail bomb meant unbounded model spend) |
| F13 | reliability | REL-09 | HIGH | CONFIRMED | fixed, unit test `worker: a throwing onDead or failed bookkeeping is contained, never an unhandled rejection` (an exception in job bookkeeping crashed the instance) |
| F14 | reliability | REL-14 | HIGH | CONFIRMED | fixed, scenario 38 (a Slack post that died left the suggestion stuck with no notice) |

## Justified

Every finding of `concern-topics/scripts/slop-check.sh --paths src/*.mjs` (2026-10-08), each looked at and kept on purpose:

- `src/gmail.mjs:99` CRAFT-03.empty-catch: the revoke response body is optional; the HTTP status decides the outcome on the next lines, and a non-2xx without a readable body still throws with its status.
- `src/jobs.mjs:130` CRAFT-03.log-and-continue: last-resort guard on the detached `run(job)` promise; `run` already contains every handler error, this only stops an unexpected throw from becoming an unhandled rejection that kills the instance (F13).
- `src/jobs.mjs:142` CRAFT-13.sleep-wait: the shutdown drain loop polls the in-flight count, bounded by the grace deadline passed in from SHUTDOWN_GRACE_MS.
- `src/jobs.mjs:144` CRAFT-03.log-and-continue: releasing leases at shutdown is an optimisation; if it fails, the leases expire after JOB_LEASE_MS and another instance takes the jobs, so the process should still exit.
- `src/llm.mjs:36` CRAFT-03.empty-catch: an unreadable body becomes null and the next line turns a 200 with null into a transient LlmError, so nothing is swallowed.
- `src/offboard.mjs:3` CRAFT-06.commented-code: false positive, the line is prose in the module's numbered description of the offboarding steps.
- `src/server.mjs:184` CRAFT-13.sleep-wait: the shutdown deadline timer itself, from SHUTDOWN_GRACE_MS, unref'd so it never holds the process open.
