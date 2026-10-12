// For `gh pr create` where no feature loop is active but the owner's approvals made a signed store (wp-loop, fork.9.7).
// HAR-181 dry run 2: after the first issue the loop stopped calling the `adversarial-review` and `pr` skills and wrote
// its own one-attacker review and PR body instead, though wp-loop steps 9 and 12 say to call them for every issue. The
// stage hook signs every Skill call into the store (stage-hook.mjs), so a PR is refused until both skills were called
// since the last `approve pr` for a different head.
//
//   node wp-pr-guard.mjs <dir>     exit 0 nothing to refuse (no store, a real feature loop, or both skills logged),
//                                  exit 1 with the reason on stdout
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readLog, storeStatus } from './stage-log.mjs';

const REQUIRED = ['adversarial-review', 'pr'];
const skillName = (s) => String(s ?? '').replace(/^.*:/, '');

try {
  const dir = resolve(process.argv[2] || process.cwd());
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = top.status === 0 ? top.stdout.trim() : dir;
  if (storeStatus(root).kind !== 'ok') process.exit(0);
  const log = readLog(root);
  if (log.errors.length) {
    console.log(`the signed log is unreadable (${log.errors[0]}), so it cannot show that adversarial-review and pr ran`);
    process.exit(1);
  }
  if (log.entries.some((e) => e.kind === 'init')) process.exit(0); // a feature loop: its own pr phase gates the PR
  const prApprovals = log.entries.map((e, i) => (e.kind === 'approval' && e.stop === 'pr' ? i : -1)).filter((i) => i >= 0);
  if (!prApprovals.length) process.exit(0); // the approval hook and the owner prompt still stand in front of the PR
  // The window opens after the last PR approval for a different head (the previous issue's PR, or this issue before a
  // new commit), so approving the same head twice keeps the review that came before it.
  const head = log.entries[prApprovals[prApprovals.length - 1]].head;
  const prev = prApprovals.filter((i) => log.entries[i].head !== head).pop();
  const from = prev === undefined ? 0 : prev + 1;
  const called = new Set(log.entries.slice(from).filter((e) => e.kind === 'skill').map((e) => skillName(e.skill)));
  const missing = REQUIRED.filter((s) => !called.has(s));
  if (!missing.length) process.exit(0);
  console.log(`wp-loop: this issue's PR needs the ${missing.map((s) => `\`${s}\``).join(' and ')} skill${missing.length > 1 ? 's' : ''} called with the Skill tool since the previous PR (steps 9 and 12); a review or PR body written without the skill does not count`);
  process.exit(1);
} catch (e) {
  console.log(`could not check the wp-loop review record: ${e.message}`);
  process.exit(1);
}
