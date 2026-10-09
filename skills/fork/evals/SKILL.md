---
name: evals
description: Design, build, run and gate evals for anything that calls an LLM, so quality is measured with error bars instead of judged by eye. Covers success criteria, error analysis on traces, task sets, code graders, calibrated LLM judges, trials, confidence intervals, paired comparisons, pass^k, CI regression gates and production sampling, with a zero-dependency harness. Use when building or changing any LLM or agent feature, prompt, model id, retrieval, tool use or AI-drafted output; when the behavioral envelope marks an LLM item Live; when a prompt or model change needs a merge decision; and when asked about evals, test sets, graders, LLM-as-judge, judge calibration, eval metrics, flaky AI tests, regressions or "is the new model better".
---

# Evals

An eval is the test suite for behavior that varies from run to run. It answers three questions with numbers that carry error bars: does this feature do its job, did this change make it better or worse, and is it still working in production.

This is the operational depth behind `AI-01` (evals are the test) and `AI-02` (nondeterminism) in the AI concern topic, and behind `llm` pack items LLM-01, LLM-02, LLM-03, LLM-06, LLM-09 and LLM-10 in the behavioral envelope. Those say *that* every AI behavior needs a graded case set, repeated runs and a merge gate; this skill says *how*. Every claim it leans on is sourced in [references/research.md](references/research.md).

## When it runs

