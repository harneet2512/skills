// Gate G9, "stages ran, in order" (fork.8; see ../gates.md). Reads the hook-owned logs in .scratch/.loop/ and re-checks
// the tree, so a loop whose files exist but whose stages never ran is red. Called by check-gates.mjs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, SKILLS, VIOLATIONS, loopDirExists, openViolations, readKey, readLog } from './stage-log.mjs';
import { lastSourceChangeMs, missingPlanning, normSkill, sourceChanges } from './stage-detect.mjs';
import { planSectionHasBody } from './plan-check.mjs';

const OPUS = /opus/i;
const list = (xs, n = 4) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
const tsMs = (e) => Date.parse(e.ts);

// A design challenge for large work: its own file, or the Design challenge section of an approved plan (plan mode ran it).
function designChallengeOk(root, work, slug, readPlan) {
  const p = join(root, '.scratch', 'design-challenge', `${slug}.md`);
  try { if (readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim() !== '') return true; } catch { /* no file */ }
  const plan = readPlan(`docs/plans/${slug}.md`);
  return plan !== null && planSectionHasBody(plan, 'Design challenge');
}

// opts: { root, work, size, slug, base, phase: build|merge|close, readPlan(path) }. Returns { state, msg } like the other gates.
export function checkStages(opts) {
  const { root, work, size, slug, base, phase, readPlan } = opts;
  const where = '.scratch/.loop';
  if (!loopDirExists(root)) return { state: 'na', msg: 'no stage logs (.scratch/.loop): the loop hooks have not run in this repo' };
  if (!readKey(root)) return { state: 'red', msg: 'the loop key is missing, so the hook logs cannot be verified (restart the session so SessionStart makes one, then redo the stages)', };
  const sk = readLog(root, SKILLS), ag = readLog(root, AGENTS), vi = readLog(root, VIOLATIONS);
  const errors = [...sk.errors, ...ag.errors, ...vi.errors];
  if (errors.length) return { state: 'red', msg: `hook log rejected: ${list(errors, 3)}`, file: where };

  const problems = [];
  const logged = new Set(sk.entries.map((e) => normSkill(e.skill)));
  const open = openViolations(vi.entries);
  const bad = [...new Set([work, root].flatMap((d) => sourceChanges(d, base)))].sort();
  const missing = missingPlanning(root, size, logged);
  if (open.length) {
    const o = open[open.length - 1];
    problems.push(`open violation: source changed before ${list(o.missing ?? [])} had run (${list(o.paths ?? [], 3)}); revert it, run the stages, write the code again`);
  } else if (bad.length && missing.length) {
    problems.push(`source changed (${list(bad, 3)}) before ${list(missing)} had run; revert it, run the stages, write the code again`);
  }
  if (phase === 'build') return problems.length ? { state: 'red', msg: problems.join('; '), file: where } : { state: 'green' };

  // Merge and close: the stages after the build must have run too.
  const need = size === 'small' ? ['wp-loop'] : ['code-review', 'live-verify'];
  const absent = need.filter((s) => !logged.has(s));
  if (absent.length) problems.push(`not run in this loop (no entry in skills.jsonl): ${absent.join(', ')}`);
  if (size !== 'small') {
    const adv = sk.entries.filter((e) => normSkill(e.skill) === 'adversarial-review').map(tsMs);
    const last = lastSourceChangeMs(work, base);
    if (!adv.length) problems.push('not run in this loop (no entry in skills.jsonl): adversarial-review');
    else if (Math.max(...adv) <= last) problems.push('adversarial-review was logged before the last source change; run it again on the final code');
  }
  if (size === 'large') {
    if (!designChallengeOk(root, work, slug, readPlan)) problems.push(`large work needs a design challenge: .scratch/design-challenge/${slug}.md, or the approved plan's Design challenge section`);
    const planned = readPlan(`docs/plans/${slug}.md`);
    const planChallenged = planned !== null && planSectionHasBody(planned, 'Design challenge');
    const spec = sk.entries.filter((e) => normSkill(e.skill) === 'to-spec').map(tsMs);
    const firstSpec = spec.length ? Math.min(...spec) : Infinity;
    const opus = ag.entries.some((e) => (OPUS.test(e.model) || OPUS.test(e.resolved)) && tsMs(e) < firstSpec);
    if (!opus && !planChallenged) problems.push('large work needs a subagent on opus (agents.jsonl) logged before to-spec');
  }
  if (phase === 'close' && !logged.has('retro')) problems.push('not run in this loop (no entry in skills.jsonl): retro');
  return problems.length ? { state: 'red', msg: problems.join('; '), file: where } : { state: 'green' };
}
