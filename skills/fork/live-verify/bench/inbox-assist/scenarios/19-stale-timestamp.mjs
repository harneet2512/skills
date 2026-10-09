import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'stale timestamp and replayed request are rejected',
  journey: 'Attack: a captured, validly signed click is replayed later',
  concerns: ['SEC-03', 'SEC-04'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.step('valid signature over a timestamp 6 minutes old');
  const old = Math.floor(Date.now() / 1000) - 360;
  const stale = await sendOption(ctx, t, s, 1, { timestamp: old });
  ctx.expect('stale timestamp -> 401', stale.status, 401);
  ctx.step('valid signature over a timestamp 6 minutes in the future');
  const future = await sendOption(ctx, t, s, 1, { timestamp: Math.floor(Date.now() / 1000) + 360 });
  ctx.expect('future timestamp -> 401', future.status, 401);
  ctx.step('missing timestamp header value');
  const none = await sendOption(ctx, t, s, 1, { timestamp: '' });
  ctx.expect('missing timestamp -> 401', none.status, 401);
  await settled(ctx, t);
  ctx.expect('no email sent', ctx.gmail.sent(t.mailbox).length, 0);
  ctx.ok('logged as stale', ctx.logs((l) => l.event === 'security.slack_signature_rejected' && l.reason === 'stale_timestamp').length >= 2, {});
}
