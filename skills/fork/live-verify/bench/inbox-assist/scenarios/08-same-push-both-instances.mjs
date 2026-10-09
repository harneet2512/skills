import { installTenant, receiveEmail, waitPosted, settled, okPosts, llmCallsFor } from './_fixtures.mjs';

export const meta = {
  name: 'same push to both instances at once drafts once',
  journey: 'J2.twice UJ step 2 across instances: two replicas receive the same push concurrently',
  concerns: ['CONC-04', 'CONC-05', 'CONC-10', 'CONC-12'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.gmail.faults.inject('push', { kind: 'duplicate', copies: 2, concurrent: true, where: (c) => c.mailbox === t.mailbox });
  const email = await receiveEmail(ctx, t, { body: 'Concurrent push CONC-5512' }, { apps: ctx.apps });
  ctx.expect('both instances acknowledged', email.ack.results.map((r) => r.status), [204, 204]);
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  ctx.expect('one Slack post', okPosts(ctx, t).length, 1);
  ctx.expect('one suggestion row', ctx.db.get('SELECT count(*) AS n FROM suggestions WHERE team_id = ?', t.teamId).n, 1);
  if (ctx.llmMode === 'stub') ctx.expect('one LLM call', llmCallsFor(ctx, 'CONC-5512').length, 1);
}
