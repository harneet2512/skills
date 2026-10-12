// The PostToolUse, PostToolUseFailure, UserPromptExpansion and SessionStart hooks of the feature loop's stage log
// (fork.8; see stage-hook.sh and gates.md "G9 stages").
//
//   node stage-hook.mjs post-tool          any tool: log Skill and Agent calls (not failed ones), then look for source
//                                          changes made before the planning skills ran (exit 2 with the reason on a new
//                                          violation, and on a loop whose key or state is missing)
//   node stage-hook.mjs prompt-expansion   a typed /skill: log it (typing a skill bypasses the Skill tool); never blocks
//   node stage-hook.mjs user-prompt        UserPromptSubmit (fork.9): the owner's `approve acceptance|plan|pr` becomes a signed approval
//   node stage-hook.mjs exit-plan          PostToolUse ExitPlanMode (fork.9): the hand-off to the codex plan review and stop 2
// post-tool also prints the timeline's one-line systemMessage (visibility.mjs) while a loop runs or a plan is in review.
//   node stage-hook.mjs init               SessionStart: make the key, the state and the signed init entry
//
// Does nothing, and writes nothing, when no loop is active. Never fails the session on its own error (exit 0).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendEntry, recordSessionHead, storeStatus } from './stage-log.mjs';
import { blobsOf, evasionTraces } from './stage-detect.mjs';
import { assess, ensureInit } from './stage-state.mjs';
import { gitOut, loopRoot, repoRoot, sha256 } from './vis-root.mjs';
import { timelineActive } from './timeline.mjs';
import { observe } from './visibility.mjs';
import { recordApprovals } from './approval.mjs';
import { handoff } from './handoff.mjs';

const mode = process.argv[2];
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(raw) ?? {}; } catch { /* not JSON */ }

const finish = (code, err = '', out = '') => { if (out) process.stdout.write(out); if (err) process.stderr.write(err); process.exit(code); };
const say = (obj) => `${JSON.stringify(obj)}\n`;
// FEATURE_LOOP_NOW is a test seam: the hook's own environment, which the agent's shell cannot set.
const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();

const findRoot = loopRoot;

function logInvocations(root, session) {
  if (mode === 'prompt-expansion') {
    if (input.command_name) appendEntry(root, { kind: 'skill', skill: String(input.command_name), ts: now(), session, via: 'slash' });
    return;
  }
  if (input.hook_event_name === 'PostToolUseFailure') return; // a failed Skill or Agent call did not run
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Skill') {
    const name = ti.skill ?? ti.command ?? ti.name;
    // args are kept (trimmed) so wp-pr-guard can tell which branch a review was for when issues are built in parallel.
    if (name) appendEntry(root, { kind: 'skill', skill: String(name), args: String(ti.args ?? '').slice(0, 300), ts: now(), session });
  } else if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    appendEntry(root, {
      kind: 'agent', subagent_type: ti.subagent_type ?? '', model: ti.model ?? '', resolved: input.tool_response?.resolvedModel ?? '',
      description: ti.description ?? '', ts: now(), session,
    });
  }
}

const VIOLATION_TAIL = 'Gate G9 is red until you revert that code (git stash, a throwaway branch or a copy elsewhere does not count), run the missing skills with the Skill tool, and write the code again.';

// Record a violation when source changed before the planning skills ran, reopen it when the same content comes back,
// and clear it when the tree is clean of source with every planning skill logged and nothing hidden away.
function detect(root, run, session) {
  const dirs = new Set([root]);
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const top = cwd && gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (top) dirs.add(top);
  const a = assess(root, run, dirs);
  if (!a.init || a.errors.length) return '';
  if (a.open.length) {
    if (!a.bad.length && !a.missing.length && !evasionTraces(root, a.init).length) {
      for (const o of a.open) appendEntry(root, { kind: 'cleared', of: o.seq, ts: now(), session });
    }
    return '';
  }
  if (!a.bad.length) return '';
  const blobs = blobsOf([...dirs], a.bad);
  if (a.missing.length) {
    appendEntry(root, { kind: 'violation', ts: now(), paths: a.bad.slice(0, 20), missing: a.missing, blobs, session });
    return `feature-loop: source changed before the planning skills for a ${a.size} change had run (missing: ${a.missing.join(', ')}; changed: ${a.bad.slice(0, 5).join(', ')}). ${VIOLATION_TAIL}\n`;
  }
  const seen = new Set(a.ep.entries.filter((e) => e.kind === 'violation').flatMap((e) => Object.values(e.blobs ?? {})));
  if (Object.values(blobs).some((h) => seen.has(h))) {
    appendEntry(root, { kind: 'violation', ts: now(), paths: a.bad.slice(0, 20), missing: [], blobs, reopened: true, session });
    return `feature-loop: code written before the planning skills ran is back with the same content (${a.bad.slice(0, 5).join(', ')}), so the violation is reopened. Write it again, not restore it. ${VIOLATION_TAIL}\n`;
  }
  return '';
}

const sessionOf = () => (typeof input.session_id === 'string' ? input.session_id : '');
const planDirs = (start, root) => [...new Set([start && gitOut(start, ['rev-parse', '--show-toplevel']), root].filter(Boolean))];

// Hooks that work with or without a loop: the owner's approvals and the plan hand-off (signed, so the store is made if needed).
function planStage(start) {
  const root = findRoot(start) ?? repoRoot(start);
  if (!root) finish(0);
  const dirs = planDirs(start, root);
  const session = sessionOf();
  if (mode === 'user-prompt') {
    const r = recordApprovals(root, dirs, input.prompt, session, sha256);
    if (!r) finish(0);
    finish(0, '', say({ systemMessage: r.message, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.context } }));
  }
  const r = handoff(root, dirs, session, sha256);
  finish(0, '', say({ systemMessage: r.message, hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: r.context } }));
}

// The visibility line for one tool call, when a loop runs or a plan is in review. Never throws into the hook.
function visible(root, run, start) {
  try {
    if (!timelineActive(root)) return '';
    const m = observe(root, input, run, planDirs(start, root));
    return m ? say({ systemMessage: m }) : '';
  } catch { return ''; }
}

try {
  const start = resolve((typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  recordSessionHead(typeof input.session_id === 'string' ? input.session_id : '', start, mode === 'init');
  if (mode === 'user-prompt' || mode === 'exit-plan') planStage(start);
  const root = findRoot(start);
  if (!root) {
    // wp-loop: no feature loop, but the owner's approvals made a signed store. Sign Skill and Agent calls into it (never
    // an init entry: that would make it a loop), so wp-pr-guard.mjs can see which skills ran before a PR.
    const store = mode === 'post-tool' || mode === 'prompt-expansion' ? repoRoot(start) : null;
    if (store && storeStatus(store).kind === 'ok') logInvocations(store, sessionOf());
    const top = mode === 'post-tool' ? repoRoot(start) : null;
    finish(0, '', top ? visible(top, {}, start) : '');
  }
  let run = {};
  try { run = JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8')) ?? {}; } catch { /* not JSON: the other hooks say so */ }
  const session = sessionOf();
  const why = ensureInit(root, run, session);
  if (why) finish(mode === 'post-tool' ? 2 : 0, `feature-loop: ${why}. Gate G9 is red until this is fixed; the loop key is never regenerated.\n`);
  if (mode === 'init') finish(0);
  logInvocations(root, session);
  if (mode !== 'post-tool') finish(0);
  const msg = detect(root, run, session);
  finish(msg ? 2 : 0, msg, visible(root, run, start));
} catch {
  finish(0);
}
