# Research behind the evals skill

Every entry below was opened and read (abstract, page or paper) on 2026-10-08. Each says what the source found and what this skill does because of it. Where sources disagree, the entry says so and says which way the skill goes. Sources considered but not used are listed at the end.

## Practice guides from model providers

### 1. Anthropic: Demystifying evals for AI agents
Mikaela Grace, Jeremy Hadfield, Rodrigo Olivares, Jiri De Jonghe. Anthropic Engineering, 9 January 2026. https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents

**Finding.** Recommends deterministic graders where possible, model graders where needed and humans to validate them. Defines pass@k (at least one of k trials succeeds) and pass^k (all k succeed), with the example that 75% per trial gives about 42% pass^3. Separates capability evals (start at a low pass rate) from regression evals (near 100%), advises starting with 20 to 50 tasks drawn from real failures, grading outcomes rather than step order, isolating trials, and reading transcripts so that "failures should seem fair". A 0% task across many trials usually means a broken task; one benchmark score moved from 42% to 95% after grading bugs and task specs were fixed.

**What we do.** The grader order in section 4; pass^k as the reliability metric; two suites (capability and regression); "start with 20 to 50"; the rule that every case must have a passing reference answer and a 0% case is presumed broken; outcome grading; reading failures before trusting a number.

### 2. Anthropic docs: Define success criteria and build evaluations
Claude Platform documentation. https://platform.claude.com/docs/en/test-and-evaluate/develop-tests

**Finding.** Good success criteria are specific, measurable, achievable and relevant, and most use cases need several dimensions (task fidelity, consistency, tone, privacy, context use, latency, price). Eval design: mirror the real task distribution including edge cases, automate grading, and prefer more cases with automated grading over fewer hand-graded ones. Grading methods ranked: code (fastest, least nuance), LLM (test reliability first, then scale), human (avoid if possible). LLM graders need detailed rubrics, specific outputs and reasoning before the verdict; the examples use a different model as grader than the one that generated the output.

**What we do.** Section 1 (criteria across dimensions, including cost and latency); code graders before judges; judges reason before deciding; volume of automated cases over a few hand-graded ones.

### 3. OpenAI: Evaluation best practices
OpenAI API documentation. https://developers.openai.com/api/docs/guides/evaluation-best-practices

**Finding.** Recommends eval-driven development ("evaluate early and often"), logging everything to mine eval cases, and continuous evaluation on every change. Names anti-patterns including vibe-based evals and datasets that do not reproduce production traffic. LLM judges should be calibrated against human annotations before being scaled, and models discriminate between options (pairwise, pass/fail) better than they score open-endedly.

**What we do.** The Build row of "When it runs" (the eval set exists before the prompt is tuned); the vibes-check anti-pattern; journeys weighted to real traffic; binary judges; calibration before trust.

## Statistics

### 4. Miller: Adding Error Bars to Evals
Evan Miller. "Adding Error Bars to Evals: A Statistical Approach to Language Model Evaluations". arXiv:2411.00640, November 2024. https://arxiv.org/abs/2411.00640 (formulas read in the PDF)

**Finding.** Treats eval questions as a sample from a super-population and gives five recommendations: report the standard error of the mean from the CLT; use clustered standard errors when questions come in related groups (they were over 3x the naive SE on one benchmark); reduce variance by resampling answers per question (and with next-token probabilities), not by lowering temperature; compare two models on question-level paired differences; and use power analysis to decide whether an eval can detect an effect. The sample-size formula is `n = (z_{α/2} + z_β)² (ω² + σ²_A/K_A + σ²_B/K_B) / δ²`; the worked example (ω² = 1/9, δ = 0.03, 80% power) needs about 969 questions.

**What we do.** Section 5 and [statistics.md](statistics.md) implement every one of these: CIs on every rate, clustered SE from the case `cluster` field, K trials per case with case score as the mean, paired deltas against the baseline, and a sample-size estimate printed after every paired run. `test-stats.mjs` reproduces the 969. We use the t distribution instead of 1.96 because product suites are often 30 to 100 cases, which makes our intervals slightly wider than Miller's at small n.

