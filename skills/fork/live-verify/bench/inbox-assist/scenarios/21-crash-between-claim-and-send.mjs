import { installTenant, receiveEmail, waitPosted, sendOption, settled, sendCalls } from './_fixtures.mjs';

export const meta = {
  name: 'instance killed mid-send: another instance sends exactly once',
  journey: 'J3.crash UJ step 3 during a crash: the worker holding the send job dies',
  concerns: ['REL-10', 'REL-12', 'CONC-05', 'CONC-06', 'LAT-03'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t);
  const { s } = await waitPosted(ctx, t, email.id);
  let hit = false;
  // The first send request hangs at Gmail without being performed; the instance that made it is then SIGKILLed.
  ctx.gmail.faults.inject('users.messages.send', { kind: 'hang', where: (c) => c.mailbox === t.mailbox, onHit: () => { hit = true; } });
  ctx.step('user sends; the worker claims the job and is killed while sending');
  await sendOption(ctx, t, s, 3);
  await ctx.waitFor(() => hit, 10000, 'send reached Gmail');
  const job = ctx.db.get("SELECT locked_by FROM jobs WHERE team_id = ? AND kind = 'send_reply' AND status = 'running'", t.teamId);
  const victim = ctx.apps.find((a) => a.id === job?.locked_by);
  ctx.ok('found the instance holding the job', Boolean(victim), { lockedBy: job?.locked_by });
  await victim.kill();
  ctx.step('lease expires; a surviving or restarted instance takes over');
  if (ctx.apps.every((a) => !a.alive)) await victim.restart();
  await ctx.waitFor(() => ctx.db.get('SELECT status FROM suggestions WHERE id = ?', s.id).status === 'sent', 20000, 'sent after recovery');
  await settled(ctx, t);
  ctx.expect('exactly one email sent', ctx.gmail.sent(t.mailbox).length, 1);
  ctx.expect('send calls: the hung one, then one real send', sendCalls(ctx, t).map((c) => c.outcome), ['hang', 'ok']);
  ctx.ok('second attempt came from another process', !sendCalls(ctx, t)[1].client.includes(`(${victim.id})`) || ctx.apps.length === 1, { client: sendCalls(ctx, t)[1].client });
  ctx.expect('job finished done on attempt 2', ctx.db.get("SELECT status, attempts FROM jobs WHERE team_id = ? AND kind = 'send_reply'", t.teamId), { status: 'done', attempts: 2 });
  await victim.restart();
  ctx.ok('killed instance is healthy again', victim.alive, {});
}
