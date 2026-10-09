// Slack stand-in: the Web API subset an app calls, plus the Slack platform side
// that sends signed Events API and interactivity requests to the app.
// Shapes follow https://api.slack.com/web and https://api.slack.com/authentication/verifying-requests-from-slack
import crypto from 'node:crypto';
import { startServer, readBody, applyFault, send } from '../lib/http.mjs';
import { Faults, Delivery } from '../lib/faults.mjs';
import { Recorder } from '../lib/recorder.mjs';

export const SLACK_ACK_DEADLINE_MS = 3000;
const TRIGGER_TTL_MS = 3000;

export async function startSlack({ signingSecret }) {
  const recorder = new Recorder('slack');
  const faults = new Faults();
  const delivery = new Delivery(faults);
  const workspaces = new Map(); // bot token -> { teamId, botUserId, domain }
  const channels = new Map(); // `${team}:${channel}` -> messages[]
  const ephemerals = [];
  const views = new Map();
  const triggers = new Map(); // trigger_id -> { issuedAt, teamId }
  const acks = [];
  let tsSeq = 0;

  const nextTs = () => `${Math.floor(Date.now() / 1000)}.${String(++tsSeq).padStart(6, '0')}`;
  const channelKey = (team, ch) => `${team}:${ch}`;
  // Posting to a user id opens (or reuses) the bot's DM with that user.
  const resolveChannel = (ch) => (ch?.startsWith('U') || ch?.startsWith('W') ? `D${ch.slice(1)}` : ch);

  const methods = {
    'auth.test': (ws) => ({ ok: true, url: `https://${ws.domain}.slack.test/`, team: ws.domain, user: 'inbox-assist', team_id: ws.teamId, user_id: ws.botUserId, bot_id: `B${ws.botUserId.slice(1)}` }),
    'chat.postMessage': (ws, a) => {
      if (!a.channel) return { ok: false, error: 'channel_not_found' };
      if (!a.text && !a.blocks) return { ok: false, error: 'no_text' };
      const channel = resolveChannel(a.channel);
      const message = { type: 'message', ts: nextTs(), user: ws.botUserId, bot_id: `B${ws.botUserId.slice(1)}`, text: a.text ?? '', blocks: a.blocks, thread_ts: a.thread_ts, metadata: a.metadata };
      const key = channelKey(ws.teamId, channel);
      if (!channels.has(key)) channels.set(key, []);
      channels.get(key).push(message);
      return { ok: true, channel, ts: message.ts, message };
    },
    'chat.update': (ws, a) => {
      const msg = (channels.get(channelKey(ws.teamId, a.channel)) ?? []).find((m) => m.ts === a.ts);
      if (!msg) return { ok: false, error: 'message_not_found' };
      if (a.text != null) msg.text = a.text;
      if (a.blocks != null) msg.blocks = a.blocks;
      msg.edited = { user: ws.botUserId, ts: nextTs() };
      return { ok: true, channel: a.channel, ts: a.ts, text: msg.text, message: msg };
    },
    'chat.postEphemeral': (ws, a) => {
      if (!a.channel) return { ok: false, error: 'channel_not_found' };
      if (!a.user) return { ok: false, error: 'user_not_in_channel' };
      const e = { teamId: ws.teamId, channel: a.channel, user: a.user, text: a.text ?? '', blocks: a.blocks, message_ts: nextTs() };
      ephemerals.push(e);
      return { ok: true, message_ts: e.message_ts };
    },
    'views.open': (ws, a) => {
      const trig = triggers.get(a.trigger_id);
      if (!trig || trig.teamId !== ws.teamId) return { ok: false, error: 'invalid_trigger_id' };
      if (Date.now() - trig.issuedAt > TRIGGER_TTL_MS) return { ok: false, error: 'expired_trigger_id' };
      const view = typeof a.view === 'string' ? JSON.parse(a.view) : a.view;
      if (!view?.type) return { ok: false, error: 'invalid_arguments' };
      const opened = { ...view, id: `V${crypto.randomBytes(5).toString('hex').toUpperCase()}`, team_id: ws.teamId, hash: crypto.randomBytes(4).toString('hex') };
      views.set(opened.id, opened);
      return { ok: true, view: opened };
    },
    // Opens (or returns) the bot's DM with a user: { users: 'U123' } -> channel D123.
    'conversations.open': (ws, a) => {
      const user = String(a.users ?? '').split(',')[0];
      if (!user) return { ok: false, error: 'users_list_not_supplied' };
      const id = resolveChannel(user);
      if (!channels.has(channelKey(ws.teamId, id))) channels.set(channelKey(ws.teamId, id), []);
      return { ok: true, channel: { id } };
    },
    // Newest first; message metadata only with include_all_metadata (as Slack does).
    'conversations.history': (ws, a) => {
      const msgs = channels.get(channelKey(ws.teamId, a.channel));
      if (!msgs) return { ok: false, error: 'channel_not_found' };
      const oldest = Number(a.oldest ?? 0);
      const limit = Math.min(Number(a.limit ?? 100), 999);
      const withMeta = a.include_all_metadata === true || a.include_all_metadata === 'true';
      const found = msgs.filter((m) => Number(m.ts) > oldest && !m.thread_ts).reverse().slice(0, limit)
        .map(({ metadata, ...m }) => (withMeta && metadata ? { ...m, metadata } : m));
      return { ok: true, messages: found, has_more: false };
    },
    'conversations.replies': (ws, a) => {
      const msgs = channels.get(channelKey(ws.teamId, a.channel));
      if (!msgs) return { ok: false, error: 'channel_not_found' };
      const thread = msgs.filter((m) => m.ts === a.ts || m.thread_ts === a.ts);
      if (thread.length === 0) return { ok: false, error: 'thread_not_found' };
      return { ok: true, messages: thread, has_more: false };
    },
  };

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const method = url.pathname.replace(/^\/api\//, '');
    const raw = (await readBody(req)).toString('utf8');
    const ctype = req.headers['content-type'] ?? '';
    let args = {};
    if (ctype.includes('application/json')) args = raw ? JSON.parse(raw) : {};
    else args = Object.fromEntries(new URLSearchParams(raw));
    for (const [k, v] of url.searchParams) args[k] ??= v;
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || args.token;
    const ws = workspaces.get(token);
    const call = { method, team: ws?.teamId ?? null, args, client: req.headers['user-agent'] ?? '', startedAt: Date.now() };
    if (!methods[method]) {
      recorder.record({ ...call, outcome: 'unknown_method', response: { ok: false, error: 'unknown_method' } });
      return send(res, 404, { ok: false, error: 'unknown_method' });
    }
    if (!token) { recorder.record({ ...call, outcome: 'not_authed' }); return send(res, 200, { ok: false, error: 'not_authed' }); }
    if (!ws) { recorder.record({ ...call, outcome: 'invalid_auth' }); return send(res, 200, { ok: false, error: 'invalid_auth' }); }
    const fault = faults.take(method, call);
    const r = await applyFault({
      fault, req, res,
      perform: async () => ({ status: 200, body: methods[method](ws, args) }),
      errorBody: (status) => ({ ok: false, error: status === 429 ? 'ratelimited' : 'internal_error' }),
    });
    recorder.record({ ...call, outcome: r.outcome, status: r.status, response: r.result, durationMs: Date.now() - call.startedAt });
  });

  // ---- Platform side: requests Slack sends to the app ----

  function sign(body, timestamp, secret = signingSecret) {
    return 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
  }

  async function signedPost(target, body, contentType, kind, teamId, opts = {}) {
    const timestamp = opts.timestamp ?? Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': contentType,
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': opts.signature ?? sign(body, timestamp, opts.secret),
      'user-agent': 'Slackbot 1.0 (+https://api.slack.com/robots)',
    };
    if (opts.retryNum) { headers['x-slack-retry-num'] = String(opts.retryNum); headers['x-slack-retry-reason'] = opts.retryReason ?? 'http_timeout'; }
    const started = performance.now();
    const res = await fetch(target, { method: 'POST', headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15000) });
    const text = await res.text();
    const ms = Math.round(performance.now() - started);
    const ack = { kind, teamId, target, status: res.status, ms, late: ms > SLACK_ACK_DEADLINE_MS, retryNum: opts.retryNum ?? 0, at: Date.now() };
    acks.push(ack);
    recorder.record({ method: `deliver:${kind}`, team: teamId, outcome: `http:${res.status}`, status: res.status, durationMs: ms, late: ack.late });
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* plain text ack */ }
    return { status: res.status, ms, text, json, late: ack.late };
  }

  // Slack redelivers when the app fails or misses the 3 s deadline: up to 3 retries.
  async function withSlackRetries(fn, opts) {
    let r = await fn({ ...opts });
    for (let n = 1; opts.autoRetry && n <= 3 && (r.status >= 500 || r.late); n++) {
      r = await fn({ ...opts, retryNum: n, retryReason: r.late ? 'http_timeout' : 'http_error' });
    }
    return r;
  }

  const platform = {
    sign,
    // Events API event_callback envelope.
    event(target, { teamId, event, eventId, ...opts }) {
      const ws = [...workspaces.values()].find((w) => w.teamId === teamId);
      const body = JSON.stringify({
        token: 'deprecated-verification-token', team_id: teamId, api_app_id: 'A0LIVEVERIFY',
        event: { event_ts: `${Date.now() / 1000}`, ...event }, type: 'event_callback',
        event_id: eventId ?? `Ev${crypto.randomBytes(6).toString('hex').toUpperCase()}`, event_time: Math.floor(Date.now() / 1000),
        authorizations: [{ enterprise_id: null, team_id: teamId, user_id: ws?.botUserId, is_bot: true, is_enterprise_install: false }],
      });
      return delivery.deliver('event', { team: teamId }, () =>
        withSlackRetries((o) => signedPost(target, body, 'application/json', 'event', teamId, o), opts));
    },
    urlVerification(target, opts = {}) {
      const body = JSON.stringify({ token: 'deprecated-verification-token', challenge: crypto.randomBytes(8).toString('hex'), type: 'url_verification' });
      return signedPost(target, body, 'application/json', 'url_verification', null, opts);
    },
    // A user clicking a button on a message the bot posted.
    blockAction(target, { teamId, userId, actionId, value, channel, messageTs, ...opts }) {
      const trigger_id = `${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
      triggers.set(trigger_id, { issuedAt: Date.now(), teamId });
      const message = (channels.get(channelKey(teamId, channel)) ?? []).find((m) => m.ts === messageTs);
      const payload = {
        type: 'block_actions', user: { id: userId, username: userId.toLowerCase(), team_id: teamId },
        api_app_id: 'A0LIVEVERIFY', token: 'deprecated-verification-token', trigger_id,
        team: { id: teamId, domain: teamId.toLowerCase() },
        container: { type: 'message', message_ts: messageTs, channel_id: channel, is_ephemeral: false },
        channel: { id: channel, name: 'directmessage' }, message,
        response_url: `${server.url}/response_url/${trigger_id}`,
        actions: [{ action_id: actionId, block_id: 'actions', value, type: 'button', action_ts: `${Date.now() / 1000}` }],
      };
      return formPost(target, payload, 'block_actions', teamId, opts);
    },
    // A user submitting a modal the app opened with views.open.
    viewSubmission(target, { teamId, userId, view, values, ...opts }) {
      const payload = {
        type: 'view_submission', team: { id: teamId, domain: teamId.toLowerCase() },
        user: { id: userId, username: userId.toLowerCase(), team_id: teamId },
        api_app_id: 'A0LIVEVERIFY', token: 'deprecated-verification-token',
        trigger_id: `${Date.now()}.${crypto.randomBytes(6).toString('hex')}`,
        view: { ...view, state: { values } },
      };
      return formPost(target, payload, 'view_submission', teamId, opts);
    },
  };

  function formPost(target, payload, kind, teamId, opts) {
    const body = 'payload=' + encodeURIComponent(JSON.stringify(payload));
    return delivery.deliver(kind, { team: teamId }, () =>
      signedPost(opts.target ?? target, body, 'application/x-www-form-urlencoded', kind, teamId, opts));
  }

  return {
    name: 'slack',
    url: server.url,
    faults,
    platform,
    acks,
    addWorkspace({ teamId, botToken, botUserId = `U${crypto.randomBytes(4).toString('hex').toUpperCase()}` }) {
      workspaces.set(botToken, { teamId, botUserId, domain: teamId.toLowerCase() });
      return { teamId, botToken, botUserId };
    },
    calls: (filter) => recorder.find(filter),
    messages: (teamId, channel) => [...channels.entries()]
      .filter(([k]) => k.startsWith(`${teamId}:`) && (!channel || k === channelKey(teamId, resolveChannel(channel))))
      .flatMap(([k, msgs]) => msgs.map((m) => ({ channel: k.split(':')[1], ...m }))),
    ephemerals: (teamId) => ephemerals.filter((e) => e.teamId === teamId),
    views: (teamId) => [...views.values()].filter((v) => v.team_id === teamId),
    reset() { faults.reset(); delivery.reset(); },
    close: () => server.close(),
  };
}
