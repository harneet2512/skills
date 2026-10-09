// The Stop and SessionStart hooks of the feature loop (see stop-hook.sh and session-start-hook.sh). Node 22, no
// dependencies. Both read the hook payload from stdin and look at `.scratch/gates.json` and `.scratch/loop-status.md`.
//
//   node loop-hooks.mjs stop           exit 2 with a reason when a stage is `running` with no result, else exit 0
//   node loop-hooks.mjs session-start  print a summary for the model's context when the loop is running; exit 0
//
// loop-status.md holds a table with the header `| Stage | Skill | Status | Gate | Evidence | Output | Finished |`,
// read by column name. A Status is `pending`, `running`, `done`, `skipped: <why>` or `blocked: <decision needed>`.
import { readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean, tables } from './md-table.mjs';

const mode = process.argv[2];
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(raw) ?? {}; } catch { /* not JSON: fall back to the environment */ }

// Never fail the session or the stop on our own error.
const finish = (code, stdout = '', stderr = '') => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
};

const hasRunFile = (dir) => !!dir && existsSync(join(dir, '.scratch', 'gates.json'));
const gitOut = (cwd, args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

// The directory holding .scratch/gates.json for the session: the cwd, else the git top level, else the main worktree
// of the repository (.scratch/ is untracked, so a linked worktree has none of its own). Null when there is no
// loop, or when gates.json says "status": "closed": the hooks stay silent for a closed loop.
function findRoot() {
  const start = resolve((typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let dir = null;
  if (hasRunFile(start)) dir = start;
  else {
    const top = gitOut(start, ['rev-parse', '--show-toplevel']);
    const common = gitOut(start, ['rev-parse', '--git-common-dir']);
    const main = common && basename(resolve(start, common)) === '.git' ? dirname(resolve(start, common)) : '';
    dir = [top, main].find(hasRunFile) ?? null;
  }
  if (!dir) return null;
  try { if (JSON.parse(readFileSync(join(dir, '.scratch', 'gates.json'), 'utf8'))?.status === 'closed') return null; } catch { /* not JSON: still a loop */ }
  return dir;
}

// The stage table: [{ stage, skill, status }] in file order, or null when there is no readable table.
function readStages(root) {
  let md;
  try { md = readFileSync(join(root, '.scratch', 'loop-status.md'), 'utf8'); } catch { return null; }
  const table = tables(md.split(/\r?\n/)).find((t) => t.header.includes('status') && t.header.includes('stage'));
  if (!table) return null;
  const col = (name) => table.header.indexOf(name);
  const cell = (r, name) => (col(name) < 0 ? '' : clean(r[col(name)] ?? ''));
  return table.rows.map((r) => ({ stage: cell(r, 'stage'), skill: cell(r, 'skill'), status: cell(r, 'status') }));
}
const statusKind = (s) => /^(running|done|pending|skipped|blocked)\b/i.exec(s.trim())?.[1].toLowerCase() ?? 'other';
const label = (s) => [s.stage, s.skill].filter(Boolean).join(' ');

function stop() {
  if (input.stop_hook_active === true) finish(0); // already continuing because of a Stop hook: no loops
  const root = findRoot();
  const stages = root && readStages(root);
  if (!stages) finish(0);
  const running = stages.filter((s) => statusKind(s.status) === 'running');
  if (!running.length) finish(0);
  const lines = running.map((s) => `feature-loop: stage ${label(s)} is running with no result; finish it and record its gate result, or mark it "blocked: <decision needed>" in .scratch/loop-status.md`);
  finish(2, '', lines.join('\n') + '\n');
}

function sessionStart() {
  const root = findRoot();
  if (!root) finish(0);
  let run;
  try { run = JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8')); } catch { finish(0); }
  const slug = typeof run?.slug === 'string' ? run.slug : '';
  const size = typeof run?.size === 'string' ? run.size : '';
  if (!slug) finish(0);
  const head = `feature-loop is running for "${slug}" (size ${size || 'unknown'})`;
  const stages = readStages(root);
  if (!stages) finish(0, `${head}; no .scratch/loop-status.md yet. Record each stage there as you go (see skills/fork/feature-loop).\n`);
  const open = stages.filter((s) => statusKind(s.status) !== 'done');
  const next = stages.find((s) => !['done', 'skipped'].includes(statusKind(s.status)));
  const out = [`${head}.`];
  if (open.length) {
    out.push('Stages not done:', ...open.map((s) => `- ${label(s)}: ${s.status || 'no status'}`));
  }
  out.push(next ? `Resume at: stage ${label(next)} (${next.status || 'no status'})` : 'Every stage is done or skipped.');
  finish(0, out.join('\n') + '\n');
}

try {
  if (mode === 'stop') stop();
  else if (mode === 'session-start') sessionStart();
  else finish(0);
} catch {
  finish(0);
}
