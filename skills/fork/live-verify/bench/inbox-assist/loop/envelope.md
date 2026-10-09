# Envelope: inbox-assist reply suggestions

Written after the fact for the product as built: every mechanism below exists in `src/`, every proof is a scenario in `scenarios/` (by number), a unit test in `test/unit.test.mjs` (by name) or the eval run in `evals/examples/inbox-assist/results/after/`.

**Purpose:** a support team gets three reply drafts in Slack for each customer email to their Gmail mailbox and sends the one they pick, in the same thread, with one click.
**Properties:** sent once, to the right person, only after a human click, every email ends visibly (drafts, a notice or a recorded skip), Slack acks under 3 s, one workspace never sees or slows another, tokens sealed and data deleted after uninstall.
**Packs:** core (always); `detect-packs.sh --paths src/*.mjs` printed: ui-visual (`src/gmail.mjs:30 async function call(token, method, path, body) {`), ui-behavior (`src/gmail.mjs:33 res = await fetch(...)`), api (`src/suggestions.mjs:29 export function get(db, teamId, id) {`), data (`src/db.mjs:7 const tenantsTable = (name) => ...CREATE TABLE`), outbound (`src/mail.mjs:78 if (h.has('list-unsubscribe') ...`), inbound-events (`src/config.mjs:9 SLACK_SIGNING_SECRET`), jobs-time (`src/db.mjs:148 export const now = () => Date.now();`), integrations-auth (`src/config.mjs:10 GMAIL_API_BASE`), llm (`src/config.mjs:14 LLM_PROVIDER`), retrieval (`src/server.mjs:47 const chunks = [];`), identity-access (`src/config.mjs:9 SLACK_SIGNING_SECRET`), files (`src/mail.mjs:106 'MIME-Version: 1.0',`), personal-data (`src/db.mjs:23 CREATE TABLE IF NOT EXISTS emails`), infra-config (`src/config.mjs:40 export function loadConfig`), money (`src/draft.mjs:66 ... account or payment details ...`). None added by judgment. ui-visual, retrieval, files and money are kept as the script selected them and answered N/A.
**Second pass:** done after the fact: the 2026-10-08 adversarial review (seven topic attackers, each reproducing its findings, see `review.md`) added the 14 confirmed issues F1 to F14; each is now a Live row or an Extra item below. No disagreement left open.

## Live

