import { installTenant, receiveEmail, waitPosted, click } from './_fixtures.mjs';

export const meta = {
  name: 'Edit click is acked under 3 s while views.open is slow',
  journey: 'UJ step 3b while the Slack API answers views.open slowly',
  concerns: ['LAT-02', 'LAT-03', 'UJ-05'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.slack.faults.inject('views.open', { kind: 'slowResponse', delayMs: 3300, where: (c) => c.team === t.teamId });
  ctx.step('user clicks Edit; views.open answers after 3.3 s');
  const ack = await click(ctx, t, s, 'edit', s.id);
  ctx.ok('click acked under 1 s', ack.status === 200 && ack.ms < 1000, { ms: ack.ms });
  await ctx.waitFor(() => ctx.slack.calls({ method: 'views.open', team: t.teamId })[0], 10000, 'views.open answered');
  ctx.expect('modal opened', ctx.slack.views(t.teamId).length, 1);
}
