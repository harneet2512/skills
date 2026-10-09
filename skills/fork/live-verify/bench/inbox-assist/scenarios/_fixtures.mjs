// Shared journey steps for Inbox Assist scenarios. Each scenario installs its own
// tenant (fresh team id and mailbox), so scenarios never see each other's traffic.

export async function installTenant(ctx, { aboutUs = 'Acme sells industrial kettles. Support hours 9 to 5 CET.', oldEmails = 0, seed } = {}) {
  const teamId = ctx.uid('T');
  const userId = ctx.uid('U');
  const botToken = `xoxb-${ctx.uid()}`;
  const gmailToken = `ya29.${ctx.uid()}`;
  const mailbox = `support-${teamId.toLowerCase()}@acme.test`;
  ctx.slack.addWorkspace({ teamId, botToken });
  ctx.gmail.addMailbox({ address: mailbox, token: gmailToken });
  for (let i = 0; i < oldEmails; i++) ctx.gmail.deliverEmail(mailbox, { from: `Old Sender ${i} <old${i}@customer.test>`, subject: `Old thread ${i}`, body: 'Old mail from before install.' });
  seed?.(mailbox);
  const res = await admin(ctx, 'POST', '/admin/installations', { teamId, slackUserId: userId, botToken, mailbox, gmailToken, aboutUs });
  ctx.ok('installation accepted', res.status === 201, { status: res.status });
  return { teamId, userId, botToken, gmailToken, mailbox, dm: `D${userId.slice(1)}` };
}

// Slack tells the app the workspace removed it (Events API, signed).
export const slackEvent = (ctx, t, event, { app = ctx.app, ...opts } = {}) =>
  ctx.slack.platform.event(`${app.url}/slack/events`, { teamId: t.teamId, event, ...opts });

export async function admin(ctx, method, path, body, app = ctx.app) {
  const res = await fetch(`${app.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${ctx.secrets.adminToken}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

export const SENDER = 'Dana Customer <dana@customer.test>';

// New mail lands in the mailbox and Pub/Sub pushes it to one instance (or several).
export async function receiveEmail(ctx, t, email = {}, { apps = [ctx.app] } = {}) {
  const d = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'Kettle arrived broken', body: 'Hi, my order #4411 arrived with a cracked lid. What can you do?', ...email });
  const ack = await ctx.gmail.pushToApp(apps.map((a) => `${a.url}/gmail/push`), d.push);
  return { ...d, ack };
}

export const suggestionFor = (ctx, t, gmailId) =>
  ctx.db.get('SELECT * FROM suggestions WHERE team_id = ? AND gmail_message_id = ?', t.teamId, gmailId);

export async function waitPosted(ctx, t, gmailId) {
  const s = await ctx.waitFor(() => { const r = suggestionFor(ctx, t, gmailId); return r?.status === 'posted' && r; }, 10000, 'suggestion posted');
  const message = ctx.slack.messages(t.teamId, s.slack_channel).find((m) => m.ts === s.slack_ts);
  return { s, message };
}

// Quiescence barrier for "nothing else happens" assertions: no job for this
// tenant is queued or running (retries waiting on backoff count as queued).
export function settled(ctx, t, timeoutMs = 10000) {
  return ctx.waitFor(() => ctx.db.get("SELECT count(*) AS n FROM jobs WHERE team_id = ? AND status IN ('queued', 'running')", t.teamId).n === 0, timeoutMs, 'jobs settled');
}

export function click(ctx, t, s, actionId, value, { userId = t.userId, app = ctx.app, ...opts } = {}) {
  return ctx.slack.platform.blockAction(`${app.url}/slack/interactions`, { teamId: t.teamId, userId, actionId, value, channel: s.slack_channel, messageTs: s.slack_ts, ...opts });
}

export const sendOption = (ctx, t, s, n, opts) => click(ctx, t, s, `send_option_${n}`, `${s.id}:${n - 1}`, opts);

export const okPosts = (ctx, t) => ctx.slack.calls({ method: 'chat.postMessage', team: t.teamId, outcome: 'ok' });
export const sendCalls = (ctx, t) => ctx.gmail.calls({ method: 'users.messages.send', mailbox: t.mailbox });
export const llmCallsFor = (ctx, marker) => ctx.llm.calls((c) => c.method === 'messages' && c.request?.prompt.includes(marker));
export const outcomes = async (ctx, t, sender) => (await admin(ctx, 'GET', `/admin/outcomes?team=${t.teamId}${sender ? `&sender=${encodeURIComponent(sender)}` : ''}`)).json.outcomes;
export const blockText = (message) => JSON.stringify(message?.blocks ?? []);