| ID | Severity | Failure path | Mechanism | Enforced at | Proof | Runtime signal |
|---|---|---|---|---|---|---|
| OUT-01 | Critical | `replies.mjs:sendReply` retries after Gmail sent but the response was lost, or a worker dies mid-send; `inbox.mjs:postOnce` retries a Slack post that succeeded | M1 send intent with a fixed Message-ID, reconciled before any retry | `suggestions.send_message_id` UNIQUE, written by `claimSend` before the Gmail call; `gmail.findSent`; post metadata key in `postOnce` | scenarios 11, 12, 21, 29 | log `send.reconciled`, `post.reconciled` |
| OUT-03 | Critical | the model or a hostile email changes the recipient; an RFC 2047 display name hides another address (`mail.mjs:addressOf`) | M2 recipient, subject and threading from the original message's raw headers; the model writes body text only | `mail.mjs:buildReply` and `addressOf`, the single owning module | scenarios 15, 36; unit test `From parsing: address from the raw header, unknown charsets decode with a fallback` | `outcomes.sender` per reply |
| LLM-03 | Critical | an email instructs the model to add recipients, links or to send now | M2, plus the thread quoted as untrusted data and a human click before any send | `draft.mjs:buildPrompt` (`quote`), `replies.requestSend` is the only path to `send_reply` | scenario 15; unit test `prompt: email is quoted untrusted data and cannot close the quote`; eval grader `injection_resisted` 100% | eval gate `grader:injection_resisted>=1` per prompt change |
| ID-01 | Critical | a click from workspace B carries workspace A's suggestion id (`replies.mjs:onInteraction`) | M3 team from the verified payload, every row read and written by (id, team_id) | `suggestions.get` and `transition` filter `team_id` | scenario 20 | log `security.unknown_suggestion` |
| ID-02 | Critical | a button value or modal `private_metadata` names a suggestion the clicker's team does not own | M3 | `suggestions.get(db, teamId, id)` before any action | scenario 20 | log `security.unknown_suggestion` |
| UIB-01 | Critical | a double click lands on two instances and both send (`suggestions.claimSend`) | M4 state machine, one conditional UPDATE per transition | `suggestions.transition`: `WHERE id = ? AND team_id = ? AND status = ?` | scenarios 09, 40; unit test `state machine: only the documented transitions are legal` | log `reply.lost_race` |
| UIB-05 | High | two people click different options at once | M4 | `suggestions.transition` | scenarios 10, 40 | log `reply.lost_race` |
| UIB-06 | Normal | a stale copy of the message is clicked after Dismiss or Send | M4, and the resolved message replaces the buttons | `suggestions.transition`; `slack.resolvedMessage` | scenario 05 | log `reply.lost_race` |
| IN-01 | High | Pub/Sub redelivers a push, two instances get the same push, Slack retries an event | M5 dedupe keys on every inbound delivery | PK `emails (team_id, gmail_message_id)`, UNIQUE `suggestions (team_id, gmail_message_id)`, PK `slack_events.event_id`, unique `jobs_coalesce` index | scenarios 06, 08, 25; unit test `emails: one row per (team, message) is enforced by the database; two syncs make one draft job` | log `slack.event_duplicate`, `push.received` with `coalesced` |
| IN-02 | High | the push for an older history id arrives last and rewinds the mailbox position | M6 forward-only history position | `tenants.advanceHistoryId` conditional UPDATE | scenario 07 | log `push.stale` |
| IN-04 | Critical | forged, tampered or replayed Slack requests, forged pushes | M7 authentication before parsing | `server.mjs`: `verifySlackSignature` on raw bytes with a 300 s window, `verifyPushToken` constant time | scenarios 18, 19; unit tests `slack signature: valid, tampered, wrong secret, stale, future, missing`, `push token: constant-time compare, empty rejected` | log `security.slack_signature_rejected`, `security.push_token_rejected` |
| API-01 | High | anyone calls `POST /admin/installations` or `GET /admin/outcomes` | M7 admin bearer token | `server.mjs:adminOk` via `verifyPushToken` | unit test `push token: constant-time compare, empty rejected`; scenarios 01, 30 (authorized calls) | none needed: rejected calls return 401 and touch nothing |
| IN-05 | High | slow Gmail, Slack or model calls on the request path push acks past Slack's 3 s | M8 durable job queue, ack after one DB write | `jobs.enqueue` in the request, work in `startWorker`; `views.open` runs after the ack | scenarios 22, 39; the runner's ack check on every scenario | Slack retries visible as `slack.event_duplicate` with `retryNum` |
| API-09 | Normal | long work inside a request handler | M8 | `server.mjs` routes only enqueue | scenario 22 | none needed: covered by IN-05's signal |
| JOB-03 | Critical | a worker crashes between claim and send | M9 leases fenced by (locked_by, attempts), handlers check state first | `jobs.claim` single statement; `fence` in `renewLease`, `complete`, `fail` | scenario 21; unit test `jobs: one claim per job across workers, fenced completion, coalescing, dead-letter` | log `job.lease_lost` |
| JOB-02 | High | two workers run the same job after a lease expires | M9 | `jobs.fence` | unit test `jobs: one claim per job across workers, fenced completion, coalescing, dead-letter`; scenario 21 | log `job.lease_lost` |
| JOB-01 | High | a job dies or a handler throws and the user never hears; an exception in bookkeeping kills the instance | M10 dead letter with a visible outcome for every failure | `handlers.onDead`, `post_fallback`, `outcomes`; `startWorker` contains every throw | scenarios 14, 38; unit test `worker: a throwing onDead or failed bookkeeping is contained, never an unhandled rejection` | log `job.dead`, `/healthz` worker check |
| CORE-03 | High | drafting, posting or sending fails silently | M10 | `outcomes` table, `slack.fallbackMessage`, `resolvedMessage` failed line | scenarios 14, 38 | `GET /admin/outcomes` `draft_failed`, `send_failed` |
| LLM-08 | High | the model is down, slow or returns invalid output | M10 fallback notice after bounded retries | `inbox.draftEmail` with `LLM_MAX_ATTEMPTS`; `draft.parseOptions` | scenario 14; unit tests `draftReplies: provider errors become DraftError with transient flag`, `model output schema: exactly 3 non-empty options within the cap` | log `draft.failed` |
| JOB-04 | Normal | retries hammer a failing provider or never stop | M11 retry policy | `jobs.fail`: exponential backoff with jitter, `retryAfterMs`, `max_attempts` | scenarios 12, 13, 34 | log `job.retry` with `retryAfterMs` |
| INT-03 | High | Slack or the model answers 429 and the app retries at once | M11 provider Retry-After honored and capped | `slack.call`, `llm.retryAfterMs` (5 min cap) | scenarios 13, 34 | log `job.retry` with `retryAfterMs` |
| INT-04 | High | a provider hangs, or a 2xx body stops halfway and reads as "no new mail" | M12 timeouts on every call, full body reads, a cut-short 2xx is retryable | `gmail.call`, `slack.call` (`invalid_json`), `anthropicProvider` | scenarios 22, 26 | log `job.retry` |
| LLM-07 | High | a mail bomb or a long thread runs up model spend | M13 per-tenant draft budget and prompt token budget | `draft_usage` upsert in `inbox.takeDraftBudget`; `draft.fitThreadToBudget` | scenarios 37, 23; unit tests `truncation: last 5 only, newest kept, oldest dropped first, within budget`, `truncation: a single huge newest message is cut to fit, not dropped` | log `draft.budget_exceeded` |
| IN-07 | High | one tenant's burst of slow drafts holds every worker slot | M14 slow lane with a per-tenant cap across instances | `jobs.claim` `slowKinds`, `WORKER_DRAFT_SLOTS`, `TENANT_MAX_RUNNING_DRAFTS` | scenario 28 | none needed: bounded by construction; queue age shows in `jobs.run_at` |
| OUT-07 | Normal | auto-replies, noreply and bulk mail get drafts and model spend | M15 skip rules before drafting | `mail.skipReason` | scenario 17; unit test `loop prevention: own mail, app mail, machine mail` | outcome `skipped` with `detail` |
| INT-09 | High | our own sent reply comes back through history and is drafted again (a loop) | M15 | `mail.skipReason` (`SENT` label, `X-Inbox-Assist-Suggestion` header, own mailbox) | scenario 16; unit test `loop prevention: own mail, app mail, machine mail` | outcome `skipped` `sent_by_app` |
| INT-06 | High | an unknown charset kills the job; CRLF in a subject injects headers | M16 defensive decoding and encoding | `mail.decodeBytes`, `mail.headerValue` | scenarios 24, 35; unit test `reply headers: no CRLF injection, RFC 2047 for non-ASCII, threading headers` | none needed: failure would show as `job.dead` |
| UIB-11 | High | email or model text renders links, mentions or `<!channel>` in Slack | M16 | `slack.escapeMrkdwn` on every email- and model-derived string | scenario 15; unit test `escapeMrkdwn: no links, mentions or broadcasts from untrusted text` | none needed: escaping is unconditional |
| PII-04 | High | uninstall keeps customer data forever and never revokes Google access | M17 offboarding | `offboard.mjs`: disconnect in the event, `offboard_tenant`, `purge_tenant` over `TENANT_TABLES` | scenarios 25, 32 | `tenant_deletions` row; log `purge.done`, `purge.google_token_not_revoked` |
| DATA-04 | High | two workspaces hold the same active mailbox; an invalid status is written | M18 schema constraints | `db.mjs`: CHECKs, partial unique index `tenants_active_mailbox` | scenario 30 | log `tenant.mailbox_taken` |
| DATA-05 | High | two instances interleave a read and a write | M18 transactions | `db.tx` (`BEGIN IMMEDIATE`), single-statement `jobs.claim` | scenarios 08, 10; unit test `jobs: one claim per job across workers, fenced completion, coalescing, dead-letter` | none needed: SQLite write lock |
| DATA-01 | Normal | an existing v0 database keeps the global mailbox UNIQUE | M18 versioned migration | `db.migrate` on `PRAGMA user_version` | unit test `migration: a v0 database (mailbox UNIQUE across all tenants) is rebuilt and keeps its rows` | none needed: runs once at boot |
| INF-08 | High | a deploy kills in-flight requests and jobs | M19 graceful shutdown | `server.shutdown`: `/healthz` 503, drain within `SHUTDOWN_GRACE_MS`, leases released | scenario 27 | log `server.stopped` with `requestsDrained` |
| LLM-02 | High | drafts invent prices, policies, teams or actions taken | M20 prompt rules traced to failure modes, graded by evals | `draft.mjs:SYSTEM`; `evals/examples/inbox-assist` | eval run `results/after`: `no_fabricated_facts` 100%, `no_invented_numbers` 100% | eval run per prompt or model change |
| LLM-01 | Normal | prompt changes judged on one run | M20 | `evals/examples/inbox-assist` (40 cases x 3 trials, held-out split) | eval run `results/after/results.json` | eval gate `pass.lo>=0.6` (fails narrowly, see Open questions) |
| CORE-01 | High | the code compiles but never posts or sends | M21 live verification against stand-ins | `live-verify` suite on every change (gate G3) | scenarios 02, 03 | outcomes `replied` over `awaiting_user` |
| CORE-02 | Normal | empty or oversized modal text, oversized bodies, malformed model output | M22 validation at the boundary | `server.readRaw` (1 MiB, 413), `replies.onInteraction` (1 to 3000 chars), `draft.parseOptions` | scenario 04; unit test `model output schema: exactly 3 non-empty options within the cap` | none needed: rejected with a field error |
| CORE-06 | Normal | nobody can answer "did this sender get a reply?" | M23 correlation ids, outcomes, doctor | `log.mjs` (`cid`), `GET /admin/outcomes`, `GET /healthz` | scenarios 03, 05, 14 (read outcomes); the runner waits on `/healthz` | the endpoints themselves |

