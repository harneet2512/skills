// Evaluates the feature-loop gates (see ../gates.md). Called by check-gates.sh, which has already found the
// repo root, read the last commit time and validated the gate names. Node 22, no dependencies.
//
//   node check-gates.mjs --root <dir> [--work <dir>] --last-commit <unix seconds> --slop <slop-check.sh>
//                        [--phase build|merge|pr|close] [--require-stages] [G1 ... G12]
//   node check-gates.mjs --root <dir> --timebox
//   node check-gates.mjs --root <dir> --plan-check [<plan file>]   (needs no run file; see plan-check.mjs)
//
// --root holds .scratch/; --work is the git worktree whose code G6 scans (default: --root). A phase narrows the
// gates to those due at that point of the loop; gate IDs narrow them further.
// --timebox prints only the time box (demo_by against the newest passing live run): exit 0 when it is met, still
// running or not set, 1 when it is overdue.
//
// Exit: 0 every evaluated gate green (or n/a), 1 any red, 2 the run file is invalid.
// --plan-check: 0 plan complete, 1 sections missing or empty or a Changed line without a reason, 2 no plan file.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { clean, blank, section, firstTable } from './md-table.mjs';
import { checkPlan } from './plan-check.mjs';
import { checkStages } from './stage-gate.mjs';
import { appendEntry, storeStatus } from './stage-log.mjs';
import { planSnapshot } from './stage-detect.mjs';
import { g8 } from './gates-ledger.mjs';
import { newestLiveReport, timebox } from './timebox.mjs';
import { validateRunFields } from './gates-runfile.mjs';
import { headFresh } from './gates-head.mjs';
import { loadApprovals } from './gates-approvals.mjs';
import { g10, g11 } from './gates-codex.mjs';
import { g12 } from './gates-acceptance.mjs';
import { g4Bypass, packsNeedEvals, recordG4Red } from './gates-g4.mjs';
import { ciGreen, prApproval } from './gates-pr.mjs';

const ALL = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12'];
const NORMAL_UP = new Set(['normal', 'large']);
const APPLIES = {
  G1: (size) => NORMAL_UP.has(size),
  G2: () => true,
  G3: () => true, // every size runs live; small proves the happy path only, and may waive it in gates.json, below
  G4: () => true, // decided by the envelope's Packs line, below
  G5: (size) => NORMAL_UP.has(size),
  G6: () => true,
  G7: (size) => NORMAL_UP.has(size),
  G8: () => true, // decided by whether .scratch/loop-status.md exists, below
  G9: () => true, // decided by whether the hooks made .scratch/.loop/, below
  G10: () => true, // codex plan review, all sizes (fork.9)
  G11: () => true, // codex code attack, all sizes
  G12: () => true, // acceptance tests, all sizes
};
// G10 to G12 belong to loops that run the fork.9 flow, which gates.json says with "plan_sha". Outside the pr phase a loop
// without it leaves them out (like G9 without hooks); the pr phase always evaluates them, so no PR opens without them.
const CODEX_FLOW = ['G10', 'G11', 'G12'];
// Which gates are due when: build = before the first push, pr = before the PR is opened (G7, the metrics line, is written
// after the owner's merge, so it is the close gate), merge = the fork.8 merge phase, close = all of them.
const PHASES = {
  build: ['G1', 'G2', 'G8', 'G9'],
  merge: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G8', 'G9', ...CODEX_FLOW],
  pr: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G8', 'G9', ...CODEX_FLOW],
  close: ALL,
};
const CASE_RE = /\bJ[0-9]+\.[a-z][a-z0-9-]*\b/g;

