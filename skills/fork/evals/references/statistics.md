# Statistics for evals: formulas and worked examples

Every function here is in [../scripts/lib/stats.mjs](../scripts/lib/stats.mjs), and every worked number below is asserted in [../scripts/test-stats.mjs](../scripts/test-stats.mjs). Sources: Miller 2024 (SE, clustering, pairing, power), Chen et al. 2021 (pass@k), Yao et al. 2024 (pass^k), judgy and Lee et al. 2025 (judge correction). Full citations in [research.md](research.md).

## Units

- A **trial** is one run of the target on one case, graded. It passes when every applicable grader passes.
- A **case score** `s_i` is the share of its K trials that passed (0, 1/3, 2/3 or 1 at K = 3). Averaging trials within a case is Miller's resampling: it shrinks the noise from sampling without changing what is measured.
- The **suite score** is the mean of case scores over n cases. Statistics are over cases, because cases are what you sampled from the world; trials of one case are not independent evidence about other cases.

## 1. Standard error and confidence interval of a mean

```
mean   s̄ = (1/n) Σ s_i
var    Var(s) = (1/(n−1)) Σ (s_i − s̄)²
SE     = sqrt(Var(s) / n)                     (Miller eq. 1)
95% CI = s̄ ± t_{0.975, n−1} × SE
```

Miller uses 1.96 in place of `t`, which is right for large n. Product suites often have 30 to 100 cases, where `t` is honestly wider (2.023 at n = 40, 2.262 at n = 10).

**Example 1.** Scores `[1, 0, 1, 1]`: s̄ = 0.75; deviations 0.25, −0.75, 0.25, 0.25; Var = (3 × 0.0625 + 0.5625) / 3 = 0.25; SE = sqrt(0.25 / 4) = 0.25; t(3) = 3.182; CI = 0.75 ± 0.80. Four cases tell you almost nothing.

