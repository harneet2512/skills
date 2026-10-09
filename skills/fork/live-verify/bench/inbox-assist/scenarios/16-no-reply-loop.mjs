import { installTenant, receiveEmail, waitPosted, sendOption, settled, okPosts, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'our own sent reply comes back through history: no loop',
  journey: 'UJ step 4: after sending, Gmail reports our reply as a new message',
  concerns: ['COST-03', 'UJ-12', 'CONC-04'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  await sendOption(ctx, t, s, 1);
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  await settled(ctx, t);
  const llmBefore = ctx.llm.calls({ method: 'messages' }).length;

  ctx.step('Pub/Sub pushes the history entry for our own reply');
  await ctx.gmail.pushToApp(`${ctx.app.url}/gmail/push`, ctx.gmail.pushPayload(t.mailbox));
  ctx.step('the user also mails the support address from itself (forwarded note)');
  const self = await receiveEmail(ctx, t, { from: `Support <${t.mailbox}>`, subject: 'note to self', body: 'reminder' });
  await ctx.waitFor(() => ctx.db.get('SELECT count(*) AS n FROM outcomes WHERE team_id = ? AND outcome = ?', t.teamId, 'skipped').n === 2, 10000, 'both skipped');
  await settled(ctx, t);
  ctx.expect('still one Slack post', okPosts(ctx, t).length, 1);
  ctx.expect('no new LLM call', ctx.llm.calls({ method: 'messages' }).length, llmBefore);
  const rows = await outcomes(ctx, t);
  ctx.expect('skip reasons recorded', rows.filter((r) => r.outcome === 'skipped').map((r) => [r.gmail_message_id, r.detail]).sort(), [[sent.id, 'own_message'], [self.id, 'own_mailbox']].sort());
}
