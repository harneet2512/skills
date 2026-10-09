import { installTenant, receiveEmail, settled, okPosts, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'suggestion post that dies falls back to a plain notice and is recorded',
  journey: 'UJ step 2 when Slack keeps rejecting the suggestion message',
  concerns: ['REL-14', 'OPS-08', 'UJ-06'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.slack.faults.inject('chat.postMessage', {
    kind: 'status', status: 200, body: { ok: false, error: 'invalid_blocks' }, times: Infinity,
    where: (c) => c.team === t.teamId && JSON.stringify(c.args.blocks ?? []).includes('send_option_1'),
  });
  const email = await receiveEmail(ctx, t, { body: 'Dead post check DEADPOST-1' });
  const notice = await ctx.waitFor(() => okPosts(ctx, t)[0], 10000, 'fallback posted');
  await settled(ctx, t);
  ctx.ok('user told to open the email in Gmail', notice.args.text.includes('Gmail'), { text: notice.args.text });
  ctx.expect('suggestion is not left as drafted', ctx.db.get('SELECT status FROM suggestions WHERE team_id = ? AND gmail_message_id = ?', t.teamId, email.id).status, 'failed');
  ctx.expect('outcome records the failed post', (await outcomes(ctx, t)).map((o) => [o.outcome, o.detail]), [['draft_failed', 'post_failed']]);
}
