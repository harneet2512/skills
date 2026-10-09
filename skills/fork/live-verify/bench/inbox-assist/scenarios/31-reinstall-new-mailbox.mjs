import { admin, receiveEmail, waitPosted } from './_fixtures.mjs';

export const meta = {
  name: 'reinstall with a different mailbox starts from that mailbox history',
  journey: 'Onboarding: a workspace reconnects with another support mailbox',
  concerns: ['TEN-01', 'DI-12', 'CONC-14'],
};

export default async function (ctx) {
  const t = { teamId: ctx.uid('T'), userId: ctx.uid('U'), botToken: `xoxb-${ctx.uid()}` };
  t.dm = `D${t.userId.slice(1)}`;
  ctx.slack.addWorkspace({ teamId: t.teamId, botToken: t.botToken });
  const old = { mailbox: `old-${t.teamId.toLowerCase()}@acme.test`, token: `ya29.${ctx.uid()}` };
  const neu = { mailbox: `new-${t.teamId.toLowerCase()}@acme.test`, token: `ya29.${ctx.uid()}` };
  ctx.gmail.addMailbox({ address: old.mailbox, token: old.token, startHistoryId: 90000 });
  ctx.gmail.addMailbox({ address: neu.mailbox, token: neu.token, startHistoryId: 1000 });
  const install = (m) => admin(ctx, 'POST', '/admin/installations', { teamId: t.teamId, slackUserId: t.userId, botToken: t.botToken, mailbox: m.mailbox, gmailToken: m.token });

  ctx.step('install with the old mailbox (history id 90000), then reinstall with the new one (1000)');
  ctx.expect('first install', (await install(old)).status, 201);
  ctx.expect('reinstall', (await install(neu)).status, 201);
  ctx.expect('history id is the new mailbox position', ctx.db.get('SELECT mailbox, last_history_id AS h FROM tenants WHERE team_id = ?', t.teamId), { mailbox: neu.mailbox, h: 1000 });

  ctx.step('mail arrives in the new mailbox');
  const email = await receiveEmail(ctx, { ...t, mailbox: neu.mailbox }, { body: 'New mailbox mail NEWBOX-1' });
  await waitPosted(ctx, t, email.id);
  ctx.ok('push not treated as stale', ctx.logs((l) => l.event === 'push.stale' && l.team === t.teamId).length === 0, {});
}
