// Tests for receipts.mjs (the receipt verifier) and for G9 in check-gates.mjs.
// Run: node --test skills/fork/feature-loop/scripts/test-receipts.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG, put } from './fixtures/codex/support.mjs';
import { MAX_ROUNDS, evaluatePlanReceipt, planHash, readReceipt, receiptRel, validateReceipt, validLocation, writeReceipt } from './receipts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const checker = join(here, 'check-gates.mjs');
const FINDING = { id: 'F1', severity: 'blocking', title: 'Retry loop never ends', location: 'src/a.js:3', failure_scenario: 'The worker retries forever when upstream returns 500.', recommendation: 'Cap retries.' };

// A directory holding only .scratch/: gates.json, contract and spec.
function loopDir({ flag = true, size = 'normal', spec = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rc-test-'));
  put(root, '.scratch/gates.json', JSON.stringify({ slug: SLUG, size, base: 'main', ...(flag === 'absent' ? {} : { codex_review: flag }) }));
  put(root, `.scratch/contract/${SLUG}.md`, '# Contract\nA\n');
  if (spec) put(root, `.scratch/spec/${SLUG}.md`, '# Spec\nB\n');
  return root;
}

function receipt(root, over = {}, size = 'normal') {
  const completed = over.completed ?? true;
  const verdict = over.verdict ?? 'pass';
  return {
    version: 1, gate: 'G9', slug: SLUG, completed, verdict, round: 1, rounds_used: completed ? 1 : 0,
    plan_hash: planHash(root, SLUG, size).hash, model: 'gpt-test', cli_version: '0.162.1', isolation: 'stdin-no-tools',
    started_at: '2026-10-10T01:00:00.000Z', finished_at: '2026-10-10T01:02:00.000Z', summary: 'ok', findings: [],
    ...(completed ? {} : { cause: 'timeout: killed' }), ...over,
  };
}

const g9 = (root, ...extra) => {
  const r = spawnSync(process.execPath, [checker, '--root', root, '--last-commit', '0', '--slop', '/none', ...extra], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr, lines: r.stdout.trim().split('\n') };
};

// ---- the verifier

test('planHash covers contract and spec, ignores line endings, and changes with either', () => {
  const root = loopDir();
  const a = planHash(root, SLUG, 'normal').hash;
  put(root, `.scratch/spec/${SLUG}.md`, '# Spec\r\nB\r\n');
  assert.equal(planHash(root, SLUG, 'normal').hash, a, 'CRLF and LF hash the same');
  put(root, `.scratch/spec/${SLUG}.md`, '# Spec\nC\n');
  assert.notEqual(planHash(root, SLUG, 'normal').hash, a);
  put(root, `.scratch/spec/${SLUG}.md`, '# Spec\nB\n');
  put(root, `.scratch/contract/${SLUG}.md`, '# Contract\nZ\n');
  assert.notEqual(planHash(root, SLUG, 'normal').hash, a);
});

test('planHash: a small change needs only the contract; a normal one needs the spec snapshot too', () => {
  const root = loopDir({ spec: false });
  assert.match(planHash(root, SLUG, 'small').hash, /^sha256:/);
  assert.match(planHash(root, SLUG, 'normal').error, /spec snapshot missing/);
  assert.match(planHash(root, '../x', 'normal').error, /plain name/);
});

test('a valid receipt validates', () => {
  const root = loopDir();
  assert.deepEqual(validateReceipt(receipt(root)), []);
  assert.deepEqual(validateReceipt(receipt(root, { verdict: 'fail', findings: [FINDING] })), []);
});

const BAD = [
  ['wrong version', { version: 2 }, /version/],
  ['unknown verdict', { verdict: 'maybe' }, /verdict/],
  ['completed without a completed verdict', { completed: true, verdict: 'paused' }, /completed is true but verdict is paused/],
  ['incomplete with pass', { completed: false, verdict: 'pass', cause: 'x' }, /completed is false but verdict is pass/],
  ['incomplete without cause', { completed: false, verdict: 'blocked', cause: '' }, /needs a cause/],
  ['pass with a blocking finding', { findings: [FINDING] }, /pass with blocking/],
  ['fail without a blocking finding', { verdict: 'fail' }, /fail without a blocking/],
  ['blocking without a failure scenario', { verdict: 'fail', findings: [{ ...FINDING, failure_scenario: ' ' }] }, /without a failure_scenario/],
  ['absolute finding location', { findings: [{ ...FINDING, severity: 'advisory', location: '/etc/passwd' }] }, /relative path/],
  ['escaping finding location', { findings: [{ ...FINDING, severity: 'advisory', location: '../secret' }] }, /relative path/],
  ['bad plan hash', { plan_hash: 'abc' }, /plan_hash/],
  ['zero round', { round: 0 }, /round/],
  ['unknown isolation', { isolation: 'none' }, /isolation/],
  ['empty model', { model: '' }, /model/],
  ['timestamp not ISO', { started_at: 'yesterday' }, /started_at/],
  ['overlong summary', { summary: 'x'.repeat(5000) }, /summary/],
  ['too many findings', { findings: Array.from({ length: 51 }, () => ({ ...FINDING, severity: 'advisory' })) }, /findings/],
];
for (const [name, over, re] of BAD) {
  test(`schema rejects: ${name}`, () => {
    const problems = validateReceipt(receipt(loopDir(), over));
    assert.ok(problems.some((p) => re.test(p)), `${re} not in ${JSON.stringify(problems)}`);
  });
}

test('validLocation accepts empty, relative paths and :line suffixes only', () => {
  for (const ok of ['', 'src/a.js', 'src/a.js:12', 'src/a.js:12-20']) assert.equal(validLocation(ok), true, ok);
  for (const bad of ['/a', 'C:\\x', 'C:/x', 'a/../b', 'a\\b', 'a//b', 'x\0y']) assert.equal(validLocation(bad), false, bad);
});

test('writeReceipt is atomic: no temp file is left, an existing receipt is replaced, an invalid one is refused', () => {
  const root = loopDir();
  writeReceipt(root, SLUG, receipt(root));
  writeReceipt(root, SLUG, receipt(root, { summary: 'second' }));
  assert.equal(readReceipt(root, SLUG).receipt.summary, 'second');
  assert.deepEqual(readdirSync(join(root, '.scratch', 'receipts', SLUG)), ['G9.json']);
  assert.throws(() => writeReceipt(root, SLUG, receipt(root, { version: 9 })), /invalid receipt/);
  assert.equal(readReceipt(root, SLUG).receipt.summary, 'second', 'the bad write changed nothing');
});

test('readReceipt: missing, truncated, not an object, oversized', () => {
  const root = loopDir();
  assert.equal(readReceipt(root, SLUG).state, 'missing');
  const file = join(root, receiptRel(SLUG));
  mkdirSync(dirname(file), { recursive: true });
  const full = JSON.stringify(receipt(root));
  writeFileSync(file, full.slice(0, 40));
  assert.match(readReceipt(root, SLUG).reason, /not valid JSON/);
  writeFileSync(file, '[1]');
  assert.match(readReceipt(root, SLUG).reason, /fails its schema/);
  writeFileSync(file, `{"pad":"${'x'.repeat(1024 * 1024)}"}`);
  assert.match(readReceipt(root, SLUG).reason, /larger than 1 MB/);
});

test('evaluatePlanReceipt: green only for a completed passing receipt with the current plan hash', () => {
  const root = loopDir();
  assert.match(evaluatePlanReceipt(root, SLUG, 'normal').reason, /no Gate A receipt/);
  writeReceipt(root, SLUG, receipt(root));
  assert.deepEqual(evaluatePlanReceipt(root, SLUG, 'normal'), { ok: true });
  put(root, `.scratch/spec/${SLUG}.md`, '# Spec\nchanged\n');
  assert.match(evaluatePlanReceipt(root, SLUG, 'normal').reason, /plan changed/);
});

test('evaluatePlanReceipt: incomplete, failing and capped receipts are red with a reason', () => {
  const root = loopDir();
  writeReceipt(root, SLUG, receipt(root, { completed: false, verdict: 'paused', cause: 'You have hit your usage limit' }));
  assert.match(evaluatePlanReceipt(root, SLUG, 'normal').reason, /Gate A is paused: You have hit/);
  writeReceipt(root, SLUG, receipt(root, { verdict: 'fail', findings: [FINDING] }));
  assert.match(evaluatePlanReceipt(root, SLUG, 'normal').reason, /1 blocking finding \(F1\)/);
  writeReceipt(root, SLUG, receipt(root, { verdict: 'fail', findings: [FINDING], round: MAX_ROUNDS, rounds_used: MAX_ROUNDS }));
  const capped = evaluatePlanReceipt(root, SLUG, 'normal').reason;
  assert.match(capped, /^blocked: 2 Codex rounds used.*escalate to the human.*F1/);
});

test('a receipt for another slug is rejected', () => {
  const root = loopDir();
  writeReceipt(root, SLUG, receipt(root, { slug: 'other-slug' }));
  assert.match(evaluatePlanReceipt(root, SLUG, 'normal').reason, /receipt is for slug other-slug/);
});

// ---- G9 through check-gates.mjs

test('G9 without codex_review: n/a with the reason when asked for, and left out of a default run', () => {
  const root = loopDir({ flag: 'absent' });
  const asked = g9(root, 'G9');
  assert.equal(asked.code, 0, asked.out);
  assert.match(asked.out, /G9 n\/a: codex_review is not enabled in \.scratch\/gates\.json/);
  const all = g9(root, '--phase', 'build', 'G9');
  assert.match(all.out, /G9 n\/a/);
  const none = g9(loopDir({ flag: false }), '--phase', 'close');
  assert.ok(!/G9/.test(none.out), 'a default run does not mention G9');
});

test('G9 red lines: missing, truncated, wrong version, incomplete, failing verdict, stale hash', () => {
  const root = loopDir();
  const file = join(root, receiptRel(SLUG));
  const red = (re) => { const r = g9(root, 'G9'); assert.equal(r.code, 1, r.out); assert.match(r.out, re); assert.match(r.out, /\(\.scratch\/receipts\/demo-feature\/G9\.json\)/); };
  red(/^G9 red: no Gate A receipt/m);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(receipt(root)).slice(0, 30));
  red(/G9 red: receipt is not valid JSON/);
  writeFileSync(file, JSON.stringify(receipt(root, { version: 7 })));
  red(/G9 red: receipt fails its schema: receipt version is 7/);
  writeFileSync(file, JSON.stringify(receipt(root, { completed: false, verdict: 'blocked', cause: 'timeout: x' })));
  red(/G9 red: Gate A is blocked: timeout: x/);
  writeFileSync(file, JSON.stringify(receipt(root, { verdict: 'fail', findings: [FINDING] })));
  red(/G9 red: Gate A has 1 blocking finding/);
  writeFileSync(file, JSON.stringify(receipt(root)));
  put(root, `.scratch/contract/${SLUG}.md`, '# Contract\nedited after review\n');
  red(/G9 red: the plan changed since the Codex review/);
});

test('G9 green for a current passing receipt, and it joins the build phase', () => {
  const root = loopDir();
  writeReceipt(root, SLUG, receipt(root));
  const one = g9(root, 'G9');
  assert.equal(one.code, 0);
  assert.match(one.out, /^G9 green/m);
  const build = g9(root, '--phase', 'build', 'G9');
  assert.match(build.out, /^G9 green/m);
  const merge = g9(root, '--phase', 'merge', 'G9');
  assert.ok(!/G9/.test(merge.out.split('\n').filter((l) => l.startsWith('G9')).join('')), 'G9 is not a merge-phase gate');
  assert.equal(JSON.parse(readFileSync(join(root, receiptRel(SLUG)), 'utf8')).gate, 'G9');
});

test('a gate ID outside the table is still an unknown argument (exit 2)', () => {
  const r = g9(loopDir(), 'G11');
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown argument: G11/);
});
