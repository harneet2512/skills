import { installTenant, receiveEmail, waitPosted, slackEvent } from './_fixtures.mjs';

export const meta = {
  name: 'tokens_revoked for user tokens only keeps the workspace connected',
  journey: 'J7.partial-revoke A member revokes their own user token; the bot keeps working for the workspace',
  concerns: ['TEN-14', 'UJ-12'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.step('tokens_revoked with only user (oauth) tokens');
  const r = await slackEvent(ctx, t, { type: 'tokens_revoked', tokens: { oauth: [t.userId] } });
  ctx.expect('acknowledged', r.status, 200);
  ctx.expect('tenant still active', ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', t.teamId).status, 'active');
  const email = await receiveEmail(ctx, t, { body: 'Still connected USERREV-1' });
  await waitPosted(ctx, t, email.id);

  ctx.step('tokens_revoked naming the bot token');
  await slackEvent(ctx, t, { type: 'tokens_revoked', tokens: { bot: ['UBOT0001'] } });
  ctx.expect('tenant disconnected', ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', t.teamId).status, 'disconnected');
}
