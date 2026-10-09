import { installTenant, receiveEmail, waitPosted, settled } from './_fixtures.mjs';

export const meta = {
  name: 'Slack post times out after success: one DM, not two',
  journey: 'UJ step 2 when chat.postMessage succeeds but the response is lost',
  concerns: ['REL-07', 'CONC-11', 'UJ-06'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.slack.faults.inject('chat.postMessage', { kind: 'timeoutAfterSuccess', where: (c) => c.team === t.teamId });
  const email = await receiveEmail(ctx, t, { body: 'Lost response check SLKTAS-1' });
  const { s } = await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  const posts = ctx.slack.calls({ method: 'chat.postMessage', team: t.teamId });
  ctx.expect('first post reached Slack but the answer was lost', posts[0].outcome, 'timeoutAfterSuccess');
  const dm = ctx.slack.messages(t.teamId, t.dm);
  ctx.expect('exactly one message in the DM', dm.length, 1);
  ctx.expect('suggestion points at that message', s.slack_ts, dm[0].ts);
}
