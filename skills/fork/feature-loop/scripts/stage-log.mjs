// The hook-owned logs of the feature loop (fork.8, see ../gates.md "G9 stages"): .scratch/.loop/skills.jsonl,
// agents.jsonl and violations.jsonl. Every line is signed with an HMAC (SHA-256) under a per-loop key that lives
// outside the repository, and chained to the line before it (seq, prev), so a hand-written, edited or removed line is
// found when the logs are read. Node 22, no dependencies.
//
// The key: $FEATURE_LOOP_KEY_DIR (else $HOME/.cache/feature-loop)/<loop id>.key, else <root>/.claude/.loop-key when
// that directory cannot be written. The loop id is a random string in .scratch/.loop/id, made with the key.
// Residual risk: the key is a file the agent can read, so an agent set on cheating can sign its own lines.
import { createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SKILLS = 'skills.jsonl';
export const AGENTS = 'agents.jsonl';
export const VIOLATIONS = 'violations.jsonl';

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;

export const loopDir = (root) => join(root, '.scratch', '.loop');
export const loopDirExists = (root) => existsSync(loopDir(root));
const keyDir = () => process.env.FEATURE_LOOP_KEY_DIR || join(process.env.HOME || process.env.USERPROFILE || homedir(), '.cache', 'feature-loop');
const readTrim = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const keyPaths = (root, id) => [join(keyDir(), `${id}.key`), join(root, '.claude', '.loop-key')];

export function readKey(root) {
  const id = readTrim(join(loopDir(root), 'id'));
  if (!id) return null;
  for (const p of keyPaths(root, id)) {
    const k = readTrim(p);
    if (k.length >= 32) return k;
  }
  return null;
}

// Make .scratch/.loop/, its id and its key when they are missing. True when the loop can sign lines.
export function ensureLoop(root) {
  try {
    mkdirSync(loopDir(root), { recursive: true });
    const idFile = join(loopDir(root), 'id');
    if (!existsSync(idFile)) {
      try { writeFileSync(idFile, randomBytes(8).toString('hex') + '\n', { flag: 'wx' }); } catch { /* made by a parallel hook */ }
    }
    if (readKey(root)) return true;
    const key = randomBytes(32).toString('hex');
    for (const p of keyPaths(root, readTrim(idFile))) {
      try { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, key + '\n', { flag: 'wx', mode: 0o600 }); return true; } catch { /* try the next place */ }
    }
  } catch { /* unwritable: the hooks stay silent, the gate says it cannot verify */ }
  return false;
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

// Append { ...fields, seq, prev, mac } to the log. False when there is no key or the lock could not be taken.
export function appendEntry(root, file, fields) {
  const key = readKey(root);
  if (!key) return false;
  const path = join(loopDir(root), file);
  return withLock(root, () => {
    const all = lines(path);
    let last = null;
    try { last = all.length ? JSON.parse(all[all.length - 1]) : null; } catch { /* a broken last line: the gate reports it */ }
    const obj = { ...fields, seq: last && Number.isInteger(last.seq) ? last.seq + 1 : all.length, prev: (last && last.mac) || '' };
    appendFileSync(path, JSON.stringify({ ...obj, mac: sign(key, obj) }) + '\n');
    return true;
  }) === true;
}

// Read a log and verify it: { entries: the lines that verify, errors: what failed }. A line fails when it is not
// JSON, its HMAC does not match, or it does not follow the line before it (a removed or inserted line).
export function readLog(root, file) {
  const key = readKey(root);
  const out = { entries: [], errors: [] };
  const all = lines(join(loopDir(root), file));
  if (!all.length) return out;
  if (!key) { out.errors.push(`${file}: the loop key is missing, so the lines cannot be verified`); return out; }
  let prev = null;
  all.forEach((text, i) => {
    let e;
    try { e = JSON.parse(text); } catch { out.errors.push(`${file} line ${i + 1} is not JSON`); prev = null; return; }
    const { mac, ...rest } = e ?? {};
    const claimedMac = typeof mac === 'string' ? mac : '';
    const prevOk = i === 0 ? (rest.prev === '' && rest.seq === 0) : (prev === null || (rest.prev === prev.mac && rest.seq === prev.seq + 1));
    if (!claimedMac || sign(key, rest) !== claimedMac) out.errors.push(`${file} line ${i + 1} fails its HMAC (written by hand?)`);
    else if (!prevOk) out.errors.push(`${file} line ${i + 1} does not follow the line before it (a line was removed or inserted)`);
    else out.entries.push({ ...rest, line: i + 1 });
    prev = { mac: claimedMac, seq: rest.seq };
  });
  return out;
}

// The violations that no later "cleared" line answers.
export function openViolations(entries) {
  const cleared = new Set(entries.filter((e) => e.kind === 'cleared').map((e) => e.of));
  return entries.filter((e) => e.kind === 'violation' && !cleared.has(e.seq));
}
