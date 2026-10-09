import { installTenant, SENDER, waitPosted, settled } from './_fixtures.mjs';

export const meta = {
  name: 'long thread is truncated to the token budget, newest kept',
  journey: 'J2.long-thread UJ step 2 on a 12-message thread with long bodies',
  concerns: ['AI-09', 'AI-10', 'COST-01'],
};

const BUDGET = 3000;

export default async function (ctx) {
  let prev = null;
  // 11 long messages already in the thread before install; the 12th arrives after.
  const t = await installTenant(ctx, {
    seed: (mailbox) => {
      for (let i = 1; i <= 11; i++) {
        const marker = i === 1 ? 'OLDEST-MARKER' : `MIDDLE-${i}`;
        prev = ctx.gmail.deliverEmail(mailbox, { from: SENDER, subject: 'Long running issue', inReplyTo: prev?.messageId, body: `${marker} ${'The kettle still leaks after the third repair. '.repeat(60)}` });
      }
    },
  });
  const last = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'Re: Long running issue', inReplyTo: prev.messageId, body: `NEWEST-MARKER ${'Still leaking today. '.repeat(150)}` });
  ctx.step('one push for the whole thread');
  await ctx.gmail.pushToApp(`${ctx.app.url}/gmail/push`, last.push);
  await waitPosted(ctx, t, last.id);
  await settled(ctx, t);
  if (ctx.llmMode !== 'stub') return ctx.ok('prompt inspection needs the stand-in LLM', true, {});
  const call = ctx.llm.calls({ method: 'messages' }).find((c) => c.request.prompt.includes('NEWEST-MARKER'));
  ctx.ok('newest message included', Boolean(call), {});
  ctx.ok('oldest message dropped', !call.request.prompt.includes('OLDEST-MARKER'), {});
  // The budget covers the thread; the system prompt is a fixed cost measured from the request itself.
  const overhead = Math.ceil(call.request.system.length / 4) + 400; // + tags, company notes, closing line
  ctx.ok(`input within budget (${BUDGET} + ${overhead} tokens overhead)`, call.inputTokens <= BUDGET + overhead, { inputTokens: call.inputTokens });
  ctx.ok('thread was long enough to need truncation', ctx.gmail.mailbox(t.mailbox).threads.get(last.threadId).length === 12, {});
  ctx.expect('only the new message is drafted', ctx.db.get('SELECT count(*) AS n FROM emails WHERE team_id = ?', t.teamId).n, 1);
}
