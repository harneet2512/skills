// Which source changes a loop has, and which planning skills they needed (fork.8, gates.md "G9 stages"). Shared by the
// PostToolUse hook (stage-hook.mjs), which records a violation, and by gate G9, which re-checks the tree itself.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { clean, tables } from './md-table.mjs';

// Paths that are not source: the loop's own notes, the planning documents (the owner's acceptance tests are written and
// approved at stop 1, before the loop starts), the Claude settings file and the caches tools leave in the repository.
// Paths Git ignores (.gitignore, .git/info/exclude) never show in `git status`, so they are not source either.
const CACHES = ['.groundtruth/', '.cache/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', '.nyc_output/', '.turbo/', '.parcel-cache/'];
const ALLOWED = ['.scratch/', 'docs/plans/', 'docs/acceptance/', 'docs/agents/', 'docs/adr/', 'GLOSSARY.md', '.claude/settings.json', '.claude/.loop/', ...CACHES];
export const isAllowed = (p) => ALLOWED.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a));
const EXCLUDES = ['.scratch', 'docs/plans', 'docs/acceptance', 'docs/agents', 'docs/adr', 'GLOSSARY.md', '.claude/settings.json', '.claude/.loop', ...CACHES.map((c) => c.replace(/\/$/, ''))].map((p) => `:(exclude)${p}`);
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
export const MARGIN_MS = 2000;
// A review counts when logged at or after the last source commit time, less one second of clock rounding.
export const AFTER_MARGIN_MS = 1000;
const MAX_BLOBS = 40;

