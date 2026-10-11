// The append-only timeline of the feature loop (fork.9, gates.md "Visibility"): .scratch/timeline.md, one table row per
// event: `| time UTC | event | detail | evidence |`. Node 22, no dependencies.
//
//   import { appendTimeline, timelineActive } from './timeline.mjs'
//   node timeline.mjs <root> <event> <detail> [evidence]     append one row (for scripts, e.g. codex-review.sh)
//
// Active only while a loop runs (gates.json present and not closed) or a plan is in review or approved (the signed log
// holds a hand-off or approval entry and there is no gates.json). Appending never fails the caller: false on any error.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLog } from './stage-log.mjs';

const HEADER = '| time UTC | event | detail | evidence |\n|---|---|---|---|\n';
const MAX_CELL = 220;
export const timelinePath = (root) => join(root, '.scratch', 'timeline.md');
const stamp = () => (process.env.FEATURE_LOOP_NOW || new Date().toISOString()).replace(/\.\d+Z$/, 'Z');
const cell = (s) => {
  const t = String(s ?? '').replace(/\r?\n/g, ' ').replaceAll('|', '\\|').trim();
  return t.length > MAX_CELL ? `${t.slice(0, MAX_CELL - 1)}…` : t;
};

export function timelineActive(root) {
  const run = join(root, '.scratch', 'gates.json');
  if (existsSync(run)) {
    try { return JSON.parse(readFileSync(run, 'utf8'))?.status !== 'closed'; } catch { return true; }
  }
  const log = readLog(root);
  return log.entries.some((e) => e.kind === 'handoff' || e.kind === 'approval');
}

export function appendTimeline(root, event, detail, evidence = '') {
  try {
    const p = timelinePath(root);
    mkdirSync(join(root, '.scratch'), { recursive: true });
    const head = existsSync(p) ? '' : HEADER;
    appendFileSync(p, `${head}| ${stamp()} | ${cell(event)} | ${cell(detail)} | ${cell(evidence)} |\n`);
    return true;
  } catch { return false; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [root, event, detail, evidence] = process.argv.slice(2);
  if (!root || !event) { process.stderr.write('usage: timeline.mjs <root> <event> <detail> [evidence]\n'); process.exit(2); }
  process.exit(appendTimeline(root, event, detail ?? '', evidence ?? '') ? 0 : 1);
}
