// Run: node --test scripts/test-stats.mjs
// Every expected value below is computed by hand in references/statistics.md
// or quoted from the cited paper; none comes from running the code under test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, sampleVariance, standardError, clusteredStandardError, summarize,
  pairedDifference, passAtK, passHatK, sampleSize, sampleSizeFromPilot,
  normalQuantile, tQuantile, wilson, zeroFailureUpperBound, agreement,
  correctedPassRate, percentile,
} from './lib/stats.mjs';

const close = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} not within ${tol} of ${b}`);

test('mean, variance, SE of a binary score vector', () => {
  const xs = [1, 0, 1, 1];
  close(mean(xs), 0.75);
  close(sampleVariance(xs), 0.25); // (3 * 0.0625 + 0.5625) / 3
  close(standardError(xs), 0.25); // sqrt(0.25 / 4)
});

test('clustered SE adds within-cluster covariance (statistics.md example 2)', () => {
  const xs = [1, 1, 0, 0];
  const clusters = ['a', 'a', 'b', 'b'];
  close(standardError(xs), Math.sqrt(1 / 12));
  close(clusteredStandardError(xs, clusters), Math.sqrt(7 / 48)); // 1/12 + 1/16
});

test('clustered SE equals naive SE when every item is its own cluster', () => {
  const xs = [1, 0, 1, 1, 0];
  close(clusteredStandardError(xs, ['a', 'b', 'c', 'd', 'e']), standardError(xs), 1e-12);
});

test('clustered SE can be smaller than naive when clusters are internally opposite', () => {
  // a = [1, 0], b = [1, 0]: deviations cancel within clusters
  const xs = [1, 0, 1, 0];
  assert.ok(clusteredStandardError(xs, ['a', 'a', 'b', 'b']) < standardError(xs));
});

test('normal and t quantiles match tables', () => {
  close(normalQuantile(0.975), 1.959964, 1e-6);
  close(normalQuantile(0.8), 0.841621, 1e-6);
  close(normalQuantile(0.025), -1.959964, 1e-6);
  close(tQuantile(0.975, 1), 12.706205, 1e-5);
  close(tQuantile(0.975, 2), 4.302653, 1e-5);
  close(tQuantile(0.975, 3), 3.182446, 1e-5);
  close(tQuantile(0.975, 4), 2.776445, 1e-5);
  close(tQuantile(0.975, 10), 2.228139, 1e-5);
  close(tQuantile(0.975, 29), 2.045230, 1e-5);
  close(tQuantile(0.025, 10), -2.228139, 1e-5);
});

test('summarize builds a t interval around the mean', () => {
  const s = summarize([1, 0, 1, 1]);
  close(s.mean, 0.75);
  close(s.se, 0.25);
  assert.equal(s.df, 3);
  close(s.lo, 0.75 - 3.182446 * 0.25, 1e-5);
  close(s.hi, 0.75 + 3.182446 * 0.25, 1e-5);
});

test('paired difference on matched ids (statistics.md example 3)', () => {
  const cur = { a: 1, b: 1, c: 0, d: 1, extra: 1 };
  const base = { a: 0, b: 1, c: 0, d: 0, gone: 0 };
  const p = pairedDifference(cur, base);
  assert.deepEqual(p.ids, ['a', 'b', 'c', 'd']);
  close(p.mean, 0.5);
  close(p.se, Math.sqrt(1 / 12));
  assert.deepEqual(p.onlyInCurrent, ['extra']);
  assert.deepEqual(p.onlyInBaseline, ['gone']);
  assert.equal(p.improved, 2);
  assert.equal(p.regressed, 0);
});

test('pass@k unbiased estimator (Chen et al. 2021)', () => {
  close(passAtK(5, 2, 2), 0.7); // 1 - C(3,2)/C(5,2) = 1 - 3/10
  close(passAtK(5, 2, 1), 0.4); // equals c/n at k = 1
  assert.equal(passAtK(3, 0, 1), 0);
  assert.equal(passAtK(5, 4, 2), 1); // n - c < k
});

test('pass^k (Yao et al. 2024)', () => {
  close(passHatK(5, 3, 2), 0.3); // C(3,2)/C(5,2)
  close(passHatK(5, 3, 1), 0.6);
  assert.equal(passHatK(3, 3, 3), 1);
  assert.equal(passHatK(3, 2, 3), 0);
  // Anthropic's example: 75% per trial gives about 42% pass^3 (0.75^3 = 0.4219).
  close(passHatK(1000, 750, 3), 0.4213, 1e-3);
});

test('sample size reproduces Miller (2024) worked example: ~969', () => {
  assert.equal(sampleSize({ delta: 0.03, omega2: 1 / 9 }), 969);
});

test('sample size from a pilot variance', () => {
  // (1.959964 + 0.841621)^2 * 0.1 / 0.1^2 = 78.49 -> 79
  assert.equal(sampleSizeFromPilot({ diffVariance: 0.1, delta: 0.1 }), 79);
});

test('Wilson interval and zero-failure bound', () => {
  const w = wilson(0, 10);
  close(w.lo, 0);
  close(w.hi, 0.2775, 1e-4);
  close(zeroFailureUpperBound(30), 0.0950, 1e-4);
});

test('judge agreement: TPR, TNR, kappa (statistics.md example 6)', () => {
  const pairs = [
    ...Array(8).fill({ human: true, judge: true }),
    ...Array(2).fill({ human: true, judge: false }),
    ...Array(3).fill({ human: false, judge: false }),
    ...Array(1).fill({ human: false, judge: true }),
  ];
  const a = agreement(pairs);
  close(a.accuracy, 11 / 14);
  close(a.tpr, 0.8);
  close(a.tnr, 0.75);
  close(a.kappa, 0.51163, 1e-4);
});

test('pass rate corrected for judge error', () => {
  close(correctedPassRate(0.8, 0.9, 0.8), 0.6 / 0.7);
  assert.ok(Number.isNaN(correctedPassRate(0.8, 0.5, 0.5))); // chance-level judge
  assert.equal(correctedPassRate(0.99, 0.9, 0.9), 1); // clamped
});

test('percentile with linear interpolation', () => {
  close(percentile([10, 20, 30, 40], 0.5), 25);
  close(percentile([10, 20, 30, 40], 0.95), 38.5);
});
