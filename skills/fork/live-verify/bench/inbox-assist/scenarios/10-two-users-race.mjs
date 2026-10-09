import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'two users click different options on two instances: one send',
  journey: 'J3.two-actors UJ step 3 with two actors: Ana sends option 1 while Ben sends option 3',
  concerns: ['UJ-07', 'CONC-09', 'CONC-12'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  const options = JSON.parse(s.options_json);
  const ana = ctx.uid('U');
  const ben = ctx.uid('U');
  ctx.step('both click at the same moment, on different instances');
  await Promise.all([
    sendOption(ctx, t, s, 1, { userId: ana, app: ctx.apps[0] }),
    sendOption(ctx, t, s, 3, { userId: ben, app: ctx.apps[1 % ctx.apps.length] }),
  ]);
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  await settled(ctx, t);
  ctx.expect('exactly one email sent', ctx.gmail.sent(t.mailbox).length, 1);
  const row = ctx.db.get('SELECT status, acted_by FROM suggestions WHERE id = ?', s.id);
  const winner = row.acted_by;
  const loser = winner === ana ? ben : ana;
  ctx.ok('winner is one of the two users', [ana, ben].includes(winner), { winner });
  ctx.expect('sent text is the winner\'s option', sent.body.trim(), winner === ana ? options[0] : options[2]);
  const eph = ctx.slack.ephemerals(t.teamId);
  ctx.expect('loser alone is told who sent it', eph.map((e) => [e.user, e.text]), [[loser, `Already sent by <@${winner}>.`]]);
  const update = ctx.slack.calls({ method: 'chat.update', team: t.teamId, outcome: 'ok' });
  ctx.ok('Slack names the winner', update.length === 1 && update[0].args.text.startsWith(`Sent by <@${winner}>`), {});
}