export const git = (dir, args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
export const normSkill = (s) => String(s ?? '').trim().toLowerCase().replace(/^\//, '').replace(/^.*:/, '');
export const SIZES = ['small', 'normal', 'large'];
export const maxSize = (...xs) => xs.filter((x) => SIZES.includes(x)).sort((a, b) => SIZES.indexOf(b) - SIZES.indexOf(a))[0] ?? 'normal';

const resolves = (dir, ref) => !!ref && git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).status === 0;
const revParse = (dir, ref) => { const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return r.status === 0 ? r.stdout.trim() : ''; };
// The sha `base` names: origin/base first (a local base branch can carry code the agent committed itself), else base; or ''.
export const baseSha = (dir, base) => (base ? revParse(dir, `origin/${base}`) || revParse(dir, base) : '');
export const headSha = (dir) => revParse(dir, 'HEAD') || EMPTY_TREE;
export const isAncestor = (dir, a, b) => !!a && !!b && git(dir, ['merge-base', '--is-ancestor', a, b]).status === 0;
export function mergeBaseOf(dir, a, b) {
  if (!a || !b) return '';
  const r = git(dir, ['merge-base', a, b]);
  return r.status === 0 ? r.stdout.trim() : '';
}
export const mergeBaseWith = (dir, sha) => mergeBaseOf(dir, sha, 'HEAD');

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

// Source paths changed since the loop's recorded start commit: committed, staged, unstaged and untracked.
export function changedSince(dir, startSha) {
  const out = new Set(dirtySource(dir));
  if (startSha) {
    const r = git(dir, ['diff', '--name-only', '-z', startSha]);
    if (r.status === 0) for (const p of r.stdout.split('\0')) if (p && !isAllowed(p)) out.add(p);
  }
  return [...out].sort();
}

// When the source last changed since the start commit, in ms: its newest commit, or its newest dirty file.
export function lastSourceChangeMs(dir, startSha) {
  const range = startSha && startSha !== EMPTY_TREE ? [`${startSha}..HEAD`] : [];
  const r = git(dir, ['log', '-1', '--format=%ct', ...range, '--', '.', ...EXCLUDES]);
  let ms = r.status === 0 && /^\d+$/.test(r.stdout.trim()) ? Number(r.stdout.trim()) * 1000 : 0;
  for (const p of dirtySource(dir)) { try { ms = Math.max(ms, statSync(join(dir, p)).mtimeMs); } catch { /* deleted */ } }
  return ms;
}

// The git blob hashes of the existing files at these paths in the given worktrees: { path: hash }.
export function blobsOf(dirs, paths) {
  const out = {};
  for (const p of paths.slice(0, MAX_BLOBS)) {
    for (const d of dirs) {
      if (!existsSync(join(d, p))) continue;
      const r = git(d, ['hash-object', '--', p]);
      if (r.status === 0) { out[p] = r.stdout.trim(); break; }
    }
  }
  return out;
}

// Signs that source was moved out of the tree instead of reverted: a stash, a worktree or a branch made after the loop
// started. `init` is the loop's init entry. Returns the list of reasons (empty when there is none).
export function evasionTraces(root, init) {
  const traces = [];
  const wall = Number(init.wall) || 0;
  const st = git(root, ['stash', 'list', '--format=%ct']);
  if (st.status === 0 && st.stdout.split('\n').some((l) => /^\d+$/.test(l.trim()) && Number(l.trim()) * 1000 >= wall - MARGIN_MS)) {
    traces.push('a git stash entry made after the loop started (git stash drop it, or restore it)');
  }
  const wt = git(root, ['worktree', 'list', '--porcelain']);
  if (wt.status === 0 && wt.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length > (Number(init.worktrees) || 1)) {
    traces.push('a git worktree added after the loop started (git worktree remove it)');
  }
  const br = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const known = new Set(init.branches ?? []);
  if (br.status === 0) {
    for (const b of br.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
      if (known.has(b)) continue;
      const d = git(root, ['diff', '--name-only', '-z', init.startSha ?? '', b]);
      if (d.status === 0 && d.stdout.split('\0').some((p) => p && !isAllowed(p))) traces.push(`a branch "${b}" made after the loop started holds source changes (delete it)`);
    }
  }
  return traces;
}

export function loopFacts(root) {
  const br = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  const wt = git(root, ['worktree', 'list', '--porcelain']);
  return {
    branches: br.status === 0 ? br.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : [],
    worktrees: wt.status === 0 ? wt.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length : 1,
  };
}

// ---- the plan, as a snapshot hashed at init: plan waivers are honoured only for a plan that existed then and is unchanged
export const stripChanges = (md) => md.replace(/\r\n/g, '\n').replace(/^##[ \t]+Changes\b[^\n]*\n[\s\S]*?(?=^##[ \t]|(?![\s\S]))/gim, '');
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// The plan file the loop would start from: docs/plans/<slug>.md, else the newest docs/plans/*.md. { file, sha } or {}.
export function planSnapshot(root, slug) {
  let file = `docs/plans/${slug}.md`;
  if (!existsSync(join(root, file))) {
    try {
      const names = readdirSync(join(root, 'docs', 'plans')).filter((n) => n.endsWith('.md'));
      names.sort((a, b) => statSync(join(root, 'docs', 'plans', b)).mtimeMs - statSync(join(root, 'docs', 'plans', a)).mtimeMs);
      file = names.length ? `docs/plans/${names[0]}` : '';
    } catch { file = ''; }
  }
  if (!file) return {};
  try { return { file, sha: sha256(stripChanges(readFileSync(join(root, file), 'utf8'))) }; } catch { return {}; }
}

// The plan text when it still hashes to the snapshot taken at init (apart from its ## Changes section), else null.
export function validPlan(root, init) {
  if (!init?.planSha || !init?.planFile) return null;
  try {
    const md = readFileSync(join(root, init.planFile), 'utf8');
    return sha256(stripChanges(md)) === init.planSha ? md : null;
  } catch { return null; }
}

// ---- the planning skills a source change needs first. Each slot is a list of skills that satisfy it.
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

// The ledger rows of .scratch/loop-status.md: [{ skill, status }].
function ledgerRows(root) {
  let md;
  try { md = readFileSync(join(root, '.scratch', 'loop-status.md'), 'utf8'); } catch { return []; }
  const t = tables(md.split(/\r?\n/)).find((x) => x.header.includes('status') && x.header.includes('skill'));
  if (!t) return [];
  const col = (n) => t.header.indexOf(n);
  return t.rows.map((r) => ({ skill: normSkill(clean(r[col('skill')] ?? '')), status: clean(r[col('status')] ?? '') }));
}

// The names of the planning slots not yet satisfied. `logged` is a Set of normalized skill names. A stage the approved
// plan covered ("done, from approved plan", checked by G8) counts only when `planOk`: the plan existed at init, unchanged.
export function missingPlanning(root, size, logged, planOk) {
  const fromPlan = planOk
    ? new Set(ledgerRows(root).filter((r) => /^done\b.*\bfrom approved plan\b/i.test(r.status) && COVERED_BY_PLAN.has(r.skill)).map((r) => r.skill))
    : new Set();
  return planningSlots(size)
    .filter((slot) => !slot.some((s) => logged.has(s) || fromPlan.has(s)))
    .map(slotName);
}

export { resolves };
