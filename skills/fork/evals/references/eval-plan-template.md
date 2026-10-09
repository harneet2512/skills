# Eval plan: <feature>

<!-- Written by the evals skill to .scratch/evals/<slug>.md at design time, before
any prompt is written. Updated at build, review and ship. Keep every section; write
"none" with a reason rather than deleting one. -->

- **Feature:** <one line: what the model produces, for whom, where it is shown or what it triggers>
- **Owner of "good":** <the person whose judgment defines pass and fail; their role>
- **Envelope link:** `.scratch/envelope/<slug>.md` items this plan proves: <LLM-01, LLM-02, LLM-03, ...>
- **Model and prompt under test:** <pinned model id, prompt file and version, parameters>
- **Suite location:** `<repo>/evals/<feature>/` (cases.jsonl, graders, target adapter, labels.jsonl, baseline results.json)

## 1. Success criteria

| # | Criterion (specific and measurable) | Dimension | Grader(s) | Critical? |
|---|---|---|---|---|
| C1 | <e.g. never states a price absent from the tenant notes> | grounding | no_invented_numbers, no_fabricated_facts | yes |
| C2 | | | | |

Budgets: cost per call ≤ <$>, p95 latency ≤ <ms>, per-tenant daily spend ≤ <$>.

## 2. Error analysis

- **Traces read:** <n> (<real, redacted / synthetic by dimensions: list them>), by <who>, on <date>.
- **Saturation:** <how many traces since the last new failure mode>.

| Failure mode (axial code) | Count / n | Example trace id | Becomes grader | Fixed directly instead? |
|---|---|---|---|---|
| | | | | |

Criteria drift noted: <what changed in the definition of good while labeling, and which labels were revised>.

## 3. Case set

| Tag | Source | Count | What it proves |
|---|---|---|---|
| journeys | <traffic sample> | | |
| tempt-claim | | | |
| injection | | | |
| invariance / directional (clusters) | | | |
| long-context / position | | | |
| hand-off / refusal / ambiguous | | | |
| past failures | <incident links> | | |

- **Split:** dev <n> / held-out <n>. Held-out ids: <file or rule>.
- **Fairness check:** every case has a reference answer that passes all graders: <yes / list exceptions>.
- **Size and power:** current n = <n>, K = <trials>. From the last paired run, Var(d) = <v>, so a <δ> change needs ≈ <7.85 v / δ²> cases. Smallest change we can claim: <δ>.
- **Suites:** regression (gated) <ids or tag>; capability (tracked) <ids or tag>.

## 4. Graders

| Grader | Kind | Failure mode | Applies to | Calibration (n, human fails, TPR, TNR, labeler, date) |
|---|---|---|---|---|
| | code | | all | n/a |
| | judge | | | |

- Judge model: <id>, family <same as / different from> the generator. Bias controls: <order swap, length cap, ...>.

## 5. Gates

```
--gate "grader:<critical>>=1"
--gate "delta.hi>=0"
--gate "pass.lo>=<floor>"
--gate "judge_tnr:<judge>>=0.8"
--gate "cost_per_trial_usd<=<budget>"
--gate "latency_p95_ms<=<budget>"
```

Baseline: `<path to approved results.json>`, model `<id>`, run on <date>.

## 6. Production

- **Sampling:** <rate>, plus every rejected, heavily edited or escalated output.
- **Online graders:** <code graders on 100%> / <judges on the sample>.
- **Alerts:** <metric, threshold, channel> for each critical grader, schema failures, truncation, refusals, cost and latency per tenant.
- **Drift check:** weekly sampled pass rate per grader vs offline baseline, CI method from statistics.md.
- **Review queue:** <who reviews, how fast, how labels flow back to labels.jsonl>.
- **Data handling:** <redaction, retention, access for stored traces (AI-12)>.

## 7. Results log

| Date | Change | Cases × K | Pass (95% CI) | Delta vs baseline (95% CI) | pass^K | Gates | Notes |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

## 8. Open questions

- <unverified assumptions, labels needing an expert, cases still missing>
