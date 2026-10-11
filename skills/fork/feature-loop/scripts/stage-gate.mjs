// Gate G9, "stages ran, in order" (fork.8; see ../gates.md). Reads the signed log of .scratch/.loop/ and re-checks the
// tree, so a loop whose files exist but whose stages never ran is red. Called by check-gates.mjs.
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { storeStatus } from './stage-log.mjs';
import { AFTER_MARGIN_MS, MARGIN_MS, baseSha, evasionTraces, isAncestor, lastSourceChangeMs, normSkill } from './stage-detect.mjs';
import { assess, baselineOk } from './stage-state.mjs';
import { planSectionHasBody } from './plan-check.mjs';

const OPUS = /opus/i;
const list = (xs, n = 4) => (xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`);
const tsMs = (e) => Date.parse(e.ts);
const red = (msg) => ({ state: 'red', msg, file: '.scratch/.loop' });

// opts: { root, work, run, phase: build|merge|close, require } where `require` is set by the merge and push hooks:
// then a loop with no signed init entry is red instead of n/a. Returns { state, msg, file } like the other gates.
export function checkStages({ root, work, run, phase, require }) {
  const st = storeStatus(root);
  if (st.kind === 'none') {
    return require
      ? red('no signed init entry: the stage hooks have not run in this loop, so no stage can be proven (install the plugin, or vendor its hooks block: see FORK.md section 9)')
      : { state: 'na', msg: 'no stage log (.scratch/.loop): the loop hooks have not run in this repo' };
  }
  const a = assess(root, run, new Set([work, root]));
  if (a.errors.length) return red(`hook log rejected: ${list(a.errors, 3)}`);
  if (!a.init) return red('no signed init entry in the log: the loop was never started by the hooks');
  const slug = a.init.slug;
  if (typeof run.slug === 'string' && run.slug !== slug) return red(`gates.json slug "${run.slug}" is not the loop that was started ("${slug}"): close that loop before starting another`);
  if (!a.baseSha) return red(`base "${a.init.base}" did not resolve to a commit when the loop started, so committed source cannot be seen: fix "base" in gates.json`);
  if (!baseSha(root, run.base)) return red(`base "${run.base ?? ''}" in gates.json does not resolve to a commit`);

  if (!baselineOk(a.init) || (a.init.startSha !== a.init.mergeBase && !isAncestor(root, a.init.mergeBase, a.init.startSha))) {
    return red('the loop baseline is not the merge-base with base (or the session start commit on top of it), so code written before the loop could be hidden: start the loop from the merge-base');
  }

  const problems = [];
  if (a.open.length) {
    const o = a.open[a.open.length - 1];
    const traces = evasionTraces(root, a.init);
    problems.push(`open violation: source changed before ${list(o.missing?.length ? o.missing : ['the planning skills'])} had run (${list(o.paths ?? [], 3)}); revert it, run the stages, write the code again${traces.length ? `; found ${traces.join('; ')}` : ''}`);
  } else if (a.bad.length && a.missing.length) {
    problems.push(`source changed (${list(a.bad, 3)}) before ${list(a.missing)} had run; revert it, run the stages, write the code again`);
  }
  if (phase === 'build') return problems.length ? red(problems.join('; ')) : { state: 'green' };

  // Merge and close: the later stages must have run, after the last source change.
  const last = lastSourceChangeMs(work, a.init.startSha);
  const ofSkill = (s) => a.ep.entries.filter((e) => e.kind === 'skill' && normSkill(e.skill) === s).map(tsMs);
  const after = (s) => ofSkill(s).some((t) => t + AFTER_MARGIN_MS >= last);
  const need = a.size === 'small' ? ['code-review', 'live-verify'] : ['code-review', 'live-verify', 'adversarial-review'];
  for (const s of a.size === 'small' ? ['wp-loop'] : []) if (!ofSkill(s).length) problems.push(`not run in this loop (no entry in the log): ${s}`);
  for (const s of need) {
    if (!ofSkill(s).length) problems.push(`not run in this loop (no entry in the log): ${s}`);
    else if (!after(s)) problems.push(`${s} was logged before the last source change; run it again on the final code`);
  }
  if (a.size === 'large') {
    if (!(a.plan !== null && planSectionHasBody(a.plan, 'Design challenge'))) {
      const spec = ofSkill('to-spec');
      const firstSpec = spec.length ? Math.min(...spec) : Infinity;
      const challengers = a.ep.entries.filter((e) => e.kind === 'agent' && (OPUS.test(e.model) || OPUS.test(e.resolved))
        && /design[\s-]*challenge/i.test(e.description) && tsMs(e) < firstSpec).map(tsMs);
      if (!challengers.length) problems.push('large work needs a subagent on opus whose description names the design challenge (agent log), logged before to-spec');
      let mtime = 0;
      try { const f = join(root, '.scratch', 'design-challenge', `${slug}.md`); mtime = statSync(f).size > 0 ? statSync(f).mtimeMs : 0; } catch { /* no file */ }
      if (!mtime) problems.push(`large work needs the design challenge written to .scratch/design-challenge/${slug}.md`);
      else if (challengers.length && mtime + MARGIN_MS < Math.min(...challengers)) problems.push('the design-challenge file is older than the opus subagent that was to write it');
    }
  }
  if (phase === 'close' && !ofSkill('retro').length) problems.push('not run in this loop (no entry in the log): retro');
  return problems.length ? red(problems.join('; ')) : { state: 'green' };
}
