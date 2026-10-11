// What the signed log says about the current loop, and how a loop is started in it (fork.8, gates.md "G9 stages").
// Shared by the hook (stage-hook.mjs) and the gate (stage-gate.mjs).
import { appendEntry, createStore, epochOf, openViolations, readLog, storeStatus } from './stage-log.mjs';
import {
  SIZES, baseSha, changedSince, headSha, loopFacts, maxSize, missingPlanning, normSkill, planSnapshot, validPlan,
} from './stage-detect.mjs';

const now = () => process.env.FEATURE_LOOP_NOW || new Date().toISOString();

// The init entry's fields: the signed facts every later check starts from.
export function initFields(root, run, session) {
  const plan = planSnapshot(root, run.slug);
  return {
    kind: 'init', ts: now(), wall: Date.now(), session, slug: run.slug ?? '', size: SIZES.includes(run.size) ? run.size : 'normal',
    base: typeof run.base === 'string' ? run.base : '', baseSha: baseSha(root, run.base), startSha: headSha(root),
    planFile: plan.file ?? '', planSha: plan.sha ?? '', ...loopFacts(root),
  };
}

// Make sure a signed init for this loop exists: the store on the first call, a new init after the last loop closed, a `size` entry when gates.json asks for more than was recorded, a `base` entry when the base
// resolves now and did not at init. Returns '' or the loud reason the loop cannot be recorded.
export function ensureInit(root, run, session) {
  if (!run || typeof run.slug !== 'string' || !run.slug) return '';
  let s = storeStatus(root);
  if (s.kind === 'broken') return s.reason;
  if (s.kind === 'none') {
    if (!createStore(root, run.slug, now())) return 'the loop key and state could not be written (.claude/.loop, and the state directory outside the repo)';
    s = storeStatus(root);
  }
  const log = readLog(root);
  if (log.errors.length) return ''; // the gate reports it; a tampered log is never appended to
  const ep = epochOf(log.entries);
  // A new slug starts a new loop only after the last one closed; renaming an open loop keeps its record (G9 reports it).
  if (!ep.init || (ep.init.slug !== run.slug && ep.closed)) {
    appendEntry(root, initFields(root, run, session));
    return '';
  }
  const eff = maxSize(ep.init.size, ...ep.entries.filter((e) => e.kind === 'size').map((e) => e.size));
  if (SIZES.indexOf(run.size) > SIZES.indexOf(eff)) appendEntry(root, { kind: 'size', ts: now(), size: run.size, session });
  const eb = [...ep.entries].reverse().find((e) => e.kind === 'base' || e.kind === 'init');
  const bs = eb ? eb.baseSha : '';
  const resolved = baseSha(root, run.base);
  if (!bs && resolved) appendEntry(root, { kind: 'base', ts: now(), base: run.base, baseSha: resolved, session });
  return '';
}

// Everything a hook or the gate needs to judge the loop, from the verified log and the tree. `dirs` are the worktrees to
// scan for source changes. `size` is the largest ever recorded or asked for: a size can go up, never down.
export function assess(root, run, dirs) {
  const log = readLog(root);
  const ep = epochOf(log.entries);
  const out = { log, ep, init: ep.init, errors: log.errors };
  if (!ep.init) return out;
  const init = ep.init;
  const sizes = [init.size, run?.size, ...ep.entries.filter((e) => e.kind === 'size').map((e) => e.size)];
  const size = maxSize(...sizes);
  const logged = new Set(ep.entries.filter((e) => e.kind === 'skill').map((e) => normSkill(e.skill)));
  const plan = validPlan(root, init);
  const bad = [...new Set([...dirs].flatMap((d) => changedSince(d, init.startSha)))].sort();
  const lastBase = [...ep.entries].reverse().find((e) => e.kind === 'base' || e.kind === 'init');
  return {
    ...out, size, logged, plan, bad, baseSha: lastBase ? lastBase.baseSha : '',
    missing: missingPlanning(root, size, logged, plan !== null),
    open: openViolations(ep.entries),
  };
}
