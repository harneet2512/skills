// The Packs bypass of G4 (fork.9, gates.md "G4"): the envelope's **Packs:** line decides whether evals apply, so editing it
// after G4 went red is the way to make a red G4 disappear. Each red G4 is signed into the stage log with a hash of the
// Packs line then; a later G4 that finds a different Packs line is a bypass, and stays red until loop-metrics.md
// carries a line with the reason:
//
//   <date> <slug> G4 packs bypass <first 8 hex of the new Packs hash>: <reason>
//
// The hash in the line ties the reason to this edit, so an old reason does not cover a new one. Without a stage log
// (the hooks never ran) nothing is recorded and nothing can be compared.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendEntry, epochOf, readLog, storeStatus } from './stage-log.mjs';

const hashOf = (packs) => createHash('sha256').update(String(packs ?? '').replace(/\s+/g, ' ').trim()).digest('hex');
const HASH_LEN = 8;

// null, or the message of the open bypass. `packs` is the current Packs line value (null when there is none).
export function g4Bypass(root, slug, packs) {
  if (storeStatus(root).kind !== 'ok') return null;
  const log = readLog(root);
  if (log.errors.length) return null; // G9 reports a tampered log
  const reds = epochOf(log.entries).entries.filter((e) => e.kind === 'g4' && e.result === 'red');
  const last = reds[reds.length - 1];
  const now = hashOf(packs);
  if (!last || last.packs === now) return null;
  const short = now.slice(0, HASH_LEN);
  let metrics = '';
  try { metrics = readFileSync(join(root, '.scratch', 'loop-metrics.md'), 'utf8'); } catch { /* none */ }
  const re = new RegExp(`\\b${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+G4 packs bypass ${short}:[ \\t]*\\S`); // [ \t], not \s: a blank reason must not borrow the next line's text
  if (metrics.split(/\r?\n/).some((l) => re.test(l))) return null;
  return `the envelope Packs line was changed after G4 was red (a bypass): record why in .scratch/loop-metrics.md as "<date> ${slug} G4 packs bypass ${short}: <reason>"`;
}

// Remember that G4 is red with this Packs line (once per distinct line).
export function recordG4Red(root, packs, now) {
  if (storeStatus(root).kind !== 'ok') return;
  const log = readLog(root);
  if (log.errors.length) return;
  const h = hashOf(packs);
  const reds = epochOf(log.entries).entries.filter((e) => e.kind === 'g4' && e.result === 'red');
  if (reds.length && reds[reds.length - 1].packs === h) return;
  appendEntry(root, { kind: 'g4', result: 'red', packs: h, ts: now });
}

// Does the Packs line name the llm or retrieval pack? Backtick spans holding one word count as that word;
// longer spans (the triggering lines) are dropped. "no llm" or "not retrieval" does not count.
export function packsNeedEvals(packs) {
  const s = packs
    .replace(/`([A-Za-z-]+)`/g, ' $1 ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ');
  const re = /(^|[^A-Za-z0-9_-])(llm|retrieval)(?![A-Za-z0-9_-])/gi;
  let m;
  while ((m = re.exec(s))) {
    const before = s.slice(0, m.index + m[1].length).toLowerCase();
    if (!/\b(no|not|without)\s*$/.test(before)) return true;
  }
  return false;
}

