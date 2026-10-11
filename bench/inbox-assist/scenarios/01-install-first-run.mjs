import { installTenant, admin, receiveEmail, waitPosted, settled, okPosts } from './_fixtures.mjs';

export const meta = {
  name: 'install and first run do not flood old mail',
  journey: 'J1.first-and-empty UJ step 1: admin installs, connects a mailbox that already has mail',
  concerns: ['UJ-02', 'UJ-03', 'CONC-14', 'COST-03'],
};

export default async function (ctx) {
  ctx.step('install with a token for the wrong mailbox is refused');
  const bad = await admin(ctx, 'POST', '/admin/installations', { teamId: 'TBAD', slackUserId: 'UBAD', botToken: 'xoxb-unknown', mailbox: 'x@acme.test', gmailToken: 'nope' });
  ctx.expect('install with unverifiable tokens is rejected', bad.status, 400);

  ctx.step('install a tenant whose mailbox already has 8 messages');
  const t = await installTenant(ctx, { oldEmails: 8 });
  const tenant = ctx.db.get('SELECT last_history_id FROM tenants WHERE team_id = ?', t.teamId);
  ctx.expect('history starts at the mailbox position at install', tenant.last_history_id, ctx.gmail.mailbox(t.mailbox).historyId);

  ctx.step('a push for history from before install is ignored');
  const old = await ctx.gmail.pushToApp(`${ctx.app.url}/gmail/push`, ctx.gmail.pushPayload(t.mailbox));
  ctx.expect('stale push acknowledged', old.status, 204);

  ctx.step('the first new email after install is drafted, and only it');
  const email = await receiveEmail(ctx, t);
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  ctx.expect('exactly one Slack post (no flood of 8 old emails)', okPosts(ctx, t).length, 1);
  ctx.expect('exactly one email recorded for drafting', ctx.db.get('SELECT count(*) AS n FROM emails WHERE team_id = ?', t.teamId).n, 1);
}
