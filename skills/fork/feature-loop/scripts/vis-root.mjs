// Where the feature loop's files live for the visibility, hand-off and approval hooks (fork.9, gates.md "Visibility").
// Node 22, no dependencies. Shared by stage-hook.mjs and the modules it calls.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

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

// The newest docs/plans/*.md in any of `dirs`: { file (absolute), rel, sha } or null.
export function newestPlan(dirs) {
  let best = null;
  for (const d of new Set(dirs.filter(Boolean))) {
    const pd = join(d, 'docs', 'plans');
    let names = [];
    try { names = readdirSync(pd).filter((n) => n.endsWith('.md')); } catch { continue; }
    for (const n of names) {
      const file = join(pd, n);
      try {
        const m = statSync(file).mtimeMs;
        if (!best || m > best.m) best = { file, rel: `docs/plans/${n}`, m };
      } catch { /* vanished */ }
    }
  }
  if (!best) return null;
  try { return { file: best.file, rel: best.rel, sha: sha256(readFileSync(best.file)) }; } catch { return null; }
}

// The text of the plan's "## Changes" section, or null when it has none.
export function changesSection(md) {
  const lines = md.split(/\r?\n/);
  const at = lines.findIndex((l) => /^##\s+Changes\b/i.test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^##\s/.test(l));
  return lines.slice(at + 1, end < 0 ? lines.length : end).join('\n');
}
