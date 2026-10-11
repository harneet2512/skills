// Owner approvals (fork.9, gates.md "Approvals"): the UserPromptSubmit hook turns what the OWNER types into signed log
// entries. Nothing the agent writes can make one: the log is signed with the loop key, and a file or a hand-written line
// fails verification (stage-log.mjs approvalReport reads only verified entries).
//   approve acceptance -> { kind: approval, stop: acceptance, plan_sha }
//   approve plan       -> { kind: approval, stop: plan, plan_sha }
//   approve pr         -> { kind: approval, stop: pr, head }
import { readFileSync } from 'node:fs';
import { appendEntry, createStore, storeStatus } from './stage-log.mjs';
import { appendTimeline } from './timeline.mjs';
import { changesSection, gitOut, newestPlan } from './vis-root.mjs';

const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();
const PATTERNS = [['acceptance', /^[ \t]*approve\s+acceptance\b/im], ['plan', /^[ \t]*approve\s+plan\b/im], ['pr', /^[ \t]*approve\s+pr\b/im]];

// The stops a prompt approves, in a fixed order. Case-insensitive, and only when a line STARTS with the phrase, so
// "don't approve plan" or "should I approve plan?" in the middle of a sentence approves nothing.
export const stopsIn = (prompt) => PATTERNS.filter(([, re]) => re.test(String(prompt ?? ''))).map(([s]) => s);

// Sign one entry, making the store first when no loop ever started here. Returns '' or the reason it was not written.
export function recordSigned(root, fields) {
  let s = storeStatus(root);
  if (s.kind === 'none') {
    if (!createStore(root, 'owner-approvals', now())) return 'the loop key and state could not be written';
    s = storeStatus(root);
  }
  if (s.kind === 'broken') return s.reason;
  return appendEntry(root, fields) ? '' : 'the signed log refused the entry (it is tampered with, or locked)';
}

export const changesSha = (planFile, sha256) => {
  try { return sha256(changesSection(readFileSync(planFile, 'utf8')) ?? ''); } catch { return ''; }
};

// Record every approval in the prompt. Returns { message, context } for the hook's JSON, or null when none matched.
export function recordApprovals(root, dirs, prompt, session, sha256) {
  const stops = stopsIn(prompt);
  if (!stops.length) return null;
  const plan = newestPlan(dirs);
  const head = gitOut(dirs[0] ?? root, ['rev-parse', 'HEAD']);
  const done = [];
  const failed = [];
  for (const stop of stops) {
    const subject = stop === 'pr' ? { head } : { plan_sha: plan?.sha ?? '' };
    if (!Object.values(subject)[0]) { failed.push(`${stop}: nothing to approve (${stop === 'pr' ? 'no git HEAD' : 'no docs/plans/*.md'})`); continue; }
    const extra = stop === 'plan' && plan ? { changes_sha: changesSha(plan.file, sha256) } : {};
    const why = recordSigned(root, { kind: 'approval', stop, ...subject, plan_file: plan?.rel ?? '', ...extra, ts: now(), session });
    if (why) { failed.push(`${stop}: ${why}`); continue; }
    const id = stop === 'pr' ? `head ${head.slice(0, 8)}` : `plan_sha ${plan.sha.slice(0, 8)}`;
    done.push(`${stop} (${id})`);
    appendTimeline(root, 'approval', `owner approved ${stop}`, id);
  }
  const parts = [];
  if (done.length) parts.push(`approval recorded: ${done.join(', ')}`);
  if (failed.length) parts.push(`approval NOT recorded: ${failed.join('; ')}`);
  const message = parts.join(' | ');
  return { message, context: `feature-loop hook: the owner's prompt was ${message}. Only the owner's own prompt can approve a stop.` };
}
