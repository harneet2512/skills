// The time box of a feature loop (see ../gates.md, "The run file"): `demo_by` in .scratch/gates.json is the time by
// which the happy path must have passed a live run. Only a live run from this loop counts: a report newer than
// `started` in gates.json, or, without it, newer than gates.json itself, so another feature's old run never meets
// it. Shared by check-gates.mjs (--timebox) and loop-hooks.mjs (the SessionStart summary). Node 22, no dependencies.
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
// sinceMs: ignore reports older than this (the start of the loop).
export function livePassing(root, sinceMs = 0) {
  const best = newestLiveReport(root);
  if (!best || best.t <= sinceMs) return { rel: null, passing: false };
  try {
    const rep = JSON.parse(readFileSync(join(root, best.rel), 'utf8'));
    const scen = Array.isArray(rep?.scenarios) ? rep.scenarios : [];
    return { rel: best.rel, passing: scen.length > 0 && scen.every((s) => s?.result === 'pass') };
  } catch {
    return { rel: best.rel, passing: false };
  }
}

// A full date and time with a zone, so a deadline means the same instant on every machine. Date.parse rolls
// impossible dates over (February 30 becomes March 2), so each field is checked against the calendar first.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;
function parseIsoTime(field, v) {
  const m = typeof v === 'string' ? ISO_RE.exec(v) : null;
  const bad = () => new Error(`"${field}" must be an ISO 8601 time with a zone, for example "2026-10-12T17:00:00-04:00" or "2026-10-12T21:00:00Z"`);
  if (!m) throw bad();
  const [y, mo, d, h, mi, sec] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i] ?? 0));
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const offOk = m[7] === 'Z' || (Number(m[8]) <= 14 && Number(m[9]) <= 59);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59 || !offOk) throw bad();
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw bad();
  return new Date(t);
}

// Validates the optional demo_by field. Returns null when absent, the Date when valid, or throws with a message.
export function parseDemoBy(run) {
  return run?.demo_by === undefined ? null : parseIsoTime('demo_by', run.demo_by);
}

// Validates the optional started field (when the loop began). Returns null when absent.
export function parseStarted(run) {
  return run?.started === undefined ? null : parseIsoTime('started', run.started);
}

// The moment from which a live run counts for this loop: `started`, else the run file's mtime.
function loopStartMs(run, root) {
  const started = parseStarted(run);
  if (started) return started.getTime();
  try { return statSync(join(root, '.scratch', 'gates.json')).mtimeMs; } catch { return 0; }
}

// Small work may waive the live run ("live": "none: <reason>"); then there is nothing to time-box.
const waiverOf = (run) => (typeof run?.live === 'string' ? /^none:\s*(\S.*)$/.exec(run.live)?.[1]?.trim() ?? '' : '');

const now = () => {
  const fake = process.env.FEATURE_LOOP_NOW;
  const t = fake ? Date.parse(fake) : Date.now();
  return Number.isNaN(t) ? Date.now() : t;
};

const minutes = (ms) => Math.round(Math.abs(ms) / 60000);

// { state: 'none' | 'waived' | 'ok' | 'running' | 'overdue', line } for the run file and the loop root.
//   none     no demo_by
//   waived   the live run is waived in gates.json
//   ok       a passing live run is recorded (before or after the deadline)
//   running  no passing live run yet, the deadline is ahead
//   overdue  no passing live run, the deadline has passed
export function timebox(run, root) {
  const due = parseDemoBy(run);
  if (!due) return { state: 'none', line: 'time box: none (no "demo_by" in .scratch/gates.json)' };
  const waiver = waiverOf(run);
  if (waiver) return { state: 'waived', line: `time box: n/a, the live run is waived in .scratch/gates.json (${waiver})` };
  const live = livePassing(root, loopStartMs(run, root));
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
