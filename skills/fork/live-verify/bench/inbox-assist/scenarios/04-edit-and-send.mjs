import { installTenant, receiveEmail, waitPosted, click, settled } from './_fixtures.mjs';

export const meta = {
  name: 'edit opens a modal and sends the edited text',
  journey: 'J4.happy UJ step 3b: user edits a draft in a modal and sends it',
  concerns: ['AI-07', 'UJ-04', 'UJ-05'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);

  ctx.step('user clicks Edit');
  const ack = await click(ctx, t, s, 'edit', s.id);
  ctx.expect('click acknowledged', ack.status, 200);
  const view = await ctx.waitFor(() => ctx.slack.views(t.teamId)[0], 5000, 'views.open');
  ctx.expect('modal pre-filled with option 1', view.blocks[0].element.initial_value, JSON.parse(s.options_json)[0]);

  ctx.step('empty submission is refused inside the modal');
  const empty = await ctx.slack.platform.viewSubmission(`${ctx.apps[1 % ctx.apps.length].url}/slack/interactions`, { teamId: t.teamId, userId: t.userId, view, values: { reply: { text: { type: 'plain_text_input', value: '   ' } } } });
  ctx.expect('empty text returns a field error', empty.json?.response_action, 'errors');

  ctx.step('user submits edited text');
  const edited = 'Sorry about the lid. A replacement ships today, no need to return the old one.';
  const sub = await ctx.slack.platform.viewSubmission(`${ctx.apps[1 % ctx.apps.length].url}/slack/interactions`, { teamId: t.teamId, userId: t.userId, view, values: { reply: { text: { type: 'plain_text_input', value: edited } } } });
  ctx.expect('modal closes', sub.json?.response_action, 'clear');
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  ctx.expect('sent text is the edited text', sent.body.trim(), edited);
  ctx.expect('sent to original sender', sent.to, ['dana@customer.test']);
  await ctx.waitFor(() => ctx.slack.calls({ method: 'chat.update', team: t.teamId, outcome: 'ok' }).length === 1, 10000, 'Slack updated');
  await settled(ctx, t);
  ctx.expect('one email sent', ctx.gmail.sent(t.mailbox).length, 1);
}
