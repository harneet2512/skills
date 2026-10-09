import { installTenant, settled, okPosts, llmCallsFor, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'per-tenant draft budget: over the cap, a plain notice instead of an LLM call',
  journey: 'J2.flood UJ step 2 when a workspace receives a burst of mail (or is being mail-bombed)',
  concerns: ['COST-13', 'COST-04', 'TEN-09'],
};

const BUDGET = 12; // DRAFT_BUDGET_PER_WINDOW in live-verify.json
const OVER = 3;

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.step(`${BUDGET + OVER} emails in one push`);
  for (let i = 0; i < BUDGET + OVER; i++) ctx.gmail.deliverEmail(t.mailbox, { from: `Sender ${i} <s${i}@customer.test>`, subject: `Burst ${i}`, body: `Burst mail BUDGET-${i}` });
  await ctx.gmail.pushToApp(`${ctx.app.url}/gmail/push`, ctx.gmail.pushPayload(t.mailbox));
  await ctx.waitFor(() => okPosts(ctx, t).length === BUDGET + 1, 20000, 'drafts and one notice posted');
  await settled(ctx, t, 20000);
  ctx.expect('no further posts for the other emails over budget', okPosts(ctx, t).length, BUDGET + 1);
  ctx.expect('drafts stop at the budget', ctx.db.get('SELECT count(*) AS n FROM suggestions WHERE team_id = ?', t.teamId).n, BUDGET);
  if (ctx.llmMode === 'stub') ctx.expect('LLM calls stop at the budget', llmCallsFor(ctx, 'BUDGET-').length, BUDGET);
  const notices = okPosts(ctx, t).filter((p) => !JSON.stringify(p.args.blocks).includes('send_option'));
  ctx.expect(`one plain notice for ${OVER} emails over budget`, notices.length, 1);
  ctx.ok('notice says the draft limit was reached', notices[0].args.text.includes('limit'), { text: notices[0].args.text });
  ctx.expect('every refused email recorded with the reason', (await outcomes(ctx, t)).filter((o) => o.detail === 'budget_exceeded').length, OVER);
}
