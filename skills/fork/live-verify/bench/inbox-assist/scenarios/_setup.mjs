// Runs before every scenario (after the runner resets all fault plans and rules).
export const DEFAULT_OPTIONS = [
  'Thanks for your note. I will look into this today and get back to you.',
  'Thank you for reaching out. Could you share a few more details so I can help?',
  'Thanks, this is noted and I have passed it to the right person.',
];

export function beforeEach(ctx) {
  ctx.llm.script({ name: 'three-options', reply: () => JSON.stringify({ options: DEFAULT_OPTIONS }) });
}
