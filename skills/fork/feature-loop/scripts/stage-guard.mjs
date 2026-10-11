// For the push and merge hooks, where no loop looks active (fork.8, gates.md "G9 stages"): was one started here by the
// stage hooks and then made to vanish? The out-of-repo state.json marks a loop that was started; this refuses a push or
// a merge when its .scratch/gates.json is gone, or says "closed" without a signed close entry from a passing close phase.
//
//   node stage-guard.mjs <dir>     exit 0 nothing to refuse (no loop was ever started here, only approvals were
//                                  signed, or it closed properly),
//                                  exit 1 with the reason on stdout
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { epochOf, readLog, readState } from './stage-log.mjs';

try {
  const dir = resolve(process.argv[2] || process.cwd());
  const top = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const here = top.status === 0 ? top.stdout.trim() : dir;
  const found = readState(here);
  if (!found) process.exit(0);
  const root = found.state.root && existsSync(found.state.root) ? found.state.root : here;
  const gates = join(root, '.scratch', 'gates.json');
  let closedFlag = false;
  if (existsSync(gates)) {
    try { closedFlag = JSON.parse(readFileSync(gates, 'utf8'))?.status === 'closed'; } catch (e) {
      // A run file that does not parse is no proof the loop closed: fail closed, say why.
      console.log(`.scratch/gates.json is not valid JSON (${e.message}), so the loop "${found.state.slug}" cannot be shown to have closed`);
      process.exit(1);
    }
    if (!closedFlag) process.exit(0);
  }
  const log = readLog(root);
  if (log.errors.length) {
    console.log(`the loop "${found.state.slug}" has no readable record (${log.errors[0]}), so it cannot be shown to have closed properly`);
    process.exit(1);
  }
  // A store with no signed init was made by the owner's approvals (approve acceptance, plan or pr) for a loop that
  // never started here, such as wp-loop on its own: nothing was started, so nothing can have vanished.
  if (!log.entries.some((e) => e.kind === 'init')) process.exit(0);
  const closedSigned = epochOf(log.entries).closed;
  if (closedSigned) process.exit(0);
  console.log(closedFlag
    ? `.scratch/gates.json says "status": "closed" for the loop "${found.state.slug}", but the log has no signed close entry: no close phase passed`
    : `the loop "${found.state.slug}" was started here but .scratch/gates.json is gone, and the log has no signed close entry`);
  process.exit(1);
} catch (e) {
  console.log(`could not check whether the loop closed properly: ${e.message}`);
  process.exit(1);
}