**Example 1b.** 40 cases, 80% pass, one trial each: SE ≈ sqrt(0.8 × 0.2 / 40) = 0.063 (Miller's Bernoulli form, eq. 2); CI ≈ 0.80 ± 2.023 × 0.063 = [0.67, 0.93]. A 40-case suite can tell 80% from 60%, not 80% from 85%.

**When every case scored the same**, SE is 0 and the t interval collapses to a point. The harness then reports the Wilson interval on the count of passing cases instead. **Example:** 0 of 10 passing gives Wilson [0, 0.2775].

**Zero failures.** If all n independent cases passed, the one-sided 95% upper bound on the true failure rate solves `(1 − p)^n = 0.05`: `p = 1 − 0.05^(1/n)`, about 3/n. n = 30 gives 0.095; n = 100 gives 0.0295. "No injection succeeded in 30 cases" still allows a 9.5% success rate.

## 2. Clustered standard error

Cases that share context (variants of one scenario, questions about the same document, the same thread in two languages) are correlated. Treating them as independent understates the SE.

```
SE_clustered = sqrt( SE² + (1/n²) Σ_c Σ_{i≠j in c} (s_i − s̄)(s_j − s̄) )     (Miller eq. 4)
```

The inner double sum for a cluster equals `(Σ_{i in c} d_i)² − Σ_{i in c} d_i²` with `d_i = s_i − s̄`, which is how the code computes it. Degrees of freedom for the t interval become (number of clusters − 1). Cases with no `cluster` are each their own cluster.

**Example 2.** Scores `[1, 1, 0, 0]`, clusters `[a, a, b, b]`. s̄ = 0.5, all deviations ±0.5. Naive SE² = (1/3) / 4 = 1/12. Cluster a: sum of d = 1, sum of d² = 0.5, cross = 0.5; cluster b the same; total cross = 1, divided by n² = 16 gives 1/16. SE_clustered = sqrt(1/12 + 1/16) = sqrt(7/48) = 0.382 versus naive 0.289. Miller reports clustered SEs over 3x the naive SE on a real benchmark.

Clustering can also make the SE smaller, when cases inside a cluster disagree with each other. That is correct, not a bug.

## 3. Paired comparison of two versions

Run both versions on the same cases with the same K and compare per case:

```
d_i = s_i(new) − s_i(baseline)
SE_paired = sqrt( Var(d) / n )                                  (Miller eq. 7)
95% CI    = d̄ ± t_{0.975, n−1} × SE_paired
Var(d̄ paired) = Var(d̄ unpaired) − 2 Cov(new, baseline) / n
```

Because case difficulty is shared, the covariance is large and positive, so the paired interval is much tighter than comparing two separate means (whose SE is `sqrt(SE_A² + SE_B²)`, eq. 5).

**Example 3.** New `{a:1, b:1, c:0, d:1}`, baseline `{a:0, b:1, c:0, d:0}`. d = [1, 0, 0, 1]; d̄ = 0.5; Var(d) = 1/3; SE = sqrt(1/12) = 0.289; t(3) = 3.182; CI = 0.5 ± 0.92. Two cases improved, none regressed, but four cases cannot show it is not noise.

**Reading the CI as a gate:** entirely below 0 means worse beyond noise (`delta.hi>=0` fails); straddling 0 means no detectable change; entirely above 0 means better beyond noise. "No detectable change" is not "no change"; section 6 says how many cases it takes to detect one.

Only ids present in both runs are compared. If the cases file or graders changed between runs, the harness warns, because an edited case with the same id compares two different questions.

## 4. pass@k: at least one of k succeeds

From n ≥ k trials of a case with c passes, the unbiased estimator (Chen et al. eq. 1):

```
pass@k = 1 − C(n − c, k) / C(n, k)       computed as 1 − Π_{i=n−c+1}^{n} (1 − k/i)
```

**Example 4.** n = 5, c = 2, k = 2: C(3,2)/C(5,2) = 3/10, so pass@2 = 0.7. The naive `1 − (1 − 0.4)²` = 0.64 underestimates, as the paper warns. At k = 1, pass@1 = c/n = 0.4.

Use pass@k when a person picks the best of k outputs (three draft options, several candidate fixes). It flatters anything that runs unattended.

## 5. pass^k: all k succeed (reliability)

```
pass^k = C(c, k) / C(n, k)      computed as Π_{i=0}^{k−1} (c − i)/(n − i)
```

averaged over cases (Yao et al.). **Example 5.** n = 5, c = 3, k = 2: C(3,2)/C(5,2) = 3/10 = 0.3, versus the plug-in 0.6² = 0.36. With many trials it approaches p^k: a case at 75% per trial has pass^3 ≈ 0.42.

Report pass^k for anything a user does repeatedly, or an agent chains. A 90% per-trial feature fails at least once in 3 tries for 27% of users.

## 6. How many cases: power analysis

To detect a true difference δ between two versions with significance α (two-sided) and power 1 − β (Miller eq. 9):

```
n = (z_{α/2} + z_β)² × (ω² + σ²_A/K_A + σ²_B/K_B) / δ²
```

`ω²` is the variance across cases of the difference in the two versions' per-case true pass probabilities; `σ²/K` is the trial noise per case. At α = 0.05 and 80% power, `(z_{α/2} + z_β)² = (1.960 + 0.842)² = 7.85`.

**Example 6a (Miller's).** ω² = 1/9, no trial noise, δ = 0.03: n = 7.85 × (1/9) / 0.0009 = 969. Detecting a 3-point improvement needs about a thousand cases.

**Example 6b (from a pilot).** A paired run with the same K already measures `Var(d) = ω² + σ²_A/K + σ²_B/K`. If Var(d) = 0.1, detecting δ = 0.10 needs 7.85 × 0.1 / 0.01 = 79 cases; δ = 0.05 needs 314. The harness prints these two numbers after every paired run.

Two levers besides more cases: more trials per case (cuts the σ²/K term; in Miller's uniform-difficulty example, K = 3 trials cut the variance of the mean to 5/9 of K = 1, and no K gets below 1/3), and pairing (shrinks ω²). Lowering temperature is not a lever: it changes the system being measured.

## 7. Judge agreement and corrected pass rates

Treat human labels as truth and **pass as the positive class**:

| | human pass | human fail |
|---|---|---|
| judge pass | TP | FP |
| judge fail | FN | TN |

```
TPR = TP / (TP + FN)         judge passes what humans passed
TNR = TN / (TN + FP)         judge fails what humans failed (recall on failures)
accuracy = (TP + TN) / n
kappa = (accuracy − p_e) / (1 − p_e),  p_e = P(judge pass)P(human pass) + P(judge fail)P(human fail)
```

**Example 7.** TP 8, FN 2, TN 3, FP 1 (n = 14): accuracy 11/14 = 0.786, TPR 0.8, TNR 0.75; p_e = (9/14)(10/14) + (5/14)(4/14) = 0.561; kappa = (0.786 − 0.561) / 0.439 = 0.512. Accuracy looks fine while the judge misses 1 in 4 real failures.

**Correcting the judge's measured pass rate** (judgy; Lee et al.): the judge passes a fraction `p_obs = θ·TPR + (1 − θ)(1 − TNR)` of outputs whose true pass rate is θ. Solving:

```
θ = (p_obs + TNR − 1) / (TPR + TNR − 1),   clamped to [0, 1]; undefined if TPR + TNR ≤ 1
```

**Example 8.** p_obs = 0.8, TPR = 0.9, TNR = 0.8: θ = 0.6 / 0.7 = 0.857. Here the raw 0.8 understates the truth, because the judge wrongly fails 10% of good outputs. The correction works both ways: a low TNR (a lenient judge) inflates p_obs, a low TPR (a harsh judge) deflates it.

The harness's corrected number is a point estimate. Its uncertainty includes the calibration set's uncertainty, which this harness does not yet propagate (Lee et al. show how); with small label sets, treat it as directional.

## 8. Percentiles for latency

Linear interpolation between order statistics: index `(n − 1) × p`. **Example:** [10, 20, 30, 40] has p50 = 25 and p95 = 38.5. Report p50 and p95 per trial, not the mean, because model latency has a long tail.
