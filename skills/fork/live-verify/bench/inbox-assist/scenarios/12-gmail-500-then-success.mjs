import { installTenant, receiveEmail, waitPosted, sendOption, settled, sendCalls } from './_fixtures.mjs';

export const meta = {
  name: 'Gmail 500 on send, then success: one email',
  journey: 'J3.slow-gmail UJ step 3 with a transient Gmail failure',
  concerns: ['REL-03', 'REL-07', 'CONC-11'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.gmail.faults.inject('users.messages.send', { kind: 'status', status: 500, where: (c) => c.mailbox === t.mailbox });
  await sendOption(ctx, t, s, 2);
  await ctx.waitFor(() => ctx.db.get('SELECT status FROM suggestions WHERE id = ?', s.id).status === 'sent', 15000, 'suggestion sent');
  await settled(ctx, t);
  const calls = sendCalls(ctx, t);
  ctx.expect('two send calls: the 500, then the success', calls.map((c) => c.outcome), ['status:500', 'ok']);
  ctx.expect('one email sent', ctx.gmail.sent(t.mailbox).length, 1);
  ctx.ok('retry looked for the earlier attempt before resending', ctx.gmail.calls({ method: 'users.threads.get', mailbox: t.mailbox }).some((c) => c.seq > calls[0].seq && c.seq < calls[1].seq), {});
}