### 5. Chen et al.: Evaluating Large Language Models Trained on Code (Codex, HumanEval)
Mark Chen, Jerry Tworek, Heewoo Jun, et al. arXiv:2107.03374, July 2021. https://arxiv.org/abs/2107.03374

**Finding.** Codex solved 28.8% of HumanEval problems with one sample and 70.2% with 100 samples per problem. The paper defines the unbiased pass@k estimator `1 − C(n−c, k) / C(n, k)` from n ≥ k samples with c correct, and shows that the naive `1 − (1 − p̂)^k` consistently underestimates; it uses n = 200 for k ≤ 100.

**What we do.** `passAtK` uses this estimator in the paper's numerically stable product form. We report pass@k only where a human picks the best of k (as with three draft options); for reliability we report pass^k instead.

### 6. Yao et al.: τ-bench
Shunyu Yao, Noah Shinn, Pedram Razavi, Karthik Narasimhan. "τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains". arXiv:2406.12045, June 2024. https://arxiv.org/abs/2406.12045

**Finding.** Agents talk to a simulated user under domain policies and are graded on the final database state against a goal state. Introduces pass^k, "the chance that all k i.i.d. task trials are successful, averaged across tasks", estimated as `C(c, k) / C(n, k)`. gpt-4o's retail pass^1 was about 61% but pass^8 below 25%: agents that look decent on one run are inconsistent.

**What we do.** pass^k for every k up to the trial count in every summary; outcome (final state) grading for agents; the rule that a single run per case is not a measurement.

### 7. Lee et al.: How to Correctly Report LLM-as-a-Judge Evaluations
Chungpa Lee, Thomas Zeng, Jongwon Jeong, Jy-yong Sohn, Kangwook Lee. arXiv:2511.21140, November 2025 (v4 May 2026). https://arxiv.org/abs/2511.21140

**Finding.** An LLM judge's imperfect sensitivity and specificity bias naive scores. The paper gives a plug-in bias correction with confidence intervals that account for uncertainty in both the test set and the human-labeled calibration set, and an adaptive way to allocate calibration labels.

**What we do.** The harness reports a judge-corrected pass rate next to the raw judge rate, and [judges.md](judges.md) warns that the corrected point estimate is only as good as the calibration set's size. The harness does not yet propagate calibration uncertainty into the CI; that is a stated limitation.

### 8. judgy (Shreya Shankar)
Python package. https://pypi.org/project/judgy/

**Finding.** Estimates a system's true pass rate from an LLM judge's observed pass rate using the judge's TPR and TNR measured on labeled data, `θ̂ = (p_obs + TNR − 1) / (TPR + TNR − 1)`, with bootstrap confidence intervals.

**What we do.** `correctedPassRate` in `stats.mjs` is this formula, with pass as the positive class, as in judgy.

## LLM judges: biases and validation

### 9. Zheng et al.: Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena
Lianmin Zheng, Wei-Lin Chiang, Ying Sheng, et al. arXiv:2306.05685, June 2023. https://arxiv.org/abs/2306.05685

**Finding.** Strong judges such as GPT-4 reach over 80% agreement with human preferences, about the level humans reach with each other. The paper documents position bias, verbosity bias, self-enhancement bias and limited reasoning ability in LLM judges.

**What we do.** LLM judges are allowed, but each bias has a countermeasure in section 4: order swapping (`variants` in the harness), length control, a different model family where possible, and source facts in the judge prompt.

### 10. Wang et al.: Large Language Models are not Fair Evaluators
Peiyi Wang, Lei Li, Liang Chen, et al. arXiv:2305.17926, May 2023. https://arxiv.org/abs/2305.17926

**Finding.** Changing only the order of candidate responses can flip an LLM evaluator's ranking; with ChatGPT as judge, Vicuna-13B beat ChatGPT on 66 of 80 queries. Proposed fixes: have the judge produce evidence before the score, aggregate across both orders, and route hard examples to humans.

**What we do.** Judges write reasoning before the verdict; multi-option or pairwise judges run both orders and must agree; judge-failed and disagreeing cases feed the human review queue.

