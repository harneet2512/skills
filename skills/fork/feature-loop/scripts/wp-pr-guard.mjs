// For a PR creation or a merge where no feature loop is active but the owner's approvals made a signed store (wp-loop,
// the `kl` flow; fork.9.7, widened in fork.9.11). Every route the gate hooks classify as a PR creation (gh pr create,
// gh api POST .../pulls, createPullRequest, the GitHub MCP create_pull_request) comes here, so nothing reaches the
// reviewer without the owner knowing:
//   create  needs the owner's signed `approve pr` for this exact HEAD, and the `adversarial-review` and `pr` skills
//           called with the Skill tool since the last `approve pr` for a different head (HAR-181 dry run 2: after the
//           first issue the loop wrote its own review and PR body instead).
//   merge   always refused: the owner merges.
//
//   node wp-pr-guard.mjs <dir> [create|merge]   exit 0 nothing to refuse (no store, or a real feature loop, whose own
//                                               gates apply), exit 1 with the reason on stdout
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readLog, storeStatus } from './stage-log.mjs';

const REQUIRED = ['adversarial-review', 'pr'];
const skillName = (s) => String(s ?? '').replace(/^.*:/, '');
const git = (dir, args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

try {
  const dir = resolve(process.argv[2] || process.cwd());
  const kind = process.argv[3] || 'create';
  const root = git(dir, ['rev-parse', '--show-toplevel']) || dir;
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
    console.log(`wp-loop: no PR without the owner's go. Show the owner the PR (title, base, body, files) and ask for \`approve pr\`; it signs this exact head (${head.slice(0, 12) || 'unknown'}), and a new commit needs a new one`);
    process.exit(1);
  }
  // The review window opens after the last PR approval for a different head (the previous issue's PR, or this issue
  // before a new commit), so approving the same head twice keeps the review that came before it.
  const prev = prApprovals.filter((i) => log.entries[i].head !== head).pop();
  const from = prev === undefined ? 0 : prev + 1;
  const called = new Set(log.entries.slice(from).filter((e) => e.kind === 'skill').map((e) => skillName(e.skill)));
  const missing = REQUIRED.filter((s) => !called.has(s));
  if (!missing.length) process.exit(0);
  console.log(`wp-loop: this issue's PR needs the ${missing.map((s) => `\`${s}\``).join(' and ')} skill${missing.length > 1 ? 's' : ''} called with the Skill tool since the previous PR (steps 9 and 12); a review or PR body written without the skill does not count`);
  process.exit(1);
} catch (e) {
  console.log(`could not check the owner's approval record: ${e.message}`);
  process.exit(1);
}
