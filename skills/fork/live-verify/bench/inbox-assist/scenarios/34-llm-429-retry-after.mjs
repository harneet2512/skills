import { installTenant, receiveEmail, waitPosted, settled, llmCallsFor } from './_fixtures.mjs';

export const meta = {
  name: 'LLM 429 with Retry-After: the draft waits as told, then succeeds',
  journey: 'UJ step 2 while the model provider rate limits us',
  concerns: ['AI-11', 'REL-05', 'COST-08'],
};

export default async function (ctx) {
  if (ctx.llmMode !== 'stub') return ctx.ok('skipped: needs the stand-in LLM', true, {});
  const t = await installTenant(ctx);
  ctx.llm.faults.inject('messages', { kind: 'status', status: 429, retryAfter: 2, where: (c) => c.request.prompt.includes('RATE-429') });
  const email = await receiveEmail(ctx, t, { body: 'Rate limit check RATE-429' });
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  const calls = llmCallsFor(ctx, 'RATE-429');
  ctx.expect('first call rate limited, second succeeded', calls.map((c) => c.outcome), ['status:429', 'ok']);
  const gap = calls[1].startedAt - calls[0].startedAt;
  ctx.ok('retry waited at least Retry-After (2 s)', gap >= 2000, { gapMs: gap });
}