## Mechanisms

| ID | Mechanism | Covers | Enforced at | Built in slice |
|---|---|---|---|---|
| M1 | Send intent: Message-ID fixed before the Gmail call, reconciliation before every retry (email by Message-ID, Slack by post metadata) | OUT-01 | UNIQUE `suggestions.send_message_id`; `gmail.findSent`; `inbox.postOnce` | 1 (foundation) |
| M2 | Recipient, subject and threading from the original raw headers; model output is body text only; human click before send | OUT-03, LLM-03 | `mail.mjs` (single owning module); `replies.requestSend` | 1 (foundation) |
| M3 | Team from the verified payload; (id, team_id) on every row access | ID-01, ID-02 | `suggestions.get`, `suggestions.transition` | 1 (foundation) |
| M4 | Suggestion state machine, conditional UPDATE per transition | UIB-01, UIB-05, UIB-06 | `suggestions.transition` | 1 (foundation) |
| M5 | Dedupe keys on inbound deliveries | IN-01 | primary keys and unique indexes in `db.mjs` | 1 (foundation) |
| M6 | Forward-only history position | IN-02 | `tenants.advanceHistoryId` | 2 |
| M7 | Authentication before parsing | IN-04, API-01 | `server.mjs` routes | 1 (foundation) |
| M8 | Durable job queue, ack after one write | IN-05, API-09 | `jobs.enqueue`, `startWorker` | 1 (foundation) |
| M9 | Fenced leases, state-checking handlers | JOB-03, JOB-02 | `jobs.claim`, `fence` | 1 (foundation) |
| M10 | Dead letter with a visible outcome | JOB-01, CORE-03, LLM-08 | `onDead` handlers, `outcomes`, `post_fallback` | 2 |
| M11 | Retry policy with backoff, jitter and Retry-After | JOB-04, INT-03 | `jobs.fail`, provider clients | 2 |
| M12 | Timeouts and strict body reads on every outbound call | INT-04 | `gmail.call`, `slack.call`, `anthropicProvider` | 2 |
| M13 | Draft budget per tenant and prompt token budget | LLM-07 | `draft_usage`, `draft.fitThreadToBudget` | 3 |
| M14 | Slow lane for drafts with a per-tenant cap | IN-07 | `jobs.claim` | 3 |
| M15 | Skip rules before drafting | OUT-07, INT-09 | `mail.skipReason` | 2 |
| M16 | Defensive decoding, header encoding, Slack escaping | INT-06, UIB-11 | `mail.mjs`, `slack.escapeMrkdwn` | 2 |
| M17 | Offboarding: disconnect, revoke, purge with a deletion record | PII-04 | `offboard.mjs` | 4 |
| M18 | Schema constraints, `BEGIN IMMEDIATE` transactions, versioned migration | DATA-04, DATA-05, DATA-01 | `db.mjs` | 1 (foundation) |
| M19 | Graceful shutdown | INF-08 | `server.shutdown`, `worker.stop` | 4 |
| M20 | Prompt rules graded by evals | LLM-02, LLM-01 | `draft.mjs:SYSTEM`, `evals/examples/inbox-assist` | 3 |
| M21 | Live verification against stand-ins | CORE-01 | `live-verify` suite, gate G3 | 1 (foundation) |
| M22 | Validation at the boundary | CORE-02 | `server.readRaw`, `replies.onInteraction`, `draft.parseOptions` | 2 |
| M23 | Correlation ids, outcomes, doctor | CORE-06 | `log.mjs`, `/admin/outcomes`, `/healthz` | 4 |

