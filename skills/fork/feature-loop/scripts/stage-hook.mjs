// The PostToolUse, UserPromptExpansion and SessionStart hooks of the feature loop's stage logs (fork.8; see
// stage-hook.sh and gates.md "G9 stages").
//
//   node stage-hook.mjs post-tool          any tool: log Skill and Agent calls, then look for source changes made
//                                          before the planning skills ran (exit 2 with the reason on a new violation)
//   node stage-hook.mjs prompt-expansion   a typed /skill: log it (typing a skill bypasses the Skill tool); never blocks
//   node stage-hook.mjs init               SessionStart: make the loop's id and key when a loop is active
//
// Does nothing, and writes nothing, when no loop is active. Never fails the session on its own error (exit 0).
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AGENTS, SKILLS, VIOLATIONS, appendEntry, ensureLoop, openViolations, readLog } from './stage-log.mjs';
import { missingPlanning, normSkill, sourceChanges } from './stage-detect.mjs';

const mode = process.argv[2];
let raw = '';
try { for await (const chunk of process.stdin) raw += chunk; } catch { /* no stdin */ }
let input = {};
try { input = JSON.parse(raw) ?? {}; } catch { /* not JSON */ }

const finish = (code, err = '') => { if (err) process.stderr.write(err); process.exit(code); };
const gitOut = (cwd, args) => { const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : ''; };
const hasRunFile = (d) => !!d && existsSync(join(d, '.scratch', 'gates.json'));
// FEATURE_LOOP_NOW is a test seam: the hook's own environment, which the agent's shell cannot set.
const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();

// The directory holding the active loop's .scratch/gates.json (cwd, git top level, main worktree); null when none or closed.
function findRoot(start) {
  let dir = null;
  if (hasRunFile(start)) dir = start;
  else {
    const top = gitOut(start, ['rev-parse', '--show-toplevel']);
    const common = gitOut(start, ['rev-parse', '--git-common-dir']);
    const main = common && basename(resolve(start, common)) === '.git' ? dirname(resolve(start, common)) : '';
    dir = [top, main].find(hasRunFile) ?? null;
  }
  if (!dir) return null;
  try { if (JSON.parse(readFileSync(join(dir, '.scratch', 'gates.json'), 'utf8'))?.status === 'closed') return null; } catch { /* still a loop */ }
  return dir;
}

function logInvocations(root, session) {
  if (mode === 'prompt-expansion') {
    if (input.command_name) appendEntry(root, SKILLS, { skill: String(input.command_name), ts: now(), session, via: 'slash' });
    return;
  }
  const ti = input.tool_input ?? {};
  if (input.tool_name === 'Skill') {
    const name = ti.skill ?? ti.command ?? ti.name;
    if (name) appendEntry(root, SKILLS, { skill: String(name), ts: now(), session });
  } else if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    appendEntry(root, AGENTS, {
      subagent_type: ti.subagent_type ?? '', model: ti.model ?? '', resolved: input.tool_response?.resolvedModel ?? '',
      description: ti.description ?? '', ts: now(), session,
    });
  }
}

// Record a violation when source changed before the planning skills ran, and clear it when the tree is clean of source
// again with every planning skill logged. Returns the message for the model when a new violation was recorded.
function detect(root, run) {
  const size = ['small', 'normal', 'large'].includes(run?.size) ? run.size : 'normal';
  const base = typeof run?.base === 'string' ? run.base : '';
  const dirs = new Set([root]);
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  const top = cwd && gitOut(cwd, ['rev-parse', '--show-toplevel']);
  if (top) dirs.add(top);
  const bad = [...new Set([...dirs].flatMap((d) => sourceChanges(d, base)))].sort();
  const logged = new Set(readLog(root, SKILLS).entries.map((e) => normSkill(e.skill)));
  const missing = missingPlanning(root, size, logged);
  const open = openViolations(readLog(root, VIOLATIONS).entries);
  if (open.length && !bad.length && !missing.length) {
    for (const o of open) appendEntry(root, VIOLATIONS, { kind: 'cleared', of: o.seq, ts: now() });
    return '';
  }
  if (bad.length && missing.length && !open.length) {
    appendEntry(root, VIOLATIONS, { kind: 'violation', ts: now(), paths: bad.slice(0, 20), missing });
    return `feature-loop: source changed before the planning skills for a ${size} change had run (missing: ${missing.join(', ')}; changed: ${bad.slice(0, 5).join(', ')}). Gate G9 is red until you revert that code, run the missing skills with the Skill tool, and write the code again.\n`;
  }
  return '';
}

try {
  const start = resolve((typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const root = findRoot(start);
  if (!root || !ensureLoop(root) || mode === 'init') finish(0);
  logInvocations(root, typeof input.session_id === 'string' ? input.session_id : '');
  if (mode !== 'post-tool') finish(0);
  let run = {};
  try { run = JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8')); } catch { /* sized later */ }
  const msg = detect(root, run);
  finish(msg ? 2 : 0, msg);
} catch {
  finish(0);
}
