// HTTP entry point. Every inbound request is verified before it is parsed, and
// every platform request is acknowledged after durable state is written and
// before any slow work: the work itself runs in the job workers.
import http from 'node:http';
import crypto from 'node:crypto';
import { loadConfig } from './config.mjs';
import { createLogger } from './log.mjs';
import { openDb } from './db.mjs';
import { startWorker } from './jobs.mjs';
import { createSealer, installTenant, MailboxTaken } from './tenants.mjs';
import { createOffboarding } from './offboard.mjs';
import { createSlackClient, verifySlackSignature } from './slack.mjs';
import { createGmailClient, verifyPushToken, decodePush } from './gmail.mjs';
import { createLlm } from './llm.mjs';
import { createInbox } from './inbox.mjs';
import { createReplies } from './replies.mjs';

const VERSION = '1.0.0';
const MAX_BODY = 1024 * 1024;

const { config, problems } = loadConfig();
const log = createLogger({ app: 'inbox-assist', instance: config.INSTANCE_ID });
if (problems.length) {
  log.error('config.invalid', { problems });
  process.exit(1);
}

const db = openDb(config.DATABASE_PATH);
const sealer = createSealer(config.TOKEN_ENC_KEY);
const userAgent = `inbox-assist/${VERSION} (${config.INSTANCE_ID})`;
const slack = createSlackClient({ baseUrl: config.SLACK_API_BASE, timeoutMs: config.HTTP_TIMEOUT_MS, userAgent });
const gmail = createGmailClient({ baseUrl: config.GMAIL_API_BASE, revokeUrl: config.GOOGLE_REVOKE_URL, timeoutMs: config.HTTP_TIMEOUT_MS, userAgent });
const llm = createLlm(config, userAgent);
const inbox = createInbox({ db, sealer, config, gmail, slack, llm });
const replies = createReplies({ db, sealer, config, gmail, slack });
const offboarding = createOffboarding({ db, sealer, config, gmail });
const worker = startWorker({ db, handlers: { ...inbox.handlers, ...replies.handlers, ...offboarding.handlers }, log, workerId: config.INSTANCE_ID, config, slowKinds: ['draft_email'] });
let stopping = false;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body === '' ? '' : JSON.stringify(body));
};

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function slackVerified(req, raw, rlog) {
  const v = verifySlackSignature({
    signingSecret: config.SLACK_SIGNING_SECRET, rawBody: raw,
    timestamp: req.headers['x-slack-request-timestamp'], signature: req.headers['x-slack-signature'],
  });
  if (!v.ok) rlog.warn('security.slack_signature_rejected', { reason: v.reason, path: req.url });
  return v.ok;
}

const adminOk = (req) => verifyPushToken(req.headers.authorization, config.ADMIN_TOKEN);

// The doctor: answers "is this instance worth driving?" without calling out.
function doctor() {
  const checks = { config: problems.length === 0 ? 'ok' : problems.join('; '), accepting: stopping ? 'shutting down' : 'ok' };
  try {
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('tenants', 'emails', 'suggestions', 'jobs', 'outcomes', 'slack_events')").get();
    checks.db = row.n === 6 ? 'ok' : `schema incomplete (${row.n}/6 tables)`;
  } catch (err) { checks.db = err.message; }
  const w = worker.health();
  checks.worker = w.lastTickMsAgo < Math.max(5000, config.WORKER_POLL_MS * 10) ? 'ok' : `stalled ${w.lastTickMsAgo} ms`;
  const ok = Object.values(checks).every((c) => c === 'ok');
  return { ok, version: VERSION, instance: config.INSTANCE_ID, llm: llm.name, checks, inFlight: w.inFlight };
}

