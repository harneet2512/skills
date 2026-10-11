// G8, the ledger (see ../gates.md): a stage is done only on evidence, and evidence says how it is known. Split out of
// check-gates.mjs. `read` reads a file of the loop root, `readPlan` a plan file.
import { clean, tables } from './md-table.mjs';
import { planCitationsOk, PLAN_STAGES_OK } from './plan-check.mjs';

const red = (what, file) => ({ state: 'red', msg: `${what} (${file})` });
const na = (why) => ({ state: 'na', msg: why });
const green = () => ({ state: 'green' });
const listShort = (xs, n = 5) => xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`;

// The ledger: a stage is done only on evidence, and evidence says how it is known.
export function g8({ read, readPlan, statusFile }) {
  const md = read(statusFile);
  if (md === null) return na('no .scratch/loop-status.md');
  const table = tables(md.split(/\r?\n/)).find((t) => t.header.includes('status') && t.header.includes('evidence'));
  if (!table) return red('no stage table with Status and Evidence columns', statusFile);
  const col = (n) => table.header.indexOf(n);
  const unmarked = [], assumed = [], planless = [], wrongStage = [];
  for (const r of table.rows) {
    const statusText = clean(r[col('status')] ?? '');
    if (!/^done\b/i.test(statusText)) continue; // running rows are the Stop hook's business
    const name = [clean(r[col('stage')] ?? ''), clean(r[col('skill')] ?? '')].filter(Boolean).join(' ') || `row ${table.rows.indexOf(r) + 1}`;
    const ev = clean(r[col('evidence')] ?? '');
    // "done, from approved plan": the stage was written from the approved plan, so the evidence must name a plan
    // section that exists and has content: `inferred: docs/plans/<file>.md#<Section>`.
    if (/^done\b.*\bfrom approved plan\b/i.test(statusText)) {
      if (!PLAN_STAGES_OK(clean(r[col('stage')] ?? ''), clean(r[col('skill')] ?? ''))) wrongStage.push(name);
      else if (!planCitationsOk(ev, readPlan)) planless.push(`${name} (${ev === '' ? 'empty' : JSON.stringify(ev)})`);
    }
    const tag = ev.replace(/^[`*_\s]+/, ''); // `measured:` or **measured:** still counts
    if (!/^(measured|inferred|assumed):/i.test(tag)) unmarked.push(`${name} (${ev === '' ? 'empty' : JSON.stringify(ev)})`);
    else if (/^assumed:/i.test(tag) && !/(^|[^A-Za-z])(measured|inferred):/i.test(tag)) assumed.push(name);
  }
  const problems = [];
  if (unmarked.length) problems.push(`done stage without evidence (measured:, inferred: or assumed:): ${listShort(unmarked, 4)}`);
  if (assumed.length) problems.push(`a stage cannot be done on an assumption: ${listShort(assumed, 4)}`);
  if (wrongStage.length) problems.push(`"done, from approved plan" is only for stages 0, 1 and 3 (baseline, shape, to-tickets); stage 2 and every build, prove and later stage still run: ${listShort(wrongStage, 4)}`);
  if (planless.length) problems.push(`"done, from approved plan" without an existing plan section as evidence (inferred: docs/plans/<file>.md#<Section>): ${listShort(planless, 4)}`);
  return problems.length ? red(problems.join('; '), statusFile) : green();
}

