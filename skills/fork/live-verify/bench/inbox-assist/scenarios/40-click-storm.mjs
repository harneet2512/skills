import { installTenant, receiveEmail, waitPosted, sendOption, settled } from './_fixtures.mjs';

export const meta = {
  name: 'click storm: many concurrent Send clicks across instances, one email per suggestion',
  journey: 'J3.twice J3.two-actors UJ step 3 under a burst: several people and retries click Send on the same drafts at once',
  concerns: ['CONC-03', 'CONC-09', 'UJ-06'],
};

const SUGGESTIONS = 8;
const CLICKS = 16;

export default async function (ctx) {
  const t = await installTenant(ctx);
  const posted = [];
  for (let i = 0; i < SUGGESTIONS; i++) {
    const email = await receiveEmail(ctx, t, { subject: `Storm ${i}`, body: `Click storm STORM-${i}` });
    posted.push((await waitPosted(ctx, t, email.id)).s);
  }
  ctx.step(`${CLICKS} clicks per suggestion at once, alternating instances`);
  for (const s of posted) {
    const acks = await Promise.all(Array.from({ length: CLICKS }, (_, k) =>
      sendOption(ctx, t, s, 1 + (k % 3), { userId: `U${k % 4}STORM`, app: ctx.apps[k % ctx.apps.length] })));
    ctx.ok(`every click on ${s.id} acknowledged`, acks.every((a) => a.status === 200), {});
  }
  await ctx.waitFor(() => ctx.gmail.sent(t.mailbox).length >= SUGGESTIONS, 15000, 'replies sent');
  await settled(ctx, t, 15000);
  ctx.expect('one Gmail send per suggestion', ctx.gmail.calls({ method: 'users.messages.send', mailbox: t.mailbox }).length, SUGGESTIONS);
  ctx.expect('one email per thread', posted.map((s) => ctx.gmail.sent(t.mailbox).filter((m) => m.threadId === s.thread_id).length), posted.map(() => 1));
  ctx.expect('one send job per suggestion', ctx.db.get("SELECT count(*) AS n FROM jobs WHERE team_id = ? AND kind = 'send_reply'", t.teamId).n, SUGGESTIONS);
}
