import { installTenant, receiveEmail, waitPosted, settled, slackEvent, admin } from './_fixtures.mjs';

export const meta = {
  name: 'uninstall stops the Gmail watch, revokes Google access and deletes the data after the grace period',
  journey: 'UJ last step: workspace admin uninstalls; customer data does not outlive the contract',
  concerns: ['TEN-11', 'COMP-02', 'SEC-10'],
};

const TENANT_TABLES = ['emails', 'suggestions', 'outcomes', 'slack_events'];
const counts = (ctx, teamId) => Object.fromEntries(TENANT_TABLES.map((tbl) => [tbl, ctx.db.get(`SELECT count(*) AS n FROM ${tbl} WHERE team_id = ?`, teamId).n]));

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t, { body: 'Data that must be deleted OFFB-1' });
  await waitPosted(ctx, t, email.id);
  await settled(ctx, t);

  ctx.step('app_uninstalled');
  const uninstalledAt = Date.now();
  await slackEvent(ctx, t, { type: 'app_uninstalled' });
  const stop = await ctx.waitFor(() => ctx.gmail.calls({ method: 'users.stop', mailbox: t.mailbox, outcome: 'ok' })[0], 10000, 'users.stop');
  ctx.expect('Gmail watch stopped', stop.status, 204);
  await ctx.waitFor(() => ctx.gmail.isRevoked(t.gmailToken), 10000, 'Google token revoked');
  ctx.ok('Google token revoked through the OAuth revoke endpoint', ctx.gmail.calls({ method: 'oauth.revoke', outcome: 'ok' }).some((c) => c.mailbox === t.mailbox), {});
  await ctx.waitFor(() => ctx.db.get('SELECT gmail_token_enc FROM tenants WHERE team_id = ?', t.teamId)?.gmail_token_enc === '', 10000, 'tokens dropped');

  ctx.step('after the grace period the tenant data is deleted and the deletion recorded');
  await ctx.waitFor(() => !ctx.db.get('SELECT 1 AS x FROM tenants WHERE team_id = ?', t.teamId), 15000, 'tenant purged');
  ctx.expect('no rows left in tenant tables', counts(ctx, t.teamId), Object.fromEntries(TENANT_TABLES.map((tbl) => [tbl, 0])));
  ctx.expect('only the purge job row remains', ctx.db.all('SELECT kind FROM jobs WHERE team_id = ?', t.teamId).map((r) => r.kind), ['purge_tenant']);
  const cert = ctx.db.get('SELECT * FROM tenant_deletions WHERE team_id = ?', t.teamId);
  ctx.ok('deletion recorded with counts', cert && JSON.parse(cert.deleted_rows).suggestions === 1, { cert });
  ctx.ok('purge waited for the grace period', cert.deleted_at - uninstalledAt >= 1000, { waitedMs: cert.deleted_at - uninstalledAt });
  ctx.expect('outcomes for the tenant are gone', (await admin(ctx, 'GET', `/admin/outcomes?team=${t.teamId}`)).json.outcomes, []);

  ctx.step('a workspace that reinstalls inside the grace period keeps its data');
  const r = await installTenant(ctx);
  const e2 = await receiveEmail(ctx, r, { body: 'Keep me OFFB-2' });
  await waitPosted(ctx, r, e2.id);
  await slackEvent(ctx, r, { type: 'app_uninstalled' });
  await ctx.waitFor(() => ctx.gmail.isRevoked(r.gmailToken), 10000, 'second tenant token revoked');
  const fresh = `ya29.${ctx.uid()}`;
  ctx.gmail.grant(r.mailbox, fresh);
  const again = await admin(ctx, 'POST', '/admin/installations', { teamId: r.teamId, slackUserId: r.userId, botToken: r.botToken, mailbox: r.mailbox, gmailToken: fresh });
  ctx.expect('reinstall accepted', again.status, 201);
  await settled(ctx, r, 15000);
  ctx.expect('tenant active with its suggestion', [ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', r.teamId)?.status, counts(ctx, r.teamId).suggestions], ['active', 1]);
  ctx.ok('new Google token not revoked', !ctx.gmail.isRevoked(fresh), {});
}
