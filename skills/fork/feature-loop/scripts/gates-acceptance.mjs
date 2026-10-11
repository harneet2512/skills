// G12 (acceptance), fork.9, see ../gates.md. The plan's `## Acceptance tests` are the final oracle: every item maps to
// an automated test or a live-verify scenario in .scratch/acceptance.md, passing on HEAD, and the owner approved them.
//
// Plan items: list lines (`- `, `1. `) or table rows under the heading. An item's id is a leading `AT<n>` or `AT-<n>`
// (case-insensitive); items without one are numbered AT1, AT2 ... in order.
// .scratch/acceptance.md: a table `| AT id | test path or scenario name | last result on <sha> |`. The result cell is
// `pass <sha>` (or `fail <sha>`); the sha must be HEAD, or HEAD with only non-source changes since (gates-head.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { clean, firstTable, section, splitRow, isSeparator } from './md-table.mjs';
import { git } from './stage-detect.mjs';
import { headFresh, isSha } from './gates-head.mjs';
import { hasApproval } from './gates-approvals.mjs';
import { acceptanceKey } from './acceptance-key.mjs';

const red = (msg, file) => ({ state: 'red', msg: `${msg} (${file})` });
const ACCEPTANCE = '.scratch/acceptance.md';
const ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/;
const normId = (s) => s.toUpperCase().replace(/^AT-?/, 'AT');
const MAX_MSG = 600;

// The acceptance tests of the plan, in order: [{ id, text }], or null when the plan has no such section.
export function acceptanceItems(planMd) {
  const sec = planMd === null ? null : section(planMd, 'acceptance tests');
  if (!sec) return null;
  const items = [];
  const rows = sec.filter((l) => l.trim());
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i];
    const bullet = ITEM_RE.exec(line);
    let text = bullet ? bullet[1] : null;
    if (text === null && line.includes('|') && !isSeparator(line)) {
      if (rows[i + 1] && isSeparator(rows[i + 1])) { i++; continue; } // a table header
      text = (splitRow(line) ?? []).map(clean).filter(Boolean).join(' ');
    }
    if (text === null || !text.trim()) continue;
    const m = /^\**(AT-?\d+)\b/i.exec(text.replace(/^[`_\s]+/, '')) ?? /\b(AT-?\d+)\b/i.exec(text);
    items.push({ id: m ? normId(m[1]) : `AT${items.length + 1}`, text });
  }
  return items;
}

// Scenario name -> { pass } over every live report; a scenario passes when a report on a fresh head says so.
function liveScenarios(root, work) {
  const names = new Map();
  const dir = join(root, '.scratch', 'live');
  let runs = [];
  try { runs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return names; }
  for (const d of runs) {
    try {
      const rep = JSON.parse(readFileSync(join(dir, d.name, 'report.json'), 'utf8'));
      const fresh = headFresh(work, rep?.head).ok;
      for (const s of Array.isArray(rep?.scenarios) ? rep.scenarios : []) {
        if (typeof s?.name !== 'string') continue;
        names.set(s.name, { pass: (names.get(s.name)?.pass ?? false) || (s.result === 'pass' && fresh) });
      }
    } catch { /* not a report */ }
  }
  return names;
}

const looksLikePath = (v) => /[\\/]/.test(v) || /\.[A-Za-z0-9]{1,5}(?:$|[:#])/.test(v);
const pathOf = (v) => v.replace(/(::|#|:\d+).*$/, '').trim();
const FORMS = 'a tracked test path, "path::test name", or a live scenario name';

// Is this path a tracked file (or one on disk)?
const isFile = (work, p) => git(work, ['ls-files', '--error-unmatch', '--', p]).status === 0 || existsSync(join(work, p));

// '' when the cell names a passing live scenario or a real test file, else why not. A cell is one of: a live scenario name
// (matched first, so a name with a dot or a slash in it is still a name), a tracked test path (`tests/a.test.js`, also
// with `:line`), or `path::test name` (also `path#name`, or a path followed by prose).
function mapped(work, scenarios, target) {
  if (!target) return 'maps to no test or scenario';
  const s = scenarios.get(target);
  if (s) return s.pass ? '' : `live-verify scenario "${target}" has no passing result on HEAD`;
  if (looksLikePath(target)) {
    const p = pathOf(target);
    if (isFile(work, p)) return '';
    const first = p.split(/\s+/)[0];
    return first !== p && isFile(work, first) ? '' : `its test ${p} does not exist`;
  }
  return `has no live-verify scenario named "${target}" in a report, and is no test path (a test cell is ${FORMS})`;
}

function rowProblem(work, scenarios, it, r, cols) {
  if (!r) return `${it.id} is not mapped`;
  const why = mapped(work, scenarios, clean(r[cols.test] ?? ''));
  if (why) return `${it.id} ${why}`;
  const m = /^(pass|fail)\w*\b[^0-9a-f]*([0-9a-f]{7,40})\b/i.exec(clean(r[cols.res] ?? ''));
  if (!m || !isSha(m[2])) return `${it.id} has no "pass <sha>" result`;
  if (m[1].toLowerCase() !== 'pass') return `${it.id} is failing`;
  const fresh = headFresh(work, m[2]);
  return fresh.ok ? '' : `${it.id} result ${fresh.msg}`;
}

export function g12({ root, work, run, appr, readPlan, planFile }) {
  const items = acceptanceItems(planFile ? readPlan(planFile) : null);
  const where = planFile || 'docs/plans/<file>.md';
  if (!items) return red('the plan has no ## Acceptance tests section', where);
  if (!items.length) return red('## Acceptance tests lists no test', where);
  let md = null;
  try { md = readFileSync(join(root, ACCEPTANCE), 'utf8'); } catch { /* missing */ }
  if (md === null) return red('no .scratch/acceptance.md mapping each acceptance test to a test or scenario', ACCEPTANCE);
  const table = firstTable(md.split(/\r?\n/));
  const cols = table && { id: table.header.indexOf('at id'), test: table.header.findIndex((h) => h.startsWith('test')), res: table.header.findIndex((h) => h.startsWith('last result')) };
  if (!table || cols.id < 0 || cols.test < 0 || cols.res < 0) return red('no table with AT id, test path or scenario name and last result on <sha> columns', ACCEPTANCE);
  const rows = new Map(table.rows.map((r) => [normId(clean(r[cols.id] ?? '')), r]));
  const scenarios = liveScenarios(root, work);
  const problems = items.map((it) => rowProblem(work, scenarios, it, rows.get(it.id), cols)).filter(Boolean);
  const key = acceptanceKey(items);
  const ap = hasApproval(appr, 'acceptance', (a) => key !== '' && String(a.acceptance_sha).toLowerCase() === key,
    `these acceptance tests (${key.slice(0, 12)}); a changed test needs a fresh approval`);
  if (!ap.ok) problems.push(ap.msg);
  if (!problems.length) return { state: 'green' };
  const text = problems.join('; ');
  return red(text.length > MAX_MSG ? `${text.slice(0, MAX_MSG)}...` : text, ACCEPTANCE);
}
