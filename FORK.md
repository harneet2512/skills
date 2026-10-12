# About this fork

This repo is a fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). It ships every upstream skill unchanged and adds ten skills on top. This file records every difference from upstream: what the original was, what was added, and why.

- **Upstream base:** [`f3fc563`](https://github.com/mattpocock/skills/commit/f3fc5632f401156837ee3872f14fe33ccf1024ea), 2026-10-07, upstream version `1.3.1`
- **Fork version:** `1.3.1-fork.9.16`
- **`/kl`, the owner's whole flow in one command:** see [KL.md](KL.md) (install, use, what is enforced, dry-run results).
- **Plugin name:** `mattpocock-skills` (unchanged, so every `mattpocock-skills:<skill>` reference keeps working)
- **Marketplace name:** `mattpocock-fork`

## What differs from upstream

| Path | Upstream | This fork |
|---|---|---|
| `skills/fork/wp-loop/` | does not exist | new skill; model-invoked since fork.5 |
| `skills/fork/deep-engineering/` | does not exist | new model-invoked skill |
| `skills/fork/behavioral-envelope/` | does not exist | new model-invoked skill |
| `skills/fork/feature-loop/` | does not exist | new user-invoked skill |
| `skills/fork/shape/`, `concern-topics/`, `evals/`, `live-verify/`, `adversarial-review/` | do not exist | new model-invoked skills |
| `skills/fork/README.md` | does not exist | bucket README for the fork skills |
| `hooks/hooks.json` | does not exist (upstream ships no hooks) | plugin hooks: `PreToolUse` on `Bash` (commit, push, PR-create and merge gates), `Stop` (no loop stage left `running`) and `SessionStart` (prints the loop ledger); see section 4, "Gates", and section 5 |
| `.claude-plugin/plugin.json` | `version` `1.3.1`; `repository` upstream; 27 skills | `version` `1.3.1-fork.9.16`; `repository` this fork; the eleven fork skills added at the top of `skills`; one sentence added to `description` |
| `package.json` | `version` `1.3.1` | `version` `1.3.1-fork.9.11` (keeps `scripts/sync-plugin-version.mjs --check` passing) |
| `.claude-plugin/marketplace.json` | `name` `mattpocock`, owner Matt Pocock | `name` `mattpocock-fork`, owner `harneet2512`, description says it is a fork |
| `README.md` | upstream | one fork notice under the title |
| `CLAUDE.md` | upstream | `## Fork` section at the end |
| `.github/workflows/` | `release.yml`, `needs-info.yml`, `triage-label.yml` | those three removed (fork.5); `fork-ci.yml` added; Actions enabled again; see "GitHub Actions on this fork" |
| `skills/engineering/to-spec/`, `to-tickets/`, `retro/` (SKILL.md frontmatter and `agents/openai.yaml`) | user-invoked (`disable-model-invocation: true`, `allow_implicit_invocation: false`) | **model-invoked**, with model-facing descriptions, so `feature-loop` can call them (fork.5, section 5). The skill bodies are unchanged. |
| `README.md`, `skills/engineering/README.md`, `skills/fork/README.md` | list those skills (and `wp-loop`) as user-invoked | list them as model-invoked |
| `docs/engineering/retro.md` | "the skill stays human-in-the-loop and user-invoked" | stays human-in-the-loop; notes that the fork makes it model-invoked so `feature-loop` can run it, and that it still only proposes |
| `skills/fork/plan-first/` (`SKILL.md`, `plan-template.md`, `design-challenge.md`) | does not exist | new model-invoked skill: the planning half of the plan-first workflow (fork.7, section 8) |
| `skills/fork/feature-loop/PRACTICE-RUN.md`, `scripts/plan-check.mjs` | do not exist | the practice run's steps; the plan checker (fork.7, section 8) |
| `scripts/check-invocation.mjs`, `scripts/test-invocation.sh`, `scripts/fixtures/invocation/` | do not exist | invocation lint and its tests (section 5) |
| `.agents/adr/0003-codex-review-gates-in-feature-loop.md` | does not exist | ADR for Codex as cross-vendor reviewer through gates G9 and G10 (section 6) |
| `FORK.md` | does not exist | this file |

Every other file is identical to upstream. Three upstream `SKILL.md` files changed in fork.5, frontmatter only (bodies unchanged); their original `description:` lines were:

- `to-spec`: `"Turn the current conversation into a spec and publish it to the project issue tracker: no interview, just synthesis of what you've already discussed."`
- `to-tickets`: `Break a plan, spec, or the current conversation into a set of tracer-bullet tickets, each declaring its blocking edges, published to the configured tracker (edges as text in one file per ticket locally, or native blocking links on a real tracker).`
- `retro`: `"Conduct a retrospective on a coding session."`

Each also had `disable-model-invocation: true`, and its `agents/openai.yaml` had `policy: allow_implicit_invocation: false`.

### GitHub Actions on this fork

Upstream's workflows misbehave on a fork, so fork.5 removes three of them and adds the fork's own CI:

| Workflow | What it would do here | Fork.5 |
|---|---|---|
| `release.yml` | runs `changeset version` on every push to `main`: turns the fork version back into a plain upstream version, deletes the changesets, then fails to open its release PR | removed; the fork releases by hand (see "Ship a change to the fork") |
| `needs-info.yml` | closes this fork's issues labelled `needs-info` after 14 days, with a message pointing at upstream's CONTRIBUTING | removed |
| `triage-label.yml` | fails on this fork's issues wherever the `needs-triage` label does not exist | removed |
| `fork-ci.yml` | new: on push and pull request, runs the invocation lint and every test suite (gates, hooks, packs, slop, invocation, evals, live-verify, the inbox-assist bench) and the plugin-version check; actions pinned to full SHAs | added |

Before fork.5, Actions was disabled in the repo settings because of `release.yml`. With it removed, Actions is enabled again so `fork-ci.yml` runs:

```bash
gh api -X PUT repos/<owner>/skills/actions/permissions -F enabled=true
```

If you fork this fork, keep those three workflows removed before your first push.

## 1. `wp-loop` (new; model-invoked since fork.5)

Type `/mattpocock-skills:wp-loop <issue>` (or let `feature-loop` call it) to take one work package (one issue, one branch, one PR) from issue to merged.

### What upstream already had

Upstream has every building block. It has no single flow that chains them through gates up to a merge.

| Upstream skill | What it does | What it stops short of |
|---|---|---|
| [`implement`](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/implement/SKILL.md) | Fetch the ticket, call `tdd` at agreed seams, typecheck, run tests, call `code-review`, commit to the current branch | No branch per ticket, no PR, no CI gate, no merge, no report |
| [`implement-spec`](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/implement-spec/SKILL.md) | Whole spec on one integration branch, parallel implementer subagents across the ticket graph, one `code-review` at the end, and a draft PR when the tracker closes work through PRs or the user asks | Built for a whole spec at once. No severity gate, no verified fix round, no merge gate, no results report |
| [`pr`](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/pr/SKILL.md) | PR body template: Summary, Evidence, Merge Danger | Writes the body only |
| [`code-review`](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/code-review/SKILL.md) | Two axes in parallel subagents, Standards and Spec, reported side by side with the worst issue within each axis | Deliberately no ranking across axes, and no rule on what blocks a merge |
| [`tdd`](https://github.com/mattpocock/skills/blob/f3fc5632f401156837ee3872f14fe33ccf1024ea/skills/engineering/tdd/SKILL.md) | Red then green, one slice at a time, only at seams confirmed with the user. Refactoring belongs to review, not the loop | Unchanged here. `wp-loop` calls it after the lead confirms the seams |

### What the fork adds, and where each rule came from

The loop was run on a private project from 2026-10-02, using the upstream skills (then `1.2.3`). The right-hand column says where each rule came from: a rule the loop started with, or the incident that added it.

| Rule in `wp-loop` | Where it came from |
|---|---|
| Contract first: call `deep-engineering` before code, and before `/to-spec` when the issue is not enough of a spec | Upstream skills assume the system model is right and nothing checks it against the code. `deep-engineering` was written to close that gap (see section 2) |
| One work package, one branch (`wp<issue>-<slug>`), one PR | Original loop rule |
| `Refs: #<issue>` on every commit, and a check of the diff against the issue before each commit | Added after the agent misread an issue's scope. Deviations get written down, never made silently |
| Builder on a cheaper model; reviewers on the strongest one; the lead verifies | Original loop rule: cheaper models build; the strongest model writes requirements and does every review |
| The lead (not a subagent) calls `code-review` and puts the strongest model in both axis briefs | Found in review before publishing: subagents usually cannot spawn subagents, and `code-review` spawns two |
| The lead confirms the contract's seams with the user before the builder starts | Found in review before publishing: `tdd` requires confirmed seams, and a builder subagent cannot ask the user |
| Severity tags (CRITICAL/HIGH/MEDIUM/LOW) inside each `code-review` axis, never across axes | The loop ranked findings by severity. Tagging inside each axis is how this fork keeps upstream's rule against reranking across axes |
| Any HIGH or above is fixed first, and the lead re-runs the targeted test for each one | Original loop rule: do not trust the builder's summary |
| MEDIUM findings are fixed now or filed, never dropped | Original loop rule |
| Merge gate: update from the default branch, renumber, wait for CI on that head, require `gh pr checks` exit 0, merge with `--match-head-commit` | A scripted loop merged a PR whose CI had failed, because it only checked that the branch merged cleanly (2026-10-05) |
| A degraded-CI procedure that needs the user's approval | GitHub Actions was degraded on 2026-10-05. The approved rule: run the jobs that never ran locally on the exact head, post the output, and never merge over a real failure |
| Migrations and ADRs numbered at merge time | Parallel branches claim the same next number, and some migration tools refuse a lower number applied later |
| Leakage tests wherever time or replay is involved | Reviews found three HIGH-severity "as of" reads that leaked later data |
| Results comment with acceptance evidence and numbers | Original loop rule: every work package reports its numbers |
| Review checks in `review-checks.md` | Each item is a bug class the review caught on that project |

### Files

- `skills/fork/wp-loop/SKILL.md`: the loop
- `skills/fork/wp-loop/check-comment.md`: the results comment template
- `skills/fork/wp-loop/review-checks.md`: extra checks for the reviewer
- `skills/fork/wp-loop/agents/openai.yaml`: Codex metadata (model-invoked since fork.5)

`wp-loop` calls only model-invoked skills through the Skill tool (`deep-engineering`, `tdd`, `pr`, `code-review`, `diagnosing-bugs`). Since fork.5 it also calls `to-spec`, and resolves fuzzy terms with `grilling` and `domain-modeling`; it tells the user to run only `/setup-matt-pocock-skills`.agents/invocation.md`](./.agents/invocation.md). The issue tracker is whatever `setup-matt-pocock-skills` configured (GitHub by default). The `gh` commands target GitHub.

## 2. `deep-engineering` (new, model-invoked)

Fires before any non-trivial build or fix. It reads the repo, derives invariants, decides which concerns matter, researches uncertain semantics, compares alternatives, and writes an **engineering contract**. It writes no product code.

### What upstream already had

No upstream skill establishes what the system actually does today before the spec is written. `grilling` interviews the user, `domain-modeling` maintains the glossary and ADRs, `to-spec` writes the spec, and `tdd` runs red and green. All of them assume the system model is right. `deep-engineering` builds that model from code and primary sources, and its contract feeds `to-spec`, `tdd` and the Spec axis of `code-review`.

### Origin and the changes made when it moved in

It was written on 2026-10-03 as a personal skill (`~/.claude/skills/deep-engineering`) to sit between Matt's skills. It moved into this fork with these edits only:

| Where | Before | After | Why |
|---|---|---|---|
| `SKILL.md` section 1 | ``glossary: use `CONTEXT.md` vocabulary`` | ``glossary: use `GLOSSARY.md` vocabulary`` | Upstream renamed `CONTEXT.md` to `GLOSSARY.md` in [#1120](https://github.com/mattpocock/skills/pull/1120) |
| `SKILL.md`, "How it composes" | ``reuse `CONTEXT.md` names`` | ``reuse `GLOSSARY.md` names`` | Same rename |
| `contract-template.md` | `domain vocabulary from CONTEXT.md` | `domain vocabulary from GLOSSARY.md` | Same rename |
| `SKILL.md` section 4 | ``use Matt's `research` skill for anything heavy`` | ``for anything heavy, call the Skill tool with `research` `` | Upstream's convention: name the Skill tool explicitly |
| `SKILL.md`, "How it composes" | ``ask via `grilling` `` | ``call the Skill tool with `grilling` `` | Same convention |
| `agents/openai.yaml` | did not exist | added | Every skill in this repo carries one |

`concerns.md` is byte-identical to the original. The original's private evaluation file (an A/B run on a private codebase) was left out because it is project-specific.

## 3. `behavioral-envelope` (new, model-invoked)

Finds every concern a change must satisfy to really work, the same way on every run, and turns them into how the change is built: a mechanism, enforcement point, proof and production signal for each live concern, ranked by severity, and a build order with shared mechanisms first. It runs as soon as what to build is decided (from the request text, before any code), `deep-engineering` designs around its output for every tier, and `wp-loop` re-checks the diff with it before review.

### Why it exists

Asking a model "what could go wrong?" returns a different list on each run, and an item missing from that list ships as a bug. `deep-engineering`'s `concerns.md` is a set of discovery prompts, deliberately not a checklist, so it still depends on recall. This skill adds a floor that does not:

| Piece | What it does |
|---|---|
| `scripts/detect-packs.sh` | Picks concern packs from the request text (`--plan`), the files to touch (`--paths`) or the diff (`--diff`) with fixed patterns, then adds implied packs (money implies data and api, and so on). Comment-only lines are skipped and `.scratch/` is ignored. Same input, same packs |
| `packs/*.md` | 17 packs, one per kind of change (core, UI visual, UI behavior, API, data, outbound messages, inbound events, jobs and time, integrations and auth, LLM, retrieval, identity and access, files, personal data, infra and config, dependencies, money). Every item in a selected pack gets an answer: Live, Later or N/A |
| `packs/SOURCES.md` | Primary sources the items cite (WCAG, Stripe idempotency and webhooks, Google sender guidelines, Google SRE book, OWASP, ISO/IEC 25010, Kleppmann, Nygard, RFC 8058, Twelve-Factor, IANA tz). Provider rules carry the date they were checked |
| Purpose step | Concerns are judged against what the change is for; the model may add items beyond the packs, never drop a selected pack |
| Second pass | For risky packs (outbound, inbound events, money, identity, personal data, data), a fresh subagent answers independently and the Live items are unioned |
| Design step | Every Live item gets a severity, a mechanism, the strongest enforcement point, a proof and a runtime signal; mechanisms are grouped and ordered into a build plan (foundations, slices, rollout, operate) |
| `scripts/test-detect.sh` and `bench/` | Fixtures that pin pack selection, and a recall and agreement bench. `bench/stress-2026-10-08.md` records eight scenarios run twice each: 100% recall on the keys, 88% mean run agreement, raised to 94% on the worst case after the implied-pack fix |

The envelope file goes to `.scratch/envelope/`; the PR carries only the handled Live items and their evidence.

### Edits to the other fork skills

| Where | Before | After |
|---|---|---|
| `deep-engineering/SKILL.md`, tier table, Tiny output | `intended behavior, invariant touched (if any), verification` | adds the envelope's Live items in one line; the full envelope stays in `.scratch/` |
| `deep-engineering/SKILL.md`, section 3 | `concerns.md` prompts only | calls `behavioral-envelope` for every tier first; `concerns.md` prompts on top for Normal and Major |
| `deep-engineering/SKILL.md`, sections 5 and 7 | alternatives compared on invariants, failure behavior and fit | alternatives also compared on how they satisfy the envelope's Live items; the contract names the envelope's mechanisms and build order |
| `deep-engineering/SKILL.md`, "How it composes" | Behavioral Envelope listed as an optional sibling | listed as a called skill; Adversarial Engineering stays optional |
| `wp-loop/SKILL.md`, step 10 | `code-review` with the issue checklist and the contract as the spec | first runs `behavioral-envelope`'s "Re-check against the diff" section; the envelope's Live items join the spec |

`concerns.md` is unchanged.

### Files

- `skills/fork/behavioral-envelope/SKILL.md`: the method
- `skills/fork/behavioral-envelope/envelope-template.md`: the envelope file format
- `skills/fork/behavioral-envelope/packs/`: the packs, their index and sources
- `skills/fork/behavioral-envelope/scripts/detect-packs.sh`: pack selection; `test-detect.sh` and `fixtures/` test it
- `skills/fork/behavioral-envelope/bench/README.md`: how to measure recall and agreement
- `skills/fork/behavioral-envelope/agents/openai.yaml`: Codex metadata, model-invoked

## 4. The feature loop (six new skills)

`wp-loop` ships one work package well, but nothing in upstream or the fork above says how a feature should be shaped around its users, designed from its concerns, proven live, attacked, shipped and learned from. These skills add that, each one calling existing skills rather than replacing them:

| Skill | Invocation | What it adds |
|---|---|---|
| `feature-loop` | user | The order of stages for one feature: baseline, shape, understand, design from concerns, plan, build, prove, attack, ship, learn. Sized small, normal or large |
| `shape` | model | Intent, actors and surfaces, a journey map crossed with interaction cases (twice, two actors, stale, abandoned, slow or failed, hostile, first and empty), success metric, scope line |
| `concern-topics` | model | 13 fixed topics (user journey, concurrency, scale, data integrity, reliability, security, multi-tenancy, AI behavior, latency, cost, operability, compliance, code craft), 176 categories in about 7,000 lines. Each category: how it fails, a real incident where one was verified, how to spot it in a plan and in code, dangerous and safe code, the proof, and what v1 needs. Used at design (journey x topic matrix), just in time while coding, and to attack. `scripts/slop-check.sh` flags mechanical code-craft problems in a diff |
| `evals` | model | Success criteria, error analysis, case sets, code graders, calibrated binary judges, confidence intervals, paired comparisons, pass^k, CI gates, production sampling. 27 primary sources in `references/research.md`. Zero-dependency harness in `scripts/` |
| `live-verify` | model | Runs the real app against recording stand-ins for Slack, Gmail and an Anthropic-compatible model API, with fault injection, two instances on shared storage and evidence files. Nothing reaches a real workspace. Includes the reference product `bench/inbox-assist/` (a Slack agent that drafts Gmail replies) with 40 scenarios |
| `adversarial-review` | model | Runs `code-review`, then design-applied, one attacker per topic, code craft, a second model and blast radius. A finding counts only when reproduced |

### Edits to the other fork skills

| Where | Change |
|---|---|
| `deep-engineering/SKILL.md`, section 3 | After the envelope, calls `concern-topics` and builds the journey x topic matrix and safety arguments; calls `evals` for the eval plan when the change produces model output |
| `wp-loop/SKILL.md`, step 6 | The builder's brief names the topic categories in play and the attack tests are written first |
| `wp-loop/SKILL.md`, new step 6b | slop-check, the eval gate and live verification before the PR |
| `wp-loop/SKILL.md`, step 10 | Normal and Major work runs `adversarial-review` instead of `code-review` alone |
| `feature-loop`, `deep-engineering`, `wp-loop` | `evals` runs only when `detect-packs.sh` selected the `llm` or `retrieval` pack; every other change skips it |
| `adversarial-review`, section 4 | Normal work attacks at most the three topics holding Critical or High Live items; Large work attacks every selected topic |

### Gates

Each stage leaves a file under `.scratch/` in the target repo, and `skills/fork/feature-loop/gates.md` defines nine gates (G1 to G9; G9 is section 9) on those files, checked by phase (`build`, `merge`, `close`; section 5). `skills/fork/feature-loop/scripts/check-gates.sh` decides green or red; the agent's own judgment does not. `test-gates.sh` beside it tests the script and the hook against throwaway git repos built from `scripts/fixtures/gates/`. `skills/fork/feature-loop/bench/gates-demo.sh` runs every gate end to end on the reference product, from its loop files in `bench/inbox-assist/loop/` (shape, envelope, review), and breaks one gate at a time.

The plugin enforces the gates with a hook, which is new in this fork (upstream ships no hooks):

- `hooks/hooks.json` at the plugin root (the default location, loaded automatically, so `plugin.json` is unchanged for it) registers a `PreToolUse` hook with matcher `Bash` that runs `${CLAUDE_PLUGIN_ROOT}/skills/fork/feature-loop/scripts/gate-hook.sh`.
- The hook reads the tool call from stdin and acts only on `git push`, `gh pr create`, and `gh api` POSTs to `.../pulls`. It does nothing unless the repo has `.scratch/gates.json`, which `feature-loop` writes when it sizes the work, so other work is never blocked.
- Red gates block the command (exit 2, with the red gates on stderr for the model). A deliberate bypass is `FEATURE_LOOP_GATES=off` together with a non-empty `FEATURE_LOOP_BYPASS_REASON`, and the hook appends `<date> <slug> gates bypassed: <reason>` to `.scratch/loop-metrics.md`.

An upstream merge cannot conflict with the hook unless upstream adds its own `hooks/hooks.json`. If that happens, keep both sets of hooks in that one file.

### Measured, not assumed

`skills/fork/feature-loop/bench/scorecard-2026-10-08.md` records the first run: 13 planted bugs, blind reviewers with and without the topics, mutant runs of the live suite, and one eval-driven iteration with a paired comparison. The planted-bug material is in `skills/fork/adversarial-review/bench/` (`run-mutants.sh` reruns it; `mutant-results-v3.md` is the run after the journey case IDs were added to the scenarios).

### Sources and licences

The topic files follow the structure of Trail of Bits' `sharp-edges` skill (CC BY-SA 4.0) and copy none of its text. `user-journey.md` uses ideas from gstack's `plan-eng-review` (MIT), credited in its sources. `live-verify`'s proof standards follow pstack's `create-verification-skill`. Every incident and figure in the topics and in `evals/references/research.md` cites a page its author opened; claims that could not be verified are labelled in place.

`live-verify/ci/live-verify.yml` is an example workflow for target repos. It is not installed in this repo; this repo's own CI is `fork-ci.yml`.

## 5. The autonomous loop (fork.5)

**Why:** before fork.5, the loop broke at stage 4. `feature-loop` told the model to "call the Skill tool with" `to-spec`, `to-tickets`, `wp-loop` and `retro`, but all four were user-invoked. `.agents/invocation.md` says no skill can reach a user-invoked skill, so stages 4, 5 and 9 could never run unattended, and nothing tested for it. Found on 2026-10-09 while running HAR-150 on a private project.

**What changed:**

| Change | Where | Rule it enforces |
|---|---|---|
| `to-spec`, `to-tickets`, `retro`, `wp-loop` made model-invoked | frontmatter, `agents/openai.yaml`, READMEs | `feature-loop` stays the single user-invoked entry point; every skill it calls is reachable |
| `feature-loop` rewritten | `skills/fork/feature-loop/SKILL.md` | Matt's main flow (`ask-matt`: understand, `to-spec`, `to-tickets`, build with `tdd` + `code-review`, `retro`) as the spine, with the fork's layer at each step. Adds roles, visibility, the evidence ledger, resume, and one PR per feature: tickets are slices on one integration branch, as Matt's `implement-spec` builds them, each reviewed before it merges. |
| `wp-loop` | `SKILL.md` | used whole for small work, and for steps 12–13 on a feature's PR. A fuzzy term calls `grilling` + `domain-modeling` instead of stopping. `merge_check` for CI that is not GitHub checks. |
| Hooks | `hooks/hooks.json`, `feature-loop/scripts/` | commit gate (`slop-check --staged`); merge gate (green gates + green CI on the exact head + `--match-head-commit`); Stop (no stage left `running`); SessionStart (prints the ledger) |
| Gates G7 (floors) and G8 (ledger) | `check-gates.mjs`, `gates.md` | every escape raises a floor; no stage is done on an assumption |
| Invocation lint | `scripts/check-invocation.mjs` | no skill can call a user-invoked skill again |
| `detect-packs.sh` | `behavioral-envelope/scripts/` | portable awk on Windows Git Bash (its own test suite failed there before) |
| Fork CI | `.github/workflows/fork-ci.yml` (upstream workflows removed: see "GitHub Actions on this fork") | every test suite runs on push and PR |

**Upstream's reason for keeping `retro` user-invoked** is that deciding what deserves a permanent check takes judgement (`docs/engineering/retro.md`). The fork keeps that: `retro` still only proposes, and `feature-loop` stage 9 stops for the user to pick which proposals become checks.

**Principle (from Lauren Tan's pstack talk):** put each rule at the strongest layer that can hold it. Skill text can be skipped, so hooks and CI hold the loop.

## 6. Cross-vendor review gates (in progress, HAR-161)

**Why:** every reviewer in the loop is Claude, so the author and the reviewers share blind spots. HAR-161 adds Codex as an independent, read-only reviewer at two points: the plan (Gate A) and the full diff before the PR (Gate B).

**Decision:** [ADR 0003](./.agents/adr/0003-codex-review-gates-in-feature-loop.md), which also maps each HAR-161 requirement to the ticket that delivers it. No skill or script changes yet: this section grows as each ticket lands.

## 7. Quality and speed together (fork.6)

**Why:** the first full run of the loop (HAR-150, 2026-10-09 and 10, on a private project) built and reviewed every slice carefully, but the product had still not run end to end after about 22 hours. The session log showed where the time went:
- The live run was the last stage, and `wp-loop`'s small path skipped it.
- Review rounds stacked on unrun code: slice review, fix, re-review, then eight attackers.
- An AI feature was sized Large by category, which turned on every stage.
- A full eval suite with judge calibration was gated before a working demo.
- A missing sandbox key surfaced about 9 hours late.
- Up to nine agents ran at once on one laptop, slowing the full suite that ran on every merge.

The reviews were not wasted (they found real defects), but they came in the wrong order.

**Principle:** run the product early and keep it running; scale depth with risk; keep both adversarial reviews (the plan and the code), bounded.

| Change | Where | Rule it enforces |
|---|---|---|
| Size by risk, not by category | `feature-loop` "Size it first" | An AI feature is not Large by itself; Large means an irreversible effect, money, tenancy, auth, a new subsystem, or an AI that acts with no person in between |
| Speed rules | `feature-loop` new section | time box, skeleton first, report the first live run, at most `max_builders` builders, review budget (one design-challenge round, `code-review` per slice, `adversarial-review` once, one fix round, MEDIUM and LOW filed), targeted tests per slice and the full suite once |
| External dependencies first | `feature-loop` stage 0 | every key, sandbox and account the live run needs is checked by name on day one, missing ones requested in one message, each with a named stand-in |
| Walking skeleton | `feature-loop` stages 3 and 4 | ticket 1 is the thinnest end-to-end path with one passing happy-path scenario; nothing else is built until it passes; every slice merges with it still passing |
| Design challenge kept, scoped | `feature-loop` stage 2 | runs for Large and for any size with a Critical Live item; one round; also lists what to cut |
| Attack after the live run | `feature-loop` stage 6, `adversarial-review` | needs G3 green; runs once per feature; at most four reviewers at once and never during a full suite run; one fix round, then the user decides |
| G3 at every size | `check-gates.mjs`, `gates.md`, `wp-loop` step 6b | small work proves its happy path live (no journey coverage); normal and large unchanged; only small may waive it, with `"live": "none: <reason>"` |
| Happy-path mode | `live-verify` | one scenario, one instance, stand-ins for the systems on the path; used for the skeleton, after each slice and for small work |
| Eval tiers | `evals` "Tiers", `gates.json` `"evals"` | `smoke` by default (10 to 20 cases, code graders first, at most one rough judge, gates the current code can evaluate); `full` when asked |
| Time box | `gates.json` `"started"` and `"demo_by"`, `scripts/timebox.mjs`, `check-gates.sh --timebox`, SessionStart summary | once the deadline passes without a passing live run from this loop (newer than `started`), the loop stops starting review, eval or hardening work; a waived live run has no time box |
| Strict run-file fields | `check-gates.mjs` | `started`, `demo_by`, `evals`, `max_builders` and `live` are validated, impossible dates are refused, and an unknown field name is refused; each is exit 2, never a rule silently off |
| One fix round | `wp-loop` step 11 | a fix that fails re-verification goes to the user, not into another round |
| Live rerun after new commits | `wp-loop` step 10, `feature-loop` stage 6 | fix commits and the default-branch merge are followed by a `live-verify` run, because G3 needs a run newer than the last commit |

**Tests:** `test-gates.sh` grows from 264 to 318 cases: G3 at small size (missing, stale, failing, happy path without coverage) and the merge hook refusing small work with no live run, the waiver and its refusals, every new field's validation (impossible dates, leap days, unknown names), the time box (none, running, overdue, met, waived, zones, a run from before the loop, an empty run, closed loop, argument misuse) and the SessionStart line. Five deliberate breakages of the new rules each turned the suite red.

**Reviewed:** a fresh-context reviewer on the strongest model read the first version. Its two HIGH findings (an old run from another feature met the time box; a waived live run was always overdue) and its MEDIUM ones (misspelt fields ignored, impossible dates accepted, a design challenge for small work that has no contract, no live rerun after fix commits) are fixed above, each with a test where it is code.

## 8. Plan first (fork.7)

**Why:** HAR-170 Phase 2. The intended workflow is the user's brief, then `grilling`, then plan mode (files to create or change, and the skill at each stage, approved once), then `feature-loop` following the approved plan. In fork.6 the loop re-asked what the plan had already settled (grilling in stage 1, `shape` and `wp-loop` step 1; seam checks in `to-spec` and `wp-loop` step 4; the `to-tickets` quiz; sizing; the stage 0 dependency request) and ran the design challenge after the plan was already agreed, which needed a second approval. This change was authored after the HAR-170 A/B measurement of fork.6 (pinned to `7bf21dff`) and must not merge before its results are in.

| Change | Where | Rule it enforces |
|---|---|---|
| Planning skill | `skills/fork/plan-first/SKILL.md` (new, model-invoked) | `feature-loop` is user-invoked and not in context while the user grills or plans, so the planning half lives in a skill whose description fires on grilling a plan or entering plan mode: the grilling cap, the template, pack detection, the design challenge and the tracked plan file are all stated there |
| Plan template | `plan-first/plan-template.md` | Twelve required sections plus `Open questions` and `Changes`: decisions, size and why, external dependencies, files to create or change, skeleton ticket, tickets and seams, skill per stage, verification, failure modes, time box, concerns, design challenge |
| Plan location (tracked) | `plan-first` step 2, `feature-loop` "The approved plan", `gates.md` | Target repos set `"plansDirectory": "docs/plans"` in `.claude/settings.json`. The plan is a tracked file (not `.scratch/`, which is untracked and not copied to worktrees), so builders commit the `Changed:` lines with the code and the PR shows the plan diff. Claude Code picks the file name, so the loop uses the newest plan file or the one the user names |
| Start from the plan | `feature-loop` stages 0 to 4, `wp-loop` steps 1 and 4, `shape` section 1 | A stage the plan covers is written from it and recorded as `done, from approved plan` with `inferred: docs/plans/<file>.md#<Section>`; the user is asked only about sections `check-gates.sh --plan` names as missing or empty |
| Ledger check | `check-gates.mjs` G8, `gates.md` | A `done, from approved plan` row must be stage 0, 1 or 3 (baseline, shape, to-tickets); stage 2 (the deeper check), the build and every later stage still run and are refused. Its evidence must be `inferred:` (not `measured:`) and every `docs/plans/<file>.md#<Section>` citation (separated by `;`) must name an existing file and a section with content |
| Plan check | `check-gates.sh --plan [FILE]`, `scripts/plan-check.mjs` | Lists missing or empty sections (blank, comments only, a header-only table, TBD, `?`, `<placeholder>`; a fenced code block counts as content) and `Changed:` lines without `because`; a relative file resolves from the cwd, then the repo root; with no file it takes `docs/plans/<slug>.md` for the slug in `gates.json` when that exists, else the newest plan; needs no `gates.json` |
| Plan-mode design challenge | `plan-first/design-challenge.md`, `feature-loop` stage 2 | The adversarial review of the design runs as a subagent on the draft plan before approval (read-only: Write and Edit denied, and read-only by instruction for shell commands); stage 2 does not run it again; no second approval |
| Concerns while planning | `plan-first` step 2, `detect-packs.sh` | `detect-packs.sh --plan` runs during planning and its packs go under `## Concerns`; `--diff` now excludes `docs/plans/` (like `.scratch/`) so the tracked plan's own words do not select packs |
| Grilling cap | `plan-first` step 1 | 3 rounds or 20 minutes, enforced from this skill because upstream `grilling` is unchanged; then the open questions with recommended defaults for one yes-or-edit answer |
| Deviations written back | `plan-first` "After approval", `feature-loop` stage 4, `plan-check.mjs` | `- Changed: <what> because <why>` appended to the tracked plan file in the same commit as the code; the PR shows the plan diff; a line without a reason is red |

Upstream skill bodies (`to-spec`, `to-tickets`) are not edited. `feature-loop` tells them, when a plan exists, that the seams and the breakdown are already confirmed.

**Do subagents run during plan mode? (checked 2026-10-10)**
- Source: the Claude Code sub-agents page, https://code.claude.com/docs/en/sub-agents. It describes the built-in Plan subagent as "a research agent used during plan mode to gather context before presenting a plan", with read-only tools (Write and Edit denied), and says "when you're in plan mode and Claude needs to understand your codebase, it delegates research to the Plan subagent so that exploration output stays in a separate context window while the main conversation remains read-only".
- Source: the permission modes page, https://code.claude.com/docs/en/permission-modes ("Analyze before you edit with plan mode"). Plan mode lets Claude read files, run shell commands to explore and write a plan without editing source; `Ctrl+G` opens the plan in an editor; approving the plan exits plan mode and starts editing; plan files live in `~/.claude/plans/` or the `plansDirectory` setting.
- Permission inheritance (sub-agents page): a subagent with no `permissionMode` inherits the main conversation's mode, and in `plan` mode a subagent's own `permissionMode` setting applies; that field is ignored for plugin subagents. A subagent's `tools` list restricts it, and the page shows read-only examples (`tools: Read, Grep, Glob`).
- Conclusion: yes, subagents run during plan mode, and the built-in Plan subagent is read-only by definition. The pages do not state in so many words that a subagent of another type launched by the lead during plan mode is allowed; it follows from the inheritance rule but has not been run here. So the design challenge uses the built-in Plan subagent (or any subagent with no Write, Edit or Bash tool), and the practice run (`feature-loop/PRACTICE-RUN.md`) records whether it ran. If a session blocks it, `design-challenge.md` gives the fallback: the same brief in a separate fresh session in plan mode against the plan file, pasted back under `## Design challenge`; never skipped, never run by the context that wrote the plan.

**Tests:** `test-gates.sh` gains cases for the plan: a loop with an approved plan marks those stages done instead of re-running them (G8 green, the SessionStart summary resumes at the first stage the plan did not cover, the Stop hook is not held), G8 red for a plan row that cites a missing section, a missing file, no section or only an assumption, a plan section that is only `TBD`, `--plan` for a complete plan, a missing section, an empty section, `Changed:` lines with and without a reason, the unfilled template (red in all 12 sections), and its usage errors. The review round added: G8 refuses `from approved plan` on stage 2 and on the build, requires `inferred:` and checks every citation; a section holding only a fenced block (with a heading-like line inside) is content; a header-only table is empty; a relative `--plan FILE` resolves from a subdirectory.

**Known gaps (LOW, not fixed):**
- `Changed:` lines are checked for a reason, not for being committed with the code; nothing blocks a code commit that leaves the plan stale.
- The G8 plan check reads sections by exact heading text; a renamed heading counts as missing.
- A section holding only a prose line such as "see above" counts as content; only blank, placeholder or header-only sections are empty.
- The plan-mode design challenge is a subagent that keeps Bash; "read-only" there is Write/Edit denied plus an instruction, checked by the lead with `git status`. Use a `Read, Grep, Glob` subagent when a hard guarantee is needed.
- Whether a subagent runs in plan mode has been read from the docs, not observed; the practice run records it.

**Not done in this change:** the practice run on a toy repo (HAR-170 "Done when"). `feature-loop/PRACTICE-RUN.md` holds the exact steps (the plan is approved by choosing "No, keep planning", pressing Shift+Tab out of plan mode (plan mode cannot write files; this gives no second approval prompt) and starting the loop on it, because the plan-mode approve prompt starts editing outside the loop) and the ledger it must show; it runs in a cloud session after the A/B.
## 9. Stages are enforced, not just files (fork.8)

**Why (evidence):** a cloud pilot ran `/feature-loop` with every skill and the three hooks vendored, a local-markdown tracker, and the instruction to run all nine stages unattended. Sonnet wrote the fix in `src/` in its first minute (through a python heredoc, not the Edit tool), backfilled the shape, envelope, spec and ticket files only when the commit gate blocked it, used a plain `npm test` run as live evidence, merged, and wrote the retro by hand. Gates G1 to G8 were all green and no stage skill (grilling, deep-engineering, design challenge, to-spec, to-tickets, code-review, live-verify, adversarial-review, retro) was invoked. The gates checked that files exist, not that stages ran.

**The rule:** no source change before the planning skills for the size have run (small: `behavioral-envelope`; normal and large: one of `grilling`, `grill-with-docs`, `shape`, then `deep-engineering`, `behavioral-envelope`, `to-spec`, `to-tickets`). Stages are proven by a log that hooks write, not by files the agent writes. A first Opus review of PR #6 found bypasses in the first version; the second version (this one) closes them as listed below.

| Change | Where | What it does |
|---|---|---|
| One signed log | `stage-log.mjs`, `.scratch/.loop/log.jsonl` | One chained HMAC-SHA256 log for every record kind (`init`, `size`, `base`, `skill`, `agent`, `violation`, `cleared`, `close`). Key in `<repo>/.claude/.loop/key` (a directory that ignores itself, so it never shows in git status); log tip and the loop-active marker in `state.json` outside the repo (`$FEATURE_LOOP_STATE_DIR` or `$HOME/.cache/feature-loop/<repo id>/`). A log shorter than its tip, a deleted log, a missing key or marker, a removed, inserted or edited line are red. A missing key after init is a loud error and is never regenerated (C1, M4) |
| Invocation log | `stage-hook.sh`, `stage-hook.mjs`; PostToolUse and PostToolUseFailure `*`, UserPromptExpansion in `hooks/hooks.json` | Skill and Agent calls (failed ones are not logged); a typed `/skill` from UserPromptExpansion. One hook on `*` does logging and detection so they cannot race (matching hooks run in parallel) (L1) |
| Code-before-plan detector | same hook, `stage-detect.mjs` | After every tool call: source changed since the signed start sha (working tree, untracked, committed), so one Bash call that edits and commits is seen (H3) and pre-loop commits are not the loop's (M5). `.claude/settings.json` is allowed (M5) |
| Revert means revert | `stage-detect.mjs` | A violation records the blob hashes of its paths. It is not cleared while a `git stash` entry, a worktree or a branch holding source exists that was made after the loop started, and if the same content reappears after a clear it is reopened (H1) |
| Baseline (N1, N2) | `stage-state.mjs`, `stage-log.mjs` | SessionStart records the session's starting commit outside the repo; the init diffs from it (commits from before the session are allowed, commits made in this session before `gates.json` are a violation). Without a trusted record the baseline is the merge-base with `base`, so deleting every store, or the session record, does not launder code. A baseline that is neither is red. Reviews must be logged at or after the last source commit time less 1 second (L3). Key creation uses O_EXCL and a loser re-reads the key |
| Signed init | `stage-state.mjs` | The init entry holds slug, size, base and its sha, merge-base, session start commit, start sha, plan file and hash, branches, worktrees. The size used is the largest ever recorded (H4); the plan waiver (`done, from approved plan`, the plan's Design challenge section) is honoured only for a plan that existed at init and is unchanged outside `## Changes` (M1); renaming an open loop's slug is red |
| Gate G9 | `stage-gate.mjs`, `gates.md` "G9 stages" | Build: log verifies, base resolved, no open violation, no unexplained source. Merge adds `code-review`, `live-verify` (all sizes), `adversarial-review` (normal, large), `wp-loop` (small), each logged after the last source change (with a 2 second margin, L3); large adds an opus subagent whose description names the design challenge, before `to-spec`, and a design-challenge file written after it (M2). Close adds `retro` |
| Mandatory at push and merge | `gate-hook.sh`, `check-gates.sh --require-stages`, `stage-guard.mjs` | The push, PR and merge hooks make G9 red when no signed init exists (H2), and refuse when the loop was started here but `gates.json` is gone or says closed without a signed `close` entry, which only a passing close phase writes (H5) |

**Vendoring instead of installing the plugin (H2).** The hooks live in `hooks/hooks.json` only; a vendoring script that copies the skills to `.claude/skills/` must also write this block into the repo's `.claude/settings.json`, with `${CLAUDE_PLUGIN_ROOT}` replaced by `$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop` (the feature-loop skill directory, `scripts/` inside). Without it G9 has no log, and the push and merge hooks block with "no signed init entry":

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/gate-hook.sh\"", "timeout": 120 }] }],
    "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/stage-hook.sh\" post-tool", "timeout": 30 }] }],
    "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/stage-hook.sh\" post-tool", "timeout": 30 }] }],
    "UserPromptExpansion": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/stage-hook.sh\" prompt-expansion", "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/stop-hook.sh\"", "timeout": 10 }] }],
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/.claude/skills/feature-loop/scripts/session-start-hook.sh\"", "timeout": 10 }] }]
  }
}
```

The vendored copy also needs `skills/concern-topics/scripts/slop-check.sh` and `plan-first` beside it, as for the other hooks; the `.claude/.loop/` key directory ignores itself, so no `.gitignore` edit is needed.

**Tests:** `test-gates.sh` (Linux and Windows CI): no loop and a closed loop do nothing and create nothing; Skill, Agent, typed `/skill` and failed calls; the key under `.claude/.loop` and the tip outside the repo; a violation and a red build gate for source edited, committed in one call, or found at gate time; revert-then-run and run-then-revert clear it; deleting or truncating the log, deleting `.scratch/.loop`, the key or the state is red and clears nothing; `git stash -u`, a throwaway branch, a worktree and a copy elsewhere (which reopens when it comes back) are not reverts; a downgraded `gates.json` size does not lower the skills; small needs envelope before code and `wp-loop`, `code-review`, `live-verify` at merge; stale reviews, the margin, large's opus subagent (wrong model, wrong description, after `to-spec`, older file); a plan written or edited after init waives nothing, a `Changed:` line does not matter; a hand-written, edited or removed line is rejected; the push and merge hooks block with no signed init, and block a hand-closed or deleted `gates.json`, and accept a loop closed after a passing close phase.

**Do PostToolUse hooks fire for the Skill and Agent tools? (checked 2026-10-10)**
- Source: the Claude Code hooks reference, https://code.claude.com/docs/en/hooks. "`PostToolUse` ... runs immediately after a tool completes successfully", it "matches on tool name, same values as PreToolUse", and to run a hook "after any tool completes successfully, omit the `matcher` or set it to `"*"`". The payload carries `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `tool_use_id`. The page documents the tool `Agent` ("Spawns a subagent": `tool_input` fields `prompt`, `description`, `subagent_type`, optional `model`; for a foreground call `tool_response` carries `agentId`, `status`, `resolvedModel` and run telemetry; a background call returns `status: "async_launched"`). The tools reference, https://code.claude.com/docs/en/tools-reference, lists `Skill` ("Executes a skill within the main conversation") and `Agent` as tools, and the hooks page says "a `PreToolUse` hook matching the `Skill` tool fires only when Claude calls the tool, but typing `/skillname` directly bypasses `PreToolUse`. `UserPromptExpansion` fires on that direct path" (payload `command_name`, `command_args`, `expansion_type`). Failed calls go to `PostToolUseFailure`, which the hook also registers.
- Not documented there: the `tool_input` field names of the `Skill` tool. The hook reads `tool_input.skill`, then `command`, then `name` (the Skill tool's own parameter is `skill`, with optional `args`), and strips a `plugin:` prefix when it compares. `Task` is the older name of `Agent`; the hook accepts both. Not observed on a live run yet: the first cloud practice run should confirm that PostToolUse fires for `Skill` and `Agent` with these fields (if it did not, the log would hold no `skill` lines and G9 would say so, never green).

**Known gaps (said plainly):**
- The HMAC key is a file the agent can read, and so is the state outside the repo. An agent determined to cheat can read both, re-sign its own history (or delete everything and start over) and defeat G9. The HMAC, the tip and the marker stop the cheap routes (editing, appending, deleting or truncating the log, hiding code in a stash or branch), not a deliberate forgery.
- It proves a skill was invoked, not that it was done well: a one-line call to `deep-engineering` followed by code satisfies the rule.
- Skills the model runs without the Skill tool (reading a SKILL.md and following it) are not logged. Anything before `gates.json` exists (grilling, plan mode) is not logged, so a plan-first loop meets the shape and `to-tickets` slots through ledger rows backed by a plan hashed at init, and large work's opus requirement through that plan's Design challenge section.
- The session's start commit is recorded by SessionStart, so a session where that hook did not run, or where an agent deleted both the loop stores and the out-of-repo session records and the state, is judged from the merge-base (strict, not lax); an agent that can write outside the repo can still forge the records themselves. A repo with the plugin not installed and no vendored block never gets a log; the push and merge hooks (if installed) then block, but with no hooks at all nothing runs.
- The detector runs after the tool, so the early write happens; the violation makes the build gate, the push and the merge red until it is cleared. An ignored (`.gitignore`) file is invisible to it. Reopening on identical content means that code written early and, by coincidence, written identically after the stages is reopened; write it differently or add a line.
- A first loop on a machine whose `$HOME` was reset after init reports "state outside the repo is missing" until the loop is restarted in a clean checkout.
- Every item of the second review (C1, H1 to H5, M1, M2, M4, M5, L1, L3) is closed in code; the gaps above are what remains by design.

## 10. The owner workflow, visible end to end (fork.9)

The owner's flow, enforced: **grill → acceptance tests (stop 1) → plan mode → codex plan review → reviewed plan (stop 2) → feature-loop builds, attacks and tests → evidence (stop 3) → PR. The owner merges.**

- **`codex-review` (new skill).** OpenAI `gpt-6-astra` runs through the local codex CLI, a different model family from the builders.
  - Plan mode reviews the plan file read-only against the repo.
  - Code mode attacks HEAD in a throwaway worktree. It writes a repro test for every suspected defect, so a finding is CONFIRMED only when its repro fails.
  - Reports are stamped with the plan hash or HEAD. `CODEX_REVIEW_MODEL` overrides the model.
- **Visibility.** The hooks, not the agent, print one line to the owner per event: every stage change, gate result, codex result, test, CI or live run, push and PR. They also keep `.scratch/timeline.md`.
  - `ESCALATION:` lines report at once: a change to the approved plan, a codex CONFIRMED CRITICAL or HIGH, a gate bypass, a touched evidence file, or a destructive git command.
- **Hand-off.** Leaving plan mode tells Claude not to implement, but to run the codex plan review and show the owner the result. `feature-loop` is model-invoked, so `plan-first` can start it after `approve plan`.
- **Owner approvals.** `approve acceptance`, `approve plan` and `approve pr`, at the start of a line in the owner's prompt, are signed into the stage log by the UserPromptSubmit hook. Nothing the agent writes can approve.
  - The acceptance approval is keyed to the acceptance tests themselves, because it comes before the plan exists.
  - The plan approval is keyed to the plan file, and the PR approval to HEAD.
- **Gates.**
  - G3 and G4 need the evidence to name the commit it ran on; file times no longer count.
  - G9 needs review and live artifacts on HEAD, not just a skill call.
  - **G10:** a codex plan review of a committed version of the approved plan, every CONFIRMED finding resolved, and `approve plan`.
  - **G11:** a codex code attack on HEAD, no CONFIRMED CRITICAL or HIGH unresolved, and a repo test for each fixed one.
  - **G12:** every acceptance test mapped to a passing test or live scenario on HEAD, and `approve acceptance`.
  - **`pr` phase:** G1 to G12 except G7, CI green on the pushed HEAD, and `approve pr` for HEAD.
- **PR last, owner merges.** No PR, draft or not, through gh, REST, GraphQL or the GitHub MCP tools, before the `pr` phase is green. Every merge is refused while a loop is active, with no bypass.
- **The reference app moved** from `skills/fork/live-verify/bench/inbox-assist` to `bench/inbox-assist` at the repo root. It holds solved versions of features the loop was evaluated on, so it must not sit inside the shipped skills.
- **Why:** the HAR-170 audits showed that fork.8's gates could be cleared without doing the work:
  - a `touch` on a live report;
  - a review skill called with no review;
  - the eval gate switched off by editing the envelope.

  The owner also asked for a flow they can see end to end, with a cross-vendor adversary.

## 11. Closing the seams the adversarial review found (1.3.1-fork.9.1)

An Opus adversarial review of fork.9 found places where the flow broke between its own parts, and places where a gate could be walked around with one cheap command. This release fixes what can be fixed on the client, and says plainly what cannot.

**The flow broke here, now fixed:**

- **The report slug (S1).** `codex-review.sh` named its report after the plan file or branch, but G10 and G11 read it by the `slug` of `.scratch/gates.json`. The default slug is now that one when a loop's run file exists, and the hand-off, `plan-first` and `codex-review` all say `--slug <slug>`.
- **The timeline (S2).** `codex-review.sh` appended `- time text` bullets into a table. It now calls `timeline.mjs`, with a correctly formatted row if node or the script is missing.
- **CRLF (S3).** On Windows with autocrlf the working plan has CRLF and the Git blob LF, so the report's hash never matched G10's committed-version check. Every plan hash (`codex-review.sh`, G10 on both sides, the approval's `plan_sha`) is now of the LF form.
- **`approve pr` (S4)** must match the exact HEAD. A later commit of a file that is not source no longer counts.
- **`approve plan` and `approve acceptance` (S5)** name the file and the full sha, and are refused when several candidate files exist unless the prompt names one.
- **`codex-review` (A13)** is run in the foreground, and prints an `ESCALATION:` line for a CONFIRMED CRITICAL or HIGH. A review with no repro files no longer dies on an empty array.

**Holes closed:**

- **Closed loops (A2).** `status: closed` is read from the top level of the parsed JSON, not by grep: a nested `{"notes":{"status":"closed"}}` no longer disables the gates, and a run file that does not parse is an active loop, not a closed one.
- **Pushes (A4).** A push to the base branch has no bypass. `git -C`, `--git-dir`, `--work-tree` and `GIT_DIR=` / `GIT_WORK_TREE=` are followed to the repository they name. The `FEATURE_LOOP_GATES=off` escalation is read from lexed tokens, so `of''f` and the like are caught.
- **GraphQL and REST (A6).** A `gh api graphql` query read from a file or stdin is refused while a loop is active; `enablePullRequestAutoMerge` and `POST .../merges` count as merges.
- **MCP (A7, A8).** The matcher covers every GitHub MCP tool; auto-merge, `update_pull_request_branch` and writes to the base branch (or an unnamed branch) are refused; reads pass. The payload is parsed as JSON, not with sed.
- **CI (A9).** `merge_check` from `gates.json` counts for the `pr` phase only when GitHub reports no CI workflows; otherwise `gh run list` decides.

**Found by live run 1 on a real repository:**

- **Heredocs (critical).** `gh pr create` after a heredoc (`cat > body.md <<'EOF' ... EOF`, then a newline) was not classified, so a PR opened with the pr phase red. The hook's lexer now skips heredoc bodies (`<<`, `<<-`, quoted or bare delimiters) and keeps classifying what follows. And it fails closed: while a loop is active, a command that mentions `pr create`, `pr new`, `pr merge`, `pulls`, `createPullRequest`, `mergePullRequest`, `enablePullRequestAutoMerge` or `/merges` in a way no gh parser looked at is refused as ambiguous, with no bypass.
- **L1 (G9).** `docs/acceptance/` (written at stop 1, before the loop) and tool caches (`.groundtruth/`, `.cache/`, `.pytest_cache/` and the like) are not source for the code-before-plan detector; paths Git ignores never were.
- **L2 (G4).** The `retrieval` pack is no longer selected by `const chunks = []` in ordinary code: it needs retrieval terms (embedding, vector, rag, retrieval, `top_k`, cosine, similarity search, `chunk_size`, a text splitter and the like).
- **L3 (G10).** The approved plan is whatever a signed `approve plan` holds, which must be a committed version of the plan file. G10 is green when the codex review is of a committed version at or before it and the plan differs from it only inside `## Changes`; any other edit says a changed plan needs `approve plan` again. `plan_sha` in `gates.json` is informational.
- **L4 (live-verify).** `"healthz": null` (readiness by a `"ready"` regex or a TCP connect) and no database unless `"db"` is set, so an app with neither no longer needs a custom driver.
- **G12.** The test cell of `.scratch/acceptance.md` is a live scenario name, a tracked test path (optionally `:line`), or `path::test name`, and the docs say exactly that.

**Not fixable here, so documented (A1, A5, A10, A11).** The hooks run as the agent's own OS user, so an agent can run the approval hook itself, route a command through arbitrary indirection, or forge an evidence file. `gates.md`, "Limits: tamper-evident, not tamper-proof", says so, and names the hard guarantee for "the owner merges": GitHub branch protection with a required review, and an agent token without merge rights.

**Housekeeping (C1, C2).** `codex-review` is in `skills/fork/README.md`; the stale `bench/inbox-assist` paths now point at the repo root; the duplicated fork.9 sentence in `hooks/hooks.json` is gone.

## 12. Live-run fixes (1.3.1-fork.9.2, 1.3.1-fork.9.3)

Found by live run 2 on `workflow-toy-todo`:

- **fork.9.2, approvals:** a plain `approve acceptance` was refused in any repo that had shipped a feature, because `docs/acceptance/` still held that feature's file. Candidate files the default branch already holds with the same content are dropped before the ambiguity check (`vis-root.mjs` `unshipped`).
- **fork.9.3, attackers on the wrong code:** the Agent tool's `isolation: "worktree"` cuts the worktree from the default branch, not HEAD. All three topic attackers of adversarial-review ran at `main`, without the feature, and reported no findings. New PreToolUse hook `agent-base-hook.mjs` (matcher `Agent`) refuses an isolated subagent while a loop is active and HEAD is ahead of the default branch, and says to cut the worktree from HEAD. adversarial-review and feature-loop say the same.

## 13. Reviewer-owned issues (the Ghost trial workflow)

**Why:** the reviewer already created one issue per step and merges every PR himself. The loop must never create, edit, comment on or close an issue, never merge, and never put anything in a PR that the issue does not need.

| Change | Where | Rule it enforces |
|---|---|---|
| Plan hands off to `wp-loop` | `plan-first` step 5, `feature-loop/scripts/handoff.mjs` and its test | After `approve plan`, `wp-loop` builds the first existing issue in plan order; `feature-loop` (which runs `to-tickets`) is not called |
| Plan stays local | `plan-first` "The reviewer's rules", step 3 and step 4 | `docs/plans/`, `docs/acceptance/`, `.scratch/`, `.claude/settings.local.json` and an untracked `CLAUDE.md` go in `.git/info/exclude`; the plan is never committed |
| Tickets are the existing issues | `plan-template.md` | One row per existing issue with its stacked branch base; no new tickets |
| No new issues | `wp-loop` steps 3 and 10 | No `to-spec` (it publishes an issue); MEDIUM findings go under `## Follow-ups` in the PR body |
| PR only when all green | `wp-loop` steps 9 to 12 | Review and fixes run before the PR; step 11 runs the repo's own checks, every scenario and acceptance test, and checks the diff holds only the issue's files |
| No merge, issue untouched | `wp-loop` steps 12 and 13, `check-comment.md`; `merge-gate.md` removed | The PR says `Closes #N`; the results comment goes on the PR only; the reviewer merges |
| Reviewer's product rules | `wp-loop` "The reviewer's product rules" and step 11, `plan-first` rules | Eight fixed rules (a person presses the button, no secrets, reference repos read-only, append-only records, text is data, plain copy, show it half done, one blocked message) become plan decisions, contract invariants, tests and a diff scan before the PR |
| Build never pauses | `wp-loop` step 5 and step 13 | The next issue branches from the previous one when its PR is open, and the plan is checked against what was built before it starts |

| Approvals alone are not a loop (fork.9.4) | `feature-loop/scripts/stage-guard.mjs`, `test-gates.sh` A3 | `approve acceptance` and `approve plan` create the signed store, but `wp-loop` never starts a feature loop. A store with no signed `init` entry passes the push and PR guard; a started loop whose `gates.json` is deleted is still refused (H5). Found by the HAR-180 dry run, where every push and PR was refused |
| PR body from the record | `wp-loop` steps 11 and 12 | Check output is saved under `.scratch/checks/<slug>/`; every check the PR body lists is copied from its file, and a check with no file is `not run`. Found when a PR body claimed a review that had not run |
| Adversarial review at every size | `wp-loop` step 9 | `adversarial-review` runs on every issue, Tiny included; a missing shape file is `n/a`, not a stop |
| Results comment and status update right away | `wp-loop` step 13 | Posted with `gh pr comment` and confirmed as soon as the PR opens; the status update is handed over before the next issue starts |
| Live-check helpers outside the evidence folder | `wp-loop` step 7 and step 9 | Helpers go in `.scratch/live-checks/<slug>/`; nothing writes, copies or redirects into `.scratch/live/` or a codex report by hand, so the tamper escalation stays quiet unless something is wrong |
| Nothing extra in a PR from the called skills | `wp-loop` steps 1 and 7 | `domain-modeling` output goes to `.scratch/domain/`, an eval suite to `.scratch/evals/<slug>/suite/`, and the `live-verify` app folder (`live-verify.json`, `scenarios/`) to `.scratch/live-checks/<slug>/`, unless the issue asks for them in the repo. Each would otherwise have added files to the reviewer's PR |
| Screenshot of a visible change | `wp-loop` step 7 | A headless browser screenshot of the running page, checked by opening it, for the status update; a missing browser is said, not skipped |
| Fresh-review fixes (fork.9.5) | `wp-loop`, `plan-first`, `plan-template.md`, `check-comment.md`, `design-challenge.md`, `handoff.mjs` | From an independent review of the whole flow: never run `setup-matt-pocock-skills` in the reviewer's repo; `.claude/settings.local.json` denies `gh pr merge`, `gh pr ready` and every `gh issue` write and `gh label` (the hooks guard only a started feature loop); `<slug>` is the issue's branch name, also passed to codex code mode; `shape` (or an `n/a` shape file) before the contract; builder commits carry `Refs: #N`; worktrees outside the repo and `.claude/worktrees/` excluded; acceptance tests mapped per issue (`ATs` column, `AT<n>:` test names, `.scratch/acceptance.md`); coverage saved or `not measured`; the results comment waits for CI green or a proven baseline failure while the next issue starts; a fix on a lower branch restacks the ones above; `approve plan` names the file; plan review resolutions never cite a commit; the design challenge fallback runs at every size |
| The owner's go before a PR or a post (fork.9.6) | `wp-loop` "The reviewer's rules", steps 12 and 13; `plan-first` settings | The loop pushes the branch, then stops and shows the PR, its body and the draft status update; `gh pr create` runs only after the owner's `approve pr` for that head, and a status update goes out only after `post it`. `.claude/settings.local.json` puts `gh pr create`, `gh pr comment`, `gh pr edit` and `gh pr review` on `ask`, so Claude Code prompts too. The build goes on while it waits |
| Countdown and the channel rule (fork.9.6) | `wp-loop` "The reviewer's rules" and product rule 7, step 12 | A per-issue countdown of the 8 gates before the PR, each ticked only from its proof file, shown on request, with every Slack draft and with the `approve pr` ask. Slack drafts only at milestones (first visible, PR ready, a checkpoint the reviewer named, blocked), which is how the reviewer's "every time something is visible, even half done" is read; grilling and planning get none; each waits for `post it` |
| Codex capacity (fork.9.12) | `plan-first` rules, `plan-template.md` Time box, `wp-loop` step 9 and the owner's-go rule | Codex is checked before the grill, the plan states a codex budget with the risky issues in priority order, re-runs happen only for fixes behind CONFIRMED CRITICAL or HIGH codex findings and are scoped to the fix commits, and a usage limit stops to ask while the next issue keeps building. Also: pushing a branch needs no go, the next issue starts while a go is pending (in its own worktree, with its `adversarial-review` and `pr` calls held until the pending `approve pr`, so `wp-pr-guard.mjs` signs the right HEAD and counts the right calls), and no posts before the build starts. Found by dry run 2 (HAR-181) |
| Every flow end to end, any system (fork.9.15) | `wp-loop` step 7, the countdown, step 13; `live-verify` modes table | At every size, each flow the change touches is driven from its real entry point to its final effects with happy path, refusal and failure-path scenarios, asserting outcomes, not screens. Any process type (web, API, worker, CLI). Any external system gets a stand-in to `live-verify`'s standard, not only Slack, Gmail and an LLM. Screenshots are optional, for the owner's post only |
| Dry run 3 fixes (fork.9.16) | `owner-guard.mjs` (from `gate-hook.sh`), `agent-base-hook.mjs` (Agent and EnterWorktree), `wp-pr-guard.mjs`, `sandbox.sh`; `wp-loop` roles, countdown, steps 6, 9 and 12; `adversarial-review` | In the owner's workflow: a made-up commit author is refused (ask the owner for a git identity); a worktree inside the repo folder and `EnterWorktree` are refused; a mutation run is refused in any working copy that holds work and runs through `sandbox.sh` (detached copy outside the repo, removed after); a background subagent is refused; the PR question needs `tdd` and `code-review` for the branch as well as `adversarial-review` and `pr`, no uncommitted edit to a tracked file, the countdown file, and the newest Slack draft for the branch carrying `7 of 8 done`, which the question names |
| Restack after a merge | `wp-loop` "The reviewer's rules" | When the reviewer merges a PR, the next branch is rebased onto the default branch with `--onto` (safe after squash merges), rechecked, pushed with `--force-with-lease` and retargeted |
| Baseline once per stack | `wp-loop` step 11 | When the default branch is already red, its failures are recorded once in `.scratch/baseline.md` and each issue shows the set is unchanged |

`feature-loop` is not part of this workflow; its stage 7 text still names `wp-loop` steps 12 and 13.

## Install

The plugin name is the same as upstream's, so uninstall Anthropic's listing first, or both copies will fight over the same name.

### Anyone

```bash
claude plugin uninstall mattpocock-skills@claude-plugins-official   # only if installed
claude plugin marketplace add harneet2512/skills
claude plugin install mattpocock-skills@mattpocock-fork
```

You get new fork releases when the `version` in `.claude-plugin/plugin.json` changes. Turn on auto-update for `mattpocock-fork` under `/plugin` → Marketplaces (it is off by default for marketplaces outside Anthropic's).

### The maintainer (edit live)

Add the local clone as the marketplace instead. Claude Code then loads the skills straight from the clone, so an edit takes effect on `/reload-plugins` with no version bump:

```bash
claude plugin marketplace add /path/to/your/clone
claude plugin install mattpocock-skills@mattpocock-fork
```

## Pull in Matt's latest

```bash
git fetch upstream
git merge upstream/main
```

Expect a conflict on the `version` line of `package.json` and `.claude-plugin/plugin.json` whenever Matt releases, and on the frontmatter of `to-spec`, `to-tickets` and `retro` (and their `agents/openai.yaml`) whenever Matt edits those lines: keep the fork's model-invoked frontmatter and take Matt's body. Resolve it as `<upstream version>-fork.1`. Then:

1. Check that every path in `plugin.json`'s `skills` still exists (upstream sometimes removes or moves skills).
2. Check that `wp-loop`, `deep-engineering` and `behavioral-envelope` still name skills upstream ships. If upstream renamed or removed one, update the fork skill and record it here.
3. Run `claude plugin validate .` (upstream's own `CLAUDE.md` makes `--strict` fail on upstream too) and `node scripts/sync-plugin-version.mjs --check`.
4. Update the **Upstream base** line at the top of this file.
5. Run `node scripts/check-invocation.mjs`: an upstream change can make a skill the loop calls user-invoked again.
6. Commit and push. Keep `release.yml`, `needs-info.yml` and `triage-label.yml` out (see "GitHub Actions on this fork").

## Ship a change to the fork

1. Edit under `skills/fork/` and test with `/reload-plugins`.
2. Bump the suffix (`-fork.1` to `-fork.2`) in `package.json`, then run `node scripts/sync-plugin-version.mjs`.
3. Record the change in this file.
4. Commit and push. Users with auto-update on get it on their next session.

To change how an upstream skill behaves, do not edit it in place: every later upstream change to that file would then conflict. Write a fork skill that calls it through the Skill tool, the way `wp-loop` wraps `tdd`, `pr` and `code-review`. If an in-place edit is unavoidable, add a row to the table at the top with the original text.

## Notes for anyone coming from upstream 1.2.x

- `CONTEXT.md` and `CONTEXT-MAP.md` are now `GLOSSARY.md` and `GLOSSARY-MAP.md`. The skills only look for the new names, so run `git mv CONTEXT.md GLOSSARY.md` in existing repos and update the `## Agent skills` block in `CLAUDE.md` and `docs/agents/domain.md`.
- `pr`, `retro` and `implement-spec` graduated from `in-progress/` to `engineering/` and now ship in the plugin.
- `resolving-merge-conflicts` was removed upstream.
