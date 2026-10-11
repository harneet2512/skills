import { installTenant, receiveEmail, waitPosted, sendOption, settled, sendCalls, okPosts } from './_fixtures.mjs';

export const meta = {
  name: 'one tenant flooding slow drafts does not delay sends or other tenants',
  journey: 'J2.noisy-tenant J3.noisy-tenant UJ steps 2-3 while another workspace gets a burst of mail and the model is slow',
  concerns: ['REL-06', 'TEN-09', 'LAT-03'],
};

const FLOOD = 10;

export default async function (ctx) {
  if (ctx.llmMode !== 'stub') return ctx.ok('skipped: needs the stand-in LLM', true, {});
  const b = await installTenant(ctx);
  const eb = await receiveEmail(ctx, b, { body: 'Tenant B needs an answer NOISY-B' });
  const { s } = await waitPosted(ctx, b, eb.id);
  const a = await installTenant(ctx);
  const c = await installTenant(ctx);

  ctx.step(`tenant A gets ${FLOOD} emails; every draft takes 2 s`);
  let slowHits = 0;
  ctx.llm.faults.inject('messages', { kind: 'delay', delayMs: 2000, times: Infinity, where: (call) => call.request.prompt.includes('FLOOD-'), onHit: () => { slowHits += 1; } });
  for (let i = 0; i < FLOOD; i++) ctx.gmail.deliverEmail(a.mailbox, { from: `Bulk ${i} <bulk${i}@customer.test>`, subject: `Flood ${i}`, body: `Flood mail FLOOD-${i}` });
  await ctx.gmail.pushToApp(ctx.apps.map((x) => `${x.url}/gmail/push`), ctx.gmail.pushPayload(a.mailbox));
  await ctx.waitFor(() => slowHits >= 2, 10000, 'tenant A drafts running');

  ctx.step('tenant B approves a send while A drafts');
  const clickedAt = Date.now();
  await sendOption(ctx, b, s, 1);
  const send = await ctx.waitFor(() => sendCalls(ctx, b)[0], 20000, 'tenant B send');
  ctx.ok('approved send starts within 1 s', send.startedAt - clickedAt < 1000, { waitMs: send.startedAt - clickedAt });

  ctx.step('tenant C gets one email while A drafts');
  const receivedAt = Date.now();
  const ec = await receiveEmail(ctx, c, { body: 'Tenant C fresh mail NOISY-C' });
  await ctx.waitFor(() => okPosts(ctx, c)[0], 20000, 'tenant C posted');
  ctx.ok('tenant C drafted within 1.5 s', okPosts(ctx, c)[0].startedAt - receivedAt < 1500, { waitMs: okPosts(ctx, c)[0].startedAt - receivedAt, email: ec.id });

  await settled(ctx, a, 30000);
  const spans = ctx.llm.calls((x) => x.method === 'messages' && x.request?.prompt.includes('FLOOD-')).map((x) => [x.startedAt, x.startedAt + x.durationMs]);
  const maxOverlap = Math.max(...spans.map(([st]) => spans.filter(([s0, e0]) => s0 <= st && st < e0).length));
  ctx.expect('every flood email drafted', spans.length, FLOOD);
  ctx.ok('tenant A never held more than 2 draft slots', maxOverlap <= 2, { maxOverlap });
}