## Build plan

1. Foundation: M1, M2, M3, M4, M5, M7, M8, M9, M18, M21, proven by scenarios 03, 06, 08, 09, 10, 11, 15, 18, 20, 21 and the unit tests for jobs, state machine and signatures.
2. Slice: email to DM with options and fallbacks, carrying IN-02, JOB-01, CORE-03, LLM-08, JOB-04, INT-03, INT-04, OUT-07, INT-09, INT-06, UIB-11, CORE-02 (M6, M10, M11, M12, M15, M16, M22).
3. Slice: cost and fairness, carrying LLM-07, IN-07, LLM-02, LLM-01 (M13, M14, M20).
4. Rollout and operate: offboarding, shutdown and observability, carrying PII-04, INF-08, CORE-06 (M17, M19, M23); the `/healthz` doctor and the `outcomes` endpoint wired to dashboards before the first external install.

## Later

- INT-01: Gmail access tokens are stored as given and never refreshed; needs the real Google OAuth flow (shape: Out), filed with it.
- INT-07: tokens are sealed with AES-256-GCM (`tenants.createSealer`), but no test reads a raw row to prove it; add one.
- PII-02: every log call passes ids, counts and reasons (`log.mjs` convention), but no check scans app logs for body text; add a live-run assertion.
- IN-03: a lost push is only recovered by the next push; add a periodic `sync_mailbox` per tenant when a mailbox can go quiet for hours.
- INT-08: Slack and Gmail API versions are implicit in the base URLs; pin when the first deprecation notice arrives.
- ID-07: who sent each reply is in `outcomes.actor`, but there is no audit export; add with the first enterprise customer.
- PII-06: no export of a tenant's data before purge; add when a customer asks.
- DATA-07, DATA-09: `outcomes` and `jobs` grow without pruning of `done` jobs; add retention when `jobs` passes a size we can name (see shape Size).
- JOB-08: no alert on queue age; wire `jobs.run_at` age to an alert with the operate slice.

