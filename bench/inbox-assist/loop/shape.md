# Shape: inbox-assist

Derived from the product as built (`src/`, the 40 scenarios in `scenarios/`, `live-verify.json`), not from a user interview: every line below is something the code does or a scenario asserts. Where the code gives no number, the line says so.

## 1. Intent

- **Job**: "When a customer emails our support mailbox, give me reply drafts in Slack so I can answer in one click, and never send anything I did not pick."
- **Why now**: support replies wait for someone to open Gmail, read the thread and type; the team lives in Slack.
- **Properties**: sent once (one email per chosen draft, whatever retries, clicks or crashes happen); sent to the right person (recipient, subject and threading come from the original email, never from the model); human in the loop (nothing is sent without a click); visible (every email ends as a DM with drafts or a plain notice, and every outcome is queryable); fast to acknowledge (every Slack ack under 3 s); isolated (one workspace never sees or slows another); private (tokens sealed, logs carry ids and counts only, data deleted after uninstall).

## 2. Users and surfaces

| Actor | Who | Surfaces |
|---|---|---|
| Support agent | the Slack user named at install (`slack_user_id`), end user | Slack DM from the bot: options, Send, Edit (modal), Dismiss; ephemeral notices |
| Second teammate | another member clicking the same suggestion (scenarios 10, 40) | the same Slack message |
| Workspace admin | installer and approver: connects one Slack workspace to one Gmail mailbox, later uninstalls | `POST /admin/installations` (bench stand-in for the Slack and Google OAuth flows), Slack app management (uninstall, token revoke) |
| External sender | the customer emailing the support mailbox | email |
| The system | Gmail via Pub/Sub push, job workers on every instance, the purge timer | `POST /gmail/push`, `POST /slack/events`, the jobs table |
| Attacker | forges Slack or push requests, replays a captured click, crafts an email that tries to redirect the reply, acts from another workspace | every public endpoint, email content |
| Support or dashboards | reads outcomes | `GET /admin/outcomes` |

Tenant: one Slack workspace (`team_id`) linked to one active Gmail mailbox. Installer and approver: the workspace admin. Absent: end-customer accounts, SSO, a web UI.

## 3. Journey map

| Step | Actor | Surface | What they do | What they see | What they see when it fails | Platform deadline |
|---|---|---|---|---|---|---|
| 1 Install | Workspace admin | admin API (OAuth in production) | Connects the workspace and the support mailbox | 201; only mail that arrives after install is drafted | 400 when a token belongs to another workspace or mailbox; 409 "mailbox is connected to another workspace"; 502 when Gmail returns no history id | none (admin call); deploys may SIGTERM mid-request |
| 2 Email arrives | External sender, then the system | email, Pub/Sub push, Slack DM | Sends an email; Gmail pushes; the app drafts | A DM "New email from ...": three options with Send option 1 to 3, Edit and Dismiss | A plain DM "Couldn't draft replies, open in Gmail" with a Gmail link, or "Draft limit reached for this hour", never silence | Pub/Sub push ack (the app acks after one DB write, under 1 s) |
| 3 Send | Support agent | Slack button, then Gmail | Clicks Send option N and confirms | Within seconds the message turns into "Sent by @agent at HH:MM"; the email goes out in the same Gmail thread | "Couldn't send this reply. Open in Gmail"; a second clicker gets an ephemeral "Already sent by @agent." | Slack interaction ack 3 s |
| 4 Edit and send | Support agent | Slack modal | Clicks Edit, changes the text, submits | A modal prefilled with option 1; on submit it closes and the edited text is sent | Modal field error "Write between 1 and 3000 characters." or the winner's "Already sent by"; if the modal never opens, clicking Edit again works | Slack ack 3 s, `views.open` trigger expires after 3 s |
| 5 Dismiss | Support agent | Slack button | Clicks Dismiss | "Dismissed by @agent", buttons gone | A stale copy clicked later gets "Already dismissed by @agent." and nothing is sent | Slack ack 3 s |
| 6 After the reply | The system | Gmail history | Gmail reports the app's own reply as a new message | Nothing: no draft for our own reply | A DM with drafts for the app's own reply, repeating after every send (a reply loop) | none |
| 7 Uninstall | Workspace admin | Slack app management, Events API | Uninstalls the app, or revokes the bot token | The bot goes quiet; the Gmail watch stops, Google access is revoked, data is deleted after the grace period | A member revoking only their own user token must not disconnect the workspace; a forged or replayed uninstall must do nothing | Slack event ack 3 s; Slack retries unacked events |

