// Evaluates the feature-loop gates (see ../gates.md). Called by check-gates.sh, which has already found the
// repo root, read the last commit time and validated the gate names. Node 22, no dependencies.
//
//   node check-gates.mjs --root <dir> --last-commit <unix seconds> --slop <slop-check.sh> [G1 ... G7]
//
// Exit: 0 every evaluated gate green (or n/a), 1 any red, 2 the run file is invalid.
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const ALL = ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'];
const NORMAL_UP = new Set(['normal', 'large']);
const APPLIES = {
  G1: (size) => NORMAL_UP.has(size),
  G2: () => true,
  G3: (size) => NORMAL_UP.has(size),
  G4: () => true, // decided by the envelope's Packs line, below
  G5: (size) => NORMAL_UP.has(size),
  G6: () => true,
  G7: (size) => NORMAL_UP.has(size),
};
const CASE_RE = /\bJ[0-9]+\.[a-z][a-z0-9-]*\b/g;
const PLACEHOLDER = /^(tbd|todo|\?|<[^>]*>)$/i;

// ---- arguments
const args = process.argv.slice(2);
let root = process.cwd(), lastCommit = 0, slop = '';
const wanted = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--root') root = args[++i];
  else if (a === '--last-commit') lastCommit = Number(args[++i]) || 0;
  else if (a === '--slop') slop = args[++i];
  else if (/^G[1-7]$/.test(a)) { if (!wanted.includes(a)) wanted.push(a); }
  else { console.error(`check-gates: unknown argument: ${a}`); process.exit(2); }
}
const selected = wanted.length ? ALL.filter((g) => wanted.includes(g)) : ALL;

// ---- the run file
const runPath = join(root, '.scratch', 'gates.json');
const die = (msg) => { console.error(msg); process.exit(2); };
let run;
try { run = JSON.parse(readFileSync(runPath, 'utf8')); }
catch (e) { die(`gates: invalid .scratch/gates.json: ${e.message}`); }
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

const P = {
  shape: `.scratch/shape/${slug}.md`,
  envelope: `.scratch/envelope/${slug}.md`,
  live: '.scratch/live',
  evals: `.scratch/evals/${slug}/results.json`,
  review: `.scratch/review/${slug}.md`,
  metrics: '.scratch/loop-metrics.md',
};
const abs = (p) => join(root, p);
const read = (p) => { try { return readFileSync(abs(p), 'utf8'); } catch { return null; } };
const newerThanCommit = (p) => statSync(abs(p)).mtimeMs / 1000 > lastCommit;
const listShort = (xs, n = 5) => xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`;

// ---- markdown helpers, tolerant of leading/trailing pipes, padding, backticks and bold in cells

// Split one table row into cells. Pipes inside backtick spans or escaped as \| do not split.
function splitRow(line) {
  let s = line.trim();
  if (!s.includes('|')) return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      if (tick === 0) tick = n; else if (tick === n) tick = 0;
      cur += '`'.repeat(n); i += n - 1; continue;
    }
    if (c === '|' && tick === 0) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}
const isSeparator = (line) => {
  const cells = splitRow(line);
  return !!cells && cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
};
// Cell text without markup: surrounding backticks, bold or italic markers, padding.
function clean(cell) {
  let s = (cell ?? '').trim();
  for (let k = 0; k < 3; k++) {
    s = s.replace(/^(\*\*|__|\*|_)(.*)\1$/s, '$2').trim();
    s = s.replace(/^(`+)(.*)\1$/s, '$2').trim();
  }
  return s;
}
const norm = (h) => clean(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const blank = (cell) => { const s = clean(cell); return s === '' || PLACEHOLDER.test(s); };

// Lines of a section whose heading text is `title` (any level), up to the next heading of the same or higher level.
// Fenced code blocks are skipped so an example inside ``` does not count.
function section(md, title) {
  const lines = md.split(/\r?\n/);
  let level = 0, out = null, fence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fence = !fence; if (out) out.push(''); continue; }
    if (fence) { if (out) out.push(''); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (out) { if (h[1].length <= level) break; out.push(line); continue; }
      if (norm(h[2]) === title) { level = h[1].length; out = []; }
      continue;
    }
    if (out) out.push(line);
  }
  return out;
}
// The first table in some lines: { header: [normalized names], rows: [[cells]] }.
function firstTable(lines) {
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = splitRow(lines[i]);
    if (!head || !isSeparator(lines[i + 1])) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length; j++) {
      if (!lines[j].trim() || !lines[j].includes('|')) break;
      const r = splitRow(lines[j]);
      if (r) rows.push(r);
    }
    return { header: head.map(norm), rows };
  }
  return null;
}
const caseIds = (text) => [...new Set(String(text ?? '').match(CASE_RE) ?? [])];