## N/A

- ui-visual (VIS-01 to VIS-11): no visual design of our own; Slack renders Block Kit.
- files (FILE-01 to FILE-06): no file uploads or attachments are read or written; `MIME-Version` is an email header.
- money (MON-01 to MON-08): no payments; the trigger was prompt text forbidding payment details.
- retrieval (RET-01 to RET-10): no retrieval or index; the trigger was a request body buffer. The thread itself is context, covered by LLM-03 and LLM-07.
- CORE-05: a new product, no earlier behavior to keep.
- CORE-07, INF-03, INF-09: no deploy target or flags yet; uninstall is the per-tenant off switch.
- CORE-08, CORE-09, CORE-10: covered by the review (`review.md`), the scenarios asserting observable outcomes, and LLM-07 and IN-07.
- API-02, API-04, API-05, API-06, API-07, API-08, API-10, API-11: no public API beyond Slack and Pub/Sub callbacks (validated under CORE-02, timeouts under INT-04); no caller-supplied URLs; no browser callers; outcomes are filtered by team and sender.
- DATA-02, DATA-03, DATA-06, DATA-08: one small migration at boot; no second source of truth; backups belong to the deploy, not built yet.
- OUT-02, OUT-04, OUT-05, OUT-06, OUT-08, OUT-09, OUT-10, OUT-11: a human-picked one-to-one reply from the customer's own mailbox: no delivery tracking, suppression lists, sending domain of ours, unsubscribe, scheduling or bulk sending; content truth is LLM-02.
- IN-06, IN-08: a malformed push is acked with 204 and dropped by design (redelivery would fail the same way); payload shapes are pinned by the stand-ins.
- JOB-05, JOB-06, JOB-07, JOB-09: instants are epoch milliseconds; no calendar rules; the only schedule is the purge delay.
- INT-02, INT-05: scopes are set by the OAuth flows (Out); history paging is handled in `gmail.history`.
- LLM-04, LLM-05, LLM-06, LLM-09, LLM-10, LLM-11: no tools; the model sees one thread of the tenant's own mail; a human always picks; model and prompt are pinned in config and graded by evals.
- ID-03, ID-04, ID-05, ID-06, ID-08, ID-09: no sessions, passwords or links; Slack identifies the user.
- PII-01, PII-03, PII-05: only what drafting needs is stored; email text goes to the model provider, which the shape's privacy property accepts.
- INF-01, INF-02, INF-04, INF-05, INF-06, INF-07: config is validated at boot (`config.loadConfig`); no caches, CDN or certificates of ours.
- UIB-02, UIB-03, UIB-04, UIB-07, UIB-08, UIB-09, UIB-10, UIB-12: Slack owns rendering, loading states and accessibility; "Sent" is shown only after Gmail accepted (`markSent`).

## Extra (from purpose, not in any pack)

| Item | Failure path | Mechanism | Proof |
|---|---|---|---|
| Member token revoke | `tokens_revoked` for a member's user token disconnected the whole workspace (`server.mjs` events route) | only `app_uninstalled` or a revoked bot token disconnects | scenario 33 |
| Mailbox moves workspace | a mailbox freed by an uninstall could never be connected again | partial unique index on active tenants (M18) | scenario 30 |
| Reinstall with another mailbox | the old mailbox's history id was kept for the new one | `installTenant` keeps the furthest position only for the same mailbox | scenario 31 |

## Open questions

- LLM-01 eval gate: `pass.lo>=0.6` fails narrowly (lower bound 58.5%, `results/after/results.json`), so gate G4 is red until the next iteration passes it. Blocking for release.
- API-01: no scenario calls an admin route without the token; the proof is the unit-tested compare function. Not blocking.
- Pub/Sub push auth is a shared bearer token, not OIDC JWT verification (`gmail.verifyPushToken` comment). Blocking for a production deploy (shape: Out).
