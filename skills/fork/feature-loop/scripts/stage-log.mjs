// The hook-owned log of the feature loop (fork.8, see ../gates.md "G9 stages"): ONE chained, signed log,
// .scratch/.loop/log.jsonl, holding every record kind (init, size, base, skill, agent, violation, cleared, close).
// Node 22, no dependencies.
//
// Each line is { ...fields, seq, prev, mac }: seq counts from 0, prev is the previous line's mac, mac is HMAC-SHA256 of
// the rest under the loop key. Three places hold the loop's state:
//   <root>/.claude/.loop/key     the HMAC key (a self-ignoring directory: it never shows in git status)
//   <state dir>/state.json       OUTSIDE the repo: { rid, root, slug, ts, tip: { seq, mac } }, the loop-active marker
//                                and the log tip; <state dir> is $FEATURE_LOOP_STATE_DIR/<rid>, else
//                                $HOME/.cache/feature-loop/<rid>, else <root>/.claude/.loop/out when HOME is unwritable
// A log shorter than its tip, a deleted log after init, a missing key or a missing marker is an error, never a quiet
// regeneration. Residual risk: an agent set on cheating can read the key and the state and re-sign its own history.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

export const loopDir = (root) => join(root, '.scratch', '.loop');
export const logPath = (root) => join(loopDir(root), 'log.jsonl');
export const keyDirIn = (root) => join(root, '.claude', '.loop');
const keyPath = (root) => join(keyDirIn(root), 'key');
const readTrim = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };

// The repository's identity, stable across the path spellings of one machine (MSYS, Windows): the git common dir.
export function repoId(root) {
  const r = spawnSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  const p = r.status === 0 && r.stdout.trim() ? r.stdout.trim() : resolve(root);
  return createHash('sha256').update(p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).digest('hex').slice(0, 16);
}

const stateBase = () => process.env.FEATURE_LOOP_STATE_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.cache', 'feature-loop');
const statePaths = (root) => [join(stateBase(), repoId(root), 'state.json'), join(keyDirIn(root), 'out', 'state.json')];

export function readState(root) {
  for (const p of statePaths(root)) {
    try { return { state: JSON.parse(readFileSync(p, 'utf8')), path: p }; } catch { /* next place */ }
  }
  return null;
}

function writeState(root, state, path) {
  const targets = path ? [path] : statePaths(root);
  for (const p of targets) {
    try {
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p + '.tmp', JSON.stringify(state) + '\n');
      renameSync(p + '.tmp', p);
      return p;
    } catch { /* next place */ }
  }
  return null;
}

export const readKey = (root) => { const k = readTrim(keyPath(root)); return k.length >= 32 ? k : null; };

// What the stores look like: none (no loop was ever started here), ok, or broken (with the reason, said plainly).
export function storeStatus(root) {
  const st = readState(root), key = readKey(root), log = existsSync(logPath(root));
  if (!st && !key && !log) return { kind: 'none' };
  if (st && key) return { kind: 'ok', state: st.state, path: st.path, key };
  if (st && !key) return { kind: 'broken', reason: 'the loop key (.claude/.loop/key) is missing after init; it is never regenerated, so the logs cannot be verified' };
  return { kind: 'broken', reason: 'the loop state outside the repo (state.json) is missing, so the log tip cannot be checked' };
}

// Make the key, its self-ignoring directory and the state for a loop that has none. False when it cannot be written.
export function createStore(root, slug, now) {
  try {
    mkdirSync(keyDirIn(root), { recursive: true });
    writeFileSync(join(keyDirIn(root), '.gitignore'), '*\n');
    writeFileSync(keyPath(root), randomBytes(32).toString('hex') + '\n', { flag: 'wx', mode: 0o600 });
    mkdirSync(loopDir(root), { recursive: true });
    return writeState(root, { rid: repoId(root), root, slug, ts: now, tip: null }) !== null;
  } catch { return false; }
}

const sign = (key, obj) => createHmac('sha256', key).update(JSON.stringify(obj)).digest('hex');
const lines = (path) => { try { return readFileSync(path, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== ''); } catch { return []; } };

