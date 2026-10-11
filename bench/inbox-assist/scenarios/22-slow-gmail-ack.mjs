import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'acks stay under 3 s while Gmail is slow',
  journey: 'J2.slow-gmail J3.slow-gmail UJ steps 2-3 while Gmail takes 3.5 s per call',
  concerns: ['LAT-02', 'LAT-03', 'UJ-05'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const slow = { kind: 'delay', delayMs: 3500, times: Infinity, where: (c) => c.mailbox === t.mailbox };
  for (const m of ['users.history.list', 'users.messages.get', 'users.messages.send']) ctx.gmail.faults.inject(m, slow);
  ctx.step('push while every Gmail call takes 3.5 s');
  const email = await receiveEmail(ctx, t);
  ctx.ok('push ack under 1 s', email.ack.ms < 1000, { ms: email.ack.ms });
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.step('click while Gmail send takes 3.5 s');
  const ack = await sendOption(ctx, t, s, 1);
  ctx.ok('click ack under 3 s (Slack deadline)', ack.status === 200 && !ack.late, { ms: ack.ms });
  await ctx.waitFor(() => ctx.gmail.sent(t.mailbox).length === 1, 15000, 'sent despite slowness');
  await settled(ctx, t);
  ctx.ok('Gmail really was slow', ctx.gmail.calls({ method: 'users.messages.send', mailbox: t.mailbox })[0].durationMs >= 3500, {});
}
