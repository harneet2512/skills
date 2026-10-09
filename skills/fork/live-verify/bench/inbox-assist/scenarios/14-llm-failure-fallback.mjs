import { installTenant, receiveEmail, settled, okPosts, llmCallsFor, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'LLM down or invalid output: fallback message, no drafts',
  journey: 'J2.llm-down UJ step 2 when drafting fails: user still learns about the email',
  concerns: ['AI-08', 'AI-11', 'REL-14', 'COST-04'],
};

export default async function (ctx) {
  if (ctx.llmMode !== 'stub') return ctx.ok('skipped: needs the stand-in LLM', true, {});
  const t = await installTenant(ctx);

  ctx.step('provider returns 500 on every call');
  ctx.llm.faults.inject('messages', { kind: 'status', status: 500, times: Infinity, where: (c) => c.request.prompt.includes('LLMDOWN-1') });
  await receiveEmail(ctx, t, { subject: 'Provider down', body: 'LLMDOWN-1 please help' });
  const fallback = await ctx.waitFor(() => okPosts(ctx, t)[0], 10000, 'fallback posted');
  ctx.expect('fallback text', fallback.args.text, "Couldn't draft replies, open in Gmail");
  ctx.ok('fallback has no send buttons', !JSON.stringify(fallback.args.blocks).includes('send_option'), {});
  await settled(ctx, t);
  ctx.expect('LLM attempts bounded (2)', llmCallsFor(ctx, 'LLMDOWN-1').length, 2);

  ctx.step('provider returns only 2 options (schema violation)');
  ctx.llm.script({ name: 'two-options', when: (r) => r.prompt.includes('BADSHAPE-2'), reply: JSON.stringify({ options: ['one', 'two'] }) });
  await receiveEmail(ctx, t, { subject: 'Bad shape', body: 'BADSHAPE-2 hello' });
  await ctx.waitFor(() => okPosts(ctx, t).length === 2, 10000, 'second fallback posted');
  await settled(ctx, t);
  ctx.expect('invalid output is not retried', llmCallsFor(ctx, 'BADSHAPE-2').length, 1);
  ctx.expect('second post is also the fallback', okPosts(ctx, t)[1].args.text, "Couldn't draft replies, open in Gmail");
  ctx.expect('no suggestions created', ctx.db.get('SELECT count(*) AS n FROM suggestions WHERE team_id = ?', t.teamId).n, 0);
  ctx.expect('outcomes say draft_failed', (await outcomes(ctx, t)).map((o) => o.outcome), ['draft_failed', 'draft_failed']);
}
