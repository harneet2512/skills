import { admin } from './_fixtures.mjs';

export const meta = {
  name: 'SIGTERM lets an in-flight request finish before exit',
  journey: 'Deploy: an instance is told to stop while an installation is being completed',
  concerns: ['REL-11', 'OPS-05'],
};

export default async function (ctx) {
  const app = ctx.apps[ctx.apps.length - 1];
  const teamId = ctx.uid('T');
  const botToken = `xoxb-${ctx.uid()}`;
  const gmailToken = `ya29.${ctx.uid()}`;
  const mailbox = `support-${teamId.toLowerCase()}@acme.test`;
  ctx.slack.addWorkspace({ teamId, botToken });
  ctx.gmail.addMailbox({ address: mailbox, token: gmailToken });
  let inFlight = false;
  ctx.gmail.faults.inject('users.getProfile', { kind: 'delay', delayMs: 1500, where: (c) => c.mailbox === mailbox, onHit: () => { inFlight = true; } });

  ctx.step('installation request is in flight (Gmail profile is slow)');
  const pending = admin(ctx, 'POST', '/admin/installations', { teamId, slackUserId: ctx.uid('U'), botToken, mailbox, gmailToken }, app)
    .catch((err) => ({ error: err.cause?.code ?? err.message }));
  await ctx.waitFor(() => inFlight, 5000, 'install reached Gmail');

  ctx.step('SIGTERM');
  const exited = new Promise((resolve) => app.child.once('exit', (code, signal) => resolve({ code, signal })));
  app.child.kill('SIGTERM');
  const res = await pending;
  ctx.expect('in-flight request completed with its real answer', res.status, 201);
  ctx.expect('installation was written', ctx.db.get('SELECT status FROM tenants WHERE team_id = ?', teamId)?.status, 'active');
  ctx.expect('process exited cleanly', await exited, { code: 0, signal: null });
  ctx.ok('shutdown logged as drained', ctx.logs((l) => l.instance === app.id && l.event === 'server.stopped').length >= 1, {});
  await app.restart();
}
