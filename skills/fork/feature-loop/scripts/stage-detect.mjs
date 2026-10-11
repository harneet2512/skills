// Which source changes a loop has, and which planning skills they needed (fork.8, gates.md "G9 stages"). Shared by the
// PostToolUse hook (stage-hook.mjs), which records a violation, and by gate G9, which re-checks the tree itself.
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clean, tables } from './md-table.mjs';

// Paths that are not source: the loop's own notes and the planning documents.
const ALLOWED = ['.scratch/', 'docs/plans/', 'docs/agents/', 'docs/adr/', 'GLOSSARY.md', '.claude/.loop-key'];
export const isAllowed = (p) => ALLOWED.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
const EXCLUDES = ['.scratch', 'docs/plans', 'docs/agents', 'docs/adr', 'GLOSSARY.md', '.claude/.loop-key'].map((p) => `:(exclude)${p}`);

const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export const normSkill = (s) => String(s ?? '').trim().toLowerCase().replace(/^\//, '').replace(/^.*:/, '');

// Source paths changed in the working tree and index (including untracked files), not yet committed.
export function dirtySource(dir) {
  const r = git(dir, ['status', '--porcelain', '-z', '-uall']);
  if (r.status !== 0) return [];
  const tokens = r.stdout.split('\0').filter(Boolean);
  const paths = [];
  for (let i = 0; i < tokens.length; i++) {
    const xy = tokens[i].slice(0, 2);
    paths.push(tokens[i].slice(3));
    if (xy.includes('R') || xy.includes('C')) paths.push(tokens[++i] ?? '');
  }
  return [...new Set(paths.filter((p) => p && !isAllowed(p)))].sort();
}

// The ref that `base` names in this repository (base, else origin/base), or null.
function baseRef(dir, base) {
  for (const ref of [base, `origin/${base}`]) {
    if (ref && git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0) return ref;
  }
  return null;
}

// Source paths the branch has changed against the base (committed work).
export function committedSource(dir, base) {
  const ref = baseRef(dir, base);
  if (!ref) return [];
  const r = git(dir, ['diff', '--name-only', '-z', `${ref}...HEAD`]);
  if (r.status !== 0) return [];
  return r.stdout.split('\0').filter((p) => p && !isAllowed(p)).sort();
}

export const sourceChanges = (dir, base) => [...new Set([...dirtySource(dir), ...committedSource(dir, base)])].sort();

// When the source last changed, in ms: the newest source commit on the branch, or the newest dirty source file.
export function lastSourceChangeMs(dir, base) {
  const ref = baseRef(dir, base);
  const r = git(dir, ['log', '-1', '--format=%ct', ...(ref ? [`${ref}..HEAD`] : []), '--', '.', ...EXCLUDES]);
  let ms = r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) * 1000 : 0;
  for (const p of dirtySource(dir)) { try { ms = Math.max(ms, statSync(join(dir, p)).mtimeMs); } catch { /* deleted */ } }
  return ms;
}

// The planning skills a source change needs first. Each slot is a list of skills that satisfy it.
const SMALL_SLOTS = [['behavioral-envelope']];
const NORMAL_SLOTS = [
  ['grilling', 'grill-with-docs', 'shape', 'plan-first'],
  ['deep-engineering'],
  ['behavioral-envelope'],
  ['to-spec'],
  ['to-tickets', 'plan-first'],
];
const COVERED_BY_PLAN = new Set(['shape', 'grilling', 'to-tickets']);
export const planningSlots = (size) => (size === 'small' ? SMALL_SLOTS : NORMAL_SLOTS);
const slotName = (slot) => slot.filter((s) => s !== 'plan-first').join('|');

// The ledger rows of .scratch/loop-status.md: [{ skill, status }]. A stage the approved plan covered ("done, from
// approved plan", checked by gate G8) counts for its slot even though nothing was invoked in this loop.
function ledgerRows(root) {
  let md;
  try { md = readFileSync(join(root, '.scratch', 'loop-status.md'), 'utf8'); } catch { return []; }
  const t = tables(md.split(/\r?\n/)).find((x) => x.header.includes('status') && x.header.includes('skill'));
  if (!t) return [];
  const col = (n) => t.header.indexOf(n);
  return t.rows.map((r) => ({ skill: normSkill(clean(r[col('skill')] ?? '')), status: clean(r[col('status')] ?? '') }));
}

// The names of the planning slots not yet satisfied. `logged` is a Set of normalized skill names from skills.jsonl.
export function missingPlanning(root, size, logged) {
  const fromPlan = new Set(ledgerRows(root)
    .filter((r) => /^done\b.*\bfrom approved plan\b/i.test(r.status) && COVERED_BY_PLAN.has(r.skill)).map((r) => r.skill));
  return planningSlots(size)
    .filter((slot) => !slot.some((s) => logged.has(s) || fromPlan.has(s)))
    .map(slotName);
}
