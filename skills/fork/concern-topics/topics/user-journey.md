# User journey

**Protects:** The user can get from "I want this" to "it worked, and I can tell it worked" on every surface they actually use, including the first time, the slow time, the failed time and the time someone else changed things underneath them.
**Read when:** The plan names a user-facing feature, a new surface (web page, Slack app, email, API, CLI), an install or connect step, a button that changes state, a notification, an approval, or anything that crosses from one surface to another. In code: route handlers behind a UI, Slack `action`/`command`/`view_submission` handlers, OAuth callbacks, email templates, status enums shown to users, `disabled={pending}`, `confirm(`.
**Prefix:** UJ

## Design questions

1. What are the steps of the journey, who are the actors at each step (end user, admin, second user, the system, a third party), and what states can each step be in? Is that table written down, or only in someone's head? (UJ-01)
2. What does a brand-new tenant see on step one, before any data, integration or teammate exists? (UJ-02)
3. Which permission, consent or install steps sit before first value, who has the authority to complete each one, and what does the user see while they wait for an admin? (UJ-03)
4. For every step that takes longer than a second, what are the user-visible states (pending, partial, stale, failed, done), and which component owns the transition between them? (UJ-04)
5. Which platform deadline applies to each interaction (Slack ack in 3 seconds, `trigger_id` valid for 3 seconds, `response_url` valid for 30 minutes), and what is sent inside it? (UJ-05)
6. What happens when the same intent arrives twice: double click, Slack button pressed twice, a provider retry, an API client retry? Which key makes the second one a no-op? (UJ-06)
7. If two people, or one person in two tabs, act on the same object at once, which one wins and how is the loser told? (UJ-07)
8. When state changes on one surface, which copies on other surfaces (Slack messages, open web tabs, emails already sent) become wrong, and how are they corrected or guarded? (UJ-08)
9. If the user leaves mid-action (closes the tab, presses back, loses network), does the work continue, and how do they find out the result? (UJ-09)
10. When a link or button moves the user from one surface to another, how is identity, tenant and context carried, and what happens if the user is logged into a different account on the destination? (UJ-10)
11. Which actions cannot be undone, and what stops a single wrong click from executing one? (UJ-11)
12. For each notification, who needs it, what will they do with it, and how many will they get on a busy day? (UJ-12)
13. Can each step be completed with keyboard alone and announced by a screen reader, including status changes? (UJ-13)
14. What observable event means "this journey succeeded for this user", and where is it counted? (UJ-14)

## Categories

### UJ-01 No journey map, so no scenario list

**How it fails:** The plan describes the feature from the system's point of view ("on event X we call Y and post Z"). Nobody enumerates the user's path, the other actors who touch the same object, or the states each step can be in. Tests cover the happy path the author imagined. Live verification has nothing to walk through except that same path, so the first-run state, the admin-approval wait, the second user and the stale Slack message are all found by customers.
**Seen in the wild:** No verified incident specific to the missing map; the gap follows from how coverage is chosen. gstack's `plan-eng-review` makes the same point: a user flow with no test is as much a gap as an untested branch, and it asks reviewers to map the full journey and its interaction edge cases next to the code paths (see Sources 1).
**Spot it in a plan:** Only a sequence diagram of services. Words like "the user clicks approve" with one user and no states. No mention of admins, installers or a second participant. "Edge cases: TBD".
**Spot it in code:** Handlers with no test that drives them from the user-facing entry point; test names that read like functions (`test_process_event`) rather than journeys (`approver_rejects_after_requester_cancels`).
**Build it right:** Write the journey map before code as a table: rows are steps, columns are actors, cells list the states that actor can see at that step. Then expand each cell with the interaction modifiers from UJ-06 to UJ-09 (twice, concurrently, stale, abandoned, slow). Every resulting row is a named scenario for live verification and, where cheap, an end-to-end test. Keep the table in the plan or next to the feature's tests so it changes with the code.

Dangerous:
```markdown
## Flow
1. User runs /approve in Slack
2. Bot calls approvals API
3. Bot posts "Approved"
```

Safe:
```markdown
## Journey map: expense approval
| Step | Requester | Approver | Admin | System |
|---|---|---|---|---|
| 0 Install | sees "ask your admin" if app approval is on | n/a | gets approval request | app not installed: no events |
| 1 Submit (web) | pending, validation error, submitted | DM: "needs your review" | n/a | idempotency key per form submit |
| 2 Decide (Slack button) | sees "approved by X" or "rejected" | ack in < 3 s, then final message | n/a | conditional update on status = pending |
| 3 Conflict | sees one final state | second approver sees "already decided by X" | n/a | 409 mapped to Slack update |
Modifiers per row: twice, two actors at once, stale message, user leaves, slow network.
```

