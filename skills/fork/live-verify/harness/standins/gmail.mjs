// Gmail stand-in: the Gmail API subset a mail-watching app uses, per-mailbox
// state with history ids, and the Pub/Sub push side that notifies the app.
// Shapes follow https://developers.google.com/gmail/api/reference/rest
//
// Push auth: the stand-in sends a static shared bearer token. Production Pub/Sub
// push sends a Google-signed OIDC JWT; the app must verify its signature, `aud`,
// `iss` and the push service account `email` (see security SEC-03).
import crypto from 'node:crypto';
import { startServer, readBody, applyFault, send } from '../lib/http.mjs';
import { Faults, Delivery } from '../lib/faults.mjs';
import { Recorder } from '../lib/recorder.mjs';
import { b64urlDecode, b64urlEncode, parseMessage, header, addresses } from '../lib/mime.mjs';

const hexId = () => crypto.randomBytes(8).toString('hex');
const normId = (v) => (v ?? '').trim().replace(/^<|>$/g, '').toLowerCase();
const stripRe = (s) => (s ?? '').replace(/^\s*((re|aw|sv|fwd?)\s*:\s*)+/i, '').trim();

const gmailError = (code, message, status) => ({ error: { code, message, errors: [{ message, domain: 'global', reason: status }], status } });