const routes = {
  'GET /healthz': (req, res) => { const d = doctor(); json(res, d.ok ? 200 : 503, d); },

  'POST /gmail/push': async (req, res, rlog) => {
    if (!verifyPushToken(req.headers.authorization, config.PUBSUB_PUSH_TOKEN)) {
      rlog.warn('security.push_token_rejected');
      return json(res, 401, { error: 'unauthorized' });
    }
    let push;
    try { push = decodePush(JSON.parse((await readRaw(req)).toString('utf8'))); } catch (err) {
      rlog.warn('push.malformed', { error: err.message });
      return json(res, 204, ''); // not retryable: redelivery would fail the same way
    }
    inbox.onPush(push, rlog);
    json(res, 204, '');
  },

  'POST /slack/events': async (req, res, rlog) => {
    const raw = await readRaw(req);
    if (!slackVerified(req, raw, rlog)) return json(res, 401, { error: 'invalid signature' });
    const body = JSON.parse(raw.toString('utf8'));
    if (body.type === 'url_verification') return json(res, 200, { challenge: body.challenge });
    if (body.type !== 'event_callback') return json(res, 200, '');
    const first = db.prepare('INSERT OR IGNORE INTO slack_events (event_id, team_id, received_at) VALUES (?, ?, ?)').run(body.event_id, body.team_id, Date.now()).changes === 1;
    if (!first) {
      rlog.info('slack.event_duplicate', { eventId: body.event_id, retryNum: req.headers['x-slack-retry-num'] });
      return json(res, 200, '');
    }
    // tokens_revoked also fires when a member revokes their own user token
    // (tokens.oauth); only a revoked bot token disconnects the workspace (TEN-14).
    const type = body.event?.type;
    if (type === 'app_uninstalled' || (type === 'tokens_revoked' && body.event.tokens?.bot?.length > 0)) {
      const changed = offboarding.onDisconnect(body.team_id, `c_${crypto.randomUUID()}`);
      rlog.info('tenant.disconnected', { team: body.team_id, reason: type, changed });
    } else if (type === 'tokens_revoked') {
      rlog.info('tenant.user_tokens_revoked', { team: body.team_id, users: body.event.tokens?.oauth?.length ?? 0 });
    }
    json(res, 200, '');
  },

  'POST /slack/interactions': async (req, res, rlog) => {
    const raw = await readRaw(req);
    if (!slackVerified(req, raw, rlog)) return json(res, 401, { error: 'invalid signature' });
    const payload = JSON.parse(new URLSearchParams(raw.toString('utf8')).get('payload') ?? '{}');
    const { body, after } = replies.onInteraction(payload, rlog.child({ team: payload.team?.id }));
    json(res, 200, body);
    if (after) await after();
  },

  // Completes an installation: the OAuth flows (Slack oauth.v2.access, Google
  // consent) are out of scope for the bench; this verifies both tokens live and
  // records where in the mailbox history to start.
  'POST /admin/installations': async (req, res, rlog) => {
    if (!adminOk(req)) return json(res, 401, { error: 'unauthorized' });
    const b = JSON.parse((await readRaw(req)).toString('utf8'));
    const auth = await slack.authTest(b.botToken).catch((err) => ({ error: err.message }));
    if (auth.team_id !== b.teamId) return json(res, 400, { error: 'slack token does not belong to teamId' });
    const profile = await gmail.profile(b.gmailToken).catch((err) => ({ error: err.message }));
    if (String(profile.emailAddress ?? '').toLowerCase() !== String(b.mailbox).toLowerCase()) return json(res, 400, { error: 'gmail token does not belong to mailbox' });
    if (!Number.isSafeInteger(Number(profile.historyId))) return json(res, 502, { error: 'gmail profile without historyId' });
    try {
      installTenant(db, sealer, { ...b, historyId: Number(profile.historyId) });
    } catch (err) {
      if (!(err instanceof MailboxTaken)) throw err;
      rlog.warn('tenant.mailbox_taken', { team: b.teamId });
      return json(res, 409, { error: err.message });
    }
    rlog.info('tenant.installed', { team: b.teamId, historyId: Number(profile.historyId) });
    json(res, 201, { ok: true, teamId: b.teamId, historyId: Number(profile.historyId) });
  },

  // "Did this sender's email get a reply?" for support and dashboards.
  'GET /admin/outcomes': (req, res) => {
    if (!adminOk(req)) return json(res, 401, { error: 'unauthorized' });
    const q = new URL(req.url, 'http://x').searchParams;
    const rows = db.prepare('SELECT gmail_message_id, sender, outcome, detail, actor, cid, updated_at FROM outcomes WHERE team_id = ? AND (? IS NULL OR sender = ?) ORDER BY updated_at')
      .all(q.get('team'), q.get('sender')?.toLowerCase() ?? null, q.get('sender')?.toLowerCase() ?? null);
    json(res, 200, { outcomes: rows });
  },
};

const server = http.createServer(async (req, res) => {
  const route = routes[`${req.method} ${new URL(req.url, 'http://x').pathname}`];
  const rlog = log.child({ rid: crypto.randomUUID().slice(0, 8) });
  if (!route) return json(res, 404, { error: 'not found' });
  try {
    await route(req, res, rlog);
  } catch (err) {
    rlog.error('request.failed', { path: req.url, error: err.message });
    if (!res.headersSent) json(res, err.status ?? 500, { error: 'internal error' });
  }
});

server.listen(config.PORT, '127.0.0.1', () => log.info('server.listening', { port: server.address().port, llm: llm.name }));

// Graceful stop (REL-11): /healthz turns 503 so no new traffic is routed here,
// the listener closes (idle keep-alive sockets too), in-flight requests and jobs
// get until SHUTDOWN_GRACE_MS to finish, leases still held are released for
// another instance, and only then is the database closed.
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('server.stopping', { signal });
  const drained = new Promise((resolve) => server.close(() => resolve(true)));
  server.closeIdleConnections();
  const deadline = new Promise((resolve) => setTimeout(() => resolve(false), config.SHUTDOWN_GRACE_MS).unref());
  const [left, requestsDrained] = await Promise.all([worker.stop(config.SHUTDOWN_GRACE_MS), Promise.race([drained, deadline])]);
  server.closeAllConnections();
  db.close();
  log.info('server.stopped', { abandonedJobs: left, requestsDrained });
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