**Prove it:** Count rows in the map times modifiers; each one has a recorded live run or test with the observed user-visible state. A reviewer picks three rows at random and replays them on staging.
**Size for now:** One table per feature, covering the actors that exist today. Skip exhaustive combinations of modifiers that the platform makes impossible; write down why.

### UJ-02 First run and empty states

**How it fails:** The feature is built and demoed against a seeded account. A new tenant installs it and sees an empty list with no explanation, a dashboard of zeros that looks broken, or a 500 because code assumed at least one row, one channel or one connected integration. The user concludes the product does not work and never reaches the step that would have shown value.
**Seen in the wild:** No verified incident; failure follows from code that assumes non-empty collections. gstack's design review treats empty states as features and rejects "No items found." as a design (see Sources 1).
**Spot it in a plan:** Screens described only with data. No step for "connect your first X". Onboarding left to "docs".
**Spot it in code:** `rows[0]`, `items.first!`, `.reduce(` without an initial value, `max(` on a possibly empty list, `Math.max(...arr)` (returns `-Infinity` on empty), templates with no `{% empty %}` or `length === 0` branch.
**Build it right:** Treat "zero" as a designed state per screen and per Slack message: say what this is, why it is empty, and the single next action (with a button). Seed nothing in tests by default so empty is the path tests hit first. Distinguish "empty because new" from "empty because filtered" from "empty because the integration is disconnected".

Dangerous:
```ts
export function lastSyncLabel(syncs: Sync[]) {
  const latest = syncs.sort((a, b) => b.at - a.at)[0];
  return `Last synced ${formatDistance(latest.at, Date.now())} ago`; // throws on new tenant
}
```

Safe:
```ts
export function lastSyncLabel(syncs: Sync[], connected: boolean) {
  if (!connected) return { text: "Not connected yet", action: "connect" as const };
  if (syncs.length === 0) return { text: "First sync in progress", action: null };
  const latest = syncs.reduce((a, b) => (b.at > a.at ? b : a));
  return { text: `Last synced ${formatDistance(latest.at, Date.now())} ago`, action: null };
}
```

**Prove it:** Create a fresh tenant on staging with no seed data and walk every screen and command; screenshot each empty state. A test renders each list component with `[]`.
**Size for now:** Designed empty states for the first-run path and each primary list. Polished illustrations can wait.

### UJ-03 Install, consent and admin approval steps

**How it fails:** The plan assumes the user can install the Slack app or grant OAuth scopes themselves. In an enterprise, a Workspace or Org Owner has turned on app approval, so the user can only request the app and then waits with no feedback. Or the OAuth consent asks for broad scopes and a security reviewer declines. Later, a refresh token stops working (revoked, unused, a Google project left in "Testing" mode, a per-client token limit) and the feature silently stops, with no path for the user to reconnect.
**Seen in the wild:** Slack lets Workspace Owners require approval before members install apps, route requests to app managers and auto-restrict apps; when an Org Owner sets an app management policy, approval turns on for every workspace in the org (Sources 2). Google documents refresh tokens expiring after 7 days for external-user projects in Testing status, after six months unused, on revocation, and silently when a 101st token is issued for the same client and account (Sources 3).
**Spot it in a plan:** "User installs the app" with no admin actor. Scopes chosen as "everything we might need". No reconnect flow. "Tokens are stored" with no expiry handling.
**Spot it in code:** OAuth callback that assumes success; `invalid_grant` handled as a generic 500; no `token_revoked` / `app_uninstalled` Slack event handler; a single integration status boolean instead of states.
**Build it right:** Model integration status as an enum the user can see (`not_installed`, `requested`, `pending_admin`, `connected`, `needs_reauth`, `revoked`) owned by one module. Request the smallest scope set for the first value and add scopes incrementally. Handle uninstall and revoke events by moving to `revoked` and telling the user what to do. Provide copy the user can forward to their admin. Treat `invalid_grant` as `needs_reauth`, not as an outage.

Dangerous:
```python
def refresh(integration):
    resp = requests.post(TOKEN_URL, data={...}, timeout=10)
    resp.raise_for_status()           # invalid_grant becomes a 400 exception
    integration.access_token = resp.json()["access_token"]
```

