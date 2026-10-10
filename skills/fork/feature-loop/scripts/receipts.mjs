// The single owner of Codex review receipts (see ../gates.md, gate G9). codex-review.mjs writes them through
// writeReceipt; check-gates.mjs reads and judges them through evaluatePlanReceipt. Nothing else opens a receipt.
// Node 22, no dependencies.
//
// A receipt is .scratch/receipts/<slug>/G9.json, versioned JSON written to a temp file and renamed into place.
// A receipt is trusted only if it parses, matches the schema below, says completed, and carries the hash of the
// plan (contract + spec snapshot) as it is now.
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RECEIPT_VERSION = 1;
export const MAX_ROUNDS = 2; // Codex rounds per plan hash (invariant I9)
export const ISOLATION_MODES = ['stdin-no-tools'];
export const VERDICTS = ['pass', 'fail', 'blocked', 'paused'];
const COMPLETED_VERDICTS = ['pass', 'fail'];
export const SEVERITIES = ['blocking', 'advisory'];
const MAX_RECEIPT_BYTES = 1024 * 1024;
export const MAX_FINDINGS = 50;
export const MAX_HISTORY = 20; // plan hashes whose round counts a receipt remembers
export const MAX_OPEN_LISTED = 10;
export const LIMITS = { model: 100, cli_version: 50, summary: 4000, cause: 1000, title: 300, location: 300, failure_scenario: 2000, recommendation: 2000, open: 300 };
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const RENAME_TRIES = 5;

export const validSlug = (s) => typeof s === 'string' && SLUG_RE.test(s) && !s.includes('..');
export const receiptRel = (slug, gate = 'G9') => `.scratch/receipts/${slug}/${gate}.json`;
export const contractRel = (slug) => `.scratch/contract/${slug}.md`;
export const specRel = (slug) => `.scratch/spec/${slug}.md`;

// ---- the plan hash

const normalizeEol = (text) => text.replace(/\r\n/g, '\n');
const readText = (file) => { try { return normalizeEol(readFileSync(file, 'utf8')); } catch { return null; } };

// The plan is the contract plus the spec snapshot. A small change has no spec snapshot (its plan is the wp-loop
// contract file alone). Line endings are normalized so a checkout on another platform hashes the same.
export function planInputs(root, slug, size) {
  if (!validSlug(slug)) return { error: 'the slug is not a plain name' };
  const contract = readText(join(root, contractRel(slug)));
  if (contract === null) return { error: `contract missing (${contractRel(slug)})` };
  const spec = readText(join(root, specRel(slug)));
  if (spec === null && size !== 'small') return { error: `spec snapshot missing (${specRel(slug)})` };
  return { contract, spec };
}

export function planHash(root, slug, size) {
  const inputs = planInputs(root, slug, size);
  if (inputs.error) return inputs;
  const h = createHash('sha256');
  h.update(`contract\n${inputs.contract}\0spec\n${inputs.spec ?? ''}`);
  return { hash: `sha256:${h.digest('hex')}`, ...inputs };
}

// ---- validation. Every field is checked: a receipt is read by a gate, and the file is only as good as its writer.

const isStr = (v, max) => typeof v === 'string' && v.length <= max;
// C0, DEL, C1 and the Unicode line separators: nothing a terminal or a log line should receive from a model.
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]/u;
export const hasControlChars = (v) => typeof v === 'string' && CONTROL_RE.test(v);
// Whitespace collapsed to single spaces and control characters dropped: one safe line.
export const cleanText = (v) => String(v ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}\s]+/gu, ' ').trim();
const isLine = (v, max) => isStr(v, max) && !hasControlChars(v);
const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1000;

// A location is '' (no file) or a relative path with an optional :line or :line-line suffix.
export function validLocation(loc) {
  if (loc === '') return true;
  if (!isLine(loc, LIMITS.location)) return false;
  const path = loc.replace(/:\d+(-\d+)?$/, '');
  if (!path || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)) return false;
  if (path.includes('\0') || path.includes('\\')) return false;
  return !path.split('/').some((seg) => seg === '..' || seg === '');
}

