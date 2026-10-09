# Iteration 1: draftReplies prompt and parser

Target: `skills/fork/live-verify/bench/inbox-assist/src/draft.mjs` (`draftReplies`). Suite: this folder, 40 cases, 7 code graders, 5 judges. Generation `haiku` (served `claude-haiku-5-5`), judging `sonnet`, through the harness's `claude-cli` client. Cases and graders unchanged between runs (same `casesSha` and `gradersSha`, so the paired comparison carries no warnings).

- Error analysis: [error-analysis.md](error-analysis.md)
- Dev and held-out split: [split.json](split.json) (15 dev, 25 held-out, stratified by tag, clusters kept on one side, fixed before the first new-prompt run)
- Results: [results/before/](results/before/results.md) and [results/after/](results/after/results.md); per-subset numbers in [results/after/subsets.json](results/after/subsets.json)

## What changed and why

Only `SYSTEM`, the closing line of `buildPrompt`'s user prompt, `parseOptions` and the `maxTokens` argument changed. `draftReplies`' signature, `fitThreadToBudget`, `stripQuoted`, `quote`, and every other file in `inbox-assist/src` are untouched. The injection defenses stay: the thread is still quoted inside `<untrusted_email_thread>` with the delimiter neutralised, the model still produces only body text (no recipients, subject or threading), and the security rules were kept and widened (account and payment details added to the "never add" list).

| Change | Failure mode it targets |
|---|---|
| Three fixed intents: **brief** (one to three sentences), **complete** (all relevant facts plus one next step), **different move** (core answer first, then one genuinely missing question or a different next step). "Do not reuse sentences"; varying greeting, sign-off or appended contact detail is named as not different. | FM1 paraphrase options (97 of 120 trials) |
| "You cannot take any action ... never write that something has been done", with the future-tense form to use instead. Unsubscribe options must say "will be removed". | FM2 claimed actions (13 trials) |
| "Do not guess either way: saying a thing does not exist is also a claim"; no qualifiers the notes lack; name only people, teams and contacts in the notes or thread; no specific follow-up time the notes do not give. | FM3 invented policy (8), FM4 embellishment and invented teams (6) |
| Every option in the language of the newest message, "even if the company works in several"; language is never a way to vary options. | FM5 French option for an English sender (3) |
| With an upset sender every option opens by acknowledging the frustration; do not volunteer fees or penalties the sender did not ask about. | FM7 volunteered $50 fee (2) |
| Special-message rules for thanks, unsubscribe and out-of-office (short, still different, no questions, no pitch). Added after dev run 1, where option 3 asked unsubscribers to "confirm your address". | Regression found on dev |
| "Never withhold an answer the notes give" and "never ask for something the thread already tells you". Added after dev run 1, where option 3 asked questions instead of answering (answers_question fell to 40% on dev). | Regression found on dev |
| Output section: one JSON object, no fences, `\n` and `\"` escaping, under 900 characters per option. Parser now strips surrounding prose, scans balanced `{...}` spans and prefers the one with `options`, and repairs raw line breaks or tabs inside strings. The exact-3 schema check is unchanged (the unit tests require 2 and 4 options to be rejected). | FM6 crashes |
| `maxTokens` 1024 to 2048. In dev run 3, 2 of 30 trials failed with "response exceeded the 1536 output token maximum" because the served model spends output tokens on thinking. | FM6, infrastructure |

### Dev iterations (15 dev cases x 2 trials, against the baseline's same 15 cases)

| Run | Pass rate (95% CI) | Paired delta vs baseline | Main remaining failure |
|---|---|---|---|
| Baseline on dev | 4.4% [0.0, 11.0] | | paraphrase options |
| dev 1: intents, no-action, facts, language, parser | 36.7% [12.4, 60.9] | +32.2 pts [+5.1, +59.3] | option 3 asks instead of answering: answers_question 40% |
| dev 2: answer first, do not ask for known facts, special messages | 56.7% [33.1, 80.3] | +52.2 pts [+26.1, +78.3] | thanks and unsubscribe options still alike; option 3 skips empathy |
| dev 3: content-level variation for special messages, empathy first, no invented follow-up times | 63.3% [47.4, 79.3] | +58.9 pts [+42.5, +75.2] | crashes (6 of 30) |

Held-out cases were not run until the final run.

## Results: full suite, 40 cases x 3 trials, paired against the baseline

| Metric | Before | After | Paired delta (95% CI) |
|---|---|---|---|
| **All graders pass, all 40 cases** | 12.5% [5.6, 19.4] | **69.2% [58.5, 79.8]** | **+56.7 pts [+43.8, +69.5]**, 32 better / 2 worse |
| pass^3 (all 3 trials pass) | 0.0% | 45.0% | |
| pass^2 | 3.3% | 54.2% | |
| pass@3 (best of 3) | 27.5% | 90.0% | |
| **Held-out only (25 cases)** | 17.3% [7.2, 27.5] | **68.0% [53.3, 82.7]** | **+50.7 pts [+32.6, +68.8]**, 18 better / 2 worse |
| Held-out pass^3 | 0.0% | 48.0% | |
| Dev only (15 cases) | 4.4% [0.0, 11.0] | 71.1% [54.2, 88.0] | +66.7 pts [+49.5, +83.9] |
| Dev pass^3 | 0.0% | 40.0% | |

The held-out gain is close to the dev gain, so the improvement generalises beyond the cases it was tuned on. Intervals are clustered t intervals over cases (36 clusters), clipped to [0, 100]; per-grader rows with `W` are Wilson intervals.

### Per grader (all 40 cases; held-out in the last column)

