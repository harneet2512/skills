import { installTenant, receiveEmail, settled, okPosts } from './_fixtures.mjs';

export const meta = {
  name: 'uninstall event, redelivered by Slack, disconnects once',
  journey: 'UJ last step: workspace admin uninstalls; Slack retries the event',
  concerns: ['TEN-14', 'TEN-11', 'SEC-04', 'SEC-10'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const url = `${ctx.app.url}/slack/events`;
  ctx.step('Events API URL verification');
  const ch = await ctx.slack.platform.urlVerification(url);
  ctx.ok('challenge echoed', ch.status === 200 && typeof ch.json?.challenge === 'string', {});

  ctx.step('app_uninstalled, then the same event again with X-Slack-Retry-Num');
  const eventId = `Ev${ctx.uid()}`;
  const first = await ctx.slack.platform.event(url, { teamId: t.teamId, eventId, event: { type: 'app_uninstalled' } });
  const retry = await ctx.slack.platform.event(ctx.apps[1 % ctx.apps.length].url + '/slack/events', { teamId: t.teamId, eventId, event: { type: 'app_uninstalled' }, retryNum: 1 });
  ctx.expect('both acknowledged 200', [first.status, retry.status], [200, 200]);
  ctx.expect('event recorded once', ctx.db.get('SELECT count(*) AS n FROM slack_events WHERE event_id = ?', eventId).n, 1);
  ctx.ok('retry recognised as duplicate', ctx.logs((l) => l.event === 'slack.event_duplicate' && l.eventId === eventId).length === 1, {});
  ctx.expect('tenant disconnected and Slack token dropped at once', ctx.db.get('SELECT status, bot_token_enc FROM tenants WHERE team_id = ?', t.teamId), { status: 'disconnected', bot_token_enc: '' });
  await ctx.waitFor(() => ctx.db.get('SELECT gmail_token_enc FROM tenants WHERE team_id = ?', t.teamId)?.gmail_token_enc === '', 10000, 'Google token dropped after revocation');
  ctx.expect('one offboarding job despite the redelivery', ctx.db.get("SELECT count(*) AS n FROM jobs WHERE team_id = ? AND kind = 'offboard_tenant'", t.teamId).n, 1);

  ctx.step('mail keeps arriving after uninstall');
  const email = await receiveEmail(ctx, t);
  ctx.expect('push acknowledged (so Pub/Sub stops retrying)', email.ack.status, 204);
  await settled(ctx, t);
  ctx.expect('no Slack post for a disconnected tenant', okPosts(ctx, t).length, 0);
  ctx.ok('push logged as unknown mailbox', ctx.logs((l) => l.event === 'push.unknown_mailbox').length >= 1, {});
}