// ---- arguments
const args = process.argv.slice(2);
let root = process.cwd(), work = '', lastCommit = 0, slop = '', phase = '', timeboxOnly = false, planCheck = null, requireStages = false;
const wanted = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') root = args[++i];
  else if (a === '--work') work = args[++i];
  else if (a === '--phase') { phase = args[++i]; if (!PHASES[phase]) { console.error(`check-gates: unknown phase: ${phase}`); process.exit(2); } }
  else if (a === '--last-commit') lastCommit = Number(args[++i]) || 0;
  else if (a === '--slop') slop = args[++i];
  else if (a === '--timebox') timeboxOnly = true;
  else if (a === '--require-stages') requireStages = true;
  else if (a === '--plan-check') planCheck = args[++i] ?? '';
  else if (/^G([1-9]|1[0-2])$/.test(a)) { if (!wanted.includes(a)) wanted.push(a); }
  else { console.error(`check-gates: unknown argument: ${a}`); process.exit(2); }
}
work = work || root;
// G9 reads the signed log the stage hooks write in .scratch/.loop/. Where no hook has run, it is left out of a general
// check (it prints and counts nothing) and says n/a only when asked for by name; with --require-stages (the push and
// merge hooks pass it) a loop with no signed init entry is red instead.
const selected = ALL.filter((g) => (!phase || PHASES[phase].includes(g)) && (!wanted.length || wanted.includes(g)));

// ---- the approved plan: checked before the run file exists, because the plan is written first
if (planCheck !== null) {
  const r = checkPlan(root, planCheck);
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}

// ---- the run file
const runPath = join(root, '.scratch', 'gates.json');
const die = (msg) => { console.error(msg); process.exit(2); };
let run;
try { run = JSON.parse(readFileSync(runPath, 'utf8')); }
catch (e) { die(`gates: invalid .scratch/gates.json: ${e.message}`); }
if (run?.status === 'closed') {
  console.log('gates: loop closed (.scratch/gates.json says "status": "closed"), nothing to check');
  process.exit(0);
}
const slug = typeof run?.slug === 'string' ? run.slug : '';
const size = typeof run?.size === 'string' ? run.size : '';
const base = typeof run?.base === 'string' && run.base ? run.base : '';
// The slug becomes part of file paths, so it may not climb out of .scratch/.
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(slug) || slug.includes('..')) {
  console.error('gates: .scratch/gates.json: "slug" must be a plain name (letters, digits, ".", "_", "-")');
  process.exit(2);
}
if (!['small', 'normal', 'large'].includes(size)) {
  console.error('gates: .scratch/gates.json: "size" must be small, normal or large');
  process.exit(2);
}
let liveWaiver = '';
try { liveWaiver = validateRunFields(run, size); } catch (e) { die(e.message); }

if (timeboxOnly) {
  const tb = timebox(run, root);
  console.log(tb.line);
  process.exit(tb.state === 'overdue' ? 1 : 0);
}

const P = {
  shape: `.scratch/shape/${slug}.md`,
  envelope: `.scratch/envelope/${slug}.md`,
  live: '.scratch/live',
  evals: `.scratch/evals/${slug}/results.json`,
  review: `.scratch/review/${slug}.md`,
  metrics: '.scratch/loop-metrics.md',
  status: '.scratch/loop-status.md',
};
const abs = (p) => join(root, p);
const read = (p) => { try { return readFileSync(abs(p), 'utf8'); } catch { return null; } };
const listShort = (xs, n = 5) => xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`;

// ---- markdown helpers live in md-table.mjs
const caseIds = (text) => [...new Set(String(text ?? '').match(CASE_RE) ?? [])];

// ---- the gates. Each returns { state: 'green' | 'red' | 'na', msg }.
const green = () => ({ state: 'green' });
const red = (what, file) => ({ state: 'red', msg: `${what} (${file})` });
const na = (why) => ({ state: 'na', msg: why });

let shapeCache;
function shapeCases() {
  if (shapeCache === undefined) { const md = read(P.shape); shapeCache = md === null ? null : caseIds(md); }
  return shapeCache;
}

function envelopePacks() {
  const md = read(P.envelope);
  if (md === null) return { md: null };
  const line = md.split(/\r?\n/).find((l) => /^\s*[-*]?\s*\*\*Packs:?\*\*:?/.test(l));
  const value = line ? line.replace(/^\s*[-*]?\s*\*\*Packs:?\*\*:?/, '').trim() : null;
  return { md, value };
}

function G1() {
  const cases = shapeCases();
  if (cases === null) return red('shape file missing', P.shape);
  if (!cases.length) return red('no journey case ID like J3.two-actors', P.shape);
  return green();
}

function G2() {
  const { md, value } = envelopePacks();
  if (md === null) return red('envelope file missing', P.envelope);
  const problems = [];
  if (value === null) problems.push('no **Packs:** line');
  else if (blank(value)) problems.push('**Packs:** line is empty');
  const live = section(md, 'live');
  const table = live && firstTable(live);
  if (!table) problems.push('no ## Live table');
  else {
    const need = ['severity', 'mechanism', 'enforced at', 'proof'];
    const col = Object.fromEntries(need.map((n) => [n, table.header.indexOf(n)]));
    const missing = need.filter((n) => col[n] < 0);
    if (missing.length) problems.push(`## Live table has no ${missing.join(', ')} column`);
    else if (!table.rows.length) {
      // A small change may honestly have nothing to guard; a normal or large one always has a failure path.
      if (NORMAL_UP.has(size)) problems.push('Live table empty on a normal or large change');
    } else {
      const idCol = table.header.indexOf('id');
      const bad = [];
      table.rows.forEach((r, k) => {
        const holes = need.filter((n) => blank(r[col[n]])).map((n) => {
          const v = clean(r[col[n]]);
          const name = n[0].toUpperCase() + n.slice(1);
          return v === '' ? `${name} empty` : `${name} ${v}`;
        });
        if (holes.length) bad.push(`${(idCol >= 0 && clean(r[idCol])) || `row ${k + 1}`} (${holes.join(', ')})`);
      });
      if (bad.length) problems.push(`Live rows not filled: ${listShort(bad, 4)}`);
    }
  }
  return problems.length ? red(problems.join('; '), P.envelope) : green();
}

