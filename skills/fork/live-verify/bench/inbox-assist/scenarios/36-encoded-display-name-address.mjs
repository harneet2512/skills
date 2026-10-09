import { installTenant, receiveEmail, waitPosted, sendOption, settled, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'an encoded display name cannot override the From address',
  journey: 'Attack: From display name hides <someone@else> inside an RFC 2047 encoded word',
  concerns: ['DI-11', 'SEC-07', 'AI-07'],
};

const enc = (s) => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.step('display name decodes to "Boss <ceo@evil.test>"');
  const email = await receiveEmail(ctx, t, { from: `${enc('Boss <ceo@evil.test>')} <dana@customer.test>`, body: 'Address check ADDR-1' });
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.expect('suggestion addressed to the real sender', s.reply_to, 'dana@customer.test');
  await sendOption(ctx, t, s, 1);
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  ctx.expect('email sent to the real sender only', sent.to, ['dana@customer.test']);

  ctx.step('display name decodes to our own mailbox: still drafted, not skipped');
  const spoof = await receiveEmail(ctx, t, { from: `${enc(`Support <${t.mailbox}>`)} <mallory@customer.test>`, body: 'Address check ADDR-2' });
  const { s: s2 } = await waitPosted(ctx, t, spoof.id);
  ctx.expect('second suggestion addressed to the real sender', s2.reply_to, 'mallory@customer.test');
  await settled(ctx, t);
  ctx.ok('spoofed display name not skipped as our own mailbox', (await outcomes(ctx, t)).every((o) => o.detail !== 'own_mailbox'), {});
}
