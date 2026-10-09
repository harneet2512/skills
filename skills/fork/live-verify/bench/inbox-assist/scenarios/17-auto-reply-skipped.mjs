import { installTenant, receiveEmail, settled, okPosts, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'auto-replies, noreply and bulk mail are skipped',
  journey: 'UJ step 2 for machine mail: no drafts, no DMs, no model spend',
  concerns: ['UJ-12', 'COST-13', 'COST-03'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const llmBefore = ctx.llm.calls({ method: 'messages' }).length;
  const cases = [
    [{ subject: 'Out of office', headers: { 'Auto-Submitted': 'auto-replied' } }, 'auto_submitted'],
    [{ from: 'Shop <no-reply@shop.test>', subject: 'Your receipt' }, 'noreply'],
    [{ from: 'News <news@list.test>', subject: 'Weekly digest', headers: { 'List-Unsubscribe': '<mailto:unsub@list.test>' } }, 'bulk'],
    [{ from: 'Bot <bot@x.test>', subject: 'Notice', headers: { Precedence: 'bulk' } }, 'bulk'],
    [{ from: 'Away <a@x.test>', subject: 'Away', headers: { 'X-Autoreply': 'yes' } }, 'auto_reply'],
  ];
  const ids = [];
  for (const [email] of cases) ids.push((await receiveEmail(ctx, t, email)).id);
  await ctx.waitFor(() => ctx.db.get("SELECT count(*) AS n FROM outcomes WHERE team_id = ? AND outcome = 'skipped'", t.teamId).n === cases.length, 10000, 'all skipped');
  await settled(ctx, t);
  const rows = await outcomes(ctx, t);
  ctx.expect('each skipped for the right reason', ids.map((id) => rows.find((r) => r.gmail_message_id === id)?.detail), cases.map(([, reason]) => reason));
  ctx.expect('no Slack posts', okPosts(ctx, t).length, 0);
  ctx.expect('no LLM calls', ctx.llm.calls({ method: 'messages' }).length, llmBefore);
}
