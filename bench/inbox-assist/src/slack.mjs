// Slack: request verification, Web API client, and the messages this app renders.
import crypto from 'node:crypto';

export const SIGNATURE_WINDOW_SEC = 300;

// https://api.slack.com/authentication/verifying-requests-from-slack
// Runs on the raw body bytes; constant-time compare; five minute window.
export function verifySlackSignature({ signingSecret, timestamp, signature, rawBody, nowSec = Math.floor(Date.now() / 1000) }) {
  if (!/^\d+$/.test(String(timestamp ?? ''))) return { ok: false, reason: 'missing_timestamp' };
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_WINDOW_SEC) return { ok: false, reason: 'stale_timestamp' };
  const expected = Buffer.from('v0=' + crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:`).update(rawBody).digest('hex'));
  const got = Buffer.from(String(signature ?? ''));
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

export class SlackError extends Error {
  constructor(message, { retryable, retryAfterMs, code } = {}) {
    super(message);
    Object.assign(this, { retryable, retryAfterMs, code });
  }
}

// invalid_json is ours: a 200 whose body was cut short is an unknown outcome, not a refusal.
const TRANSIENT_ERRORS = new Set(['invalid_json', 'ratelimited', 'internal_error', 'fatal_error', 'service_unavailable', 'request_timeout']);

export function createSlackClient({ baseUrl, timeoutMs, userAgent }) {
  // Read methods (conversations.*) take form-encoded arguments; JSON bodies are for write methods.
  async function call(method, token, args, { form = false } = {}) {
    let res;
    try {
      res = await fetch(`${baseUrl}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8', 'user-agent': userAgent },
        body: form ? new URLSearchParams(args) : JSON.stringify(args),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new SlackError(`slack ${method}: transport ${err.cause?.code ?? err.name}`, { retryable: true });
    }
    if (res.status === 429) {
      const after = Number(res.headers.get('retry-after'));
      throw new SlackError(`slack ${method}: 429`, { retryable: true, retryAfterMs: (Number.isFinite(after) && after > 0 ? after : 1) * 1000, code: 'ratelimited' });
    }
    if (res.status >= 500) throw new SlackError(`slack ${method}: ${res.status}`, { retryable: true });
    const json = await res.json().catch(() => ({ ok: false, error: 'invalid_json' }));
    if (!json.ok) throw new SlackError(`slack ${method}: ${json.error}`, { retryable: TRANSIENT_ERRORS.has(json.error), code: json.error });
    return json;
  }
  return {
    authTest: (token) => call('auth.test', token, {}),
    postMessage: (token, args) => call('chat.postMessage', token, { unfurl_links: false, unfurl_media: false, ...args }),
    update: (token, args) => call('chat.update', token, args),
    postEphemeral: (token, args) => call('chat.postEphemeral', token, args),
    openView: (token, triggerId, view) => call('views.open', token, { trigger_id: triggerId, view }),
    // Needs im:write and im:history: used to find a message we may already have posted.
    openDm: async (token, userId) => (await call('conversations.open', token, { users: userId }, { form: true })).channel.id,
    history: (token, args) => call('conversations.history', token, args, { form: true }),
  };
}

// Email-derived and model-derived text is escaped so it cannot render links,
// mentions or broadcasts (<!channel>) in Slack.
export const escapeMrkdwn = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const gmailLink = (threadId) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(threadId)}`;
const heading = (s) => `*New email from ${escapeMrkdwn(s.reply_to)}*\n${escapeMrkdwn(clip(s.subject || '(no subject)', 200))}`;
const fmtTime = (ms) => `<!date^${Math.floor(ms / 1000)}^{time}|${new Date(ms).toISOString().slice(11, 16)} UTC>`;

export function suggestionMessage(s) {
  const options = s.options.map((o, i) => ({ type: 'section', text: { type: 'mrkdwn', text: `*Option ${i + 1}*\n${escapeMrkdwn(clip(o, 2800))}` } }));
  const confirm = { title: { type: 'plain_text', text: 'Send this reply?' }, text: { type: 'plain_text', text: `The email goes to ${clip(s.reply_to, 150)}.` }, confirm: { type: 'plain_text', text: 'Send' }, deny: { type: 'plain_text', text: 'Cancel' } };
  const send = s.options.map((_, i) => ({ type: 'button', action_id: `send_option_${i + 1}`, text: { type: 'plain_text', text: `Send option ${i + 1}` }, value: `${s.id}:${i}`, confirm }));
  return {
    text: `New email from ${s.reply_to}: ${clip(s.subject, 150)}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: heading(s) } },
      ...options,
      { type: 'actions', block_id: 'actions', elements: [...send,
        { type: 'button', action_id: 'edit', text: { type: 'plain_text', text: 'Edit' }, value: s.id },
        { type: 'button', action_id: 'dismiss', text: { type: 'plain_text', text: 'Dismiss' }, value: s.id, style: 'danger' }] },
    ],
  };
}

// The final state replaces the buttons, so a stale copy cannot be acted on twice.
export function resolvedMessage(s) {
  const line = {
    sent: `Sent by <@${s.acted_by}> at ${fmtTime(s.updated_at)}`,
    dismissed: `Dismissed by <@${s.acted_by}>`,
    failed: `Couldn't send this reply. <${gmailLink(s.thread_id)}|Open in Gmail>`,
  }[s.status];
  return { text: line.replace(/<[^>]*\|([^>]*)>/g, '$1'), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `${heading(s)}\n\n${line}` } }] };
}

const FALLBACK_LINES = {
  failed: "Couldn't draft replies, open in Gmail",
  budget: 'Draft limit reached for this hour: this and further new emails are not drafted until it resets, open in Gmail',
};

export function fallbackMessage({ sender, subject, threadId, reason = 'failed' }) {
  const line = FALLBACK_LINES[reason] ?? FALLBACK_LINES.failed;
  const text = `New email from ${escapeMrkdwn(sender)}: ${escapeMrkdwn(clip(subject, 200))}\n${line}: <${gmailLink(threadId)}|Open in Gmail>`;
  return { text: line, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] };
}

export const EDIT_CALLBACK = 'edit_reply';
export const MAX_EDIT_CHARS = 3000;

export function editModal(s) {
  return {
    type: 'modal', callback_id: EDIT_CALLBACK, private_metadata: s.id,
    title: { type: 'plain_text', text: 'Edit reply' }, submit: { type: 'plain_text', text: 'Send' }, close: { type: 'plain_text', text: 'Cancel' },
    blocks: [{
      type: 'input', block_id: 'reply', label: { type: 'plain_text', text: `Reply to ${clip(s.reply_to, 100)}` },
      element: { type: 'plain_text_input', action_id: 'text', multiline: true, max_length: MAX_EDIT_CHARS, initial_value: s.options[0] },
    }],
  };
}
