import { installTenant, receiveEmail, waitPosted, sendOption, settled, outcomes } from './_fixtures.mjs';

export const meta = {
  name: 'send option replies in the same thread',
  journey: 'J3.happy UJ step 3: user clicks Send option 2, reply goes out, Slack shows who sent it',
  concerns: ['AI-07', 'CONC-09', 'UJ-08', 'OPS-01', 'OPS-02'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  await settled(ctx, t);
  ctx.expect('nothing is sent before a human clicks', ctx.gmail.sent(t.mailbox).length, 0);

  ctx.step('user clicks Send option 2');
  const ack = await sendOption(ctx, t, s, 2);
  ctx.expect('click acknowledged 200', ack.status, 200);
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  const options = JSON.parse(s.options_json);
  ctx.expect('reply goes to the original sender only', [sent.to, sent.cc, sent.bcc], [['dana@customer.test'], [], []]);
  ctx.expect('reply body is option 2', sent.body.trim(), options[1]);
  ctx.ok('reply is in the same Gmail thread', sent.threaded && sent.threadId === email.threadId, { threadId: sent.threadId, expected: email.threadId });
  ctx.expect('In-Reply-To is the original Message-ID', sent.inReplyTo, email.messageId);
  ctx.ok('References includes the original Message-ID', sent.references.includes(email.messageId), {});
  ctx.expect('subject is Re: original', sent.subject, 'Re: Kettle arrived broken');

  ctx.step('Slack message is updated to the sent state');
  const update = await ctx.waitFor(() => ctx.slack.calls({ method: 'chat.update', team: t.teamId, outcome: 'ok' })[0], 10000, 'chat.update');
  ctx.ok('Slack shows "Sent by <@user> at <time>"', new RegExp(`^Sent by <@${t.userId}> at \\d\\d:\\d\\d UTC$`).test(update.args.text), { text: update.args.text });
  ctx.ok('buttons are gone after sending', !JSON.stringify(update.args.blocks).includes('send_option'), {});
  await settled(ctx, t);
  ctx.expect('exactly one email sent', ctx.gmail.sent(t.mailbox).length, 1);

  ctx.step('support can answer "did Dana get a reply?"');
  const rows = await outcomes(ctx, t, 'dana@customer.test');
  ctx.expect('outcome is replied by the clicking user', rows.map((r) => [r.outcome, r.actor]), [['replied', t.userId]]);

  ctx.step('one correlation id joins push, Slack post and send across instances');
  const cid = rows[0].cid;
  const events = new Set(ctx.logs((l) => l.cid === cid).map((l) => l.event));
  ctx.ok('logs for this cid cover push, draft, post, claim, send, render', ['push.received', 'draft.done', 'post.done', 'reply.claimed', 'send.done', 'render.done'].every((e) => events.has(e)), { events: [...events] });
}
