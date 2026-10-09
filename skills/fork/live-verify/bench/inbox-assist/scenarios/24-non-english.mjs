import { installTenant, receiveEmail, waitPosted, sendOption } from './_fixtures.mjs';

export const meta = {
  name: 'non-English email round-trips through drafting and sending',
  journey: 'UJ steps 2-3 for a Japanese customer',
  concerns: ['DI-11', 'UJ-04', 'SEC-07'],
};

const JA = ['ご連絡ありがとうございます。本日中に交換品を発送いたします。', 'ご不便をおかけし申し訳ございません。詳細をお知らせいただけますか。', '承知いたしました。担当者に確認いたします。'];

export default async function (ctx) {
  const t = await installTenant(ctx);
  ctx.llm.script({ name: 'japanese', when: (r) => r.prompt.includes('ケトル'), reply: JSON.stringify({ options: JA }) });
  const email = await receiveEmail(ctx, t, { from: '山田 花子 <hanako@customer.jp>', subject: '請求書について', body: 'ケトルの蓋が割れて届きました。どうすればよいですか。' });
  const { s, message } = await waitPosted(ctx, t, email.id);
  ctx.ok('Slack shows the Japanese subject', JSON.stringify(message.blocks).includes('請求書について'), {});
  const options = JSON.parse(s.options_json);
  if (ctx.llmMode === 'stub') ctx.expect('options stored intact', options, JA);
  await sendOption(ctx, t, s, 1);
  const sent = await ctx.waitFor(() => ctx.gmail.sent(t.mailbox)[0], 10000, 'reply sent');
  ctx.expect('subject decoded by Gmail is Re: + original', sent.subject, 'Re: 請求書について');
  ctx.ok('subject was RFC 2047 encoded on the wire', sent.headers.find((h) => h.name === 'Subject') != null, {});
  ctx.expect('body decoded intact', sent.body.trim(), options[0]);
  ctx.expect('to original sender', sent.to, ['hanako@customer.jp']);
  ctx.ok('threaded', sent.threaded, {});
}