function findingProblems(f, i) {
  const at = `findings[${i}]`;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return [`${at} is not an object`];
  const out = [];
  if (!SEVERITIES.includes(f.severity)) out.push(`${at}.severity must be blocking or advisory`);
  if (!isStr(f.id, 40) || !f.id) out.push(`${at}.id must be a short non-empty string`);
  if (!isLine(f.title, LIMITS.title) || !f.title) out.push(`${at}.title must be a non-empty single line`);
  if (!validLocation(f.location)) out.push(`${at}.location must be empty or a relative path`);
  if (!isLine(f.failure_scenario, LIMITS.failure_scenario)) out.push(`${at}.failure_scenario must be a string`);
  if (!isLine(f.recommendation, LIMITS.recommendation)) out.push(`${at}.recommendation must be a string`);
  // A finding blocks only with a concrete failure scenario (spec amendment A1).
  if (f.severity === 'blocking' && !(typeof f.failure_scenario === 'string' && f.failure_scenario.trim())) {
    out.push(`${at} is blocking without a failure_scenario`);
  }
  return out;
}

const stampProblems = (r) => ['started_at', 'finished_at'].filter((k) => !(typeof r[k] === 'string' && ISO_RE.test(r[k]) && !Number.isNaN(Date.parse(r[k]))))
  .map((k) => `${k} must be an ISO-8601 UTC timestamp`);

function stateProblems(r) {
  const out = [];
  if (typeof r.completed !== 'boolean') return ['completed must be true or false'];
  if (!VERDICTS.includes(r.verdict)) return ['verdict must be pass, fail, blocked or paused'];
  if (r.completed !== COMPLETED_VERDICTS.includes(r.verdict)) out.push(`completed is ${r.completed} but verdict is ${r.verdict}`);
  if (!r.completed && !(isLine(r.cause, LIMITS.cause) && r.cause)) out.push('an incomplete receipt needs a cause on a single line');
  const blocking = Array.isArray(r.findings) ? r.findings.filter((f) => f?.severity === 'blocking').length : 0;
  if (r.verdict === 'pass' && blocking) out.push('verdict pass with blocking findings');
  if (r.verdict === 'fail' && !blocking) out.push('verdict fail without a blocking finding');
  return out;
}

// rounds_by_hash: how many Codex rounds each plan hash has had, with its open blocking findings, so returning to an
// earlier plan does not reset its cap. The entry for this receipt's own plan agrees with rounds_used.
function historyProblems(r) {
  const h = r.rounds_by_hash;
  if (typeof h !== 'object' || h === null || Array.isArray(h) || Object.keys(h).length > MAX_HISTORY) return ['rounds_by_hash must be an object of at most 20 plan hashes'];
  const out = [];
  for (const [hash, e] of Object.entries(h)) {
    const ok = HASH_RE.test(hash) && isCount(e?.rounds) && Array.isArray(e.open) && e.open.length <= MAX_OPEN_LISTED && e.open.every((o) => isLine(o, LIMITS.open));
    if (!ok) out.push(`rounds_by_hash entry ${hash.slice(0, 20)} is malformed`);
  }
  if ((h[r.plan_hash]?.rounds ?? 0) !== r.rounds_used) out.push('rounds_by_hash disagrees with rounds_used for this plan');
  return out;
}