function G3() {
  if (liveWaiver) return na(`live run waived in .scratch/gates.json: ${liveWaiver}`);
  const rel = newestLiveReport(root)?.rel ?? null;
  if (!rel) return red('no live run', `${P.live}/<run>/report.json`);
  const problems = [];
  let rep;
  try { rep = JSON.parse(readFileSync(abs(rel), 'utf8')); } catch (e) { return red(`report.json is not valid JSON: ${e.message}`, rel); }
  // Fresh means the head the run recorded is HEAD (or HEAD with only non-source changes since), never the file time.
  const fresh = headFresh(work, rep?.head);
  if (!fresh.ok) problems.push(`live run ${fresh.msg}, rerun live-verify (the runner records "head" in report.json)`);
  const scen = Array.isArray(rep?.scenarios) ? rep.scenarios : null;
  if (!scen || !scen.length) problems.push('no scenarios in the report');
  else {
    const failing = scen.filter((s) => s?.result !== 'pass').map((s) => `${s?.name ?? '(unnamed)'} [${s?.result ?? 'no result'}]`);
    if (failing.length) problems.push(`${failing.length} scenario${failing.length > 1 ? 's' : ''} not passing: ${listShort(failing, 3)}`);
  }
  // Small work proves its happy path; journey coverage is for normal and large, which have a shape file (G1).
  const cases = NORMAL_UP.has(size) ? shapeCases() : [];
  if (cases === null) problems.push(`journey coverage unknown, shape file ${P.shape} missing`);
  else if (scen && cases.length) {
    const covered = new Set(scen.flatMap((s) => caseIds([].concat(s?.journey ?? []).join(' '))));
    const missing = cases.filter((c) => !covered.has(c));
    if (missing.length) problems.push(`journey cases in no scenario: ${listShort(missing)}`);
  }
  return problems.length ? red(problems.join('; '), rel) : green();
}

function G4() {
  const { md, value } = envelopePacks();
  // Without the envelope nobody can say evals are not needed, so fail closed.
  if (md === null) return red('cannot tell whether evals apply: envelope file missing', P.envelope);
  // Editing the Packs line after a red G4 is a bypass: red until the reason is recorded (gates-g4.mjs).
  const bypass = g4Bypass(root, slug, value);
  const r = g4Core(value);
  if (r.state === 'red') recordG4Red(root, value, process.env.FEATURE_LOOP_NOW || new Date().toISOString());
  if (bypass) return red(bypass, P.metrics);
  return r;
}

