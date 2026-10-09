# Scorecard, 2026-10-08

The first measured run of the feature loop's proving and attacking stages, on the reference product in `live-verify/bench/inbox-assist/`: a multi-tenant Slack agent that watches a Gmail inbox, drafts three reply options with an LLM, and sends the chosen one in the same thread. Everything below comes from runs in this session; the raw outputs are in `adversarial-review/bench/` and `evals/examples/inbox-assist/`.

## What was measured

1. **Planted bugs.** 13 realistic bugs, one or more per topic, each a 1 to 10 line edit that still passes the happy path (`adversarial-review/bench/answer-key.json`, `patches/`).
2. **Blind review.** The bug-planted code was reviewed by reviewers who saw only the code and a one-paragraph product description, never the key:
   - **Baseline:** Matt's `code-review` axes (Standards with the smell baseline, Spec against the description), reading only, no proof asked.
   - **Adversarial:** seven topic attackers (concurrency, reliability, security, multi-tenancy, AI behavior, latency plus cost, data integrity plus code craft), each with its topic file, each required to reproduce findings.
3. **Live verification as a mutant test.** Each planted bug alone, then the full live suite (two app instances, stand-ins, faults) to see which scenarios fail.
4. **Learn step.** Every finding the attackers reproduced beyond the planted bugs was checked against the clean app, reproduced again, fixed, and kept as a scenario or test. Then the mutant run was repeated.
5. **Evals.** One eval-driven iteration on the drafting prompt: error analysis, a dev/held-out split, a paired comparison against the previous run.

## Results

### Planted bugs found (13)

| Who | Found | Reproduced |
|---|---|---|
| Baseline, Standards axis | 12 | 0 |
| Baseline, Spec axis | 11 | 0 |
| Baseline, both axes | 12 (missed: CRLF header injection) | 0 |
| Adversarial attackers, union | 12 (missed: own-mailbox check broken by a display name) | 12 of 12 |
| Live suite v1 (25 scenarios) | 11 (missed: work before the Slack ack, missing unique key); one catch was timing-dependent | by construction |
| Live suite v2 (40 scenarios) plus unit tests | 13 | by construction |
| All of it together | 13 | 13 |

The planted bugs were findable by careful reading, so on recall alone the baseline nearly matched. The differences are in the next two tables.

### Findings beyond the planted bugs

| | Baseline | Adversarial |
|---|---|---|
| Findings reported | 29 (16 Standards, 13 Spec), plus 26 smell notes | 51 |
| Reproduced with a failing test or scenario | 0 | 41 (the other 10 marked PLAUSIBLE, none blocking) |
| Real issues in the clean app beyond the plant, later confirmed and fixed | 3 of 14 mentioned, none proven | 14 of 14 |

The 14 real issues the attackers found in the app as built: a truncated Gmail body treated as success (mail silently skipped), shutdown not draining requests, one tenant's flood delaying others, duplicate Slack DMs after a lost response, a disconnected mailbox that can never be reconnected, reinstall with a new mailbox keeping the old history id, uninstall keeping customer data and never revoking the Google token, a user-token revoke disconnecting the whole workspace, the model provider's Retry-After ignored, an unknown charset killing the job, an encoded display name overriding the sender address, no per-tenant draft budget, an exception in job bookkeeping crashing the instance, and a dead Slack post leaving the suggestion silently stuck. Each now has a scenario (26 to 38) or a unit test.

### Live verification

| | v1 | v2 |
|---|---|---|
| Scenarios | 25 | 40 |
| Assertions | 202 | 301 |
| Time per run, 2 instances | about 22 s | about 49 s |
| Stable 3 runs in a row | yes | yes |
| Planted bugs caught | 11 of 13 | 12 of 13 by scenarios, 13 of 13 with unit tests |
| Real model mode (`--llm claude`) | happy path passes | |

The concurrency race (two users clicking at once) is caught by the click-storm scenario 7 runs in 10 on its own and in every full-suite run measured; making it certain would need a test-only hook in the app, which the proof standards forbid.

### Evals, one iteration (40 cases x 3 trials; haiku drafts, sonnet judges)

| | Before | After | Paired delta (95% CI) |
|---|---|---|---|
| All graders pass | 12.5% | 69.2% | +56.7 points (+43.8 to +69.5) |
| Held-out cases only (25) | 17.3% | 68.0% | +50.7 points (+32.6 to +68.8) |
| Options meaningfully different | 17.1% | 91.2% | +74.2 points |
| No fabricated facts | 77.5% | 100% | +22.5 points |
| Answers the question | 100% | 85.8% | -14.2 points (-23.1 to -5.2), a regression |
| pass^3 (all three trials pass) | 0% | 45% | |

The gate "lower bound of pass rate at least 60%" still fails narrowly (58.5%). The judges are calibrated on only 22 author labels, which is too few to trust their exact rates.

## Score

Ratings on the same scale as the earlier estimates (Matt's loop alone 5 of 10, the fork before this 6 of 10, this design on paper 8 of 10).

**Measured now: 7 of 10.**

What earned it:

- Every finding that blocks is reproduced, so reviewers converge on one list instead of each giving different reasons the work is not done.
- Live verification runs the whole product in the cloud with no real Slack or Gmail, catches 12 of 13 planted bugs on its own, and grew by 15 scenarios from what review found.
- Evals turned "the drafts feel fine" into numbers with error bars, found a real quality problem (near-identical options in 83% of trials), and roughly quadrupled the pass rate on held-out cases plus a regression the eye would have missed.

What holds it back from 8 or 9:

- **Design and build are not yet near zero.** The reference app was built by one agent with the topics as reading material, not through the full loop (shape, envelope, journey x topic matrix, contract), and the attackers still found 14 real issues in it. The claim that design-time concerns make the adversarial pass find close to nothing is the next thing to measure: run `feature-loop` end to end on a new feature and count reproduced findings per stage in `.scratch/loop-metrics.md`.
- **Judges need about 100 or more human labels per failure mode** before their rates are trustworthy.
- **slop-check is noisy on good code.** On the 3,900 lines of this session's own code it reported 30 findings, almost all justified (math in comments, poll loops in the test harness, timeouts as default parameters). It needs precision tuning before it can gate.
- **Tier 2 (a real sandbox Slack workspace, nightly) is documented, not built.**
- **Time cost.** The attack stage took 1.5 to 9 minutes per attacker in parallel, and the live suite takes about 49 s per run. Acceptable for normal and large changes, which is why small changes skip both.

## How to rerun

```
cd skills/fork/live-verify && node harness/runner.mjs --app bench/inbox-assist --instances 2 --llm stub
skills/fork/adversarial-review/bench/run-mutants.sh            # control plus every planted bug
node skills/fork/evals/scripts/run-evals.mjs --help             # see evals/examples/inbox-assist/iteration-1.md for the exact run
```