Safe:
```python
def refresh(integration):
    resp = requests.post(TOKEN_URL, data={...}, timeout=10)
    if resp.status_code == 400 and resp.json().get("error") == "invalid_grant":
        integration.status = "needs_reauth"
        notify_owner(integration, template="reconnect", link=reconnect_url(integration))
        return None
    resp.raise_for_status()
    integration.access_token = resp.json()["access_token"]
    integration.status = "connected"
```

**Prove it:** On a Slack test workspace with app approval turned on, run the install as a non-admin and record what the user sees. Revoke the token at the provider and confirm the UI shows "reconnect" within one sync cycle and an owner is notified.
**Size for now:** The status enum, uninstall and revoke handling, and a reconnect link. A full admin console can wait for the first enterprise that asks.

### UJ-04 Every state the user can see

**How it fails:** A long step (an LLM call, an import, a sync) has two visible states: "spinner" and "done". When it partially succeeds, fails, or is still running after the user comes back tomorrow, the UI shows the spinner forever, or "done" with half the data, or a stale result from last week as if it were current.
**Seen in the wild:** No verified incident; failure follows from status fields that cannot represent partial or failed outcomes. The behavioral envelope's UIB-02 requires loading, empty and error states to be designed and reachable; this category extends it to partial and stale.
**Spot it in a plan:** "Show a loading indicator", with no failure or partial wording. Status described as a boolean (`done`).
**Spot it in code:** `isLoading && <Spinner/>` with no timeout branch; `status IN ('pending','done')` check constraints; job tables without `error`, `completed_at`, or counts of items processed vs total.
**Build it right:** Give each long-running unit a status column with a closed set of values (`queued`, `running`, `partial`, `failed`, `succeeded`, `cancelled`) enforced by a database `CHECK` or enum, plus `updated_at` so the UI can show age. Render every value. Show "as of" timestamps on data that can be stale. Map each failure to a message that says what to do next (CORE-03).

Dangerous:
```sql
CREATE TABLE imports (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL,
  done boolean NOT NULL DEFAULT false
);
```

