// Owner approvals (fork.9, gates.md "Approvals"): the UserPromptSubmit hook turns what the OWNER types into signed log
// entries. Nothing the agent writes can make one: the log is signed with the loop key, and a file or a hand-written line
// fails verification (stage-log.mjs approvalReport reads only verified entries).
//   approve acceptance [docs/<dir>/<file>.md] -> { kind: approval, stop: acceptance, acceptance_sha } (acceptance-key.mjs: the tests themselves)
//   approve plan [docs/plans/<file>.md]       -> { kind: approval, stop: plan, plan_sha }
// With more than one candidate file the prompt must name it (fork.9.1); the recorded message names the file and the full sha.
//   approve pr         -> { kind: approval, stop: pr, head }
import { readFileSync } from 'node:fs';
import { appendEntry, createStore, storeStatus } from './stage-log.mjs';
import { appendTimeline } from './timeline.mjs';
import { changesSection, choosePlan, gitOut, namedDoc } from './vis-root.mjs';
import { chooseAcceptance } from './acceptance-key.mjs';

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

// What one stop's approval is for: { subject (the fields signed), label (what the owner is told), file } or { error }.
function subjectOf(stop, dirs, prompt, head) {
  const named = stop === 'pr' ? '' : namedDoc(prompt, stop);
  if (stop === 'pr') {
    return head ? { subject: { head }, label: `pr (head ${head})`, file: '' } : { error: 'no git HEAD' };
  }
  if (stop === 'acceptance') {
    const r = chooseAcceptance(dirs, named);
    return r.error ? r : { subject: { acceptance_sha: r.at.key }, label: `acceptance (${r.at.rel}, key ${r.at.key})`, file: r.at.file, rel: r.at.rel };
  }
  const r = choosePlan(dirs, named);
  return r.error ? r : { subject: { plan_sha: r.plan.sha }, label: `plan (${r.plan.rel}, sha256 ${r.plan.sha})`, file: r.plan.file, rel: r.plan.rel };
}

// Record every approval in the prompt. Returns { message, context } for the hook's JSON, or null when none matched. The
// message names the file and the full sha of what was approved, so the owner can see it was the right one; an approval
// that would have to guess between several plans (or acceptance files) is refused until the prompt names one.
export function recordApprovals(root, dirs, prompt, session, sha256) {
  const stops = stopsIn(prompt);
  if (!stops.length) return null;
  const head = gitOut(dirs[0] ?? root, ['rev-parse', 'HEAD']);
  const done = [];
  const failed = [];
  for (const stop of stops) {
    const s = subjectOf(stop, dirs, prompt, head);
    if (s.error) { failed.push(`${stop}: ${s.error}`); continue; }
    const extra = stop === 'plan' ? { changes_sha: changesSha(s.file, sha256) } : {};
    const file = stop === 'acceptance' ? { acceptance_file: s.rel } : { plan_file: s.rel ?? '' };
    const why = recordSigned(root, { kind: 'approval', stop, ...s.subject, ...file, ...extra, ts: now(), session });
    if (why) { failed.push(`${stop}: ${why}`); continue; }
    done.push(s.label);
    appendTimeline(root, 'approval', `owner approved ${s.label}`, Object.values(s.subject)[0]);
  }
  const parts = [];
  if (done.length) parts.push(`approval recorded: ${done.join(', ')}`);
  if (failed.length) parts.push(`approval NOT recorded: ${failed.join('; ')}`);
  const message = parts.join(' | ');
  return { message, context: `feature-loop hook: the owner's prompt was ${message}. Only the owner's own prompt can approve a stop.` };
}
