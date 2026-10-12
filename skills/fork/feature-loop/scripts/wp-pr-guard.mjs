// For a PR creation or a merge where no feature loop is active but the owner's approvals made a signed store (wp-loop,
// the `kl` flow; fork.9.7, widened in fork.9.11). Every route the gate hooks classify as a PR creation (gh pr create,
// gh api POST .../pulls, createPullRequest, the GitHub MCP create_pull_request) comes here, so nothing reaches the
// reviewer without the owner knowing:
//   create  needs the owner's signed `approve pr` for this exact HEAD, and the `adversarial-review` and `pr` skills
//           called with the Skill tool with this branch's name in their args (HAR-181 dry run 2: after the first issue
//           the loop wrote its own review and PR body instead; fork.9.13: issues built in parallel each need their own).
//           Works from any worktree: the store is the main worktree's.
//   merge   always refused: the owner merges.
//
//   node wp-pr-guard.mjs <dir> [create|merge]   exit 0 nothing to refuse (no store, or a real feature loop, whose own
//                                               gates apply), exit 1 with the reason on stdout
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

try {
  const dir = resolve(process.argv[2] || process.cwd());
  const kind = process.argv[3] || 'create';
  // The store lives in the main worktree's .scratch/ (untracked, so a linked worktree has none): find it from any
  // worktree, or a PR from the parallel issue's worktree would find no store and pass (HAR-182 pre-check).
  const root = repoRoot(dir) || git(dir, ['rev-parse', '--show-toplevel']) || dir;
  if (storeStatus(root).kind !== 'ok') process.exit(0);
  const log = readLog(root);
  if (log.errors.length) {
    console.log(`the signed log is unreadable (${log.errors[0]}), so it cannot show the owner approved this; nothing goes out`);
    process.exit(1);
  }
  if (log.entries.some((e) => e.kind === 'init')) process.exit(0); // a feature loop: its own pr phase gates the PR
  if (kind === 'merge') {
    console.log('wp-loop: the owner merges; the loop never merges a PR, by any route');
    process.exit(1);
  }
  const head = git(dir, ['rev-parse', 'HEAD']);
  const prApprovals = log.entries.map((e, i) => (e.kind === 'approval' && e.stop === 'pr' ? i : -1)).filter((i) => i >= 0);
  const forHead = prApprovals.filter((i) => head && log.entries[i].head === head);
  if (!forHead.length) {
    console.log(`wp-loop: no PR without the owner's go. Show the owner the PR (title, base, body, files) and ask for \`approve pr\` (\`approve pr <branch>\` for a branch the main folder has not checked out); it signs this exact head (${head.slice(0, 12) || 'unknown'}), and a new commit needs a new one`);
    process.exit(1);
  }
  // Each review is tied to its branch by the Skill call's args, so with issues built in parallel one issue's review
  // never stands in for another's.
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch || branch === 'HEAD') {
    console.log('wp-loop: the PR must be opened from its issue branch (HEAD is detached), so its review can be matched to it');
    process.exit(1);
  }
  const names = (args) => String(args ?? '').split(/[\s,;:()`'"]+/).filter(Boolean);
  const called = new Set(log.entries
    .filter((e) => e.kind === 'skill' && names(e.args).includes(branch))
    .map((e) => skillName(e.skill)));
  const missing = REQUIRED.filter((s) => !called.has(s));
  if (!missing.length) process.exit(0);
  console.log(`wp-loop: this issue's PR needs ${missing.map((s) => `\`${s}\``).join(' and ')} called with the Skill tool with the branch name as args (Skill ${missing[0]} args "${branch}"), steps 9 and 12; a review or PR body written without the skill, or one for another branch, does not count`);
  process.exit(1);
} catch (e) {
  console.log(`could not check the owner's approval record: ${e.message}`);
  process.exit(1);
}
