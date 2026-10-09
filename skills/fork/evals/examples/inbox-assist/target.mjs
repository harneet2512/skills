// Target adapter: maps an eval case onto the feature under test.
// The feature is draftReplies() in the inbox-assist reference app. The harness
// passes ctx.llm, which has the same { complete({ system, prompt, maxTokens }) -> string }
// shape the app's providers have, so the real prompt, budget and parser run unchanged.
//
// INBOX_DRAFT_MODULE overrides the module path (for example to eval a branch's copy).
// There is no silent fallback: evaluating a stand-in by accident would report the
// wrong system's quality.
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT = resolve(HERE, '../../../live-verify/bench/inbox-assist/src/draft.mjs');
const modulePath = process.env.INBOX_DRAFT_MODULE ? resolve(process.env.INBOX_DRAFT_MODULE) : DEFAULT;
const { draftReplies } = await import(pathToFileURL(modulePath).href);

export async function run(input, ctx) {
  const { options } = await draftReplies({ thread: input.thread, aboutUs: input.aboutUs, llm: ctx.llm });
  return { options };
}
