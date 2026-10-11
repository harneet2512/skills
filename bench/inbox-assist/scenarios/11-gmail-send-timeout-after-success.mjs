import { installTenant, receiveEmail, waitPosted, sendOption, settled, sendCalls } from './_fixtures.mjs';

export const meta = {
  name: 'Gmail send times out after success: reconciled, never sent twice',
  journey: 'J3.lost-response UJ step 3 with an ambiguous send: Gmail sends, the response is lost',
  concerns: ['REL-07', 'CONC-11', 'REL-10', 'DI-07'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  // Search lags (as Gmail's index can), so reconciliation must not rely on search alone.
  ctx.gmail.mailbox(t.mailbox).searchLagMs = 60000;
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  ctx.gmail.faults.inject('users.messages.send', { kind: 'timeoutAfterSuccess', where: (c) => c.mailbox === t.mailbox });

  ctx.step('user sends; Gmail sends but the connection drops before the response');
  await sendOption(ctx, t, s, 1);
  await ctx.waitFor(() => ctx.db.get('SELECT status FROM suggestions WHERE id = ?', s.id).status === 'sent', 15000, 'suggestion sent');
  await settled(ctx, t);
  ctx.expect('exactly one email in the mailbox sent folder', ctx.gmail.sent(t.mailbox).length, 1);
  ctx.expect('exactly one Gmail send call (retry reconciled instead of resending)', sendCalls(ctx, t).length, 1);
  const row = ctx.db.get('SELECT sent_gmail_id, send_message_id FROM suggestions WHERE id = ?', s.id);
  ctx.expect('stored Gmail id is the message that was sent', row.sent_gmail_id, ctx.gmail.sent(t.mailbox)[0].id);
  ctx.expect('sent Message-ID is the recorded send intent', ctx.gmail.sent(t.mailbox)[0].messageId, row.send_message_id);
  ctx.ok('reconciliation was logged', ctx.logs((l) => l.event === 'send.reconciled' && l.team === t.teamId).length === 1, {});
  ctx.ok('Slack shows sent', ctx.slack.calls({ method: 'chat.update', team: t.teamId, outcome: 'ok' }).some((c) => c.args.text.startsWith('Sent by')), {});
}
