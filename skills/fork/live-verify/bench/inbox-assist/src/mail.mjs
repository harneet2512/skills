// Pure email helpers: reading Gmail API messages, deciding whether a message
// deserves a draft, and building the reply. Recipients, subject and threading
// headers are derived here from the original message, never from model output.
import crypto from 'node:crypto';

export const APP_HEADER = 'X-Inbox-Assist-Suggestion';

const b64urlToText = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
export const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// An unknown or unsupported charset must not fail the whole message: decode as
// UTF-8 with replacement characters instead (DI-11).
function decodeBytes(charset, bytes) {
  try { return new TextDecoder(charset).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

export function decodeMimeWords(value = '') {
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    const bytes = enc.toUpperCase() === 'B' ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return decodeBytes(cs, bytes);
  });
}

// Pass the RAW header: an encoded display name decodes to arbitrary text, such
// as "Boss <ceo@evil.test>", which must not be read as the address. Raw display
// names cannot contain a bare angle-addr after it, so the last <...> is the address.
export function addressOf(value = '') {
  const angle = [...value.matchAll(/<([^<>]*)>/g)].pop()?.[1];
  return (angle ?? value).trim().toLowerCase();
}

function textOf(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64urlToText(part.body.data);
  for (const p of part.parts ?? []) {
    const t = textOf(p);
    if (t) return t;
  }
  if (part.mimeType === 'text/html' && part.body?.data) return b64urlToText(part.body.data).replace(/<[^>]+>/g, ' ');
  return '';
}

// Gmail API message (format=full) -> the fields the app uses.
export function parseGmailMessage(m) {
  const raw = m.payload?.headers ?? [];
  const headers = new Map(raw.map((h) => [h.name.toLowerCase(), decodeMimeWords(h.value)]));
  const rawFrom = raw.find((h) => h.name.toLowerCase() === 'from')?.value ?? '';
  return {
    id: m.id,
    threadId: m.threadId,
    labelIds: m.labelIds ?? [],
    headers,
    from: headers.get('from') ?? '',
    sender: addressOf(rawFrom),
    subject: headers.get('subject') ?? '',
    date: headers.get('date') ?? '',
    messageId: headers.get('message-id') ?? '',
    references: headers.get('references') ?? '',
    text: textOf(m.payload),
  };
}

const NOREPLY = /^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?)([+._-].*)?$/i;

// Returns why this message must not get a draft, or null. Covers our own sent
// replies (which Gmail reports back through history), and machine-sent mail.
export function skipReason(msg, mailbox) {
  const h = msg.headers;
  if (msg.labelIds.includes('SENT') || msg.labelIds.includes('DRAFT')) return 'own_message';
  if (h.has(APP_HEADER.toLowerCase())) return 'sent_by_app';
  if (msg.sender === mailbox.toLowerCase()) return 'own_mailbox';
  if (!msg.labelIds.includes('INBOX')) return 'not_inbox';
  const autoSubmitted = (h.get('auto-submitted') ?? 'no').toLowerCase();
  if (autoSubmitted !== 'no') return 'auto_submitted';
  if (h.has('x-autoreply') || h.has('x-autorespond')) return 'auto_reply';
  if (/^(bulk|junk|list|auto_reply)$/i.test(h.get('precedence') ?? '')) return 'bulk';
  if (h.has('list-unsubscribe') || h.has('list-id')) return 'bulk';
  if (NOREPLY.test(msg.sender.split('@')[0] ?? '')) return 'noreply';
  return null;
}

// Header values never carry CR/LF (header injection); non-ASCII uses RFC 2047.
export function headerValue(v) {
  const clean = String(v).replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function replySubject(subject) {
  return /^\s*re\s*:/i.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}

export const newMessageId = (domain) => `<${crypto.randomUUID()}@${domain}>`;

// Builds the RFC 2822 reply as base64url for users.messages.send.
export function buildReply({ from, to, subject, inReplyTo, references, messageId, body, suggestionId }) {
  const refs = [references, inReplyTo].filter(Boolean).join(' ').trim();
  const lines = [
    `From: ${headerValue(from)}`,
    `To: ${headerValue(to)}`,
    `Subject: ${headerValue(replySubject(subject))}`,
    `Message-ID: ${headerValue(messageId)}`,
    `Date: ${new Date().toUTCString()}`,
    ...(inReplyTo ? [`In-Reply-To: ${headerValue(inReplyTo)}`, `References: ${headerValue(refs)}`] : []),
    `${APP_HEADER}: ${headerValue(suggestionId)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return toBase64Url(lines.join('\r\n'));
}
