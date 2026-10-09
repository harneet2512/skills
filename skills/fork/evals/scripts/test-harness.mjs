// Run: node --test scripts/test-harness.mjs
// End-to-end checks of run-evals.mjs with a stub model client: no network, no cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN = join(dirname(fileURLToPath(import.meta.url)), 'run-evals.mjs');
const dir = mkdtempSync(join(tmpdir(), 'evals-harness-'));
const f = (name, body) => { const p = join(dir, name); writeFileSync(p, body); return p; };

// Judge verdict: fail when the judged output contains BAD; "INFRA" makes the judge return junk.
const client = f('client.mjs', `
export function createClient({ model }) {
  return { name: 'stub', model, async complete({ prompt }) {
    if (prompt.startsWith('GEN:')) return { text: prompt.slice(4), costUsd: 0.001, models: [model] };
    if (prompt.includes('INFRA')) return { text: 'not json', costUsd: 0, models: [model] };
    const pass = !prompt.includes('BAD');
    return { text: JSON.stringify({ reasoning: 'stub', pass }), costUsd: 0.0005, models: [model] };
  } };
}`);
const target = f('target.mjs', `
export async function run(input, { llm, trial }) {
  if (input.throws) throw new Error('boom');
  if (input.flaky && trial === 2) return 'BAD flaky';
  return llm.complete({ prompt: 'GEN:' + input.text });
}`);
const graders = f('graders.mjs', `
export const graders = [{ name: 'nonempty', grade: ({ output }) => ({ pass: output.length > 0, note: 'len ' + output.length }) }];
export const judges = [{ name: 'quality', prompt: ({ output }) => '<data>' + output + '</data>' }];`);
const cases = f('cases.jsonl', [
  { id: 'a', input: { text: 'good one' }, tags: ['t1'], cluster: 'x' },
  { id: 'b', input: { text: 'good two' }, tags: ['t1'], cluster: 'x' },
  { id: 'c', input: { text: 'BAD three' }, tags: ['t2'] },
  { id: 'd', input: { text: 'good four', flaky: true }, tags: ['t2'] },
  { id: 'e', input: { throws: true }, tags: ['t2'] },
].map((x) => JSON.stringify(x)).join('\n'));
const labels = f('labels.jsonl', [
  { id: 'l1', case_id: 'a', judge: 'quality', output: 'fine', human: 'pass' },
  { id: 'l2', case_id: 'a', judge: 'quality', output: 'BAD', human: 'fail' },
  { id: 'l3', case_id: 'a', judge: 'quality', output: 'also fine', human: 'fail' }, // judge will disagree
].map((x) => JSON.stringify(x)).join('\n'));

const run = (out, ...extra) => spawnSync(process.execPath, [RUN, '--cases', cases, '--target', target, '--graders', graders, '--client', client, '--trials', '3', '--concurrency', '2', '--out', join(dir, out), ...extra], { encoding: 'utf8' });
const load = (out) => JSON.parse(readFileSync(join(dir, out, 'results.json'), 'utf8'));

test('scores, pass^k, target errors as failures, tags and clusters', () => {
  const r = run('r1');
  assert.equal(r.status, 0, r.stderr);
  const j = load('r1');
  const score = Object.fromEntries(j.cases.map((c) => [c.id, c.score]));
  assert.deepEqual(score, { a: 1, b: 1, c: 0, d: 2 / 3, e: 0 });
  assert.ok(Math.abs(j.metrics.pass.mean - (1 + 1 + 0 + 2 / 3 + 0) / 5) < 1e-9);
  assert.equal(j.metrics.pass.clustered, true);
  // pass^3: a and b are 1, d is C(2,3)/C(3,3) = 0, others 0 -> 2/5
  assert.ok(Math.abs(j.metrics['pass^3'].mean - 0.4) < 1e-9);
  // pass@3: a, b, d are 1 -> 3/5
  assert.ok(Math.abs(j.metrics['pass@3'].mean - 0.6) < 1e-9);
  assert.ok(Math.abs(j.metrics.target_error_rate.mean - 3 / 15) < 1e-9);
  assert.equal(j.metrics['tag:t1'].mean, 1);
  assert.ok(readFileSync(join(dir, 'r1', 'trials.jsonl'), 'utf8').trim().split('\n').length === 15);
});

test('gates: pass, fail (exit 1), unknown metric (exit 2)', () => {
  assert.equal(run('g1', '--gate', 'pass>=0.5').status, 0);
  assert.equal(run('g2', '--gate', 'pass.lo>=0.9').status, 1);
  assert.equal(run('g3', '--gate', 'nonsense>=0').status, 2);
});

test('paired comparison against a baseline', () => {
  const base = load('r1');
  base.cases.find((c) => c.id === 'c').score = 1; // pretend c used to pass
  base.cases.find((c) => c.id === 'c').graderScores.quality = 1;
  writeFileSync(join(dir, 'base.json'), JSON.stringify(base));
  const r = run('p1', '--baseline', join(dir, 'base.json'), '--gate', 'delta.hi>=0');
  const j = load('p1');
  assert.equal(j.comparison.delta.n, 5);
  assert.ok(Math.abs(j.comparison.delta.mean - -0.2) < 1e-9);
  assert.equal(j.comparison.delta.regressed, 1);
  assert.equal(r.status, 0, 'one regression in five is within noise, so a significance gate passes');
});

test('judge calibration reports TPR, TNR and disagreements', () => {
  const r = run('c1', '--labels', labels, '--calibrate-only');
  assert.equal(r.status, 0, r.stderr);
  const cal = load('c1').calibration.quality;
  assert.equal(cal.tpr, 1);
  assert.equal(cal.tnr, 0.5);
  assert.equal(cal.disagreements.length, 1);
});

test('judge infrastructure errors are excluded and can invalidate the run', () => {
  const infraCases = f('infra.jsonl', [{ id: 'i', input: { text: 'INFRA' } }, { id: 'ok', input: { text: 'fine' } }].map((x) => JSON.stringify(x)).join('\n'));
  const r = spawnSync(process.execPath, [RUN, '--cases', infraCases, '--target', target, '--graders', graders, '--client', client, '--out', join(dir, 'i1')], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  const j = load('i1');
  assert.equal(j.cases.find((c) => c.id === 'i').score, null);
  assert.match(j.meta.invalid, /infrastructure errors/);
});