// Does the Packs line name the llm or retrieval pack? Backtick spans holding one word count as that word;
// longer spans (the triggering lines) are dropped. "no llm" or "not retrieval" does not count.
function packsNeedEvals(packs) {
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

function newestReport() {
  let best = null;
  let dirs = [];
  try { dirs = readdirSync(abs(P.live), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return null; }
  for (const d of dirs) {
    const rel = `${P.live}/${d.name}/report.json`;
    if (!existsSync(abs(rel))) continue;
    const t = statSync(abs(rel)).mtimeMs;
    if (!best || t > best.t || (t === best.t && rel > best.rel)) best = { rel, t };
  }
  return best && best.rel;
}

function G3() {
  const rel = newestReport();
  if (!rel) return red('no live run', `${P.live}/<run>/report.json`);
  const problems = [];
  if (!newerThanCommit(rel)) problems.push('newest live run is older than the last commit, rerun live-verify');
  let rep;
  try { rep = JSON.parse(readFileSync(abs(rel), 'utf8')); } catch (e) { return red(`report.json is not valid JSON: ${e.message}`, rel); }
  const scen = Array.isArray(rep?.scenarios) ? rep.scenarios : null;
  if (!scen || !scen.length) problems.push('no scenarios in the report');
  else {
    const failing = scen.filter((s) => s?.result !== 'pass').map((s) => `${s?.name ?? '(unnamed)'} [${s?.result ?? 'no result'}]`);
    if (failing.length) problems.push(`${failing.length} scenario${failing.length > 1 ? 's' : ''} not passing: ${listShort(failing, 3)}`);
  }
  const cases = shapeCases();
  if (cases === null) problems.push(`journey coverage unknown, shape file ${P.shape} missing`);
  else if (scen) {
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
  if (!value || !packsNeedEvals(value)) return na('envelope Packs names neither llm nor retrieval');
  if (!existsSync(abs(P.evals))) return red('eval results missing', P.evals);
  const problems = [];
  if (!newerThanCommit(P.evals)) problems.push('eval results are older than the last commit, rerun the evals');
  let res;
  try { res = JSON.parse(readFileSync(abs(P.evals), 'utf8')); } catch (e) { return red(`results.json is not valid JSON: ${e.message}`, P.evals); }
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

function justifiedLines() {
  const md = read(P.review);
  if (md === null) return null;
  return (section(md, 'justified') ?? []).map((l) => l.replace(/`/g, ''));
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function isJustified(lines, loc) {
  const re = new RegExp(`(^|[\\s(\\[,;])(\\./)?${escapeRe(loc)}(?![0-9])`);
  return lines.some((l) => {
    if (!re.test(l)) return false;
    const reason = l
      .replace(/^\s*[-*+]\s*/, '')
      .replace(/\S+:[0-9]+/g, ' ')
      .replace(/\b(CRAFT-[0-9]+|SLOP)(\.[a-z-]+)?\b/g, ' ');
    return /[A-Za-z]{3,}/.test(reason);
  });
}

function G6() {
  if (!slop || !existsSync(slop)) return red('slop-check.sh not found next to the feature loop', slop || 'concern-topics/scripts/slop-check.sh');
  const argv = [slop, '--diff'];
  if (base) argv.push(base);
  const r = spawnSync('bash', argv, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status === 0) return green();
  if (r.status !== 1) {
    const why = (r.stderr || r.stdout || String(r.error ?? 'no output')).trim().split('\n')[0];
    return red(`slop-check could not run: ${why}`, '.scratch/gates.json base');
  }
  const findings = r.stdout.split('\n').filter(Boolean).map((l) => { const [rule, loc] = l.split('\t'); return { rule, loc }; });
  const lines = justifiedLines() ?? [];
  const open = findings.filter((f) => !isJustified(lines, f.loc)).map((f) => `${f.rule} ${f.loc}`);
  if (open.length) return red(`slop findings not justified under ## Justified: ${listShort(open)}`, P.review);
  return green();
}

function G7() {
  const md = read(P.metrics);
  if (md === null) return red(`no metrics line containing ${slug}`, P.metrics);
  // A bypass record names the slug too, but it is not the change's numbers.
  const ok = md.split(/\r?\n/).some((l) => l.includes(slug) && !/gates bypassed:/.test(l));
  return ok ? green() : red(`no metrics line containing ${slug}`, P.metrics);
}

const IMPL = { G1, G2, G3, G4, G5, G6, G7 };
const SIZE_NOTE = 'applies to normal and large only';
const counts = { green: 0, red: 0, na: 0 };
for (const g of selected) {
  let r;
  if (!APPLIES[g](size)) r = na(`${SIZE_NOTE}, size is ${size}`);
  else {
    try { r = IMPL[g](); } catch (e) { r = { state: 'red', msg: `check crashed: ${e.message}` }; }
  }
  counts[r.state]++;
  if (r.state === 'green') console.log(`${g} green`);
  else if (r.state === 'red') console.log(`${g} red: ${r.msg}`);
  else console.log(`${g} n/a: ${r.msg}`);
}
const verdict = counts.red ? 'red' : 'green';
console.log(`gates: ${verdict} for ${slug} (size ${size}): ${counts.green} green, ${counts.red} red, ${counts.na} n/a`);
process.exit(counts.red ? 1 : 0);