function g4Core(value) {
  if (!value || !packsNeedEvals(value)) return na('envelope Packs names neither llm nor retrieval');
  if (!existsSync(abs(P.evals))) return red('eval results missing', P.evals);
  const problems = [];
  let res;
  try { res = JSON.parse(readFileSync(abs(P.evals), 'utf8')); } catch (e) { return red(`results.json is not valid JSON: ${e.message}`, P.evals); }
  const fresh = headFresh(work, res?.head);
  if (!fresh.ok) problems.push(`eval results ${fresh.msg}, rerun the evals (run-evals.mjs records "head" in results.json)`);
  const gates = Array.isArray(res?.gates) ? res.gates : [];
  if (!gates.length) problems.push('no gates in results.json, run the evals with at least one --gate');
  else {
    const bad = gates.filter((g) => g?.ok !== true).map((g) => String(g?.gate ?? JSON.stringify(g)));
    if (bad.length) problems.push(`eval gates not ok: ${listShort(bad, 3)}`);
  }
  return problems.length ? red(problems.join('; '), P.evals) : green();
}

function G5() {
  const md = read(P.review);
  if (md === null) return red('review file missing', P.review);
  const sec = section(md, 'findings');
  const table = sec && firstTable(sec);
  if (!table) return red('no ## Findings table', P.review);
  const need = ['severity', 'status', 'resolution'];
  const col = Object.fromEntries(need.map((n) => [n, table.header.indexOf(n)]));
  const missing = need.filter((n) => col[n] < 0);
  if (missing.length) return red(`## Findings table has no ${missing.join(', ')} column`, P.review);
  const idCol = table.header.indexOf('id');
  const open = table.rows.filter((r) => {
    const status = clean(r[col.status]).toUpperCase();
    const sev = clean(r[col.severity]).toUpperCase();
    const resolution = clean(r[col.resolution]);
    return status === 'CONFIRMED' && (sev === 'CRITICAL' || sev === 'HIGH') && (blank(resolution) || /^open\b/i.test(resolution));
  }).map((r, k) => `${(idCol >= 0 && clean(r[idCol])) || `row ${k + 1}`} ${clean(r[col.severity]).toUpperCase()}`);
  if (open.length) return red(`open CONFIRMED finding${open.length > 1 ? 's' : ''}: ${listShort(open)}`, P.review);
  return green();
}

