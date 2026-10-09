import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'forged Slack signature and bad push token are rejected',
  journey: 'J3.hostile-forged J7.hostile-forged Attack: someone posts fake clicks, events and pushes to the public endpoints',
  concerns: ['SEC-01', 'SEC-03'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);

  ctx.step('click signed with the wrong secret');
  const forged = await sendOption(ctx, t, s, 1, { secret: 'not-the-signing-secret' });
  ctx.expect('forged click -> 401', forged.status, 401);
  ctx.step('click with a garbage signature');
  const garbage = await sendOption(ctx, t, s, 1, { signature: 'v0=deadbeef' });
  ctx.expect('garbage signature -> 401', garbage.status, 401);
  ctx.step('event signed with the wrong secret');
  const ev = await ctx.slack.platform.event(`${ctx.app.url}/slack/events`, { teamId: t.teamId, event: { type: 'app_uninstalled' }, secret: 'wrong' });
  ctx.expect('forged event -> 401', ev.status, 401);
  ctx.step('signed body tampered in transit');
  const ts = Math.floor(Date.now() / 1000);
  const body = 'payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', team: { id: t.teamId }, user: { id: 'UEVIL' }, actions: [{ action_id: 'send_option_1', value: `${s.id}:0` }] }));
  const sig = ctx.slack.platform.sign(body, ts);
  const tampered = await fetch(`${ctx.app.url}/slack/interactions`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig }, body: body.replace('UEVIL', 'UEVI1') });
  ctx.expect('tampered body -> 401', tampered.status, 401);
  ctx.step('push with a bad bearer token, and with none');
  const badPush = await ctx.gmail.pushToApp(`${ctx.app.url}/gmail/push`, ctx.gmail.pushPayload(t.mailbox), { token: 'forged' });
  ctx.expect('bad push token -> 401', badPush.status, 401);
  const noAuth = await fetch(`${ctx.app.url}/gmail/push`, { method: 'POST', body: JSON.stringify(ctx.gmail.pushPayload(t.mailbox)) });
  ctx.expect('missing push token -> 401', noAuth.status, 401);

  await settled(ctx, t);
  ctx.expect('no email sent', ctx.gmail.sent(t.mailbox).length, 0);
  ctx.expect('suggestion untouched', ctx.db.get('SELECT status FROM suggestions WHERE id = ?', s.id).status, 'posted');
  ctx.expect('tenant still active', ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', t.teamId).status, 'active');
  ctx.ok('rejections logged', ctx.logs((l) => l.event === 'security.slack_signature_rejected' && l.reason === 'bad_signature').length >= 4, {});
}
