import { installTenant, receiveEmail, waitPosted, settled } from './_fixtures.mjs';

export const meta = {
  name: 'team B cannot act on team A suggestion',
  journey: 'J3.hostile-tenant Attack: a user in workspace B crafts a click carrying workspace A suggestion id',
  concerns: ['TEN-03', 'TEN-02', 'SEC-02'],
};

export default async function (ctx) {
  const a = await installTenant(ctx);
  const b = await installTenant(ctx);
  const email = await receiveEmail(ctx, a);
  const { s } = await waitPosted(ctx, a, email.id);
  const url = `${ctx.app.url}/slack/interactions`;
  const asB = (actionId, value) => ctx.slack.platform.blockAction(url, { teamId: b.teamId, userId: b.userId, actionId, value, channel: b.dm, messageTs: '1.000001' });

  ctx.step('signed request from team B: send, edit, dismiss on team A suggestion');
  for (const [action, value] of [['send_option_1', `${s.id}:0`], ['edit', s.id], ['dismiss', s.id]]) {
    const r = await asB(action, value);
    ctx.expect(`${action} acknowledged without effect`, r.status, 200);
  }
  ctx.step('signed modal submission from team B naming team A suggestion');
  const view = { id: 'VFAKE', callback_id: 'edit_reply', private_metadata: s.id, type: 'modal' };
  const sub = await ctx.slack.platform.viewSubmission(url, { teamId: b.teamId, userId: b.userId, view, values: { reply: { text: { value: 'pwned' } } } });
  ctx.expect('modal submission refused', sub.json?.response_action, 'errors');

  await settled(ctx, a);
  await settled(ctx, b);
  ctx.expect('no email sent from A', ctx.gmail.sent(a.mailbox).length, 0);
  ctx.expect('A suggestion untouched', ctx.db.get('SELECT status, acted_by FROM suggestions WHERE id = ?', s.id), { status: 'posted', acted_by: null });
  ctx.expect('no modal opened in either workspace', [ctx.slack.views(a.teamId).length, ctx.slack.views(b.teamId).length], [0, 0]);
  ctx.ok('nothing posted into workspace A for B', ctx.slack.ephemerals(a.teamId).length === 0, {});
  ctx.expect('B user told only "not available"', [...new Set(ctx.slack.ephemerals(b.teamId).map((e) => e.text))], ['This suggestion is not available.']);
  ctx.expect('each attempt logged as a security event', ctx.logs((l) => l.event === 'security.unknown_suggestion' && l.team === b.teamId).length, 4);
}
