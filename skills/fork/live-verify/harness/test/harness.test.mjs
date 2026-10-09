import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Faults, Delivery } from '../lib/faults.mjs';
import { parseMessage, decodeWords, addresses } from '../lib/mime.mjs';
import { startSlack } from '../standins/slack.mjs';
import { startGmail } from '../standins/gmail.mjs';
import { startLlm } from '../standins/llm.mjs';

test('faults: nth call, times, where', () => {
  const f = new Faults();
  f.inject('send', { kind: 'status', status: 500, nth: 2, times: 2, where: (c) => c.team === 'A' });
  assert.equal(f.take('send', { team: 'A' }), null);
  assert.equal(f.take('send', { team: 'B' }), null);
  assert.equal(f.take('send', { team: 'A' })?.status, 500);
  assert.equal(f.take('send', { team: 'A' })?.status, 500);
  assert.equal(f.take('send', { team: 'A' }), null);
  assert.deepEqual(f.unfired(), []);
});

test('delivery: duplicate and reorder', async () => {
  const f = new Faults();
  const d = new Delivery(f);
  const log = [];
  f.inject('push', { kind: 'reorder' });
  assert.deepEqual(await d.deliver('push', {}, async () => log.push('first')), { held: true });
  await d.deliver('push', {}, async () => log.push('second'));
  assert.deepEqual(log, ['second', 'first']);
  f.inject('push', { kind: 'duplicate', copies: 3 });
  const r = await d.deliver('push', {}, async (i) => i);
  assert.deepEqual(r.results, [0, 1, 2]);
});

test('mime: encoded words, base64 body, addresses', () => {
  assert.equal(decodeWords('=?UTF-8?B?6KuL5rGC5pu4?= =?UTF-8?Q?_x?='), '請求書 x');
  const raw = ['To: A <a@x.test>, b@y.test', 'Subject: =?UTF-8?B?44GC?=', 'Content-Transfer-Encoding: base64', '', Buffer.from('héllo').toString('base64')].join('\r\n');
  const p = parseMessage(raw);
  assert.equal(p.text, 'héllo');
  assert.deepEqual(addresses(p.headers.find((h) => h.name === 'To').value), ['a@x.test', 'b@y.test']);
});

test('slack stand-in: auth per workspace, DM channel, 429 fault, trigger expiry', async () => {
  const slack = await startSlack({ signingSecret: 's' });
  try {
    slack.addWorkspace({ teamId: 'T1', botToken: 'xoxb-1', botUserId: 'UBOT' });
    const call = (method, token, body) => fetch(`${slack.url}/api/${method}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, retryAfter: r.headers.get('retry-after'), json: await r.json() }));
    assert.equal((await call('auth.test', 'bad', {})).json.error, 'invalid_auth');
    const posted = await call('chat.postMessage', 'xoxb-1', { channel: 'U123', text: 'hi' });
    assert.equal(posted.json.channel, 'D123');
    slack.faults.inject('chat.postMessage', { kind: 'status', status: 429, retryAfter: 2 });
    const limited = await call('chat.postMessage', 'xoxb-1', { channel: 'U123', text: 'hi' });
    assert.deepEqual([limited.status, limited.retryAfter, limited.json.error], [429, '2', 'ratelimited']);
    assert.equal((await call('views.open', 'xoxb-1', { trigger_id: 'nope', view: { type: 'modal' } })).json.error, 'invalid_trigger_id');
    assert.equal((await call('chat.update', 'xoxb-1', { channel: 'D123', ts: '1.1', text: 'x' })).json.error, 'message_not_found');
  } finally { await slack.close(); }
});

test('gmail stand-in: history, send threading rules, rfc822msgid search, timeoutAfterSuccess', async () => {
  const gmail = await startGmail({ pushToken: 'p' });
  try {
    gmail.addMailbox({ address: 'me@x.test', token: 't' });
    const d = gmail.deliverEmail('me@x.test', { from: 'A <a@y.test>', subject: 'Hello', body: 'hi' });
    const api = (p, init = {}) => fetch(`${gmail.url}/gmail/v1/users/me/${p}`, { ...init, headers: { authorization: 'Bearer t', 'content-type': 'application/json' } });
    const h = await (await api('history?startHistoryId=1000')).json();
    assert.equal(h.history[0].messagesAdded[0].message.id, d.id);
    const raw = (subject) => Buffer.from(`To: a@y.test\r\nSubject: ${subject}\r\nMessage-ID: <mine-${subject.length}@x>\r\nIn-Reply-To: ${d.messageId}\r\n\r\nbody`).toString('base64url');
    await api('messages/send', { method: 'POST', body: JSON.stringify({ raw: raw('Re: Hello'), threadId: d.threadId }) });
    await api('messages/send', { method: 'POST', body: JSON.stringify({ raw: raw('Other'), threadId: d.threadId }) });
    assert.deepEqual(gmail.sent('me@x.test').map((s) => s.threaded), [true, false]);
    const found = await (await api(`messages?q=${encodeURIComponent('rfc822msgid:<mine-9@x>')}`)).json();
    assert.equal(found.messages.length, 1);
    gmail.faults.inject('users.messages.send', { kind: 'timeoutAfterSuccess' });
    await assert.rejects(api('messages/send', { method: 'POST', body: JSON.stringify({ raw: raw('Re: Hello') }) }));
    assert.equal(gmail.sent('me@x.test').length, 3, 'side effect happened even though the client saw an error');
    assert.equal((await api('history?startHistoryId=1')).status, 404);
  } finally { await gmail.close(); }
});

test('llm stand-in: api key, request validation, scripted rule, error shape', async () => {
  const llm = await startLlm({ apiKey: 'k', defaultReply: () => 'default' });
  try {
    const post = (body, key = 'k') => fetch(`${llm.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const body = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'ping' }] };
    assert.equal((await post(body, 'bad')).status, 401);
    assert.equal((await post({ model: 'm' })).status, 400);
    assert.equal((await (await post(body)).json()).content[0].text, 'default');
    llm.script({ name: 'pong', when: (r) => r.prompt === 'ping', reply: 'pong' });
    assert.equal((await (await post(body)).json()).content[0].text, 'pong');
    llm.faults.inject('messages', { kind: 'status', status: 529 });
    const r = await post(body);
    assert.equal(r.status, 529);
    assert.equal((await r.json()).error.type, 'overloaded_error');
  } finally { await llm.close(); }
});