| Grader | Before | After | Paired delta, all | Paired delta, held-out |
|---|---|---|---|---|
| options_distinct | 17.1% [9.3, 24.9] | 91.2% [84.8, 97.7] | **+74.2 pts [+64.4, +83.9]** | +77.3 [+64.9, +89.8] |
| no_fabricated_facts | 77.5% [66.4, 88.6] | 100.0% [91.2, 100] W | **+22.5 pts [+11.4, +33.6]** | +14.7 [+3.4, +25.9] |
| answers_question | 100.0% [91.2, 100] W | 85.8% [76.9, 94.8] | **-14.2 pts [-23.1, -5.2]** | -20.0 [-33.2, -6.8] |
| appropriate_tone | 97.5% [92.4, 100] | 97.1% [93.8, 100] | -0.4 [-6.6, +5.8] | -3.3 [-8.0, +1.4] |
| language_match | 97.5% [92.4, 100] | 99.2% [97.5, 100] | +1.7 [-3.8, +7.1] | -1.3 [-4.0, +1.3] |
| injection_resisted (6 cases) | 100% [61.0, 100] W | 100% [61.0, 100] W | 0 | 0 |
| no_foreign_emails, no_invented_numbers, no_forbidden_strings, option_count, non_empty, length_cap | 100% | 100% | 0 | 0 |
| target_ran (crashes) | 4 of 120 trials (3.3%) | 7 of 120 trials (5.8%) | | |

Gates (same as the baseline plus `delta.hi>=0`): injection, foreign emails, forbidden strings, judge TNR and `delta.hi>=0` pass; `pass.lo>=0.6` **fails narrowly** (lower bound 58.5%).

### Cost and latency

| | Before | After |
|---|---|---|
| Generation cost per trial | $0.0008 | $0.0014 (+75%: longer system prompt, longer complete option, more thinking) |
| Judge cost, whole run | $6.36 | $5.79 |
| Latency p50 / p95 | 6.1 s / 10.7 s | 9.3 s / 18.3 s |

Power: with this suite's paired variance, detecting a 5-point change needs about 523 cases, a 10-point change about 131. The 40-case suite can only resolve changes of roughly 20 points or more, which this one is.

## What still fails (37 grader failures across 120 trials)

1. **answers_question regressed (16 trials, 9 cases)**: the price of distinct options. Sub-modes:
   - Brief option drops part of the answer (sched-saturday 2, lang-fr-delais 2, lang-es-return 1): "closed Saturdays" without offering weekdays; start date without project duration.
   - Option 3 drifts off the request (sched-demo-ny 2, sched-discovery 1, price-nonprofit 1): pitches a trial or asks about plans instead of the demo or discount.
   - Vague message, not every option asks the key question (ambig-broken 2, ambig-sizes 2).
   - **Unfair to the drafter (long-early-detail, all 3 trials)**: option 3 asks for the order number. The number is in an older message that `fitThreadToBudget` drops (`THREAD_MESSAGES = 5`, 2 messages omitted), so the model never saw it, but the judge sees the whole thread. This is a truncation or case-design issue, not a prompt one; the baseline hid it by never asking.
2. **Crashes rose to 7 of 120 (6 not_json, 1 wrong_option_count)**. Probing raw CLI output showed the cause of the not_json ones: the served model interleaves a thinking block in the middle of the JSON, the response then has two text blocks, and the `claude -p` JSON `result` field (what `scripts/lib/claude-cli-client.mjs` returns) holds only the **last** text block, so the parser receives the tail of the object. The production client `src/llm.mjs` joins all text blocks, so production would very likely parse these. This is an eval-client fidelity bug, outside the files this iteration may touch; the longer outputs make it more frequent. Fix in the client (join every text block, for example from `--output-format stream-json`), then re-measure.
3. **options_distinct (10 trials)**: ord-thanks still fails in all 3 trials (the judge wants different content for a pure thank-you, which the case criteria also say should carry no new commitments; these two pull against each other), plus one-offs.
4. **appropriate_tone (3 trials)**: option 3 on angry-refund once led with policy; ooo-de proposed a call; sched-saturday asked if she could take a day off.
5. **language_match (1 trial) is a grader false negative**: "Guten Tag Jonas, Ihre Daten werden in Frankfurt (EU) gehostet." is German, but the stopword detector needs two stopwords and a one-sentence brief option has one.
6. **Judge calibration**: answers_question showed TPR 50% on its 4 labels this run (one human-pass label failed: a question-first option on long-last-question). With 4 labels this is noise-level evidence, but it points the same way as item 1: the judge is strict about question-first options. It needs a real calibration set (100+ labels) before its regression is trusted at face value.

## Next iteration

- Fix the eval client to join text blocks (removes most crashes), and give the drafter the thread facts it needs (or make the judge see what the drafter saw) for long-thread cases.
- Brief option: "covers every part of the question, only shorter". Option 3: "the next step must be about the sender's request".
- Language grader: fall back to a script or character n-gram check for short options.
- Calibrate answers_question and options_distinct on 100+ human labels now that outputs look different from the baseline.

## Verification

Every number above was copied from `results/before/results.md`, `results/after/results.md`, `results/after/subsets.json` (computed with the harness's own `lib/stats.mjs`: clustered t intervals, paired differences, pass^k), or the dev run outputs, not written from memory. Failure counts in "What still fails" were counted from `results/after/trials.jsonl`. The crash cause was observed directly in 3 of 47 probed raw CLI responses (2 price-crown, 1 sched-reschedule); that it explains the other not_json crashes is an inference, and the single wrong_option_count crash was not reproduced. The claim that production would parse these responses rests on reading `src/llm.mjs`, not on running it.
