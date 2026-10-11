// The owner's approvals (fork.9, gates.md "Approvals"), read through ONE function so the source can change.
//
// Assumed interface (builder B, stage-log.mjs): `approvals(root)` returns the verified approvals of the signed log,
//   [{ stop: 'acceptance' | 'plan' | 'pr', plan_sha?, head?, at }]
// and may be sync or async. Where stage-log.mjs has no such export, approvals are unavailable and every gate that
// needs one is red (fail closed).
// Tests stub it: FEATURE_LOOP_APPROVALS_FIXTURE=<json file holding the same list>. The gate hook runs with the
// harness's environment, which the agent does not control, so this is not an agent-side bypass.
import { readFileSync } from 'node:fs';

export async function loadApprovals(root) {
  const fixture = process.env.FEATURE_LOOP_APPROVALS_FIXTURE;
  try {
    if (fixture) {
      const list = JSON.parse(readFileSync(fixture, 'utf8'));
      return Array.isArray(list) ? { ok: true, list } : { ok: false, why: `${fixture} is not a list` };
    }
    const m = await import('./stage-log.mjs');
    if (typeof m.approvals !== 'function') return { ok: false, why: 'stage-log.mjs has no approvals(root): the approvals hook is not installed' };
    const list = await m.approvals(root);
    return Array.isArray(list) ? { ok: true, list } : { ok: false, why: 'approvals(root) did not return a list' };
  } catch (e) {
    return { ok: false, why: `approvals could not be read: ${e.message}` };
  }
}

// Is there a signed approval for this stop that `match` accepts? { ok } or { ok: false, msg }.
export function hasApproval(appr, stop, match, what) {
  if (!appr.ok) return { ok: false, msg: appr.why };
  return appr.list.some((a) => a && a.stop === stop && match(a))
    ? { ok: true }
    : { ok: false, msg: `the signed log has no "approve ${stop}" for ${what}: only the owner can give it, in a prompt` };
}