function withLock(root, fn) {
  const lock = join(loopDir(root), '.lock');
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true }); } catch { /* gone already */ }
      if (Date.now() > until) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return fn(); } finally { try { rmSync(lock, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// Append { ...fields, seq, prev, mac }. Refuses (false) when the stores are not ok, or when the log's last line is not
// the recorded tip: a tampered log is left as it is, so the gate keeps reporting it.
export function appendEntry(root, fields) {
  const s = storeStatus(root);
  if (s.kind !== 'ok') return false;
  return withLock(root, () => {
    const all = lines(logPath(root));
    let last = null;
    try { last = all.length ? JSON.parse(all[all.length - 1]) : null; } catch { return false; }
    const tip = s.state.tip;
    if ((tip ? tip.seq : -1) !== (last ? last.seq : -1) || (tip ? tip.mac : '') !== (last ? last.mac : '')) return false;
    const obj = { ...fields, seq: last ? last.seq + 1 : 0, prev: last ? last.mac : '' };
    const mac = sign(s.key, obj);
    mkdirSync(loopDir(root), { recursive: true });
    appendFileSync(logPath(root), JSON.stringify({ ...obj, mac }) + '\n');
    return writeState(root, { ...s.state, tip: { seq: obj.seq, mac } }, s.path) !== null;
  }) === true;
}

// Read and verify the log: { status, entries (the lines that verify, with .line), errors }. A line fails when it is not
// JSON, its HMAC is wrong, or it does not follow the line before it; the log fails when it ends before its tip.
export function readLog(root) {
  const s = storeStatus(root);
  const out = { status: s.kind, entries: [], errors: [] };
  if (s.kind === 'none') return out;
  if (s.kind === 'broken') { out.errors.push(s.reason); return out; }
  const all = lines(logPath(root));
  const tip = s.state.tip;
  if (!all.length) {
    if (tip) out.errors.push(`log.jsonl is gone or empty but the loop recorded ${tip.seq + 1} line(s): it was deleted or truncated`);
    return out;
  }
  let prev = null;
  let lastClaimed = null;
  all.forEach((text, i) => {
    let e;
    try { e = JSON.parse(text); } catch { out.errors.push(`log.jsonl line ${i + 1} is not JSON`); prev = null; return; }
    const { mac, ...rest } = e ?? {};
    const claimed = typeof mac === 'string' ? mac : '';
    const prevOk = i === 0 ? (rest.prev === '' && rest.seq === 0) : (prev === null || (rest.prev === prev.mac && rest.seq === prev.seq + 1));
    if (!claimed || sign(s.key, rest) !== claimed) out.errors.push(`log.jsonl line ${i + 1} fails its HMAC (written by hand?)`);
    else if (!prevOk) out.errors.push(`log.jsonl line ${i + 1} does not follow the line before it (a line was removed or inserted)`);
    else out.entries.push({ ...rest, line: i + 1 });
    prev = { mac: claimed, seq: rest.seq };
    lastClaimed = prev;
  });
  if (!tip) out.errors.push('log.jsonl has lines but the loop recorded none: the state outside the repo was replaced');
  else if (!lastClaimed || lastClaimed.seq !== tip.seq || lastClaimed.mac !== tip.mac) {
    out.errors.push(lastClaimed && lastClaimed.seq < tip.seq
      ? `log.jsonl ends at line ${lastClaimed.seq + 1} but the loop recorded ${tip.seq + 1}: it was truncated`
      : 'log.jsonl does not end at the recorded tip');
  }
  return out;
}

// The entries of the current loop: from the last init on. { init, entries, closed }.
export function epochOf(entries) {
  let at = -1;
  entries.forEach((e, i) => { if (e.kind === 'init') at = i; });
  if (at < 0) return { init: null, entries: [], closed: false };
  const eps = entries.slice(at);
  return { init: entries[at], entries: eps, closed: eps.some((e) => e.kind === 'close') };
}

// The violations that no later "cleared" line answers.
export function openViolations(entries) {
  const cleared = new Set(entries.filter((e) => e.kind === 'cleared').map((e) => e.of));
  return entries.filter((e) => e.kind === 'violation' && !cleared.has(e.seq));
}