Safe:
```sql
CREATE TABLE imports (
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','partial','failed','succeeded','cancelled')),
  items_total int,
  items_done int NOT NULL DEFAULT 0,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

**Prove it:** Force each status on staging (kill the worker mid-run, inject a failure on item 3 of 10) and screenshot what the user sees for each.
**Size for now:** The closed status set and age display. Live progress bars can wait unless jobs routinely run over a minute.

### UJ-05 Feedback inside the platform's deadline

**How it fails:** A Slack button handler does the real work (database writes, an LLM call) before acknowledging. It takes four seconds; Slack shows the user an error even though the work later succeeds, so the user clicks again. A modal is opened with a `trigger_id` after a slow lookup and fails because the trigger expired. A follow-up is sent to a `response_url` an hour later and is rejected.
**Seen in the wild:** Slack requires the acknowledgment for interaction payloads within 3 seconds, and if it is missing "the Slack user who interacted with the app will see an error message"; `trigger_id` expires in three seconds and can be used once; `response_url` accepts up to 5 responses within 30 minutes (Sources 4). Bolt's docs tell handlers to call `ack()` before sending messages or querying a database (Sources 5).
**Spot it in a plan:** "When the user clicks, we generate the summary and reply." No mention of ack or of a later update.
**Spot it in code:** In Bolt handlers, `await ack()` after `await` calls to anything else; `views.open` after a database query; `response_url` stored and used by a job that can run later than 30 minutes.
**Build it right:** Acknowledge first with an immediate visible change (replace the button with "Working on it..."), persist the intent, then do the work and update the message with `chat.update` (bot-posted messages only) or post a new message. Open modals immediately with a loading view and update the view when data arrives. For results that can take more than 30 minutes, post a normal message rather than relying on `response_url`. The latency topic owns the budget arithmetic (LAT-02).

Dangerous:
```ts
app.action("summarize", async ({ ack, body, client }) => {
  const summary = await llm.summarize(await loadThread(body)); // 5-20 s
  await ack();
  await client.chat.postMessage({ channel: body.channel!.id, text: summary });
});
```

Safe:
```ts
app.action("summarize", async ({ ack, body, respond }) => {
  await ack();
  await respond({ replace_original: true, text: "Summarizing this thread..." });
  await jobs.enqueue("summarize", {
    idempotencyKey: `${body.container.message_ts}:${body.actions[0].action_ts}`,
    channel: body.channel!.id,
    messageTs: body.container.message_ts,
  });
});
```

**Prove it:** Add an artificial 4 second delay to a dependency on staging and click the button: the user must see "Summarizing..." immediately and the result later, with no Slack error.
**Size for now:** Ack-first for every Slack interaction and a job queue. A generic "progress message" framework can wait.

### UJ-06 The same intent arrives twice

**How it fails:** The user double clicks "Send", presses a Slack button twice because the first click looked dead, or the platform retries a delivery it thinks failed. Two invoices, two Slack posts, two emails, two LLM runs. Client-side disabling helps the first case but not the others.
**Seen in the wild:** Slack marks retried Events API deliveries with `X-Slack-Retry-Num` and `X-Slack-Retry-Reason` headers (Sources 6), and GitHub notes that a requested redelivery carries the same `X-GitHub-Delivery` as the original (Sources 7). Both mean duplicates are normal traffic, not an anomaly.
**Spot it in a plan:** "Disable the button after click" as the only guard. No idempotency key named.
**Spot it in code:** `INSERT` without a unique constraint on the natural key; handlers that ignore retry headers and provider delivery ids; `onClick={submit}` without a pending guard.
**Build it right:** The server is the guard: derive an idempotency key per intent (form submission id generated when the form renders, Slack `action_ts` plus message ts, provider event id) and enforce it with a unique constraint; return the first result for the second request. Disable controls while pending as a courtesy (UIB-01).

Dangerous:
```sql
INSERT INTO outbound_messages (tenant_id, thread_id, body) VALUES ($1, $2, $3);
```

Safe:
```sql
INSERT INTO outbound_messages (tenant_id, thread_id, intent_key, body)
VALUES ($1, $2, $3, $4)
ON CONFLICT (tenant_id, intent_key) DO NOTHING
RETURNING id;
-- no row returned means a duplicate: look up and return the existing result
```

**Prove it:** Fire the same Slack action payload twice within 50 ms and replay a provider webhook with the same delivery id; exactly one row and one user-visible effect.
**Size for now:** Unique constraint plus key per intent on every state-changing endpoint. A shared idempotency middleware can wait until there are more than a handful of endpoints.

### UJ-07 Two actors on the same object

**How it fails:** Two approvers press "Approve" and "Reject" on the same request within a second. Or one user has two tabs open and edits the same record in both. The last write silently wins, both users get a success message, and the audit trail shows a decision nobody saw.
**Seen in the wild:** No verified incident; failure follows from read-modify-write without a version check, see the PostgreSQL `UPDATE ... WHERE` semantics and the behavioral envelope's UIB-05.
**Spot it in a plan:** Shared objects (requests, tickets, documents, channels) with more than one actor who can change them, and no word about conflicts.
**Spot it in code:** `SELECT` then `UPDATE` by id only; ORM `.save()` on an object loaded earlier; no `version`, `updated_at` or status predicate in the `WHERE` clause.
**Build it right:** Make the transition conditional on the state the user saw: `UPDATE ... WHERE id = $1 AND status = 'pending'` or `AND version = $2`. Zero rows updated means someone else got there first: tell this user who and what ("Already rejected by Priya at 10:42"), and refresh their view. Put the transition in one owning module so no path bypasses the check.

Dangerous:
```python
req = db.get(ApprovalRequest, req_id)
req.status = "approved"
req.decided_by = user.id
db.commit()
```

Safe:
```python
updated = db.execute(
    update(ApprovalRequest)
    .where(ApprovalRequest.id == req_id, ApprovalRequest.status == "pending")
    .values(status="approved", decided_by=user.id, decided_at=func.now())
).rowcount
db.commit()
if updated == 0:
    current = db.get(ApprovalRequest, req_id)
    return Conflict(f"Already {current.status} by {current.decided_by_name}")
