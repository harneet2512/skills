// Where the feature loop's files live for the visibility, hand-off and approval hooks (fork.9, gates.md "Visibility").
// Node 22, no dependencies. Shared by stage-hook.mjs and the modules it calls.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Lf } from './lf-sha.mjs';

export const gitOut = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
export const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const hasRunFile = (d) => !!d && existsSync(join(d, '.scratch', 'gates.json'));

// The main worktree's top level (.scratch/ is untracked, so a linked worktree has none), else the git top level, else null.
export function repoRoot(start) {
  const top = gitOut(start, ['rev-parse', '--show-toplevel']);
  const common = gitOut(start, ['rev-parse', '--git-common-dir']);
  const main = common && basename(resolve(start, common)) === '.git' ? dirname(resolve(start, common)) : '';
  return main || top || null;
}

// The directory holding the active loop's .scratch/gates.json (cwd, git top level, main worktree); null when none or closed.
export function loopRoot(start) {
  let dir = null;
  if (hasRunFile(start)) dir = start;
  else {
    const top = gitOut(start, ['rev-parse', '--show-toplevel']);
    const common = gitOut(start, ['rev-parse', '--git-common-dir']);
    const main = common && basename(resolve(start, common)) === '.git' ? dirname(resolve(start, common)) : '';
    dir = [top, main].find(hasRunFile) ?? null;
  }
  if (!dir) return null;
  try { if (JSON.parse(readFileSync(join(dir, '.scratch', 'gates.json'), 'utf8'))?.status === 'closed') return null; } catch { /* still a loop */ }
  return dir;
}

// Every docs/<sub>/*.md in any of `dirs`, one per relative path (the newest copy wins): [{ file (absolute), rel, m }].
export function mdCandidates(dirs, sub) {
  const byRel = new Map();
  for (const d of new Set(dirs.filter(Boolean))) {
    const pd = join(d, 'docs', sub);
    let names = [];
    try { names = readdirSync(pd).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const n of names) {
      const file = join(pd, n);
      const rel = `docs/${sub}/${n}`;
      try {
        const m = statSync(file).mtimeMs;
        if (!byRel.has(rel) || m > byRel.get(rel).m) byRel.set(rel, { file, rel, m });
      } catch { /* vanished */ }
    }
  }
  return [...byRel.values()];
}

// The file an approval prompt names ("approve plan docs/plans/x.md"), as a relative docs/ path, or ''.
export function namedDoc(prompt, stop) {
  const m = new RegExp(String.raw`^[ \t]*approve[ \t]+${stop}\b[ \t]+(\S+)`, 'im').exec(String(prompt ?? ''));
  if (!m) return '';
  const p = m[1].replace(/^[`'"(<]+|[`'")>.,;:!?]+$/g, '').replaceAll('\\', '/').replace(/^\.\//, '');
  if (!/\.md$/i.test(p)) return '';
  const at = p.lastIndexOf('docs/');
  return at >= 0 ? p.slice(at) : p;
}

const hashed = (c) => { try { return { file: c.file, rel: c.rel, sha: sha256Lf(readFileSync(c.file)) }; } catch { return null; } };
const nameList = (cands) => cands.map((c) => c.rel).sort().join(', ');

// The plan an "approve plan" is for: { plan: { file, rel, sha } } or { error }. With one docs/plans/*.md that is the plan;
// with several the owner must name one (`approve plan docs/plans/x.md`), so the approval never lands on a guess.
export function choosePlan(dirs, named = '') {
  const cands = mdCandidates(dirs, 'plans');
  if (!cands.length) return { error: 'no docs/plans/*.md' };
  let pick = cands[0];
  if (named) {
    pick = cands.find((c) => c.rel === named);
    if (!pick) return { error: `${named} is not a plan in docs/plans/ (${nameList(cands)})` };
  } else if (cands.length > 1) {
    return { error: `${cands.length} plans in docs/plans/ (${nameList(cands)}): name the one you approve, for example "approve plan ${[...cands].sort((a, b) => b.m - a.m)[0].rel}"` };
  }
  const plan = hashed(pick);
  return plan ? { plan } : { error: `${pick.rel} could not be read` };
}

// The newest docs/plans/*.md in any of `dirs`: { file (absolute), rel, sha } or null (the hand-off and the visibility look).
export function newestPlan(dirs) {
  const best = [...mdCandidates(dirs, 'plans')].sort((a, b) => b.m - a.m)[0];
  return best ? hashed(best) : null;
}

// The text of the plan's "## Changes" section, or null when it has none.
export function changesSection(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Changes\b/i.test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  return lines.slice(at + 1, end < 0 ? lines.length : end).join('\n');
}