// The justification rule ("## Justified" in the review file, a reason on the line) lives in slop-check.sh --justified,
// the same code the commit hook runs, so the commit hook and this gate cannot disagree about a review file.
function G6() {
  if (!slop || !existsSync(slop)) return red('slop-check.sh not found next to the feature loop', slop || 'concern-topics/scripts/slop-check.sh');
  const argv = [slop, '--diff'];
  if (base) argv.push(base);
  if (existsSync(abs(P.review))) argv.push('--justified', abs(P.review).replaceAll('\\', '/'));
  const r = spawnSync('bash', argv, { cwd: work, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return green();
  if (r.status !== 1) {
    const why = (r.stderr || r.stdout || String(r.error ?? 'no output')).trim().split('\n')[0];
    return red(`slop-check could not run: ${why}`, '.scratch/gates.json base');
  }
  const open = r.stdout.split('\n').filter(Boolean).map((l) => { const [rule, loc] = l.split('\t');return `${rule} ${loc}`; });
  return red(`slop findings not justified under ## Justified: ${listShort(open)}`, P.review);
}

// How many findings in the review file are CONFIRMED, of any severity.
function confirmedCount() {
  const md = read(P.review);
  const table = md && firstTable(section(md, 'findings') ?? []);
  const status = table ? table.header.indexOf('status') : -1;
  return status < 0 ? 0 : table.rows.filter((r) => clean(r[status]).toUpperCase() === 'CONFIRMED').length;
}

function G7() {
  const md = read(P.metrics);
  if (md === null) return red(`no metrics line containing ${slug}`, P.metrics);
  // A bypass record names the slug too, but it is not the change's numbers.
  const lines = md.split(/\r?\n/).filter((l) => l.includes(slug) && !/gates bypassed:/.test(l));
  if (!lines.length) return red(`no metrics line containing ${slug}`, P.metrics);
  const confirmed = confirmedCount();
  if (!confirmed) return green();
  // Every CONFIRMED finding is a defect that got past the earlier layers, so the line must count at least that many
  // escapes=<n>, and each escape must have raised a floor (a check, pack item, scenario or eval case): floors=<m>,
  // m at least n. Only the last line for the slug is the change's final numbers.
  const last = lines[lines.length - 1];
  const e = /(?:^|[^A-Za-z0-9_])escapes=([0-9]+)/.exec(last);
  const f = /(?:^|[^A-Za-z0-9_])floors=([0-9]+)/.exec(last);
  if (!e || !f) return red(`the review has CONFIRMED findings, so a ${slug} metrics line needs escapes=<n> floors=<m>`, P.metrics);
  const escapes = Number(e[1]), floors = Number(f[1]);
  if (escapes < confirmed) {
    return red(`escapes=${escapes} is below the ${confirmed} CONFIRMED finding${confirmed > 1 ? 's' : ''} in ${P.review}: every CONFIRMED finding is an escape`, P.metrics);
  }
  if (floors < escapes) {
    return red(`floors=${floors} is below escapes=${escapes}, so an escape raised no floor (a check, pack item, scenario or eval case)`, P.metrics);
  }
  return green();
}

const G8 = () => g8({ read, readPlan, statusFile: P.status });

// The plan is a tracked file (docs/plans/), so read it from the loop root, else from the worktree being checked.
function readPlan(p) {
  const fromRoot = read(p);
  if (fromRoot !== null || work === root) return fromRoot;
  try { return readFileSync(join(work, p), 'utf8'); } catch { return null; }
}

function G9() {
  const r = checkStages({ root, work, run, phase: phase || 'close', require: requireStages });
  return r.state === 'red' ? red(r.msg, r.file ?? '.scratch/.loop') : r;
}

// The approvals come from the signed log; they are read once, and only when a gate that needs them is going to run.
const needsApprovals = selected.some((g) => ['G10', 'G12'].includes(g)) || phase === 'pr';
const appr = needsApprovals ? await loadApprovals(root) : { ok: false, why: 'not loaded' };
const planFile = planSnapshot(root, slug).file ?? '';
const codexCtx = { root, work, run, slug, appr, readPlan, planFile };
const G10 = () => g10(codexCtx);
const G11 = () => g11(codexCtx);
const G12 = () => g12(codexCtx);

const IMPL = { G1, G2, G3, G4, G5, G6, G7, G8, G9, G10, G11, G12 };
const SIZE_NOTE = 'applies to normal and large only';
const counts = { green: 0, red: 0, na: 0 };
let stagesChecked = false;
for (const g of selected) {
  if (g === 'G9' && !wanted.includes('G9') && !requireStages && storeStatus(root).kind === 'none') continue;
  if (CODEX_FLOW.includes(g) && !wanted.includes(g) && phase !== 'pr' && run.plan_sha === undefined) continue;
  let r;
  if (!APPLIES[g](size)) r = na(`${SIZE_NOTE}, size is ${size}`);
  else {
    try { r = IMPL[g](); } catch (e) { r = { state: 'red', msg: `check crashed: ${e.message}` }; }
  }
  counts[r.state]++;
  if (g === 'G9' && r.state !== 'na') stagesChecked = true;
  if (r.state === 'green') console.log(`${g} green`);
  else if (r.state === 'red') console.log(`${g} red: ${r.msg}`);
  else console.log(`${g} n/a: ${r.msg}`);
}
// The pr phase also needs CI on the exact HEAD of the pushed branch and the owner's signed `approve pr` for it.
if (phase === 'pr' && !wanted.length) {
  for (const [name, check] of [['PR-CI', ciGreen], ['PR-APPROVAL', prApproval]]) {
    let r;
    try { r = check(codexCtx); } catch (e) { r = { state: 'red', msg: `check crashed: ${e.message}` }; }
    counts[r.state]++;
    console.log(r.state === 'green' ? `${name} green` : `${name} red: ${r.msg}`);
  }
}
const verdict = counts.red ? 'red' : 'green';
// A close phase that passes every gate, G9 included, is signed into the log: the hooks accept "status": "closed" only
// after that entry exists (a loop closed by hand, or a deleted gates.json, is refused at push and merge).
if (!counts.red && stagesChecked && !wanted.length && (!phase || phase === 'close')) {
  appendEntry(root, { kind: 'close', ts: process.env.FEATURE_LOOP_NOW || new Date().toISOString(), slug });
}
console.log(`gates: ${verdict} for ${slug} (size ${size}): ${counts.green} green, ${counts.red} red, ${counts.na} n/a`);
process.exit(counts.red ? 1 : 0);
