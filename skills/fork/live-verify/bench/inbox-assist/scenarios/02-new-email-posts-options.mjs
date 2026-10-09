import { installTenant, receiveEmail, waitPosted, okPosts, blockText } from './_fixtures.mjs';

export const meta = {
  name: 'new email posts 3 options in DM',
  journey: 'J2.happy UJ step 2: email arrives, user sees 3 drafts with buttons in their DM',
  concerns: ['UJ-04', 'LAT-03', 'AI-08', 'TEN-14'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.step('email arrives and Pub/Sub pushes');
  const email = await receiveEmail(ctx, t, { body: 'Hi, order NEW-2201 arrived with a cracked lid. What can you do?' });
  ctx.ok('push acknowledged with 2xx', email.ack.status >= 200 && email.ack.status < 300, { status: email.ack.status });
  ctx.ok('push ack is fast (work is queued, not done inline)', email.ack.ms < 1000, { ms: email.ack.ms });

  ctx.step('draft is posted to the user DM');
  const { s, message } = await waitPosted(ctx, t, email.id);
  ctx.expect('posted to the installing user DM', s.slack_channel, t.dm);
  const posts = okPosts(ctx, t);
  ctx.expect('exactly one Slack post', posts.length, 1);
  ctx.expect('posted with this workspace token', posts[0].team, t.teamId);
  const actions = message.blocks.find((b) => b.type === 'actions').elements.map((e) => e.action_id);
  ctx.expect('buttons: send 1/2/3, edit, dismiss', actions, ['send_option_1', 'send_option_2', 'send_option_3', 'edit', 'dismiss']);
  const optionBlocks = message.blocks.filter((b) => b.text?.text?.startsWith('*Option '));
  ctx.expect('three options shown', optionBlocks.length, 3);
  ctx.ok('send buttons ask for confirmation (irreversible action)', message.blocks.find((b) => b.type === 'actions').elements.slice(0, 3).every((e) => e.confirm), {});
  ctx.ok('message names the sender and subject', blockText(message).includes('dana@customer.test') && blockText(message).includes('Kettle arrived broken'), {});
  const llmCalls = ctx.llm.calls({ method: 'messages' }).filter((c) => c.request.prompt.includes('NEW-2201'));
  if (ctx.llmMode === 'stub') ctx.expect('one LLM call for one email', llmCalls.length, 1);
}
