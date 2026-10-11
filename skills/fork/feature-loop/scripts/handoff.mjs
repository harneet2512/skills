// The ExitPlanMode hand-off (fork.9, gates.md "Hand-off"): plan approval is not permission to build. The hook tells
// Claude what happens next (additionalContext) and tells the owner it did (systemMessage).
import { appendTimeline } from './timeline.mjs';
import { changesSha, recordSigned } from './approval.mjs';
import { newestPlan } from './vis-root.mjs';

const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();

export const handoffText = (planRel) => [
  `feature-loop hand-off: the plan was approved in plan mode${planRel ? ` (${planRel})` : ''}. Do NOT implement anything yet.`,
  '1. Commit the plan file.',
  '2. Run the `codex-review` skill in plan mode on the plan file (`scripts/codex-review.sh plan <plan-file>`).',
  '3. Fold every CONFIRMED finding into the plan, and write each resolution to `.scratch/review/codex-plan-<slug>.resolutions.md` (`fixed: <commit>` or `rejected: <reason>`).',
  '4. Present the findings and the revised plan to the owner. This is stop 2: STOP and wait.',
  '5. Only when the owner types "approve plan", invoke the `feature-loop` skill on the plan. Nothing else waits for approval.',
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
    context: handoffText(plan?.rel ?? ''),
  };
}
