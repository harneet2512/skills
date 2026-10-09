import { installTenant, receiveEmail, waitPosted, click, sendOption, settled, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'dismiss, then a stale Send click does nothing',
  journey: 'UJ step 3c: user dismisses; an old copy of the message is clicked later',
  concerns: ['CONC-09', 'UJ-08', 'UJ-11'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);

  ctx.step('user clicks Dismiss');
  await click(ctx, t, s, 'dismiss', s.id);
  const update = await ctx.waitFor(() => ctx.slack.calls({ method: 'chat.update', team: t.teamId, outcome: 'ok' })[0], 10000, 'chat.update');
  ctx.expect('Slack shows who dismissed', update.args.text, `Dismissed by <@${t.userId}>`);
  ctx.expect('state is dismissed', ctx.db.get('SELECT status FROM suggestions WHERE id = ?', s.id).status, 'dismissed');

  ctx.step('a stale copy of the message is clicked: Send option 1');
  await sendOption(ctx, t, s, 1, { app: ctx.apps[1 % ctx.apps.length] });
  const eph = await ctx.waitFor(() => ctx.slack.ephemerals(t.teamId)[0], 5000, 'ephemeral');
  ctx.expect('user is told it was already dismissed', eph.text, `Already dismissed by <@${t.userId}>.`);
  await settled(ctx, t);
  ctx.expect('no email sent', ctx.gmail.sent(t.mailbox).length, 0);
  ctx.expect('outcome recorded as dismissed', (await outcomes(ctx, t)).map((o) => o.outcome), ['dismissed']);
}
