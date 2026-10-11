import { installTenant, receiveEmail, waitPosted, settled, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'Gmail 200 with a truncated body is retried, not read as empty',
  journey: 'J2.truncated-body UJ step 2 when Gmail starts a 200 response and the body stops halfway',
  concerns: ['REL-07', 'REL-03', 'DI-03'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const cut = { kind: 'truncate', where: (c) => c.mailbox === t.mailbox };
  ctx.gmail.faults.inject('users.history.list', cut);
  ctx.gmail.faults.inject('users.messages.get', cut);

  ctx.step('history and message reads each lose half their body once');
  const email = await receiveEmail(ctx, t, { body: 'Truncated body check TRUNC-5521' });
  const { s } = await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  const outcomesOf = (m) => ctx.gmail.calls({ method: m, mailbox: t.mailbox }).map((c) => c.outcome);
  ctx.ok('history read was truncated, then retried', outcomesOf('users.history.list')[0] === 'truncate' && outcomesOf('users.history.list').includes('ok'), { outcomes: outcomesOf('users.history.list') });
  ctx.ok('message read was truncated, then retried', outcomesOf('users.messages.get')[0] === 'truncate' && outcomesOf('users.messages.get').includes('ok'), { outcomes: outcomesOf('users.messages.get') });
  ctx.expect('drafted for the real sender', s.reply_to, 'dana@customer.test');
  ctx.expect('outcome is awaiting the user, not skipped', (await outcomes(ctx, t)).map((o) => [o.gmail_message_id, o.outcome]), [[email.id, 'awaiting_user']]);
  ctx.ok('history id is a number and moved forward', Number.isInteger(ctx.db.get('SELECT last_history_id AS h FROM tenants WHERE team_id = ?', t.teamId).h), {});
}