### 11. Liu et al.: G-Eval
Yang Liu, Dan Iter, Yichong Xu, Shuohang Wang, Ruochen Xu, Chenguang Zhu. "G-Eval: NLG Evaluation using GPT-4 with Better Human Alignment". arXiv:2303.16634, March 2023. https://arxiv.org/abs/2303.16634

**Finding.** BLEU and ROUGE correlate weakly with human judgment on open-ended generation. Chain-of-thought plus a form-filling prompt let GPT-4 reach a Spearman correlation of 0.514 with humans on summarization, ahead of earlier metrics. The authors flag that LLM evaluators may favor LLM-generated text.

**What we do.** No similarity metrics as quality measures; judges reason in steps. The 0.514 figure is also a reminder that even good judges are far from perfect, which is why calibration is mandatory.

### 12. Dubois et al.: Length-Controlled AlpacaEval
Yann Dubois, Balázs Galambosi, Percy Liang, Tatsunori B. Hashimoto. arXiv:2404.04475, April 2024. https://arxiv.org/abs/2404.04475

**Finding.** AlpacaEval's LLM judge favors longer outputs. Regressing out the length difference raised the benchmark's Spearman correlation with Chatbot Arena from 0.94 to 0.98 and made it harder to game with verbosity.

**What we do.** Length is a confounder judges reward: binary judges with explicit pass and fail definitions (not "which is better"), length caps as code graders, and length reported alongside judge results.

### 13. Panickssery, Bowman, Feng: LLM Evaluators Recognize and Favor Their Own Generations
Arjun Panickssery, Samuel R. Bowman, Shi Feng. arXiv:2404.13076, April 2024. https://arxiv.org/abs/2404.13076

**Finding.** Models such as GPT-4 and Llama 2 recognize their own outputs better than chance, and after fine-tuning, self-recognition strength correlates linearly with self-preference bias.

**What we do.** Prefer a judge from a different model family than the generator when one is available. See entry 17 for the practitioner view that this is often unnecessary; the skill resolves the tension by requiring measured TPR/TNR either way.

### 14. Shankar et al.: Who Validates the Validators?
Shreya Shankar, J. D. Zamfirescu-Pereira, Björn Hartmann, Aditya G. Parameswaran, Ian Arawjo. arXiv:2404.12272, April 2024. https://arxiv.org/abs/2404.12272

**Finding.** LLM-generated evaluators inherit the flaws of the models they judge and must be aligned with human judgment. In a study of EvalGen, users needed criteria to grade outputs, but grading outputs changed their criteria ("criteria drift"), and some criteria only made sense after seeing outputs.

**What we do.** Error analysis precedes grader design (section 2), criteria are expected to drift and early labels are revisited, and judges are validated against human labels rather than trusted because a model wrote them.

## Practitioner method

### 15. Husain: Your AI Product Needs Evals
Hamel Husain, 29 March 2024. https://hamel.dev/blog/posts/evals/

**Finding.** Three levels: assertion-style unit tests run on every change, human and model evaluation over logged traces, and A/B tests. Remove all friction from looking at data and never stop doing it. Judge agreement should be measured with precision and recall, because raw agreement misleads when classes are imbalanced.

