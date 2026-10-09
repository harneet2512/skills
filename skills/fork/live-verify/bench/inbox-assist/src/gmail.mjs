// Gmail API client and Pub/Sub push verification.
import crypto from 'node:crypto';
import { parseGmailMessage } from './mail.mjs';

export class GmailError extends Error {
  constructor(message, { status = null, retryable = true, retryAfterMs } = {}) {
    super(message);
    Object.assign(this, { status, retryable, retryAfterMs });
  }
}

// The stand-in and this check use a static shared bearer token. In production
// Pub/Sub push sends a Google-signed OIDC JWT: verify its signature against
// Google's certs, `aud` equal to the subscription audience, `iss`, and that
// `email` is the push service account with `email_verified` true.
export function verifyPushToken(authorization, expected) {
  const got = String(authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = crypto.createHash('sha256').update(got).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return got.length > 0 && crypto.timingSafeEqual(a, b);
}

export function decodePush(body) {
  const data = JSON.parse(Buffer.from(body?.message?.data ?? '', 'base64').toString('utf8'));
  if (!data.emailAddress || !Number.isFinite(Number(data.historyId))) throw new Error('push without emailAddress/historyId');
  return { mailbox: String(data.emailAddress).toLowerCase(), historyId: Number(data.historyId), pubsubMessageId: body.message.messageId };
}

export function createGmailClient({ baseUrl, revokeUrl, timeoutMs, userAgent }) {
  async function call(token, method, path, body) {
    let res;
    try {
      res = await fetch(`${baseUrl}/users/me/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'user-agent': userAgent },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The request may or may not have reached Gmail: callers treat this as unknown.
      throw new GmailError(`gmail ${path}: transport ${err.cause?.code ?? err.name}`, { retryable: true });
    }
    // A 2xx whose body stalls or arrives cut short is not an empty success: it
    // would read as "no new mail" or "not an inbox message" and drop mail silently.
    let text;
    try { text = await res.text(); } catch (err) {
      throw new GmailError(`gmail ${path}: body ${err.cause?.code ?? err.name}`, { status: res.status, retryable: true });
    }
    if (res.ok) {
      if (text === '') return {};
      try { return JSON.parse(text); } catch {
        throw new GmailError(`gmail ${path}: unreadable ${res.status} body`, { status: res.status, retryable: true });
      }
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* error bodies are best effort */ }
    const retryAfter = Number(res.headers.get('retry-after'));
    throw new GmailError(`gmail ${path}: ${res.status} ${json?.error?.status ?? ''}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
      retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
    });
  }

  return {
    profile: (token) => call(token, 'GET', 'profile'),
    // All messages added since startHistoryId, across pages, plus the newest history id.
    async history(token, startHistoryId) {
      const ids = [];
      let pageToken;
      let historyId = startHistoryId;
      do {
        const q = new URLSearchParams({ startHistoryId: String(startHistoryId), historyTypes: 'messageAdded', maxResults: '100' });
        if (pageToken) q.set('pageToken', pageToken);
        const page = await call(token, 'GET', `history?${q}`);
        for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) ids.push({ id: a.message.id, threadId: a.message.threadId });
        historyId = Number(page.historyId);
        if (!Number.isSafeInteger(historyId)) throw new GmailError('gmail history: response without historyId', { retryable: true });
        pageToken = page.nextPageToken;
      } while (pageToken);
      const seen = new Set();
      return { added: ids.filter((m) => !seen.has(m.id) && seen.add(m.id)), historyId };
    },
    async message(token, id) { return parseGmailMessage(await call(token, 'GET', `messages/${encodeURIComponent(id)}?format=full`)); },
    async thread(token, id) { return (await call(token, 'GET', `threads/${encodeURIComponent(id)}?format=full`)).messages.map(parseGmailMessage); },
    // Stops push notifications for this mailbox (all watches, not just ours).
    stopWatch: (token) => call(token, 'POST', 'stop'),
    // Revokes the grant. 400 invalid_token means it is already revoked or expired.
    async revoke(token) {
      let res;
      try {
        res = await fetch(revokeUrl, {
          method: 'POST', body: new URLSearchParams({ token }), signal: AbortSignal.timeout(timeoutMs),
          headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': userAgent },
        });
      } catch (err) {
        throw new GmailError(`google revoke: transport ${err.cause?.code ?? err.name}`, { retryable: true });
      }
      const body = await res.json().catch(() => null);
      if (res.ok) return 'revoked';
      if (res.status === 400 && body?.error === 'invalid_token') return 'already_invalid';
      throw new GmailError(`google revoke: ${res.status} ${body?.error ?? ''}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
    },
    send: (token, raw, threadId) => call(token, 'POST', 'messages/send', { raw, threadId }),
    // Reconciliation for an ambiguous send: the thread read is consistent, the
    // rfc822msgid search catches a reply Gmail filed outside the thread.
    async findSent(token, threadId, messageId) {
      const msgs = await this.thread(token, threadId).catch((err) => { if (err.status === 404) return []; throw err; });
      const hit = msgs.find((m) => m.messageId.trim() === messageId);
      if (hit) return hit.id;
      const found = await call(token, 'GET', `messages?${new URLSearchParams({ q: `rfc822msgid:${messageId}` })}`);
      return found.messages?.[0]?.id ?? null;
    },
  };
}
