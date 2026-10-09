import { installTenant, receiveEmail, waitPosted, blockText } from './_fixtures.mjs';

export const meta = {
  name: 'unknown charset in headers still reaches the user',
  journey: 'UJ step 2 with an email whose headers name a charset we cannot decode',
  concerns: ['DI-11', 'REL-14', 'UJ-06'],
};

export default async function (ctx) {
  const t = await installTenant(ctx);
  const email = await receiveEmail(ctx, t, {
    from: '=?x-unknown-8bit?Q?Dana_K?= <dana@customer.test>',
    subject: `=?x-klingon?B?${Buffer.from('Order 7781 broken').toString('base64')}?=`,
    body: 'Charset check CHARSET-1',
  });
  const { s, message } = await waitPosted(ctx, t, email.id);
  ctx.expect('reply goes to the sender', s.reply_to, 'dana@customer.test');
  ctx.ok('subject decoded with a safe fallback', blockText(message).includes('Order 7781 broken'), { subject: s.subject });
}
