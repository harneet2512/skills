import { installTenant, SENDER, waitPosted, settled, okPosts } from './_fixtures.mjs';

export const meta = {
  name: 'out-of-order pushes: history only moves forward',
  journey: 'J2.stale UJ step 2 under reordering: the push for the older email arrives last',
  concerns: ['CONC-14', 'CONC-04', 'REL-08'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const target = `${ctx.app.url}/gmail/push`;
  ctx.gmail.faults.inject('push', { kind: 'reorder', where: (c) => c.mailbox === t.mailbox });
  ctx.step('two emails arrive; push 1 is held and delivered after push 2');
  const e1 = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'First', body: 'first' });
  const e2 = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'Second', body: 'second' });
  const held = await ctx.gmail.pushToApp(target, e1.push);
  ctx.ok('push 1 held by the fault', held.held === true, {});
  const both = await ctx.gmail.pushToApp(target, e2.push);
  ctx.expect('both pushes acknowledged, newer first', both.results.map((r) => r.status), [204, 204]);
  await waitPosted(ctx, t, e1.id);
  await waitPosted(ctx, t, e2.id);
  await settled(ctx, t);
  ctx.expect('each email drafted exactly once', okPosts(ctx, t).length, 2);
  ctx.expect('stored history id is the newest', ctx.db.get('SELECT last_history_id AS h FROM tenants WHERE team_id = ?', t.teamId).h, e2.historyId);

  ctx.step('Pub/Sub redelivers the older push after the sync moved past it');
  const late = await ctx.gmail.pushToApp(target, e1.push);
  ctx.expect('late push acknowledged', late.status, 204);
  ctx.ok('late push recognised as stale', ctx.logs((l) => l.event === 'push.stale' && l.team === t.teamId && l.historyId === e1.historyId).length === 1, {});
  await settled(ctx, t);
  ctx.expect('still two posts', okPosts(ctx, t).length, 2);
  ctx.expect('history id did not move back', ctx.db.get('SELECT last_history_id AS h FROM tenants WHERE team_id = ?', t.teamId).h, e2.historyId);

  ctx.step('a slow sync reads old history, a newer sync finishes first, the slow one lands last');
  let slowHit = false;
  ctx.gmail.faults.inject('users.history.list', { kind: 'slowResponse', delayMs: 1500, where: (c) => c.mailbox === t.mailbox, onHit: () => { slowHit = true; } });
  const e3 = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'Third', body: 'third' });
  await ctx.gmail.pushToApp(target, e3.push);
  await ctx.waitFor(() => slowHit, 5000, 'slow history read started');
  const e4 = ctx.gmail.deliverEmail(t.mailbox, { from: SENDER, subject: 'Fourth', body: 'fourth' });
  await ctx.gmail.pushToApp(ctx.apps[1 % ctx.apps.length].url + '/gmail/push', e4.push);
  await waitPosted(ctx, t, e4.id);
  await settled(ctx, t);
  ctx.expect('history id stays at the newest after the slow sync lands', ctx.db.get('SELECT last_history_id AS h FROM tenants WHERE team_id = ?', t.teamId).h, e4.historyId);
  ctx.expect('every email drafted exactly once', okPosts(ctx, t).length, 4);
}
