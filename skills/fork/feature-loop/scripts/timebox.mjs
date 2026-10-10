// The time box of a feature loop (see ../gates.md, "The run file"): `demo_by` in .scratch/gates.json is the time by
// which the happy path must have passed a live run. Shared by check-gates.mjs (--timebox) and loop-hooks.mjs
// (the SessionStart summary). Node 22, no dependencies.
//
// FEATURE_LOOP_NOW (an ISO 8601 time) replaces the clock, for tests.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// The newest .scratch/live/<run>/report.json under root: { rel, t } or null.
export function newestLiveReport(root) {
  const live = join(root, '.scratch', 'live');
  let dirs = [];
  try { dirs = readdirSync(live, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  let best = null;
  for (const d of dirs) {
    const rel = `.scratch/live/${d.name}/report.json`;
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const t = statSync(p).mtimeMs;
    if (!best || t > best.t || (t === best.t && rel > best.rel)) best = { rel, t };
  }
  return best;
}

// Has the newest live run passed? A run passes when it has at least one scenario and every scenario passed.
export function livePassing(root) {
  const best = newestLiveReport(root);
  if (!best) return { rel: null, passing: false };
  try {
    const rep = JSON.parse(readFileSync(join(root, best.rel), 'utf8'));
    const scen = Array.isArray(rep?.scenarios) ? rep.scenarios : [];
    return { rel: best.rel, passing: scen.length > 0 && scen.every((s) => s?.result === 'pass') };
  } catch {
    return { rel: best.rel, passing: false };
  }
}

// Validates the optional demo_by field. Returns null when absent, the Date when valid, or throws with a message.
export function parseDemoBy(run) {
  if (run?.demo_by === undefined) return null;
  const v = run.demo_by;
  // A full date and time with a zone, so "the deadline" means the same instant on every machine.
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(v) || Number.isNaN(Date.parse(v))) {
    throw new Error('"demo_by" must be an ISO 8601 time with a zone, for example "2026-10-12T17:00:00-04:00"');
  }
  return new Date(v);
}

const now = () => {
  const fake = process.env.FEATURE_LOOP_NOW;
  const t = fake ? Date.parse(fake) : Date.now();
  return Number.isNaN(t) ? Date.now() : t;
};

const minutes = (ms) => Math.round(Math.abs(ms) / 60000);

// { state: 'none' | 'ok' | 'running' | 'overdue', line } for the run file and the loop root.
//   none     no demo_by
//   ok       a passing live run is recorded (before or after the deadline)
//   running  no passing live run yet, the deadline is ahead
//   overdue  no passing live run, the deadline has passed
export function timebox(run, root) {
  const due = parseDemoBy(run);
  if (!due) return { state: 'none', line: 'time box: none (no "demo_by" in .scratch/gates.json)' };
  const live = livePassing(root);
  const left = due.getTime() - now();
  if (live.passing) return { state: 'ok', line: `time box: met, a passing live run is recorded (${live.rel})` };
  if (left > 0) {
    return { state: 'running', line: `time box: ${minutes(left)} min left until demo_by ${run.demo_by}, and no passing live run is recorded yet. Get the happy path running live before any more review, eval or hardening work.` };
  }
  return {
    state: 'overdue',
    line: `time box: OVERDUE by ${minutes(left)} min (demo_by ${run.demo_by}) with no passing live run. Stop starting review, eval or hardening work. Either get the happy path passing in live-verify now, or set the ledger stage to "blocked: <what stops the live run>" and tell the user.`,
  };
}