```

**Prove it:** Two sessions on staging press opposite buttons at the same time (script both requests with a barrier); exactly one decision is stored and the other user sees the conflict message.
**Size for now:** Conditional updates on every shared state transition. Real-time collaborative editing is out of scope unless the product is an editor.

### UJ-08 Stale copies on other surfaces

**How it fails:** A request is approved on the web. The Slack message that announced it still shows active "Approve / Reject" buttons. A second approver clicks "Reject" in Slack an hour later; the handler trusts the payload and reverses the decision. Or an email sent yesterday links to an action that no longer applies.
**Seen in the wild:** No verified incident; failure follows from Slack messages being snapshots that the app must update itself. `chat.update` needs the channel and message `ts`, and bots can only update messages they posted (Sources 8), so an app that does not store those cannot correct its own stale messages.
**Spot it in a plan:** Notifications with action buttons, plus a second surface where the same action is possible. No mention of updating or expiring the first.
**Spot it in code:** Slack posts whose returned `ts` is not stored; action handlers that read the target state from `body.actions[0].value` instead of the database; email links with no expiry or state check.
**Build it right:** The server re-checks current state on every action, whatever surface it came from (UJ-07's conditional update). Store `(channel, ts)` for every message with buttons and, when the object changes state anywhere, update those messages to show the final state without buttons. Email action links carry a signed token with an expiry and land on a page that shows current state before acting.

Dangerous:
```ts
app.action("reject", async ({ ack, body }) => {
  await ack();
  const { requestId } = JSON.parse(body.actions[0].value);
  await db.query("UPDATE requests SET status='rejected' WHERE id=$1", [requestId]);
});
```

Safe:
```ts
app.action("reject", async ({ ack, body, respond }) => {
  await ack();
  const { requestId } = JSON.parse(body.actions[0].value);
  const res = await db.query(
    "UPDATE requests SET status='rejected', decided_by=$2 WHERE id=$1 AND status='pending' RETURNING id",
    [requestId, body.user.id],
  );
  if (res.rowCount === 0) {
    const cur = await requests.get(requestId);
    await respond({ replace_original: true, text: `Already ${cur.status} by ${cur.decidedByName}.` });
    return;
  }
  await surfaces.refreshAll(requestId); // chat.update every stored (channel, ts), close web tabs via push
});
```

**Prove it:** Approve on the web, then click "Reject" on the old Slack message: the decision is unchanged and the Slack message now shows the final state.
**Size for now:** Server-side state check everywhere plus updating stored Slack messages. Pushing live updates to open web tabs can wait; revalidate on focus instead (UIB-06).

### UJ-09 The user leaves, the network is slow, the back button

**How it fails:** A user starts an export, the page takes 10 seconds, they press back or close the laptop. If the work ran inside the request, it is cancelled midway with no record. If it ran in the background, the user has no way to find the result. On a slow connection the user sees nothing for 8 seconds and resubmits. Pressing back after a POST shows a "Confirm form resubmission" prompt that leads to a duplicate.
**Seen in the wild:** No verified incident; gstack's engineering review lists navigate-away mid-operation, the back button, a page left open for 30 minutes and a 10 second API call as interaction cases every flow must answer (Sources 1).
**Spot it in a plan:** Long operations inside a request handler. No "where does the user see the result later" answer.
**Spot it in code:** Request handlers that loop over many items; no job id returned to the client; POST handlers that render a page directly instead of redirecting (no POST/redirect/GET); fetches with no `AbortController` or timeout on the client.
**Build it right:** Anything over a couple of seconds becomes a job with an id, returned immediately; the user can leave and come back to a status page or receive a notification when it finishes. Use POST/redirect/GET for form submissions. Show feedback within 100 to 300 ms of a click (pending state), and a "still working" message if the operation exceeds its expected time. Pair with UJ-06 so a resubmit is harmless.

Dangerous:
```python
@app.post("/exports")
def create_export(req: ExportRequest, user=Depends(current_user)):
    rows = load_all_rows(user.tenant_id)      # can take minutes
    url = upload_csv(rows)
    return {"url": url}
```

Safe:
```python
@app.post("/exports", status_code=202)
def create_export(req: ExportRequest, user=Depends(current_user)):
    job = jobs.create_or_get(tenant_id=user.tenant_id, kind="export",
                             idempotency_key=req.client_request_id)
    queue.enqueue("export", job_id=job.id)
    return {"job_id": job.id, "status_url": f"/exports/{job.id}"}
