import { installTenant, admin, slackEvent, receiveEmail, waitPosted } from './_fixtures.mjs';

export const meta = {
  name: 'a mailbox freed by an uninstall can be connected again; an active one cannot',
  journey: 'Onboarding: a company moves its support mailbox to a new Slack workspace',
  concerns: ['TEN-11', 'DI-05', 'UJ-01'],
};

export default async function (ctx) {
  const a = await installTenant(ctx);
  ctx.step('workspace A uninstalls');
  await slackEvent(ctx, a, { type: 'app_uninstalled' });
  await ctx.waitFor(() => ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', a.teamId)?.status !== 'active', 5000, 'A disconnected');

  ctx.step('workspace B connects the same mailbox with a new Google grant');
  const b = { teamId: ctx.uid('T'), userId: ctx.uid('U'), botToken: `xoxb-${ctx.uid()}`, gmailToken: `ya29.${ctx.uid()}`, mailbox: a.mailbox };
  b.dm = `D${b.userId.slice(1)}`;
  ctx.slack.addWorkspace({ teamId: b.teamId, botToken: b.botToken });
  ctx.gmail.grant(a.mailbox, b.gmailToken);
  const res = await admin(ctx, 'POST', '/admin/installations', { teamId: b.teamId, slackUserId: b.userId, botToken: b.botToken, mailbox: b.mailbox, gmailToken: b.gmailToken });
  ctx.expect('reconnect accepted', res.status, 201);
  const email = await receiveEmail(ctx, b, { body: 'Mail after the move MOVE-1' });
  const { s } = await waitPosted(ctx, b, email.id);
  ctx.expect('mail goes to the new workspace', s.team_id, b.teamId);

  ctx.step('workspace C tries to connect the mailbox B is using');
  const cTeam = ctx.uid('T');
  const cBot = `xoxb-${ctx.uid()}`;
  const cGmail = `ya29.${ctx.uid()}`;
  ctx.slack.addWorkspace({ teamId: cTeam, botToken: cBot });
  ctx.gmail.grant(a.mailbox, cGmail);
  const conflict = await admin(ctx, 'POST', '/admin/installations', { teamId: cTeam, slackUserId: ctx.uid('U'), botToken: cBot, mailbox: a.mailbox, gmailToken: cGmail });
  ctx.expect('active mailbox conflict is a 409, not a 500', conflict.status, 409);
  ctx.expect('B still owns the mailbox', ctx.db.all("SELECT team_id FROM tenants WHERE mailbox = ? AND status = 'active'", a.mailbox).map((r) => r.team_id), [b.teamId]);
}
