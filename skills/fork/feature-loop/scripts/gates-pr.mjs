// The two checks of the pr phase that are not gates (fork.9, gates.md "Phases"): CI green on the exact HEAD of the
// pushed branch, and the owner's signed `approve pr` for that HEAD. They print as `PR-CI` and `PR-APPROVAL`.
//
// CI is `gh run list --commit <sha> --json conclusion,status`: at least one run, every run finished, none failed
// (success, skipped and neutral pass). The "merge_check" command of .scratch/gates.json ({sha} filled in, {pr} empty)
// replaces gh, as it does for the fork.8 merge check, so CI that gh cannot see can still be asked.
import { spawnSync } from 'node:child_process';
import { headSha } from './stage-detect.mjs';
import { headFresh } from './gates-head.mjs';
import { hasApproval } from './gates-approvals.mjs';

const OK = new Set(['success', 'skipped', 'neutral']);
const MAX_RUNS = '100';

export function ciGreen({ root, work, run }) {
  const sha = headSha(work);
  const short = sha.slice(0, 9);
  if (typeof run.merge_check === 'string' && run.merge_check) {
    const cmd = run.merge_check.replaceAll('{sha}', sha).replaceAll('{pr}', '');
    const r = spawnSync('bash', ['-c', cmd], { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? { state: 'green' } : { state: 'red', msg: `merge_check failed on ${short}: ${run.merge_check}` };
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
  const r = hasApproval(appr, 'pr', (a) => headFresh(work, a.head).ok, `HEAD ${head.slice(0, 9)}`);
  return r.ok ? { state: 'green' } : { state: 'red', msg: r.msg };
}
