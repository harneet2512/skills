# About this fork

This repo is a fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). It ships every upstream skill unchanged and adds nine skills on top. This file records every difference from upstream: what the original was, what was added, and why.

- **Upstream base:** [`f3fc563`](https://github.com/mattpocock/skills/commit/f3fc5632f401156837ee3872f14fe33ccf1024ea), 2026-10-07, upstream version `1.3.1`
- **Fork version:** `1.3.1-fork.4`
- **Plugin name:** `mattpocock-skills` (unchanged, so every `mattpocock-skills:<skill>` reference keeps working)
- **Marketplace name:** `mattpocock-fork`

## What differs from upstream

| Path | Upstream | This fork |
|---|---|---|
| `skills/fork/wp-loop/` | does not exist | new user-invoked skill |
| `skills/fork/deep-engineering/` | does not exist | new model-invoked skill |
| `skills/fork/behavioral-envelope/` | does not exist | new model-invoked skill |
| `skills/fork/feature-loop/` | does not exist | new user-invoked skill |
| `skills/fork/shape/`, `concern-topics/`, `evals/`, `live-verify/`, `adversarial-review/` | do not exist | new model-invoked skills |
| `skills/fork/README.md` | does not exist | bucket README for the fork skills |
| `hooks/hooks.json` | does not exist (upstream ships no hooks) | plugin hook: a `PreToolUse` hook on `Bash` that runs the feature-loop gates before `git push` and PR creation; see section 4, "Gates" |
| `.claude-plugin/plugin.json` | `version` `1.3.1`; `repository` upstream; 27 skills | `version` `1.3.1-fork.4`; `repository` this fork; the nine fork skills added at the top of `skills`; one sentence added to `description` |
| `package.json` | `version` `1.3.1` | `version` `1.3.1-fork.4` (keeps `scripts/sync-plugin-version.mjs --check` passing) |
| `.claude-plugin/marketplace.json` | `name` `mattpocock`, owner Matt Pocock | `name` `mattpocock-fork`, owner `harneet2512`, description says it is a fork |
| `README.md` | upstream | one fork notice under the title |
| `CLAUDE.md` | upstream | `## Fork` section at the end |
| GitHub Actions (repo setting, not a file) | enabled | **disabled** on this fork; see below |
| `FORK.md` | does not exist | this file |

Every other file, including every upstream `SKILL.md`, is identical to upstream.

### GitHub Actions is off on this fork

Upstream's `.github/workflows/release.yml` runs on every push to `main`. On this fork it would run `changeset version` over upstream's pending changesets, which turns `1.3.1-fork.1` back into a plain upstream version and deletes the changesets, and then fail to open its release PR. So Actions is disabled in the repo settings:

```bash
gh api -X PUT repos/<owner>/skills/actions/permissions -F enabled=false
```

If you fork this fork, do the same before your first push.

## 1. `wp-loop` (new, user-invoked)

Type `/mattpocock-skills:wp-loop <issue>` to take one work package (one issue, one branch, one PR) from issue to merged.

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
- `skills/fork/wp-loop/merge-gate.md`: the merge gate and the degraded-CI procedure
- `skills/fork/wp-loop/check-comment.md`: the results comment template
- `skills/fork/wp-loop/review-checks.md`: extra checks for the reviewer
- `skills/fork/wp-loop/agents/openai.yaml`: Codex metadata, user-invoked

`wp-loop` calls only model-invoked skills through the Skill tool (`deep-engineering`, `tdd`, `pr`, `code-review`, `diagnosing-bugs`). It tells the user to run the user-invoked ones (`/setup-matt-pocock-skills`, `/to-spec`, `/grill-with-docs`), following [`.agents/invocation.md`](./.agents/invocation.md). The issue tracker is whatever `setup-matt-pocock-skills` configured (GitHub by default). The `gh` commands target GitHub.

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

Each stage leaves a file under `.scratch/` in the target repo, and `skills/fork/feature-loop/gates.md` defines seven gates (G1 to G7) on those files. `skills/fork/feature-loop/scripts/check-gates.sh` decides green or red; the agent's own judgment does not. `test-gates.sh` beside it tests the script and the hook against throwaway git repos built from `scripts/fixtures/gates/`. `skills/fork/feature-loop/bench/gates-demo.sh` runs every gate end to end on the reference product, from its loop files in `skills/fork/live-verify/bench/inbox-assist/loop/` (shape, envelope, review), and breaks one gate at a time.

The plugin enforces the gates with a hook, which is new in this fork (upstream ships no hooks):

- `hooks/hooks.json` at the plugin root (the default location, loaded automatically, so `plugin.json` is unchanged for it) registers a `PreToolUse` hook with matcher `Bash` that runs `${CLAUDE_PLUGIN_ROOT}/skills/fork/feature-loop/scripts/gate-hook.sh`.
- The hook reads the tool call from stdin and acts only on `git push`, `gh pr create`, and `gh api` POSTs to `.../pulls`. It does nothing unless the repo has `.scratch/gates.json`, which `feature-loop` writes when it sizes the work, so other work is never blocked.
- Red gates block the command (exit 2, with the red gates on stderr for the model). A deliberate bypass is `FEATURE_LOOP_GATES=off` together with a non-empty `FEATURE_LOOP_BYPASS_REASON`, and the hook appends `<date> <slug> gates bypassed: <reason>` to `.scratch/loop-metrics.md`.

An upstream merge cannot conflict with the hook unless upstream adds its own `hooks/hooks.json`. If that happens, keep both sets of hooks in that one file.

### Measured, not assumed

`skills/fork/feature-loop/bench/scorecard-2026-10-08.md` records the first run: 13 planted bugs, blind reviewers with and without the topics, mutant runs of the live suite, and one eval-driven iteration with a paired comparison. The planted-bug material is in `skills/fork/adversarial-review/bench/` (`run-mutants.sh` reruns it; `mutant-results-v3.md` is the run after the journey case IDs were added to the scenarios).

### Sources and licences

The topic files follow the structure of Trail of Bits' `sharp-edges` skill (CC BY-SA 4.0) and copy none of its text. `user-journey.md` uses ideas from gstack's `plan-eng-review` (MIT), credited in its sources. `live-verify`'s proof standards follow pstack's `create-verification-skill`. Every incident and figure in the topics and in `evals/references/research.md` cites a page its author opened; claims that could not be verified are labelled in place.

`live-verify/ci/live-verify.yml` is an example workflow for target repos. It is not installed in this repo, where Actions stays off.

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

Expect a conflict on the `version` line of `package.json` and `.claude-plugin/plugin.json` whenever Matt releases. Resolve it as `<upstream version>-fork.1`. Then:

1. Check that every path in `plugin.json`'s `skills` still exists (upstream sometimes removes or moves skills).
2. Check that `wp-loop`, `deep-engineering` and `behavioral-envelope` still name skills upstream ships. If upstream renamed or removed one, update the fork skill and record it here.
3. Run `claude plugin validate .` (upstream's own `CLAUDE.md` makes `--strict` fail on upstream too) and `node scripts/sync-plugin-version.mjs --check`.
4. Update the **Upstream base** line at the top of this file.
5. Commit and push. Leave Actions disabled.

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
