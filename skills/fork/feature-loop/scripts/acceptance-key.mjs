// The identity of a set of acceptance tests (fork.9, stop 1). The owner approves the tests at the end of grilling,
// before any plan file exists, so an approval is keyed to the tests themselves, not to a plan: the same items under the
// plan's `## Acceptance tests` later give the same key, and any change to an item gives a new one.
//
// Source at approval time: docs/acceptance/*.md, else docs/plans/*.md. Both use the same
// `## Acceptance tests` section format (see ../../plan-first/plan-template.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { acceptanceItems } from './gates-acceptance.mjs';
import { mdCandidates, unshipped } from './vis-root.mjs';

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

// The acceptance tests an "approve acceptance" is for: { at: { file, rel, key } } or { error }. Source: docs/acceptance/*.md,
// else docs/plans/*.md. With one candidate file in the directory that is the one; with several the owner must name one
// (`approve acceptance docs/acceptance/x.md`), so the approval never lands on a guess.
export function chooseAcceptance(dirs, named = '') {
  const keyOf = (c) => { try { return acceptanceKeyOf(readFileSync(c.file, 'utf8')); } catch { return ''; } };
  const sources = [mdCandidates(dirs, 'acceptance'), mdCandidates(dirs, 'plans')];
  const live = sources.map(unshipped);
  if (named) {
    const pick = sources.flat().find((c) => c.rel === named);
    if (!pick) return { error: `${named} is not a file in docs/acceptance/ or docs/plans/` };
    const key = keyOf(pick);
    return key ? { at: { file: pick.file, rel: pick.rel, key } } : { error: `${named} has no "## Acceptance tests" items` };
  }
  for (const cands of live) {
    if (cands.length > 1) {
      const names = cands.map((c) => c.rel).sort().join(', ');
      return { error: `${cands.length} files in ${cands[0].rel.replace(/\/[^/]*$/, '/')} (${names}): name the one you approve, for example "approve acceptance ${[...cands].sort((a, b) => b.m - a.m)[0].rel}"` };
    }
    const key = cands.length ? keyOf(cands[0]) : '';
    if (key) return { at: { file: cands[0].file, rel: cands[0].rel, key } };
  }
  return { error: 'no "## Acceptance tests" items in docs/acceptance/*.md or docs/plans/*.md' };
}
