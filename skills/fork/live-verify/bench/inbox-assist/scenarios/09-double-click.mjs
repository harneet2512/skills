import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'double click across instances sends once',
  journey: 'UJ step 3 twice: the same user double-clicks Send, each click hits a different instance',
  concerns: ['CONC-03', 'CONC-09', 'UJ-06'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.step('two identical clicks at the same moment');
  const acks = await Promise.all(ctx.apps.concat(ctx.apps).slice(0, 2).map((app) => sendOption(ctx, t, s, 1, { app })));
  ctx.expect('both clicks acknowledged', acks.map((a) => a.status), [200, 200]);
  await ctx.waitFor(() => ctx.gmail.sent(t.mailbox).length === 1, 10000, 'reply sent');
  const eph = await ctx.waitFor(() => ctx.slack.ephemerals(t.teamId)[0], 5000, 'ephemeral for the second click');
  ctx.expect('second click is told it was already sent', eph.text, `Already sent by <@${t.userId}>.`);
  await settled(ctx, t);
  ctx.expect('exactly one email sent', ctx.gmail.sent(t.mailbox).length, 1);
  ctx.expect('exactly one Gmail send call', ctx.gmail.calls({ method: 'users.messages.send', mailbox: t.mailbox }).length, 1);
}
