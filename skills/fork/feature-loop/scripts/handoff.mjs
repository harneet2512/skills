// The ExitPlanMode hand-off (fork.9, gates.md "Hand-off"): plan approval is not permission to build. The hook tells
// Claude what happens next (additionalContext) and tells the owner it did (systemMessage).
import { appendTimeline } from './timeline.mjs';
import { changesSha, recordSigned } from './approval.mjs';
import { newestPlan } from './vis-root.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();

// The slug the codex review and gates.json share: G10 and G11 read .scratch/review/codex-<kind>-<slug>.json for the slug in
// .scratch/gates.json, so the review is run with that slug (the plan file's name is the natural one).
export const slugOf = (planRel) => (planRel ? planRel.split('/').pop().replace(/\.md$/i, '') : '<slug>');

// The slug of .scratch/gates.json when a loop's run file already exists, else the plan file's name.
const gatesSlug = (root) => { try { const s = JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8'))?.slug; return typeof s === 'string' ? s : ''; } catch { return ''; } };

export const handoffText = (planRel, slug = '') => [
  `feature-loop hand-off: the plan was approved in plan mode${planRel ? ` (${planRel})` : ''}. Do NOT implement anything yet.`,
  '1. Save the plan file and copy it to .scratch/plan-at-handoff.md. Never commit it: PRs carry only the issue\'s work.',
  '2. Run the `codex-review` skill in plan mode on the plan file, in the foreground (`scripts/codex-review.sh plan <plan-file> --slug ' + (slug || slugOf(planRel))
    + '`). The slug must be the `slug` of .scratch/gates.json, which G10 and G11 read the reports by: use the same one when you start the loop.',
  '3. Fold every CONFIRMED finding into the plan, and write each resolution to `.scratch/review/codex-plan-' + (slug || slugOf(planRel))
    + '.resolutions.md` (`fixed: plan revised (<section>)` or `rejected: <evidence>`; the plan is never committed).',
  '4. Present the findings and the revised plan to the owner. This is stop 2: STOP and wait.',
  '5. Only when the owner types "approve plan", invoke the `wp-loop` skill on the first existing issue in the plan\'s order. Never create, edit or close an issue, and do not invoke `feature-loop`.',
].join('\n');

// Returns { message, context }. Records a signed hand-off entry (with the plan's `## Changes` hash as the baseline for
// later edits) so the timeline and the escalation checks are active from here on.
export function handoff(root, dirs, session, sha256) {
  const plan = newestPlan(dirs);
  const why = recordSigned(root, {
    kind: 'handoff', plan_file: plan?.rel ?? '', plan_sha: plan?.sha ?? '', changes_sha: plan ? changesSha(plan.file, sha256) : '', ts: now(), session,
  });
  if (!why) appendTimeline(root, 'plan hand-off', `plan approved in plan mode; codex plan review next, then stop 2${plan ? ` (${plan.rel})` : ''}`, plan ? `plan_sha ${plan.sha.slice(0, 8)}` : '');
  const note = why ? ` (hand-off NOT recorded in the signed log: ${why})` : '';
  return {
    message: `plan approved in plan mode: handed off to codex plan review, then stop 2 (your go) before any build${note}`,
    context: handoffText(plan?.rel ?? '', gatesSlug(root)),
  };
}