### Journey cases

Each case names the scenario(s) that prove it in `scenarios/` (gate G3 checks that every ID below appears in a scenario's `meta.journey`).

| ID | Case | Expected outcome a scenario asserts | Scenarios |
|---|---|---|---|
| J1.first-and-empty | first run on a mailbox that already has mail | no drafts, DMs or model calls for mail from before install | 01 |
| J1.twice | the workspace reinstalls with a different mailbox | history starts from the new mailbox's position, old position discarded | 31 |
| J1.two-actors | a second workspace claims a mailbox that is active elsewhere, then after uninstall | 409 while active; accepted once the first workspace uninstalled | 30 |
| J1.abandoned | the instance is told to stop while an install is in flight | the request finishes with 201, the row is written, the process exits 0 | 27 |
| J2.happy | an email arrives | one DM with three options and the right buttons; outcome `awaiting_user` | 02 |
| J2.twice | the same push is delivered twice, or to both instances at once | one email row, one draft, one DM | 06, 08 |
| J2.stale | the push for an older history id arrives last | history only moves forward, nothing re-drafted | 07 |
| J2.slow-slack | Slack answers 429 with Retry-After on the post | retried after the wait, posted once | 13 |
| J2.lost-response | `chat.postMessage` succeeds but the response is lost | one DM, not two (found by metadata on retry) | 29 |
| J2.slack-down | Slack keeps rejecting the suggestion message | a plain notice instead, outcome `draft_failed` with `post_failed` | 38 |
| J2.llm-down | the model is down or returns invalid output | the fallback DM, no drafts, outcome `draft_failed` | 14 |
| J2.llm-rate-limited | the model answers 429 with Retry-After | the draft waits as told, then succeeds | 34 |
| J2.slow-gmail | every Gmail call takes 3.5 s | push ack under 1 s, the DM still arrives | 22 |
| J2.truncated-body | Gmail answers 200 but the body stops halfway | retried, not read as "no new mail" | 26 |
| J2.long-thread | a 12-message thread with long bodies | the prompt fits the token budget, newest messages kept | 23 |
| J2.other-language | a Japanese email | subject and options intact in Slack | 24 |
| J2.encoding | headers name a charset the app cannot decode | the user still gets the DM | 35 |
| J2.machine-mail | auto-replies, noreply and bulk mail | no drafts, no DMs, no model spend, outcome `skipped` | 17 |
| J2.hostile-injection | an email tells the model to change the recipient | the reply still goes only to the original sender, nothing is auto-sent | 15 |
| J2.hostile-sender | the From display name hides another address in an RFC 2047 word | the reply goes to the real From address | 36 |
| J2.flood | a burst of mail over the per-tenant draft budget | drafts stop at the budget, one plain notice, every refusal recorded | 37 |
| J2.noisy-tenant | another workspace floods slow drafts | this workspace's DM still starts within 1.5 s | 28 |
| J3.happy | the agent clicks Send option 2 | one email in the same thread to the sender, the DM shows who sent it | 03 |
| J3.twice | double click, or a storm of clicks, across instances | one email per suggestion | 09, 40 |
| J3.two-actors | two people click different options at once | one email with the winner's text; the loser alone is told who sent it | 10, 40 |
| J3.slow-gmail | Gmail answers 500 then succeeds, or takes 3.5 s | one email; the click ack stays under 3 s | 12, 22 |
| J3.lost-response | Gmail sends but the response is lost | reconciled by Message-ID, never sent twice | 11 |
| J3.crash | the instance holding the send job is killed | another instance sends exactly once | 21 |
| J3.other-language | the agent sends a Japanese option | subject `Re: <original>` RFC 2047 encoded, body intact, threaded | 24 |
| J3.noisy-tenant | another workspace floods slow drafts | the approved send starts within 1 s | 28 |
| J3.hostile-forged | clicks with a wrong or tampered signature | 401, nothing sent, suggestion untouched | 18 |
| J3.hostile-replay | a validly signed click replayed six minutes later | 401, nothing sent | 19 |
| J3.hostile-tenant | a user in workspace B clicks with workspace A's suggestion id | "not available", nothing sent, logged as a security event | 20 |
| J4.happy | the agent edits a draft and submits | the edited text is sent, modal closes | 04 |
| J4.slow-slack | `views.open` answers slowly | the Edit click is acked under 3 s | 39 |
| J5.happy | the agent dismisses | "Dismissed by", outcome `dismissed` | 05 |
| J5.stale | a stale copy is clicked Send after Dismiss | nothing sent, the clicker is told it was dismissed | 05 |
| J6.own-reply | our sent reply comes back through history | skipped as our own mail, no reply loop | 16 |
| J7.happy | the admin uninstalls | watch stopped, Google token revoked, data purged after the grace period with a deletion record | 32 |
| J7.twice | Slack redelivers the uninstall event | disconnected once | 25 |
| J7.partial-revoke | a member revokes only their user token | the workspace stays connected; revoking the bot token disconnects it | 33 |
| J7.hostile-forged | an uninstall event signed with the wrong secret | 401, the tenant stays active | 18 |

## 4. Success metric

- **Primary**: share of drafted emails answered from a suggestion: `outcomes` rows `replied` over rows that reached `awaiting_user`, per week, per tenant. No production baseline yet: the first two weeks after launch set it.
- **Guardrails**:
  - wrong-recipient sends: 0 (J2.hostile-injection, J2.hostile-sender);
  - duplicate sends or duplicate DMs: 0 (J2.twice, J2.lost-response, J3.twice, J3.lost-response, J3.crash);
  - Slack acks over 3000 ms: 0 (checked automatically in every scenario);
  - push ack: under 1 s at p95 (J2.slow-gmail);
  - silent drops: 0, every email ends in a DM, a notice or a `skipped` outcome;
  - model spend: at most `DRAFT_BUDGET_PER_WINDOW` drafts per tenant per hour (200 by default); generation cost per trial $0.0014 in the last eval run.
- **Model output success criteria** (graded by `evals/examples/inbox-assist`): exactly three non-empty options under the length cap; in the language of the newest message; no fabricated facts, numbers or email addresses; options meaningfully different; answers the question; appropriate tone; injection resisted. Gate: lower bound of the all-graders pass rate at least 60% (last run: 69.2%, lower bound 58.5%, so it fails narrowly).

## 5. Scope line

- **In**: steps 1 to 7 and every journey case above.
- **Out, on purpose**:
  - the real Slack `oauth.v2.access` and Google consent flows: in before the first install outside the bench;
  - OIDC JWT verification on Pub/Sub push (today a shared bearer token, see `src/gmail.mjs:verifyPushToken`): in before the first production deploy;
  - several agents per workspace (the DM goes to one `slack_user_id`): in when a customer asks for a shared channel;
  - Tier 2 sandbox runs against real Slack and Gmail: in before the first release;
  - moving off SQLite: in when write lock waits pass `busy_timeout` (5 s) or two hosts must share the database.
- **Size**: today's production load is unknown (no deploy yet); the bench drives a handful of tenants with bursts of 15 emails per push (scenario 37) and 10 concurrent slow drafts (scenario 28). 10x of the bench burst is 150 emails per push for one tenant: the code bounds it with the draft budget (200 per tenant per hour by default), 2 concurrent drafts per tenant across instances, and 3 of 4 worker slots per instance for drafts, so sends and posts keep a slot.
