// The two checks of the pr phase that are not gates (fork.9, gates.md "Phases"): CI green on the exact HEAD of the
// pushed branch, and the owner's signed `approve pr` for that HEAD. They print as `PR-CI` and `PR-APPROVAL`.
//
// CI is `gh run list --commit <sha> --json conclusion,status`: at least one run, every run finished, none failed
// (success, skipped and neutral pass). The "merge_check" command of .scratch/gates.json ({sha} filled in, {pr} empty) is
// asked only when GitHub says the repository has no CI workflows at all (fork.9.1): with CI present the agent's own
// merge_check could answer green for anything, so gh decides. The pass says so: `PR-CI green (merge_check, no CI workflows)`.
import { spawnSync } from 'node:child_process';
import { headSha } from './stage-detect.mjs';
import { fullSha, isSha } from './gates-head.mjs';
import { hasApproval } from './gates-approvals.mjs';

const OK = new Set(['success', 'skipped', 'neutral']);
const MAX_RUNS = '100';

// Does GitHub report any workflow for the repository of `work`? true, false, or null when gh could not say (not logged in,
// no remote, offline): null never opens the merge_check fallback.
function hasWorkflows(work) {
  const r = spawnSync('bash', ['-c', 'exec gh "$@"', 'gh', 'workflow', 'list', '--limit', '1', '--json', 'id'], { cwd: work, encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout || '[]');
    return Array.isArray(list) ? list.length > 0 : null;
  } catch { return null; }
}

export function ciGreen({ root, work, run }) {
  const sha = headSha(work);
  const short = sha.slice(0, 9);
  if (typeof run.merge_check === 'string' && run.merge_check && hasWorkflows(work) === false) {
    const cmd = run.merge_check.replaceAll('{sha}', sha).replaceAll('{pr}', '');
    const r = spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? { state: 'green', note: '(merge_check, no CI workflows)' } : { state: 'red', msg: `merge_check failed on ${short}: ${run.merge_check}` };
  }
  // Through bash, so that `gh` resolves the way it does in the hook (and a stand-in script on PATH is found on Windows,
  // where spawning 'gh' directly only finds gh.exe).
  const r = spawnSync('bash', ['-c', 'exec gh "$@"', 'gh', 'run', 'list', '--commit', sha, '--json', 'conclusion,status', '--limit', MAX_RUNS], { cwd: work, encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { state: 'red', msg: `gh run list --commit ${short} failed, so CI could not be checked: ${(r.error?.message ?? r.stderr ?? '').trim().split('\n')[0]}` };
  }
  let runs;
  try { runs = JSON.parse(r.stdout || '[]'); } catch { return { state: 'red', msg: 'gh run list did not return JSON' }; }
  if (!Array.isArray(runs) || !runs.length) return { state: 'red', msg: `no CI run on ${short}: push the branch and wait for the workflow` };
  const pending = runs.filter((x) => x?.status !== 'completed');
  if (pending.length) return { state: 'red', msg: `CI is still running on ${short} (${pending.length} of ${runs.length} runs)` };
  const bad = runs.filter((x) => !OK.has(String(x?.conclusion)));
  if (bad.length) return { state: 'red', msg: `CI is not green on ${short}: ${[...new Set(bad.map((x) => x?.conclusion || 'no conclusion'))].join(', ')}` };
  return runs.some((x) => x.conclusion === 'success') ? { state: 'green' } : { state: 'red', msg: `no CI run succeeded on ${short}` };
}

export function prApproval({ work, appr }) {
  const head = headSha(work);
  // The approval is for this exact commit: no tolerance for later commits, not even of files that are not source.
  const r = hasApproval(appr, 'pr', (a) => isSha(a.head) && fullSha(work, a.head) === head, `HEAD ${head.slice(0, 9)}`);
  return r.ok ? { state: 'green' } : { state: 'red', msg: r.msg };
}
