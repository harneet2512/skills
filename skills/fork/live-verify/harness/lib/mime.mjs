// Minimal RFC 2822 / MIME reader for what an app sends through Gmail:
// header unfolding, RFC 2047 encoded words, base64 and quoted-printable bodies,
// and the first text/plain part of a multipart message.

export const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const b64urlEncode = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function decodeWords(value) {
  // Whitespace between adjacent encoded words is not part of the text (RFC 2047 section 6.2).
  return value.replace(/(\?=)\s+(=\?)/g, '$1$2').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, text) => {
    const bytes = enc.toUpperCase() === 'B'
      ? Buffer.from(text, 'base64')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
    return new TextDecoder(charset).decode(bytes);
  });
}

function splitHeadersBody(text) {
  const idx = text.search(/\r?\n\r?\n/);
  if (idx === -1) return { head: text, body: '' };
  const sep = text.slice(idx).match(/^\r?\n\r?\n/)[0];
  return { head: text.slice(0, idx), body: text.slice(idx + sep.length) };
}

export function parseHeaders(head) {
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  return unfolded.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf(':');
    return { name: line.slice(0, i).trim(), value: decodeWords(line.slice(i + 1).trim()), raw: line.slice(i + 1).trim() };
  });
}

export const header = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function decodeBody(body, headers) {
  const cte = (header(headers, 'content-transfer-encoding') ?? '7bit').toLowerCase();
  const charset = /charset="?([^";]+)"?/i.exec(header(headers, 'content-type') ?? '')?.[1] ?? 'utf-8';
  let bytes;
  if (cte === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (cte === 'quoted-printable') {
    bytes = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  } else bytes = Buffer.from(body, 'utf8');
  return new TextDecoder(charset).decode(bytes);
}

// Returns { headers, text } where text is the first text/plain body.
export function parseMessage(raw) {
  const { head, body } = splitHeadersBody(raw);
  const headers = parseHeaders(head);
  const ctype = header(headers, 'content-type') ?? 'text/plain';
  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    for (const part of parts) {
      const parsed = parseMessage(part.replace(/^\r?\n/, ''));
      if (/text\/plain/i.test(header(parsed.headers, 'content-type') ?? 'text/plain')) return { headers, text: parsed.text };
    }
    return { headers, text: '' };
  }
  return { headers, text: decodeBody(body, headers) };
}

// Address list "A <a@x>, b@y" -> ['a@x', 'b@y'] (lowercased).
export function addresses(value) {
  if (!value) return [];
  return value.split(',').map((part) => (/<([^>]+)>/.exec(part)?.[1] ?? part).trim().toLowerCase()).filter(Boolean);
}
