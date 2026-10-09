# live-verify

Run the real app process against high-fidelity stand-ins for every external system, drive real user journeys end to end, and keep the evidence. Nothing reaches a real Slack workspace or Gmail mailbox, and nobody has to read a Slack message to know the product works.

```
node harness/runner.mjs --app bench/inbox-assist --instances 2 --llm stub
node harness/runner.mjs --app bench/inbox-assist --llm claude --only 03-     # real model for drafting
node --no-warnings --test bench/inbox-assist/test/*.test.mjs harness/test/*.test.mjs
```

Zero npm dependencies. Node 22 or later (`node:sqlite`, `node:test`, `fetch`).

## Layout

- `harness/`: reusable, product-agnostic.
  - `standins/slack.mjs`: Slack Web API subset (`chat.postMessage` with message metadata, `chat.update`, `chat.postEphemeral`, `views.open`, `auth.test`, `conversations.open`, `conversations.history` with `include_all_metadata`, `conversations.replies`), bearer token per workspace, Slack-shaped responses. Also the Slack platform: signed Events API and interactivity requests (`block_actions`, `view_submission`), retries with `X-Slack-Retry-Num`, ack latency measured and flagged over 3000 ms, trigger ids that expire after 3 s.
  - `standins/gmail.mjs`: Gmail API subset (profile, history, messages get/list/send, threads get, drafts create, `users.stop`) and Google OAuth token revocation (`POST /revoke`), per-mailbox history ids, Gmail's threading rules on send, `rfc822msgid:` search with optional index lag. Also Pub/Sub push with a bearer token.
  - `standins/llm.mjs`: Anthropic Messages API (`POST /v1/messages`) with scripted rules and Anthropic-shaped errors.
  - `lib/faults.mjs`: per-method fault plans: `status` (429 with Retry-After, 500), `delay`, `slowResponse`, `hang`, `reset`, `timeoutAfterSuccess`, `truncate` (a 2xx whose body stops halfway), and for deliveries `duplicate` and `reorder`. Rules target the nth matching call and can filter by tenant.
  - `runner.mjs`: boots stand-ins and N app instances on free ports with a shared SQLite file, waits for each `/healthz`, runs `<app>/scenarios/*.mjs`, kills only its own child pids, exits non-zero on any failure.
- `bench/inbox-assist/`: the reference product (a Slack agent that drafts Gmail replies). `live-verify.json` tells the runner how to start it and which env vars point at the stand-ins.
- `ci/live-verify.yml`: example GitHub Actions workflow. Copy it to `.github/workflows/` to enable it.

## Writing a scenario

One file per journey step or attack in `<app>/scenarios/`, sorted by name. Files starting with `_` are helpers; `_setup.mjs` may export `beforeEach(ctx)`.

```js
export const meta = { name: 'send option replies in the same thread', journey: 'J3.two-actors UJ step 3: ...', concerns: ['AI-07', 'CONC-09'] };
export default async function (ctx) { /* drive, then assert on recorded calls, DB rows, responses */ }
```

`journey` (a string or an array) names the journey case ID(s) the scenario proves, in the shape file's form `J<n>.<case>`; gate G3 checks that every journey case ID in the shape file appears in at least one scenario's `journey`.

`ctx` gives: `slack`, `gmail`, `llm` (stand-ins: `.calls(filter)`, `.faults.inject(method, spec)`, platform helpers), `apps` (instances with `url`, `kill()`, `restart()`), `db` (read-only), `secrets`, `step(name)`, `ok(name, cond, evidence)`, `expect(name, actual, expected)`, `waitFor(predicate, timeoutMs, label)`, `logs(filter)`, `uid(prefix)`, `llmMode`.

Rules that keep runs deterministic: every scenario installs its own tenant; no fixed sleeps, only `waitFor`; "nothing else happened" assertions first wait for a quiescence barrier (no queued or running jobs for the tenant); a fault is scoped with `where` to the scenario's tenant.

Every scenario also gets an automatic check that every Slack ack it caused came back within 3000 ms.

## Evidence

Each run writes `.scratch/live/<run-id>/` relative to the working directory, and keeps it after teardown:

- `report.json`: every scenario with steps, assertions (pass, fail, evidence) and ack timings.
- `report.md`: one row per scenario: journey step, concern ids, result.
- `calls.json`: every call the stand-ins recorded and every delivery to the app.
- `app-<n>.log`: structured logs per instance (ids and counts, no message bodies).
- `db.sqlite`: the shared database at teardown.

The console prints scenario names, pass or fail and counts only.

## Proof standards

- Drive the real entry points with real wire formats: signed Slack requests, Pub/Sub push JSON, Gmail and Anthropic API shapes. No test-only endpoints in the app.
- Assert the observable outcome: what the stand-ins recorded (an email in the sent folder with these headers, a `chat.update` with this text), what the app answered, and the rows the user-facing answers come from.
- A fault that never fired proves nothing: scenarios assert on the faulted call's recorded outcome (`status:429`, `hang`, `timeoutAfterSuccess`).
- Scenarios were mutation-checked: breaking the safeguard they name (conditional state update, reconciliation, signature window, tenant scoping, loop prevention, forward-only history) makes them fail.

## Tier 2: sandbox Slack workspace (documented, not built)

Stand-ins prove the app against the protocol as documented. Tier 2 proves it against the real platform, still without anyone reading messages:

1. A dedicated Slack sandbox workspace (Developer Program sandbox or a free workspace) with the app installed from a staging manifest. Its bot token and a second user token for a test user live in CI secrets.
2. A dedicated Google Workspace test mailbox with a Pub/Sub topic and push subscription to the staging deploy (OIDC push auth, with the app verifying the JWT audience and service account).
3. The runner targets the staging URL instead of booting instances. Scenarios send mail to the test mailbox from a second test account, then read the result back by API: `conversations.history` on the test user's DM with the bot (user token), `users.messages.list`/`get` on the sender's mailbox for the reply and its headers.
4. Button clicks cannot be scripted through Slack's UI by API. Tier 2 therefore covers delivery, rendering and sending; clicks either stay in tier 1 or use a browser driver logged in as the test user.
5. Runs are nightly and before release, not on every PR: real APIs rate-limit and add flake. Every run cleans up what it posted and archives evidence the same way.
