// Every PR creation and every merge the gate hooks see outside a feature loop comes here (wp-loop, the `kl` flow;
// fork.9.7, reworked in fork.9.14 at the owner's word: "never raise a PR without asking me; we never merge").
// Routes: gh pr create, gh api POST .../pulls, createPullRequest, the GitHub MCP create_pull_request; from the main
// folder or any worktree.
//   create  exit 3: ask. The hook turns this into Claude Code's own permission prompt, so the PR is opened only when the
//           owner answers yes, with the branch, commit and changed files in front of them. In a repo where the owner's
//           workflow is running (a signed store from plan-first's approvals) it first needs the `adversarial-review` and
//           `pr` skills called with this branch's name as args; without them, exit 1 (refused, the owner is not asked).
//   merge   exit 1 in a repo where the workflow is running: the owner merges, the loop never does. Elsewhere exit 0.
//
//   node wp-pr-guard.mjs <dir> [create|merge]   exit 0 nothing to do, 1 refused (reason on stdout), 3 ask (the
//                                               question on stdout)
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readLog, storeStatus } from './stage-log.mjs';
import { repoRoot } from './vis-root.mjs';

const REQUIRED = ['adversarial-review', 'pr'];
const skillName = (s) => String(s ?? '').replace(/^.*:/, '');
const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const refuse = (why) => { console.log(why); process.exit(1); };

// The question the owner sees: which branch and commit, and what the PR would carry.
function question(dir) {
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || '?';
  const head = git(dir, ['rev-parse', '--short=10', 'HEAD']) || '?';
  const base = ['origin/HEAD', 'origin/main', 'origin/master'].find((r) => git(dir, ['rev-parse', '--verify', '--quiet', r])) ?? '';
  const files = base ? git(dir, ['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean) : [];
  const shown = files.slice(0, 12).join(', ') + (files.length > 12 ? `, and ${files.length - 12} more` : '');
  return `Open a pull request from ${branch} (${head})? ${files.length ? `${files.length} file(s) changed vs ${base}: ${shown}.` : ''} Answer yes only if you have seen the PR title, base and body; no PR is ever opened without your yes, and nothing is merged.`;
}

try {
  const dir = resolve(process.argv[2] || process.cwd());
  const kind = process.argv[3] || 'create';
  // The store lives in the main worktree's .scratch/ (untracked, so a linked worktree has none): find it from any
  // worktree, or a PR from a parallel issue's worktree would look like a repo with no workflow running.
  const root = repoRoot(dir) || git(dir, ['rev-parse', '--show-toplevel']) || dir;
  const store = storeStatus(root).kind === 'ok';
  const log = store ? readLog(root) : { entries: [], errors: [] };
  if (log.errors.length) refuse(`the signed log is unreadable (${log.errors[0]}), so nothing goes out until it is fixed`);
  const workflow = store && !log.entries.some((e) => e.kind === 'init'); // a feature loop gates its own PR phase
  if (kind === 'merge') {
    if (workflow) refuse('the owner merges; the loop never merges a PR, by any route');
    process.exit(0);
  }
  if (workflow) {
    // Each review is tied to its branch by the Skill call's args, so with issues built in parallel one issue's
    // review never stands in for another's.
    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') refuse('open the PR from its issue branch (HEAD is detached), so its review can be matched to it');
    const names = (args) => String(args ?? '').split(/[\s,;:()`'"]+/).filter(Boolean);
    const called = new Set(log.entries.filter((e) => e.kind === 'skill' && names(e.args).includes(branch)).map((e) => skillName(e.skill)));
    const missing = REQUIRED.filter((s) => !called.has(s));
    if (missing.length) {
      refuse(`wp-loop: before asking the owner to open this PR, call ${missing.map((s) => `\`${s}\``).join(' and ')} with the Skill tool with the branch name as args (Skill ${missing[0]} args "${branch}"), steps 9 and 12; a review or PR body written without the skill, or one for another branch, does not count`);
    }
  }
  console.log(question(dir));
  process.exit(3);
} catch (e) {
  refuse(`could not check this PR: ${e.message}`);
}