**What we do.** Code graders run on every change; traces are logged and read; judge agreement is reported as TPR and TNR, not accuracy alone. (The AI concern topic's AI-01 already cites this post.)

### 16. Husain: Using LLM-as-a-Judge for Evaluation (critique shadowing)
Hamel Husain, 29 October 2024 (updated 2026). https://hamel.dev/blog/posts/llm-judge/

**Finding.** A single principal domain expert makes binary pass/fail calls with written critiques; those critiques become few-shot examples and the yardstick for the judge, which is iterated until agreement is acceptable (one project passed 90% in three iterations). Report TPR and TNR separately; split labels into train (few-shot), dev and test, never putting dev or test examples in the prompt. 1 to 5 scales are not actionable: "People don't know what to do with a 3 or 4."

**What we do.** Binary judges; the calibration procedure in [judges.md](judges.md) (expert, critiques, train/dev/test, TPR/TNR); no Likert scores.

### 17. Husain and Shankar: AI Evals FAQ
Hamel Husain, Shreya Shankar. "AI Evals: Everything You Need to Know", September 2026. https://hamel.dev/blog/posts/evals-faq/

**Finding.** Error analysis is open coding (free-text notes on traces, like journaling) followed by axial coding into a failure taxonomy, "the most important step". Annotate at least 30 traces yourself and review around 100, stopping at theoretical saturation. Binary labels beat Likert. For a judge, label 100 to 200 examples per failure mode with a train split of 10 to 20% and dev and test of 40 to 45% each. Generic metrics "create false confidence". Synthetic data helps start error analysis but "cannot tell you how common a failure is". On judge choice the FAQ says using the same model as the application "is usually fine" and to switch only if alignment is poor.

**What we do.** Section 2 follows this process and its numbers; section 4's calibration sizes and splits. On the same-model question we lean toward a different family (entries 2 and 13) when it costs nothing, and treat measured TPR/TNR as the deciding evidence, which is the FAQ's own test.

### 18. Husain: A Field Guide to Rapidly Improving AI Products
Hamel Husain, 24 March 2025. https://hamel.dev/blog/posts/field-guide/

**Finding.** Bottom-up error analysis on real conversations found that three issues caused over 60% of problems in one product; a custom data viewer is called "the most important AI investment". Binary judgments with critiques; synthetic data generated along features, scenarios and personas, generating inputs rather than expected outputs and checking that they hit the intended scenario.

**What we do.** The viewer advice in section 2; synthetic data generated by dimensions and verified, as a starting point only.

## Benchmarks: what they teach about case quality

### 19. Jimenez et al.: SWE-bench
Carlos E. Jimenez, John Yang, Alexander Wettig, Shunyu Yao, Kexin Pei, Ofir Press, Karthik Narasimhan. arXiv:2310.06770, October 2023. https://arxiv.org/abs/2310.06770

**Finding.** 2,294 tasks built from real GitHub issues and pull requests in 12 Python repositories, graded by the repositories' tests; the best model at release, Claude 2, resolved 1.96%.

**What we do.** Cases from real work, graded by executable checks on the outcome.

### 20. Chowdhury et al. (OpenAI): Introducing SWE-bench Verified
Neil Chowdhury, James Aung, Chan Jun Shern, et al. OpenAI, 13 August 2024 (updated February 2025). https://openai.com/index/introducing-swe-bench-verified/

**Finding.** 93 developers reviewed 1,699 SWE-bench samples three times each: 38.3% had underspecified problem statements and 61.1% had tests that could reject valid solutions. 68.3% were filtered out, leaving 500; GPT-4o's score went from 16% to 33.2%.

**What we do.** "Every case must be fair": a reference answer that passes every grader, review of cases and graders before trusting a low score, and the assumption that a case nobody passes is broken until shown otherwise.

### 21. Liang et al.: Holistic Evaluation of Language Models (HELM)
Percy Liang, Rishi Bommasani, Tony Lee, et al. arXiv:2211.09110, November 2022. https://arxiv.org/abs/2211.09110

**Finding.** Measures seven metrics (accuracy, calibration, robustness, fairness, bias, toxicity, efficiency) across many scenarios under standardized conditions, raising the share of core scenarios on which models were compared from 17.9% to 96.0%, so trade-offs stay visible.

**What we do.** No one-number dashboard: per-grader and per-tag results, with cost and latency beside quality, all from one standardized run.

### 22. Ribeiro et al.: Beyond Accuracy: Behavioral Testing of NLP Models with CheckList
Marco Tulio Ribeiro, Tongshuang Wu, Carlos Guestrin, Sameer Singh. arXiv:2005.04118, May 2020. https://arxiv.org/abs/2005.04118

**Finding.** Held-out accuracy overstates model quality. CheckList tests capabilities with three test types: minimum functionality tests (simple labeled cases, like unit tests), invariance tests (label-preserving perturbations such as swapping a city name must not change the output) and directional expectation tests (a perturbation must move the output a known way). Practitioners using it found about three times as many bugs, including in a heavily tested commercial model.

**What we do.** The behavioral-test bullet in section 3, with derived variants sharing a `cluster` so the statistics treat them as related.

### 23. Liu et al.: Lost in the Middle
Nelson F. Liu, Kevin Lin, John Hewitt, Ashwin Paranjape, Michele Bevilacqua, Fabio Petroni, Percy Liang. "Lost in the Middle: How Language Models Use Long Contexts". arXiv:2307.03172, July 2023. https://arxiv.org/abs/2307.03172

**Finding.** Performance is often highest when relevant information is at the start or end of the input and drops when it sits in the middle, even for long-context models.

**What we do.** Long-context cases place the key fact early or in the middle, not only at the end (section 3, "Scale and position").

### 24. Debenedetti et al.: AgentDojo
Edoardo Debenedetti, Jie Zhang, Mislav Balunović, Luca Beurer-Kellner, Marc Fischer, Florian Tramèr. arXiv:2406.13352, June 2024. https://arxiv.org/abs/2406.13352

**Finding.** An extensible environment of 97 realistic agent tasks (email, banking, travel) and 629 prompt-injection security cases; models fail many tasks even without attacks, and existing attacks break some security properties but not all.

**What we do.** Injection cases are part of every suite that reads untrusted text, scored with hard floors, and utility is measured on the same cases (a refusal to help is not a pass).

## Contamination

### 25. Sainz et al.: NLP Evaluation in Trouble
Oscar Sainz, Jon Ander Campos, Iker García-Ferrero, Julen Etxaniz, Oier Lopez de Lacalle, Eneko Agirre. arXiv:2310.18018, October 2023. https://arxiv.org/abs/2310.18018

**Finding.** Training on a benchmark's test split inflates scores on it, the extent is hard to measure, and it leads to wrong conclusions; the authors call for contamination detection and flagging.

**What we do.** Product decisions rest on private, held-out cases from our own traffic, not public benchmarks.

### 26. Zhang et al.: A Careful Examination of LLM Performance on Grade School Arithmetic (GSM1k)
Hugh Zhang, Jeff Da, Dean Lee, et al. arXiv:2405.00332, May 2024. https://arxiv.org/abs/2405.00332

**Finding.** On a new set matched to GSM8k in style and difficulty, some models scored up to 8% lower, several model families showed systematic overfitting, and the gap correlated with a model's likelihood of generating GSM8k items (Spearman r² = 0.36), suggesting partial memorization.

**What we do.** The held-out split and the rule against tuning on it: the same effect happens inside a team when prompts are tuned against the cases that judge them.

## Frameworks

### 27. Inspect (UK AI Security Institute)
https://inspect.aisi.org.uk/

**Finding.** An open-source evaluation framework built from datasets (input and target), solvers (from one model call to multi-turn agents with tools) and scorers (text match, model-graded, custom), with a log viewer.

**What we do.** The harness uses the same split (cases, target, graders) so suites port to Inspect when a team outgrows a single script; we stayed zero-dependency so a suite runs anywhere Node 22 does.

## Patterns from reference skill repositories

Read in `cursor-plugins` (pstack `poteto-mode/playbooks/eval.md`), `gstack` (`test/helpers/eval-budgets.ts`, eval baselines and flake ranking) and `tob` (`plugins/property-based-testing/evals` and `evals-extra/run.sh`). Not research, but practice worth copying:

- pstack: judges see outputs under sanitized labels, from a different model family when available, and the operator reads every output end to end to check the judge. → judge blinding and "read the failures".
- gstack: paid evals never retry; a failed verdict is final, and a re-run adds trials rather than replacing results. → verdicts are never retried.
- tob: one grader per concern ("judge only how the dependency decision is framed; correctness is scored by a different grader"), three runs and a majority threshold because one run "reports noise as signal", and a crashed session invalidates the sweep instead of counting as a result. → single-failure-mode judges, K trials, infrastructure errors invalidate.

## Considered and not used

- Rogan and Gladen's prevalence correction is the classical name for the formula in entry 8; I did not open the original paper, so the skill cites judgy and Lee et al. instead.
- Venues for CheckList and Lost in the Middle (often cited as ACL 2020 and TACL 2024): the arXiv pages I read did not state them, so entries cite arXiv only.
- A claim that Zheng et al. recommend reference-guided judging: not confirmed in what I read, so the "give the judge the source facts" advice rests on entry 3 (reference-guided grading) and on the injection cases' needs.
