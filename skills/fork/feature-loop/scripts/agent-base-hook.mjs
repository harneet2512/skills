// Claude Code PreToolUse hook for the Agent and EnterWorktree tools, active where a feature loop runs or where the
// owner's signed store exists (plan-first's approvals). Exit 2 refuses (stderr is the reason); anything else passes.
//
// - isolation: "worktree" (fork.9.3) gets a worktree cut from the default branch, not from HEAD. In live run 2 all three
//   topic attackers of adversarial-review ran in such worktrees at main, without the feature they were attacking, and
//   reported "no findings". So an isolated subagent is refused whenever HEAD is not the default branch's tip, and told
//   to cut its worktree from HEAD:   git worktree add --detach <dir outside the repo> HEAD   (pass <dir> in the prompt)
// - run_in_background: true (fork.9.16). In dry run 3 the reviewers started in the background died when the turn
//   ended, and their reviews were lost. Subagents run in the foreground; several Agent calls in one message still run
//   at the same time.
// - EnterWorktree (fork.9.16) makes its worktree inside the repo folder (.claude/worktrees/); worktrees go outside it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { storeStatus } from './stage-log.mjs';
import { gitOut, loopRoot, repoRoot } from './vis-root.mjs';

function defaultTip(dir, root) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    const sha = gitOut(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha) return { ref, sha };
  }
  let base = 'main';
  try { base = JSON.parse(readFileSync(join(root, '.scratch', 'gates.json'), 'utf8')).base || base; } catch { /* default */ }
  const sha = gitOut(dir, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  return sha ? { ref: base, sha } : null;
}

const refuse = (why) => { process.stderr.write(`${why}\n`); process.exit(2); };

let payload;
try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
const cwd = payload.cwd || process.cwd();
const repo = repoRoot(cwd);
const root = loopRoot(cwd) || (repo && storeStatus(repo).kind === 'ok' ? repo : null);
if (!root) process.exit(0);
const input = payload?.tool_input ?? {};

if (payload.tool_name === 'EnterWorktree') {
  refuse(`owner workflow: refused. EnterWorktree puts the worktree inside the repo folder (.claude/worktrees/); worktrees go outside it. Use git worktree add <dir outside ${root}> <branch>, and work there by path.`);
}
if (input.run_in_background === true) {
  refuse('owner workflow: refused. A subagent started in the background dies when the turn ends, and its work is lost (dry run 3 lost its reviewers this way). Run it in the foreground: drop run_in_background. Several Agent calls in one message still run at the same time.');
}
if (input.isolation !== 'worktree') process.exit(0);
const head = gitOut(cwd, ['rev-parse', 'HEAD']);
const tip = defaultTip(cwd, root);
if (!head || !tip || head === tip.sha) process.exit(0);
refuse(
  `feature-loop: refused. isolation: "worktree" starts the subagent from the default branch (${tip.ref} ${tip.sha.slice(0, 7)}), ` +
  `not from HEAD (${head.slice(0, 7)}), so it would work on code without this change. Cut the worktree from HEAD yourself ` +
  `(git worktree add --detach <dir outside the repo> HEAD), pass <dir> in the prompt, drop the isolation field, and remove the worktree after.`);
