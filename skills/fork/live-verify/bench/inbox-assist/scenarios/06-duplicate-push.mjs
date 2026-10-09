import { installTenant, receiveEmail, waitPosted, settled, okPosts, llmCallsFor } from './_fixtures.mjs';

export const meta = {
  name: 'duplicate Pub/Sub push drafts once',
  journey: 'J2.twice UJ step 2 under redelivery: Pub/Sub delivers the same push twice',
  concerns: ['CONC-04', 'SEC-04', 'REL-08', 'UJ-06'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.gmail.faults.inject('push', { kind: 'duplicate', copies: 3, where: (c) => c.mailbox === t.mailbox });
  ctx.step('one email, its push delivered 3 times');
  const email = await receiveEmail(ctx, t, { body: 'Duplicate push check DUP-7731' });
  ctx.ok('every copy acknowledged', email.ack.results.every((r) => r.status === 204), { statuses: email.ack.results.map((r) => r.status) });
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  ctx.expect('one Slack post', okPosts(ctx, t).length, 1);
  if (ctx.llmMode === 'stub') ctx.expect('one LLM call', llmCallsFor(ctx, 'DUP-7731').length, 1);
}