export async function startGmail({ pushToken }) {
  const recorder = new Recorder('gmail');
  const faults = new Faults();
  const delivery = new Delivery(faults);
  const mailboxes = new Map(); // address -> mailbox
  const byToken = new Map(); // token -> address
  const revoked = new Map(); // revoked token -> address
  const acks = [];
  let pubsubSeq = 1000;

  function addMailbox({ address, token, startHistoryId = 1000, searchLagMs = 0 }) {
    const mb = { address: address.toLowerCase(), watching: true, messages: new Map(), threads: new Map(), history: [], historyId: startHistoryId, firstHistoryId: startHistoryId, searchLagMs, sent: [], drafts: [] };
    mailboxes.set(mb.address, mb);
    byToken.set(token, mb.address);
    return mb;
  }

  function addMessage(mb, { threadId, labelIds, headers, text }) {
    const id = hexId();
    mb.historyId += 1;
    const msg = { id, threadId: threadId ?? id, labelIds, headers, text, historyId: mb.historyId, internalDate: Date.now(), searchableAt: Date.now() + mb.searchLagMs };
    mb.messages.set(id, msg);
    if (!mb.threads.has(msg.threadId)) mb.threads.set(msg.threadId, []);
    mb.threads.get(msg.threadId).push(id);
    mb.history.push({ id: String(mb.historyId), messages: [{ id, threadId: msg.threadId }], messagesAdded: [{ message: { id, threadId: msg.threadId, labelIds } }] });
    return msg;
  }

  const findByMessageId = (mb, mid) => [...mb.messages.values()].find((m) => normId(header(m.headers, 'message-id')) === normId(mid));

  function toApi(msg, format = 'full') {
    const base = { id: msg.id, threadId: msg.threadId, labelIds: msg.labelIds, snippet: msg.text.slice(0, 100), historyId: String(msg.historyId), internalDate: String(msg.internalDate), sizeEstimate: msg.text.length };
    if (format === 'minimal') return base;
    const data = b64urlEncode(Buffer.from(msg.text, 'utf8'));
    return { ...base, payload: { partId: '', mimeType: 'text/plain', filename: '', headers: msg.headers.map(({ name, value }) => ({ name, value })), body: format === 'metadata' ? { size: 0 } : { size: Buffer.byteLength(msg.text), data } } };
  }

  // Route table: [httpMethod, regex, apiMethodName, handler(mb, match, query, body) -> {status, body}]
  const routes = [
    ['GET', /^profile$/, 'users.getProfile', (mb) => ok({ emailAddress: mb.address, messagesTotal: mb.messages.size, threadsTotal: mb.threads.size, historyId: String(mb.historyId) })],
    ['GET', /^history$/, 'users.history.list', (mb, _m, q) => {
      const start = Number(q.get('startHistoryId'));
      if (!q.get('startHistoryId') || !Number.isFinite(start)) return err(400, 'Invalid startHistoryId', 'INVALID_ARGUMENT');
      if (start < mb.firstHistoryId - 1) return err(404, 'Requested entity was not found.', 'NOT_FOUND');
      const all = mb.history.filter((h) => Number(h.id) > start);
      const offset = Number(q.get('pageToken') ?? 0);
      const max = Math.min(Number(q.get('maxResults') ?? 100), 500);
      const page = all.slice(offset, offset + max);
      const body = { historyId: String(mb.historyId) };
      if (page.length) body.history = page;
      if (offset + max < all.length) body.nextPageToken = String(offset + max);
      return ok(body);
    }],
    ['GET', /^messages$/, 'users.messages.list', (mb, _m, q) => {
      const query = q.get('q') ?? '';
      const rfc = /rfc822msgid:(\S+)/i.exec(query)?.[1];
      let found = [...mb.messages.values()].filter((m) => m.searchableAt <= Date.now());
      if (rfc) found = found.filter((m) => normId(header(m.headers, 'message-id')) === normId(rfc));
      return ok(found.length ? { messages: found.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: found.length } : { resultSizeEstimate: 0 });
    }],
    ['GET', /^messages\/([^/]+)$/, 'users.messages.get', (mb, m, q) => {
      const msg = mb.messages.get(m[1]);
      return msg ? ok(toApi(msg, q.get('format') ?? 'full')) : err(404, 'Requested entity was not found.', 'NOT_FOUND');
    }],
    ['GET', /^threads\/([^/]+)$/, 'users.threads.get', (mb, m, q) => {
      const ids = mb.threads.get(m[1]);
      if (!ids) return err(404, 'Requested entity was not found.', 'NOT_FOUND');
      const msgs = ids.map((id) => mb.messages.get(id));
      return ok({ id: m[1], historyId: String(Math.max(...msgs.map((x) => x.historyId))), messages: msgs.map((x) => toApi(x, q.get('format') ?? 'full')) });
    }],
    ['POST', /^messages\/send$/, 'users.messages.send', (mb, _m, _q, body) => {
      if (!body?.raw) return err(400, "'raw' RFC822 payload message string or uploading message via /upload/* URL required", 'INVALID_ARGUMENT');
      const raw = b64urlDecode(body.raw).toString('utf8');
      const parsed = parseMessage(raw);
      const to = addresses(header(parsed.headers, 'to'));
      if (to.length === 0) return err(400, 'Invalid To header', 'INVALID_ARGUMENT');
      // Gmail threads a sent message only when threadId is given, the Subject
      // matches, and In-Reply-To/References point into the thread.
      let threadId = null;
      let threaded = false;
      const thread = body.threadId ? mb.threads.get(body.threadId) : null;
      if (body.threadId && !thread) return err(404, 'Requested entity was not found.', 'NOT_FOUND');
      if (thread) {
        const threadMsgs = thread.map((id) => mb.messages.get(id));
        const refs = `${header(parsed.headers, 'in-reply-to') ?? ''} ${header(parsed.headers, 'references') ?? ''}`.split(/\s+/).map(normId).filter(Boolean);
        const subjectOk = stripRe(header(parsed.headers, 'subject')) === stripRe(header(threadMsgs[0].headers, 'subject'));
        const refOk = threadMsgs.some((t) => refs.includes(normId(header(t.headers, 'message-id'))));
        threaded = subjectOk && refOk;
        if (threaded) threadId = body.threadId;
      }
      const headers = parsed.headers.map(({ name, value }) => ({ name, value }));
      if (!header(headers, 'message-id')) headers.push({ name: 'Message-ID', value: `<${hexId()}@mail.gmail.test>` });
      if (!header(headers, 'from')) headers.push({ name: 'From', value: mb.address });
      const msg = addMessage(mb, { threadId, labelIds: ['SENT'], headers, text: parsed.text });
      mb.sent.push({
        id: msg.id, threadId: msg.threadId, requestedThreadId: body.threadId ?? null, threaded,
        from: header(headers, 'from'), to, cc: addresses(header(headers, 'cc')), bcc: addresses(header(headers, 'bcc')),
        subject: header(headers, 'subject'), inReplyTo: header(headers, 'in-reply-to'), references: header(headers, 'references'),
        messageId: header(headers, 'message-id'), body: parsed.text, headers,
      });
      return ok({ id: msg.id, threadId: msg.threadId, labelIds: ['SENT'] });
    }],
    // Stops push notifications for the mailbox. Gmail answers 204 with an empty body.
    ['POST', /^stop$/, 'users.stop', (mb) => { mb.watching = false; return { status: 204, body: '' }; }],
    ['POST', /^drafts$/, 'users.drafts.create', (mb, _m, _q, body) => {
      if (!body?.message?.raw) return err(400, 'Missing draft message', 'INVALID_ARGUMENT');
      const draft = { id: `r${hexId()}`, message: { id: hexId(), threadId: body.message.threadId ?? hexId(), labelIds: ['DRAFT'] } };
      mb.drafts.push({ ...draft, parsed: parseMessage(b64urlDecode(body.message.raw).toString('utf8')) });
      return ok(draft);
    }],
  ];
  const ok = (body) => ({ status: 200, body });
  const err = (code, message, status) => ({ status: code, body: gmailError(code, message, status) });

  // Google OAuth token revocation (https://oauth2.googleapis.com/revoke): the
  // token stops working for every API call. Unknown tokens get invalid_token.
  async function revoke(req, res, url) {
    const form = new URLSearchParams((await readBody(req)).toString('utf8'));
    const token = url.searchParams.get('token') ?? form.get('token') ?? '';
    const address = byToken.get(token) ?? null;
    const call = { method: 'oauth.revoke', mailbox: address, path: url.pathname, client: req.headers['user-agent'] ?? '', startedAt: Date.now() };
    const fault = faults.take('oauth.revoke', call);
    const r = await applyFault({
      fault, req, res,
      perform: async () => {
        if (!address) return { status: 400, body: { error: 'invalid_token', error_description: 'Token expired or revoked' } };
        byToken.delete(token);
        revoked.set(token, address);
        return { status: 200, body: {} };
      },
      errorBody: () => ({ error: 'server_error' }),
    });
    recorder.record({ ...call, outcome: r.outcome, status: r.status, durationMs: Date.now() - call.startedAt });
  }

  const server = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/revoke') return revoke(req, res, url);
    const m = /^\/gmail\/v1\/users\/([^/]+)\/(.+)$/.exec(url.pathname);
    const raw = await readBody(req);
    const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const address = byToken.get(token);
    const route = m && routes.find(([verb, re]) => verb === req.method && re.test(m[2]));
    const method = route?.[2] ?? `${req.method} ${url.pathname}`;
    const call = { method, mailbox: address ?? null, path: url.pathname, query: url.search, client: req.headers['user-agent'] ?? '', startedAt: Date.now() };
    if (!route) { recorder.record({ ...call, outcome: 'not_found', status: 404 }); return send(res, 404, gmailError(404, 'Not Found', 'NOT_FOUND')); }
    if (!address || (m[1] !== 'me' && m[1].toLowerCase() !== address)) {
      recorder.record({ ...call, outcome: 'unauthenticated', status: 401 });
      return send(res, 401, gmailError(401, 'Request had invalid authentication credentials.', 'UNAUTHENTICATED'));
    }
    const mb = mailboxes.get(address);
    let body = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { return send(res, 400, gmailError(400, 'Invalid JSON payload', 'INVALID_ARGUMENT')); }
    call.args = body ? { threadId: body.threadId ?? body.message?.threadId } : undefined;
    const fault = faults.take(method, call);
    const r = await applyFault({
      fault, req, res,
      perform: async () => route[3](mb, route[1].exec(m[2]), url.searchParams, body),
      errorBody: (status) => gmailError(status, status === 429 ? 'Rate Limit Exceeded' : 'Backend Error', status === 429 ? 'RESOURCE_EXHAUSTED' : 'INTERNAL'),
    });
    recorder.record({ ...call, outcome: r.outcome, status: r.status, durationMs: Date.now() - call.startedAt });
  });

  // ---- Platform side: new mail and Pub/Sub push ----

  function pushPayload(address) {
    const mb = mailboxes.get(address.toLowerCase());
    const messageId = String(++pubsubSeq);
    const data = Buffer.from(JSON.stringify({ emailAddress: mb.address, historyId: mb.historyId })).toString('base64');
    const publishTime = new Date().toISOString();
    return { message: { data, messageId, message_id: messageId, publishTime, publish_time: publishTime, attributes: {} }, subscription: 'projects/live-verify/subscriptions/gmail-push' };
  }

  // Adds an inbound message to the mailbox (threading by In-Reply-To like Gmail
  // does for the recipient) and returns it with the Pub/Sub push that announces it.
  function deliverEmail(address, { from, to, subject, body, inReplyTo, references, headers = {}, labelIds = ['INBOX', 'UNREAD'], messageId }) {
    const mb = mailboxes.get(address.toLowerCase());
    if (!mb) throw new Error(`no mailbox ${address}`);
    const mid = messageId ?? `<${hexId()}@sender.test>`;
    const parent = inReplyTo ? findByMessageId(mb, inReplyTo) : null;
    const hdrs = [
      { name: 'From', value: from }, { name: 'To', value: to ?? mb.address }, { name: 'Subject', value: subject },
      { name: 'Date', value: new Date().toUTCString() }, { name: 'Message-ID', value: mid },
      { name: 'Content-Type', value: 'text/plain; charset=UTF-8' },
    ];
    if (inReplyTo) hdrs.push({ name: 'In-Reply-To', value: inReplyTo });
    if (references || inReplyTo) hdrs.push({ name: 'References', value: references ?? inReplyTo });
    for (const [name, value] of Object.entries(headers)) hdrs.push({ name, value });
    const msg = addMessage(mb, { threadId: parent?.threadId, labelIds, headers: hdrs, text: body });
    return { id: msg.id, threadId: msg.threadId, messageId: mid, historyId: msg.historyId, push: pushPayload(mb.address) };
  }

  // POSTs a push to the app. `targets` may list several app instances: copies
  // from a duplicate fault go round-robin across them.
  function pushToApp(targets, push, { token = pushToken, timeoutMs = 15000 } = {}) {
    const list = Array.isArray(targets) ? targets : [targets];
    const address = JSON.parse(Buffer.from(push.message.data, 'base64').toString()).emailAddress;
    return delivery.deliver('push', { mailbox: address }, async (i = 0) => {
      const target = list[i % list.length];
      const started = performance.now();
      const res = await fetch(target, {
        method: 'POST', body: JSON.stringify(push), signal: AbortSignal.timeout(timeoutMs),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'APIs-Google; (+https://developers.google.com/webmasters/APIs-Google.html)' },
      });
      await res.text();
      const ms = Math.round(performance.now() - started);
      acks.push({ kind: 'push', mailbox: address, target, status: res.status, ms, at: Date.now() });
      recorder.record({ method: 'deliver:push', mailbox: address, outcome: `http:${res.status}`, status: res.status, durationMs: ms });
      return { status: res.status, ms };
    });
  }

  return {
    name: 'gmail',
    url: server.url,
    faults,
    acks,
    addMailbox,
    deliverEmail,
    pushPayload,
    pushToApp,
    mailbox: (address) => mailboxes.get(address.toLowerCase()),
    sent: (address) => mailboxes.get(address.toLowerCase())?.sent ?? [],
    isRevoked: (token) => revoked.has(token),
    // A fresh OAuth grant for an existing mailbox (reconnect after a revoke).
    grant: (address, token) => { byToken.set(token, address.toLowerCase()); },
    calls: (filter) => recorder.find(filter),
    reset() { faults.reset(); delivery.reset(); },
    close: () => server.close(),
  };
}
