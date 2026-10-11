// Claude Code PreToolUse hook for the Agent tool (fork.9.3). An Agent call with `isolation: "worktree"` gets a worktree
// cut from the default branch, not from HEAD. In live run 2 all three topic attackers of adversarial-review ran in such
// worktrees at main, without the feature they were attacking, and reported "no findings". So while a loop is active, an
// isolated subagent is refused whenever HEAD is not the default branch's tip, and told to cut its worktree from HEAD:
//
//   git worktree add --detach <dir> HEAD     (pass <dir> in the prompt; remove it after)
//
// Registered in hooks.json with the matcher "Agent". Exit 2 refuses (stderr is the reason); anything else passes. Without
// an active loop, without isolation, or when HEAD is the default branch tip (the worktree would hold the same code), it passes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gitOut, loopRoot } from './vis-root.mjs';

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

let payload;
try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
if (payload?.tool_input?.isolation !== 'worktree') process.exit(0);
const cwd = payload.cwd || process.cwd();
const root = loopRoot(cwd);
if (!root) process.exit(0);
const head = gitOut(cwd, ['rev-parse', 'HEAD']);
const tip = defaultTip(cwd, root);
if (!head || !tip || head === tip.sha) process.exit(0);
process.stderr.write(
  `feature-loop: refused. isolation: "worktree" starts the subagent from the default branch (${tip.ref} ${tip.sha.slice(0, 7)}), ` +
  `not from HEAD (${head.slice(0, 7)}), so it would work on code without this change. Cut the worktree from HEAD yourself ` +
  `(git worktree add --detach <dir> HEAD), pass <dir> in the prompt, drop the isolation field, and remove the worktree after.\n`);
process.exit(2);