| Moment | What this skill does | Output |
|---|---|---|
| **Design** (next to the envelope's LLM items) | Success criteria, failure modes from error analysis, the case plan, graders, the gate. Before any prompt is written. | `.scratch/evals/<slug>.md` from [references/eval-plan-template.md](references/eval-plan-template.md) |
| **Build** | Eval-driven development: the case set and graders exist and run before the prompt is tuned. Each prompt edit is a run with a delta, not a vibe. | `evals/<feature>/` in the target repo, a stored baseline |
| **Review** | The paired delta against the baseline is a gate, like a failing test. The PR shows the eval summary. | `results.md` in the PR |
| **Ship** | Online evals: sampled production traces graded by the same graders, guardrail metrics, drift alerts, a human review queue. | Dashboard and alert entries |
| **Learn** | Every production failure becomes a case before it is fixed. Capability cases that reach near 100% graduate to the regression suite. | New rows in `cases.jsonl` |

If the change has no envelope file yet, call the Skill tool with `behavioral-envelope` first: its Live LLM items are what the eval plan has to prove, and each one names its eval proof.

## 1. Success criteria first

Write what "working" means as criteria that are specific, measurable, achievable and relevant, across every dimension the feature is held to: task fidelity, grounding, safety, tone, language, format, latency and cost. "Good replies" is not a criterion; "never states a price absent from the tenant notes" is. Each criterion maps to at least one grader. A criterion nobody can grade is either rewritten or recorded as unmeasured.

## 2. Start from error analysis, not from metrics

Generic scores ("helpfulness 4.1/5", ROUGE, BERTScore) measure something, rarely your failure modes. Find the failure modes in data first:

1. **Collect traces.** Real ones (redacted) if the feature or a predecessor exists. Otherwise synthetic inputs generated along explicit dimensions (feature, scenario, persona, plus language, length, adversarial intent), checked to actually hit the scenario they claim. Synthetic data finds failure modes; it cannot tell you how common they are.
2. **Open coding.** One person with the domain judgment reads traces and writes a free-text note on what went wrong in each. Read at least 30 yourself before any model suggests categories; keep going (often around 100) until new traces stop revealing new failures.
3. **Axial coding.** Group the notes into a short failure taxonomy (for example: invents prices, follows injected instructions, wrong language, ignores the newest question, near-identical options). Count each. Fix obvious bugs now; the rest become graders.
4. **Expect criteria drift.** Reading outputs changes what you think good is. Re-label early cases when that happens, and write the decision down.

Make reading cheap: a viewer that shows the whole trace (input, retrieved context, output, tool calls) on one screen with one-key pass/fail beats any metric for the first weeks.

## 3. Build the task set

Each case: `id`, `input`, `expected` (facts, allowlists, criteria text for judges), `tags`, `cluster`. Sources, in order of value: production failures and escalations, real traffic sampled across user journeys, edge cases from the envelope's Live items, adversarial cases, synthetic fill.

Cover at minimum:

- **Journeys**: the common requests, weighted toward what users actually do.
- **Tempted claims**: inputs where the true answer is absent from context, so the only way to "answer" is to invent (`AI-03`).
- **Untrusted text**: prompt injection inside emails, documents, tool results; attacker addresses, links, delimiters that try to close the data block (`AI-04`).
- **Behavioral tests** (CheckList): *minimum functionality* (simple cases that must always pass), *invariance* (a change that must not change the outcome: name swap, language, formatting), *directional* (a change that must move the outcome one way: add "urgent", remove the needed fact). Mark derived variants with a shared `cluster`.
- **Scale and position**: long threads, the key fact early or in the middle of a long context, the question in the last message.
- **Hand-off and refusal**: cases where the right output is "ask", "route to a person" or nothing (`LLM-10`).

**Every case must be fair.** A case nobody could pass from its input (underspecified ask, grader that rejects valid answers) is a broken case, not a hard one. Write or imagine a reference answer that passes every grader; a case at 0% across many trials is a grader or spec bug until proven otherwise.

**Size.** Start with 30 to 100 real, redacted cases (`AI-01`); if you have fewer, 20 to 50 drawn from real failures is enough to begin, so never wait for a big set. Grow past 100 as failure modes appear. Size for the decision you need: to detect a difference of δ between two versions at 80% power, a pilot run's per-case paired-difference variance `v` gives `n ≈ 7.85 v / δ²` cases (Miller 2024, eq. 9; worked examples in [references/statistics.md](references/statistics.md)). The harness prints this after every paired run. If you cannot afford the `n`, you cannot claim the smaller improvement.

**Split.** Keep a held-out set you never tune against. Prompt iteration happens on the dev cases; the held-out set is run before merge. A case that leaked into a prompt as a few-shot example moves to dev.

**Two suites.** Capability cases (hard, low pass rate, where you are trying to improve) and regression cases (near 100%, must not drop). Gate on regression; track capability.

## 4. Graders, in order of preference

1. **Code** (deterministic): schema, option count, length caps, allowlisted emails and URLs, forbidden strings, numbers present in the inputs, language detection, tool-call arguments, final state in a database. Fast, free, reproducible. Prefer grading the outcome over the path the agent took.
2. **LLM judge**, only for what code cannot check. One judge per failure mode, **binary pass/fail** with a short reasoning first, never a 1 to 5 score. The prompt states the failure mode, what counts as pass and as fail with examples, and "judge only this; X is scored elsewhere". Untrusted content goes inside data tags with the tag neutralized in the content, because injected text targets judges too.
3. **Humans**, for labeling the judge's calibration set and for reading failures. Not as the routine grader.

**Calibrate every judge before trusting it** ([references/judges.md](references/judges.md)): a domain expert labels 100 or more outputs per failure mode (a smaller set gives a rough first read, and says so), split train/dev/test; tune the judge on dev, report on test. Report **TPR and TNR separately** (pass as the positive class: TPR is "passes what humans passed", TNR is "fails what humans failed"); raw agreement hides a judge that never fails anything when failures are rare. With both known, correct the judge's measured pass rate: `θ = (p_obs + TNR − 1) / (TPR + TNR − 1)`.

**Judge biases to design out**: position (swap order on pairwise or multi-option judgments and require agreement), verbosity (do not let length win; length-control or cap), self-preference (a judge can favor its own family's text: prefer a different model family when one is available, and in any case rely on measured TPR/TNR rather than the assumption), and judges being fooled by confident wrong answers (give the judge the source facts).

## 5. Trials and statistics

- **Run each case K times** (K = 3 to 5 for most features; more for agents). Case score = share of trials that pass. Do not lower temperature to make numbers stable; that changes the system you are measuring.
- **Report mean with a 95% CI** over cases, never a bare number. Use **clustered** standard errors when cases share context (same document, same thread template, variants of one scenario); they can be several times wider.
- **Compare versions on paired differences** per case, not two independent means. A paired CI is usually much tighter for the same cost.
- **Reliability is pass^k**, the chance that all k trials of a case pass. A feature at 75% per trial is at about 42% pass^3. Report pass^k for anything users repeat or agents chain; pass@k (any of k passes) only where a human picks the best of k.
- **Zero failures is not zero risk.** With n passing cases the 95% upper bound on the failure rate is `1 − 0.05^(1/n)`, about 3/n.
- **Infrastructure errors are not failures.** A judge timeout or unparseable judge reply is excluded and counted; above a small rate the run is invalid. A target exception is a product failure. Verdicts are never retried; retrying until green hides flakiness.

## 6. Regression gates in CI

Gate syntax in the harness is `metric[.lo|.hi] <op> value`; see [scripts/run-evals.mjs](scripts/run-evals.mjs). A sensible default for a merge gate on a prompt, model, retrieval or tool change:

- **Hard floors on critical graders** (security, privacy, money): `grader:injection_resisted>=1`, `grader:no_foreign_emails>=1`. One failure blocks.
- **No regression beyond noise**: `delta.hi>=0` and `delta:grader:<critical>.hi>=0`. Fails only when the paired CI is entirely below zero.
- **Absolute floor with uncertainty**: `pass.lo>=<agreed>`, so a suite too small to be confident fails closed.
- **Judge still trustworthy**: `judge_tnr:<judge>>=0.8` when labels exist.
- **Budget**: cost per trial and p95 latency against the budget in the plan (`AI-10`).

A non-inferiority gate (`delta.lo>=-0.03`, the "agreed margin" of `AI-01`) is stricter and needs the `n` from section 3; use it when you have the cases. The model id, prompt version and graders hash are in every results file; the approved results file for a model id is its record (`AI-14`). Run the full suite on a schedule too, because serving-side drift happens without a code change (`AI-02`).

## 7. Online evals in production

- **Sample** traces (for example 1% to 5% plus every trace a user rejected, edited heavily, or escalated) into the same graders. Code graders can run on 100% as guardrails; judges on the sample.
- **Guardrail metrics** with alerts: forbidden-string hits, foreign recipients, schema failures, truncation rate, refusal rate, cost and latency per tenant.
- **Drift**: compare the weekly sampled pass rate per grader with the offline baseline using the same CI method; alert when the interval separates. Watch the input mix too (languages, lengths, new tenants).
- **Human review queue**: low-confidence and judge-failed traces go to a person, whose labels extend the calibration set.
- Production traces are customer data: redaction, retention and access rules from `AI-12` apply to eval storage too.

## 8. Every failure becomes a case

A production incident, a support escalation or a user's edit that reverses a draft becomes a case (redacted) with a grader that fails on it, before the fix. When capability cases saturate, add harder ones; a suite everyone passes measures nothing.

## The harness

[scripts/run-evals.mjs](scripts/run-evals.mjs) (Node 22, no dependencies) runs cases × trials against a target module (`export async function run(input, ctx)`, with `ctx.llm.complete({ system, prompt, maxTokens })`), applies code graders and judges, calibrates judges against `labels.jsonl`, and writes `results.json`, `results.md` and `trials.jsonl`. Model calls go through a pluggable client; the default shells out to `claude -p`. Exit 0 when gates pass, 1 when a gate fails, 2 when the run is invalid. Tests: `node --test scripts/test-stats.mjs scripts/test-harness.mjs`. A complete suite for a Slack reply drafter, with 40 cases, 7 code graders, 5 judges and a calibration set, is in [examples/inbox-assist/](examples/inbox-assist/graders.mjs).

## Anti-patterns

| Anti-pattern | Why it fails | Instead |
|---|---|---|
| Vibes check ("looks good on the examples I tried") | A few hand-picked tries say nothing about the distribution or the next change. | Case set, trials, CI. |
| One-number dashboard | Hides which failure mode moved and how sure you are. | Per-grader and per-tag rates with CIs, plus pass^k. |
| Judge without calibration | Unknown TPR/TNR means unknown truth; a lenient judge reports 100%. | Human labels, TPR/TNR on a held-out split, corrected rates. |
| 1 to 5 scores from a judge | Unactionable, noisy at the middle, drift between runs. | Binary per failure mode. |
| Generic "helpfulness" or similarity metrics | Not your failure modes; they reward length and fluency. | Graders derived from error analysis. |
| Evaluating on training or tuning data | Contamination inflates scores; a public benchmark may be in the model's training data. | Private held-out cases from your own traffic. |
| Tuning the prompt on the test set | The suite stops measuring generalization. | Dev split for iteration, held-out split before merge. |
| Comparing two unpaired means | Throws away the per-case pairing; differences look like noise or like wins. | Paired deltas with a CI. |
| Retrying failed trials | Converts flakiness into a pass. | Fixed K, failures final, pass^k reported. |
| Same model judging itself, unmeasured | Self-preference bias. | Different family when possible; measure either way. |

## Rules

- No prompt, model id, retrieval or tool change merges without a paired eval run against the stored baseline, and its summary in the PR.
- The case set and graders exist before the prompt is tuned.
- Every reported rate carries a 95% CI and its n.
- Code graders before judges; every judge is binary, scoped to one failure mode, and calibrated with TPR and TNR reported.
- Critical failure modes (injection, data leaks, invented money or commitments) have hard floors, not averages.
- Infrastructure errors invalidate or are excluded; they are never counted as passes or failures, and verdicts are never retried.
- Every production failure becomes a case.
- The eval plan lives in `.scratch/evals/<slug>.md`; the suite lives in the target repo.
