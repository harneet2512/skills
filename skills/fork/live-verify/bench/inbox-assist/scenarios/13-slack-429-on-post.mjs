import { installTenant, receiveEmail, waitPosted, settled, okPosts } from './_fixtures.mjs';

export const meta = {
  name: 'Slack 429 on post: retried after Retry-After, posted once',
  journey: 'UJ step 2 while Slack rate limits the workspace',
  concerns: ['REL-05', 'LAT-09', 'REL-03'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.slack.faults.inject('chat.postMessage', { kind: 'status', status: 429, retryAfter: 1, where: (c) => c.team === t.teamId });
  const email = await receiveEmail(ctx, t);
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  const calls = ctx.slack.calls({ method: 'chat.postMessage', team: t.teamId });
  ctx.expect('first post rate limited, second succeeded', calls.map((c) => c.outcome), ['status:429', 'ok']);
  const gap = calls[1].startedAt - calls[0].startedAt;
  ctx.ok('retry waited at least Retry-After (1 s)', gap >= 1000, { gapMs: gap });
  ctx.expect('posted exactly once', okPosts(ctx, t).length, 1);
}