```

**Prove it:** Start the operation on staging with network throttled to a slow profile, close the tab after one second, reopen: the result or its status is findable, and a notification arrives if promised.
**Size for now:** Jobs plus a status page for anything slow. Resumable uploads only if users upload large files.

### UJ-10 Handoff between surfaces

**How it fails:** A Slack message has an "Open in app" button. The browser opens logged into a different tenant, or logged out with the deep link lost after SSO login, or the Slack user is not linked to any web account. The user lands on the dashboard home instead of the object, or worse, sees a different tenant's object with the same id.
**Seen in the wild:** No verified incident; failure follows from Slack identities (team id plus user id) and web identities being separate namespaces that the app must link.
**Spot it in a plan:** "Button links to the web app" with no word on account linking, SSO redirects or tenant selection.
**Spot it in code:** Deep links containing only an object id; login redirect that drops the `next` parameter; lookups by Slack `user.id` without `team.id`; handlers that resolve the tenant from the web session instead of from the object.
**Build it right:** Link identities explicitly (store `slack_team_id`, `slack_user_id` to `user_id`, per tenant). Deep links carry the tenant and object, survive the login redirect (validated `next` path on your own origin only), and on arrival the server checks the current session can see that object; if the session is for another tenant, offer a switch rather than a 404. Unlinked Slack users get a one-time link flow, not an error.

Dangerous:
```ts
const url = `${APP_URL}/requests/${requestId}`;
// login page: res.redirect(req.query.next as string)  (open redirect, and `next` lost after SSO)
```

Safe:
```ts
const url = `${APP_URL}/t/${tenantSlug}/requests/${requestId}`;
// login: persist `next` in the SSO state parameter; on return:
const next = safeInternalPath(state.next) ?? "/";         // only same-origin paths
const obj = await requests.findVisible(session.userId, tenantSlug, requestId);
if (!obj) return renderSwitchTenantOrNotFound(session, tenantSlug);
```

**Prove it:** From a Slack message, click through while logged out, while logged into another tenant, and as an unlinked Slack user; each lands on the right object or a clear next step.
**Size for now:** Identity linking and deep links that survive login. Cross-device handoff can wait.

### UJ-11 Irreversible actions without a real guard

**How it fails:** A destructive or external action (send to all customers, delete a workspace, pay out money, post publicly) is one click away, next to the safe option, with an "Are you sure?" dialog that users click through by habit. Once done, there is no undo and no prepared correction.
**Seen in the wild:** In January 2018 a Hawaii emergency officer selected the live missile alert template and clicked "yes" on "Are you sure that you want to send this Alert?"; the correction took 38 minutes and the FCC found no procedure prevented one person from sending it or for recalling a false alert (Sources 9). In August 2020 Citibank sent about $900 million to Revlon's lenders instead of an internal account, despite a three-person "six eyes" review in its loan software (Sources 10).
**Spot it in a plan:** Bulk actions, deletes, sends to external parties, money movement. "We will show a confirmation" as the only guard.
**Spot it in code:** `window.confirm(`; delete endpoints that hard-delete; bulk endpoints without a count check; no `deleted_at`; external sends with no delay or outbox.
**Build it right:** First prefer making it reversible: soft delete with a restore window, a short send delay with "Undo" (hold in an outbox for N seconds), drafts. When it truly cannot be reversed, the confirmation must state the concrete consequence ("Email 4,212 customers") and require a deliberate input (type the count or name), and for high-impact actions a second person. Prepare the correction path (template, runbook) before launch.

Dangerous:
```ts
<button onClick={() => confirm("Are you sure?") && api.post(`/campaigns/${id}/send`)}>Send</button>
```

Safe:
```ts
// server: send schedules into an outbox with a 30 s hold; UI shows "Sending to 4,212 in 30 s. Undo"
await db.query(
  `INSERT INTO outbox (campaign_id, release_at, recipient_count, requested_by)
   VALUES ($1, now() + interval '30 seconds', $2, $3)`,
  [id, recipients.length, user.id],
);
// undo: DELETE FROM outbox WHERE campaign_id = $1 AND release_at > now() AND sent_at IS NULL
```

**Prove it:** Trigger the action and press Undo within the window: nothing is sent. Attempt the confirmation without typing the required value: the server rejects it (not only the UI).
**Size for now:** Undo windows and soft delete for the few truly destructive actions. Two-person approval only where money or mass external sends are involved.

### UJ-12 Notifications that are noise

**How it fails:** Every state change posts to Slack or sends an email. A busy tenant gets 300 messages a day, users mute the channel, and the one notification that mattered is missed. Or a burst of events hits a channel faster than the platform allows and messages are throttled or dropped.
**Seen in the wild:** No verified incident; Slack documents that `chat.postMessage` generally allows about 1 message per second to a given channel, with bursts (Sources 11), so per-event posting is both noisy and rate limited.
**Spot it in a plan:** "Notify the channel on every X." No owner per notification. No digest or quiet hours.
**Spot it in code:** `postMessage` inside a loop over events; notifications with no dedupe key; no per-user preference table.
**Build it right:** For each notification, write who it is for and what action it enables; drop the ones with no action. Notify the person who must act, not the whole channel. Coalesce bursts (one message updated in place, or a digest), dedupe by object and state, and respect per-user preferences. Thread follow-ups under the original message.

Dangerous:
```python
for event in events:
    slack.chat_postMessage(channel=team_channel, text=f"{event.kind}: {event.title}")
```

Safe:
```python
by_object = group_by(events, key=lambda e: e.object_id)
for object_id, evs in by_object.items():
    latest = max(evs, key=lambda e: e.at)
    owner = assignee_for(object_id)
    if not wants(owner, latest.kind):
        continue
    upsert_notification(owner, object_id, latest)   # updates the existing message via chat.update
```

**Prove it:** Replay a busy day of events for one tenant in staging and count messages per user; compare against a written target (for example, no more than N per user per day).
**Size for now:** Targeted notifications, coalescing and a mute option. A full preference center can wait.

### UJ-13 Accessibility basics

**How it fails:** A status change ("Saved", "3 errors") appears visually but is not announced to a screen reader. A custom dropdown cannot be operated by keyboard. Focus disappears behind a sticky header. Error messages are shown only in red. Enterprise customers with accessibility requirements cannot adopt the product.
**Seen in the wild:** No verified incident cited; the requirements are WCAG 2.2, including 2.1.1 Keyboard, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured (Minimum), 1.4.3 Contrast (Minimum), 3.3.1 Error Identification, 4.1.2 Name, Role, Value and 4.1.3 Status Messages (Sources 12).
**Spot it in a plan:** Custom widgets, toasts, inline validation, drag and drop with no keyboard path.
**Spot it in code:** `<div onClick=` without `role` and key handling; inputs without `<label>`; toasts without `role="status"` or `aria-live`; color-only error styling; Slack Block Kit images without `alt_text`.
**Build it right:** Native elements first. Every input labelled. Async status changes in a live region. Errors identified in text and linked to the field. Keyboard-only walkthrough of each journey row from UJ-01. Automated checker in CI as a floor, not a ceiling.

Dangerous:
```tsx
<div className="btn" onClick={save}>Save</div>
{saved && <div className="toast green">Saved</div>}
```

Safe:
```tsx
<button type="button" onClick={save} disabled={pending}>Save</button>
<div role="status" aria-live="polite">{saved ? "Saved" : ""}</div>
```

**Prove it:** Keyboard-only and screen-reader runs of the main journeys, plus an automated checker (for example axe) with zero serious violations.
**Size for now:** WCAG 2.2 A and AA basics on the main journeys. A formal audit when a customer contract requires it.

### UJ-14 Success is undefined and unmeasured

**How it fails:** The feature ships, the dashboards show requests and errors, but nobody can say what fraction of users who started the journey got the outcome they came for. A silent failure (the Slack reply never posted, the import finished with zero rows) looks like success to every system metric.
**Seen in the wild:** No verified incident; the SRE book advises choosing indicators by "what your users care about, not what you can measure" (Sources 13).
**Spot it in a plan:** Success described as "it works" or as a system metric (requests served). No funnel.
**Spot it in code:** No event emitted at the journey's end; only HTTP status metrics.
**Build it right:** Define the success event for each journey in user terms ("summary posted in the thread the user asked in"), emit it with tenant and correlation id, and count start, success and each named failure. This becomes the journey SLI the operability topic alerts on (OPS-03). Review it a week after launch.

Dangerous:
```ts
metrics.increment("summarize.requests");
```

Safe:
```ts
analytics.track("journey.summarize.started", { tenantId, correlationId });
// ... in the worker, after chat.postMessage returns ok:
analytics.track("journey.summarize.succeeded", { tenantId, correlationId, latencyMs });
// on each handled failure:
analytics.track("journey.summarize.failed", { tenantId, correlationId, reason: "llm_timeout" });
```

**Prove it:** On staging, run each journey once successfully and once with an injected failure, and show both in the success-rate query.
**Size for now:** Start, success and failure events per journey with a reason. Product analytics tooling can wait.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "We disable the button, so double submit cannot happen" | Retries, second tabs and platform redeliveries bypass the client | Enforce an idempotency key on the server (UJ-06) |
| "Admins will install it for them" | The person who wants it is not the one who can approve it, and they wait with no feedback | Model `pending_admin` as a visible state with a forwardable request (UJ-03) |
| "Empty state is an edge case" | Every new customer sees it first | Design zero as a primary state (UJ-02) |
| "The Slack message is just a notification" | Its buttons are a live control surface that goes stale | Re-check state on every action and update old messages (UJ-08) |
| "We have a confirm dialog" | People click through dialogs by habit | Make it reversible, or require a deliberate input stating the consequence (UJ-11) |
| "Users will check the dashboard" | Users do not come back to look | Notify the person who must act, once, with the action (UJ-12) |
| "It is fast on my machine" | Customer networks and cold paths are slower | Show pending feedback immediately and test throttled (UJ-09) |
| "Accessibility later" | Retrofitting custom widgets is a rewrite, and enterprise buyers ask early | Native elements and labels now (UJ-13) |

## Attack recipes

1. **Double fire.** Send the same Slack `block_actions` payload twice within 50 ms (or double click with devtools throttling). More than one row in the effect table or more than one message means UJ-06 failed.
2. **Two approvers.** Script two users pressing Approve and Reject on the same object with a barrier so both requests land within 10 ms. Two success responses, or a final state neither user was told about, means UJ-07 failed.
3. **Stale button.** Change an object's state on the web, then press the old button in Slack. Any state change, or a Slack message still showing buttons afterwards, means UJ-08 failed.
4. **Slow dependency.** Add 4 s latency to the LLM or database on staging and press a Slack button. A Slack error shown to the user means UJ-05 failed.
5. **Fresh tenant.** Create a tenant with no data and no integrations and walk every screen and command. Any exception, blank screen or zero without explanation means UJ-02 failed.
6. **Admin wall.** Install as a non-admin on a workspace with app approval on. No visible "waiting for admin" state means UJ-03 failed. Then revoke the token at the provider: no "reconnect" prompt within one sync cycle means UJ-03 failed.
7. **Walk away.** Start a long action, close the tab after one second, reopen later. No way to find the result means UJ-09 failed.
8. **Wrong account handoff.** Click a Slack deep link while logged into a different tenant and while logged out with SSO. Landing anywhere but the object or a clear switch prompt means UJ-10 failed.
9. **Keyboard only.** Complete the main journey without a mouse with a screen reader on. A step that cannot be completed, or a status change not announced, means UJ-13 failed.

## Sources

1. gstack (MIT), `plan-eng-review/sections/review-sections.md` (Step 2: map user flows, interactions and error states), `plan-ceo-review/SKILL.md.tmpl` (Prime Directive 4) and `plan-design-review/SKILL.md.tmpl` (empty states are features). https://github.com/garrytan/gstack
2. Slack Help Center, "Manage app approval for your workspace." https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace
3. Google Identity, "Using OAuth 2.0 to Access Google APIs" (refresh token expiration). https://developers.google.com/identity/protocols/oauth2
4. Slack Developer Docs, "Handling user interaction." https://docs.slack.dev/interactivity/handling-user-interaction
5. Slack Bolt for JavaScript, "Acknowledging requests." https://docs.slack.dev/tools/bolt-js/concepts/acknowledge
6. Slack Node SDK (legacy) Events API adapter, retry headers and 3 second response. https://docs.slack.dev/tools/node-slack-sdk/legacy/events-api/
7. GitHub Docs, "Best practices for using webhooks." https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks
8. Slack API reference, `chat.update`. https://docs.slack.dev/reference/methods/chat.update
9. NPR via APR, "False Hawaii Alert Sent Because Drill Said 'This Is Not A Drill'" (FCC findings), 30 January 2018. https://www.apr.org/2018-01-30/false-hawaii-alert-sent-because-drill-said-this-is-not-a-drill
10. Banking Dive, Citibank Revlon trial coverage. https://www.bankingdive.com/news/citibank-revlon-trial/591947/
11. Slack API reference, `chat.postMessage` (rate limiting). https://docs.slack.dev/reference/methods/chat.postMessage
12. W3C, "How to Meet WCAG (Quick Reference)", WCAG 2.2. https://www.w3.org/WAI/WCAG22/quickref/
13. Google SRE Book, "Service Level Objectives." https://sre.google/sre-book/service-level-objectives/
