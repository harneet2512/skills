// The identity of a set of acceptance tests (fork.9, stop 1). The owner approves the tests at the end of grilling,
// before any plan file exists, so an approval is keyed to the tests themselves, not to a plan: the same items under the
// plan's `## Acceptance tests` later give the same key, and any change to an item gives a new one.
//
// Source at approval time: the newest docs/acceptance/*.md, else the newest docs/plans/*.md. Both use the same
// `## Acceptance tests` section format (see ../../plan-first/plan-template.md).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { acceptanceItems } from './gates-acceptance.mjs';

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const withoutId = (text) => norm(text).replace(/^\**`?AT-?\d+`?\**\s*[:.)-]?\s*/i, '');

// sha256 of the items, in order, as "<id> <text>" lines, or '' when there are none.
export function acceptanceKey(items) {
  if (!items || !items.length) return '';
  const body = items.map((it) => `${it.id} ${withoutId(it.text)}`).join('\n');
  return createHash('sha256').update(body).digest('hex');
}

// The key of the acceptance tests in a markdown text, or ''.
export const acceptanceKeyOf = (md) => acceptanceKey(acceptanceItems(md));

function newestMd(dir) {
  let best = null;
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return null; }
  for (const n of names) {
    try {
      const m = statSync(join(dir, n)).mtimeMs;
      if (!best || m > best.m) best = { file: join(dir, n), m };
    } catch { /* vanished */ }
  }
  return best?.file ?? null;
}

// The acceptance tests the owner is looking at now: { file, key } or null.
export function currentAcceptance(dirs) {
  for (const sub of [['docs', 'acceptance'], ['docs', 'plans']]) {
    for (const d of new Set(dirs.filter(Boolean))) {
      const file = newestMd(join(d, ...sub));
      if (!file) continue;
      let key = '';
      try { key = acceptanceKeyOf(readFileSync(file, 'utf8')); } catch { /* unreadable */ }
      if (key) return { file, key };
    }
  }
  return null;
}