export function validateReceipt(r) {
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return ['receipt is not a JSON object'];
  if (r.version !== RECEIPT_VERSION) return [`receipt version is ${JSON.stringify(r.version)}, this verifier reads ${RECEIPT_VERSION}`];
  const out = [];
  if (r.gate !== 'G9') out.push('gate must be G9');
  if (!validSlug(r.slug)) out.push('slug must be a plain name');
  if (!HASH_RE.test(r.plan_hash ?? '')) out.push('plan_hash must be sha256:<64 hex>');
  if (!Number.isInteger(r.round) || r.round < 1 || r.round > 100) out.push('round must be a positive integer');
  if (!isCount(r.rounds_used)) out.push('rounds_used must be a non-negative integer');
  if (!ISOLATION_MODES.includes(r.isolation)) out.push(`isolation must be one of ${ISOLATION_MODES.join(', ')}`);
  for (const k of ['model', 'cli_version']) if (!isLine(r[k], LIMITS[k]) || !r[k]) out.push(`${k} must be a non-empty string`);
  if (!isLine(r.summary, LIMITS.summary)) out.push('summary must be a single line');
  out.push(...historyProblems(r));
  if (!Array.isArray(r.findings) || r.findings.length > MAX_FINDINGS) out.push(`findings must be an array of at most ${MAX_FINDINGS}`);
  else r.findings.forEach((f, i) => out.push(...findingProblems(f, i)));
  out.push(...stampProblems(r), ...stateProblems(r));
  return out;
}

// ---- reading and writing

export function readReceipt(root, slug) {
  const file = join(root, receiptRel(slug));
  let text;
  try {
    if (statSync(file).size > MAX_RECEIPT_BYTES) return { state: 'invalid', reason: 'receipt file is larger than 1 MB' };
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return e.code === 'ENOENT' ? { state: 'missing' } : { state: 'invalid', reason: `receipt unreadable: ${e.code ?? e.message}` };
  }
  let receipt;
  try { receipt = JSON.parse(text); } catch (e) { return { state: 'invalid', reason: `receipt is not valid JSON, truncated? (${e.message})` }; }
  const problems = validateReceipt(receipt);
  if (problems.length) return { state: 'invalid', reason: `receipt fails its schema: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? `; and ${problems.length - 3} more` : ''}` };
  return { state: 'ok', receipt };
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Temp file in the same directory, flushed, then renamed over the target: a reader sees the old receipt or the new
// one, never half of one. Windows can refuse the rename while a reader holds the target, so it retries briefly.
export function writeReceipt(root, slug, receipt) {
  const problems = validateReceipt(receipt);
  if (problems.length) throw new Error(`refusing to write an invalid receipt: ${problems.join('; ')}`);
  const target = join(root, receiptRel(slug));
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  for (let attempt = 1; ; attempt++) {
    try { renameSync(tmp, target); return target; } catch (e) {
      if (attempt >= RENAME_TRIES || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { unlinkSync(tmp); } catch { /* temp already gone */ } throw e; }
      sleepMs(25 * attempt);
    }
  }
}

// ---- the G9 judgement

const idList = (fs) => fs.map((f) => f.id).join(', ');

// { ok: true } or { ok: false, reason }. The reason names what to do next.
export function evaluatePlanReceipt(root, slug, size) {
  const plan = planHash(root, slug, size);
  if (plan.error) return { ok: false, reason: plan.error };
  const got = readReceipt(root, slug);
  if (got.state === 'missing') return { ok: false, reason: 'no Gate A receipt, run codex-review.mjs gate-a' };
  if (got.state === 'invalid') return { ok: false, reason: got.reason };
  const r = got.receipt;
  if (r.slug !== slug) return { ok: false, reason: `receipt is for slug ${r.slug}, not ${slug}` };
  if (r.plan_hash !== plan.hash) return { ok: false, reason: 'the plan changed since the Codex review (contract or spec hash differs), rerun gate-a' };
  if (!r.completed) return { ok: false, reason: `Gate A is ${r.verdict}: ${r.cause}` };
  const open = r.findings.filter((f) => f.severity === 'blocking');
  if (r.verdict === 'fail' && r.rounds_used >= MAX_ROUNDS) {
    return { ok: false, reason: `blocked: ${MAX_ROUNDS} Codex rounds used on this plan, escalate to the human; open findings: ${idList(open)}` };
  }
  if (r.verdict === 'fail') return { ok: false, reason: `Gate A has ${open.length} blocking finding${open.length > 1 ? 's' : ''} (${idList(open)}), fix the plan and rerun gate-a` };
  return { ok: true };
}
