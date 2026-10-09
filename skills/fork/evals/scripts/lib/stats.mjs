// Statistics for eval results. Zero dependencies.
// Formulas follow Miller (2024), "Adding Error Bars to Evals" (arXiv 2411.00640),
// Chen et al. (2021) for pass@k, Yao et al. (2024) for pass^k.
// Worked examples for every function are in references/statistics.md.

export function mean(xs) {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

// Unbiased sample variance (divides by n - 1).
export function sampleVariance(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

// Miller eq. 1: SE = sqrt(Var(s) / n).
export function standardError(xs) {
  const n = xs.length;
  if (n < 2) return NaN;
  return Math.sqrt(sampleVariance(xs) / n);
}

// Miller eq. 4: clustered SE. Adds the within-cluster cross products of
// deviations from the overall mean. Items in the same cluster (same source
// document, same thread template, same user) are not independent; ignoring
// that understates the SE, by over 3x on some public benchmarks.
export function clusteredStandardError(xs, clusters) {
  const n = xs.length;
  if (n < 2) return NaN;
  if (clusters.length !== n) throw new Error('clusters must align with scores');
  const m = mean(xs);
  const seClt = standardError(xs);
  const sums = new Map(); // cluster -> [sum of deviations, sum of squared deviations]
  for (let i = 0; i < n; i++) {
    const d = xs[i] - m;
    const key = clusters[i] ?? `__solo_${i}`;
    const acc = sums.get(key) ?? [0, 0];
    acc[0] += d;
    acc[1] += d * d;
    sums.set(key, acc);
  }
  // sum over i != j in the same cluster of d_i d_j = (sum d)^2 - sum d^2
  let cross = 0;
  for (const [s, s2] of sums.values()) cross += s * s - s2;
  const v = seClt ** 2 + cross / (n * n);
  return Math.sqrt(Math.max(v, 0));
}

export function clusterCount(clusters) {
  return new Set(clusters.map((c, i) => c ?? `__solo_${i}`)).size;
}

// Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9).
export function normalQuantile(p) {
  if (p <= 0 || p >= 1) throw new Error('p must be in (0, 1)');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  if (p < pl) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - pl) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// Student t CDF for integer df, from the closed-form finite series
// (Abramowitz and Stegun 26.7.3 and 26.7.4): A = P(|T| < t), CDF = (1 + A) / 2.
export function tCdf(t, df) {
  const theta = Math.atan(t / Math.sqrt(df));
  const s = Math.sin(theta), c2 = Math.cos(theta) ** 2;
  let a;
  if (df % 2 === 1) {
    let term = 1, sum = 1;
    for (let k = 3; k <= df - 2; k += 2) { term *= ((k - 1) / k) * c2; sum += term; }
    a = df === 1 ? (2 / Math.PI) * theta : (2 / Math.PI) * (theta + s * Math.cos(theta) * sum);
  } else {
    let term = 1, sum = 1;
    for (let k = 2; k <= df - 2; k += 2) { term *= ((k - 1) / k) * c2; sum += term; }
    a = s * sum;
  }
  return (1 + a) / 2;
}

// Student t quantile for integer df, by bisection on tCdf (exact to 1e-10).
// Large df falls back to the normal quantile, which is within 1e-3 above df 1000.
export function tQuantile(p, df) {
  if (!Number.isFinite(df) || df <= 0) return NaN;
  df = Math.round(df);
  if (df > 1000) return normalQuantile(p);
  if (p === 0.5) return 0;
  if (p < 0.5) return -tQuantile(1 - p, df);
  let lo = 0, hi = 1;
  while (tCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-10; i++) {
    const mid = (lo + hi) / 2;
    if (tCdf(mid, df) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Mean with SE and 95% CI. Uses the t distribution with df = n - 1, or
// df = clusters - 1 when clustered. Miller uses 1.96 (large n); product eval
// sets are often 30 to 100 items, where t is honestly wider.
export function summarize(xs, clusters = null, level = 0.95) {
  const n = xs.length;
  const m = mean(xs);
  const useClusters = clusters && clusterCount(clusters) < n;
  const se = useClusters ? clusteredStandardError(xs, clusters) : standardError(xs);
  const df = useClusters ? clusterCount(clusters) - 1 : n - 1;
  const t = df >= 1 ? tQuantile(1 - (1 - level) / 2, df) : NaN;
  const half = t * se;
  return {
    n,
    mean: m,
    se,
    seNaive: standardError(xs),
    clustered: Boolean(useClusters),
    df,
    lo: Number.isFinite(half) ? m - half : NaN,
    hi: Number.isFinite(half) ? m + half : NaN,
  };
}

// Miller eq. 7: paired difference on matched items. a and b are Maps or
// objects keyed by item id; only ids present in both are compared.
export function pairedDifference(current, baseline, clustersById = null, level = 0.95) {
  const cur = current instanceof Map ? current : new Map(Object.entries(current));
  const base = baseline instanceof Map ? baseline : new Map(Object.entries(baseline));
  const ids = [...cur.keys()].filter((id) => base.has(id)).sort();
  const diffs = ids.map((id) => cur.get(id) - base.get(id));
  const clusters = clustersById ? ids.map((id) => clustersById.get(id) ?? null) : null;
  const s = summarize(diffs, clusters, level);
  return {
    ...s,
    ids,
    onlyInCurrent: [...cur.keys()].filter((id) => !base.has(id)),
    onlyInBaseline: [...base.keys()].filter((id) => !cur.has(id)),
    improved: diffs.filter((d) => d > 0).length,
    regressed: diffs.filter((d) => d < 0).length,
  };
}

// Chen et al. (2021) eq. 1, in the numerically stable product form from the
// paper's code: 1 - C(n-c, k) / C(n, k).
export function passAtK(n, c, k) {
  if (k > n) throw new Error('k must be <= n');
  if (n - c < k) return 1;
  let prod = 1;
  for (let i = n - c + 1; i <= n; i++) prod *= 1 - k / i;
  return 1 - prod;
}

// Yao et al. (2024): pass^k = C(c, k) / C(n, k), the chance that k trials
// drawn without replacement from the n run are all successes.
export function passHatK(n, c, k) {
  if (k > n) throw new Error('k must be <= n');
  if (c < k) return 0;
  let prod = 1;
  for (let i = 0; i < k; i++) prod *= (c - i) / (n - i);
  return prod;
}

// Miller eq. 9: questions needed to detect a difference delta between two
// versions. omega2 is the variance of the paired difference of per-question
// conditional means; sigmaA2 and sigmaB2 the within-question variances; kA, kB
// the trials per question.
export function sampleSize({ delta, omega2, sigmaA2 = 0, sigmaB2 = 0, kA = 1, kB = 1, alpha = 0.05, power = 0.8 }) {
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  return Math.ceil(((za + zb) ** 2 * (omega2 + sigmaA2 / kA + sigmaB2 / kB)) / delta ** 2);
}

// From a pilot paired run with the same trials per item, the observed variance
// of per-item differences already equals omega2 + sigmaA2/kA + sigmaB2/kB.
export function sampleSizeFromPilot({ diffVariance, delta, alpha = 0.05, power = 0.8 }) {
  return sampleSize({ delta, omega2: diffVariance, alpha, power });
}

// When every one of n independent items passed, the one-sided 95% upper bound
// on the true failure rate is 1 - 0.05^(1/n) (about 3/n).
export function zeroFailureUpperBound(n, level = 0.95) {
  return 1 - (1 - level) ** (1 / n);
}

// Wilson score interval for a binomial proportion; better than the normal
// approximation near 0 or 1 and for small n.
export function wilson(successes, n, level = 0.95) {
  if (n === 0) return { lo: NaN, hi: NaN };
  const z = normalQuantile(1 - (1 - level) / 2);
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// Judge vs human agreement. "Positive" is PASS here, as in judgy and Lee et al.:
// TPR = P(judge pass | human pass), TNR = P(judge fail | human fail).
// TNR is the judge's recall on real failures, the number that matters most
// when failures are rare.
export function agreement(pairs) {
  let tp = 0, tn = 0, fp = 0, fn = 0;
  for (const { human, judge } of pairs) {
    if (human && judge) tp++;
    else if (!human && !judge) tn++;
    else if (!human && judge) fp++;
    else fn++;
  }
  const n = tp + tn + fp + fn;
  const po = n ? (tp + tn) / n : NaN;
  const pYes = n ? ((tp + fp) / n) * ((tp + fn) / n) : NaN;
  const pNo = n ? ((tn + fn) / n) * ((tn + fp) / n) : NaN;
  const pe = pYes + pNo;
  return {
    n, tp, tn, fp, fn,
    accuracy: po,
    tpr: tp + fn ? tp / (tp + fn) : NaN,
    tnr: tn + fp ? tn / (tn + fp) : NaN,
    kappa: pe < 1 ? (po - pe) / (1 - pe) : NaN,
  };
}

// Corrects a judge-measured pass rate for the judge's known error rates:
// p_obs = theta * TPR + (1 - theta) * (1 - TNR), solved for theta.
// Undefined when TPR + TNR <= 1 (the judge is no better than chance).
export function correctedPassRate(pObs, tpr, tnr) {
  const denom = tpr + tnr - 1;
  if (!(denom > 0)) return NaN;
  return Math.min(1, Math.max(0, (pObs + tnr - 1) / denom));
}

export function percentile(xs, p) {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
