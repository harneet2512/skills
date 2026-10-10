---
name: feature-loop
description: "Take one feature from request to merged and shipped, end to end, optimized for quality and speed together: Matt's main flow (understand, spec, tracer-bullet tickets, TDD build, review, retro) with this fork's upgrades at every step: journey shape, engineering contract, behavioral envelope, concern topics, evals, a walking skeleton proven live first, adversarial plan and code review, an optional time box, gates enforced by hooks, and one PR per feature."
disable-model-invocation: true
---

Take one feature from request to shipped, without stopping except for decisions only the user can make.

**Quality and speed together.** The product runs live early (a walking skeleton before the rest of the build), every later change is checked against that live run, and the depth of each stage scales with risk, not with the size of the feature's name. Review finds what the live run cannot; it never replaces it.

**The flow:**
- **The spine is Matt's main flow:** understand, `to-spec`, `to-tickets`, build each ticket with `tdd` and `code-review`, then `retro`.
- **This fork adds a layer at every step:** the journey shape, the engineering contract, the behavioral envelope, the concern topics, evals, live verification, adversarial review, the evidence ledger, and gates.

**How done is decided:**
- Each stage calls existing skills, reads the previous stage's files, and leaves evidence.
- A **gate** is a check on a stage's file, green or red, decided by `scripts/check-gates.sh`. Gate IDs, paths and formats are in [gates.md](gates.md), and each **Done when** below names the same condition.
- The plugin's hooks enforce the gates whether or not this text is followed (see Enforcement).

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## The approved plan (plan-first workflow)

The intended path is: the user's brief, then `grilling` (shared understanding, capped), then **plan mode** (files to create or change, and which skill runs at each stage, challenged and approved once), then this loop follows the approved plan. Nothing the plan settled is asked again.

**The planning half is the `plan-first` skill** ([plan-first](../plan-first/SKILL.md), model-invoked, so it is in context while the user grills and plans; this skill is user-invoked and is not). It holds the grilling cap (3 rounds or 20 minutes), the plan template, pack detection with `detect-packs.sh --plan`, the read-only design challenge before approval, and the rule that the plan is a **tracked file** (`"plansDirectory": "docs/plans"` in the target repo's `.claude/settings.json`), so builders and the PR see it. Claude Code chooses the file name, so the loop uses the newest file in `docs/plans/`, or the one the user names. Starting this loop on the plan is the approval: the plan-mode approve prompt starts editing outside the loop, so the user chooses "No, keep planning" there and runs `/mattpocock-skills:feature-loop`.

**When an approved plan exists** (`docs/plans/<file>.md`), start from it:
1. Run `scripts/check-gates.sh --plan`. For each section it names as missing or empty, ask the user about that section only, say which one, and write the answer into the plan. Never re-ask a section that is filled. Commit the plan file on the integration branch before any builder starts.
2. Write the files of the stages the plan covers: **stage 0 (baseline), stage 1 (shape) and stage 3 (to-tickets)** only. Record each in the ledger with the status `done, from approved plan` and the evidence `inferred: docs/plans/<file>.md#<Section>` (several citations are separated by `;`). Gate G8 checks that the stage is one of those three, that every cited file and section exist and have content, and that the evidence says `inferred:`. Write `gates.json` from Size and why and Time box.
3. These stops do **not** run again: `grilling` in stage 1, in `shape` and in `wp-loop` step 1; the seam checks in `to-spec` and `wp-loop` step 4 (tell `to-spec` the seams are confirmed in the plan); the `to-tickets` quiz (it stops only when the tickets it cuts differ from the plan's, and then only to ask about the difference); re-sizing; and the stage 0 request for dependencies (the plan's list is the request, already answered or open).
4. These still run, starting from the plan's facts, and are never marked from the plan: stage 2 (`deep-engineering`'s deeper check against the code, and the envelope written from the plan's Concerns and Failure modes), the walking skeleton, the tests, the live run and the reviews (stages 4 to 9). The plan lowers the number of questions, never the number of checks.
5. **Deviations are written back.** When the build finds reality differs from the plan (a file shaped differently, a seam that does not exist), append `- Changed: <what> because <why>` under `## Changes` in the plan file, in the same commit as the code, whoever writes it (lead or builder). The PR shows the plan file's diff. Code and plan never silently diverge. `check-gates.sh --plan` refuses a `Changed:` line without a reason.

Without an approved plan, the loop runs as the stages below describe.

## Size it first

Size by **risk**: what breaks, for whom, and whether it can be undone. The kind of feature does not decide the size; an AI feature is sized like any other.

| Size | When | Stages |
|---|---|---|
| **Small** | One component, no new state, no new integration, nothing irreversible, and no Critical item in the envelope (copy, a color, a validation rule) | 2 (envelope only), then the single-issue path: call the Skill tool with `wp-loop` (which runs the live happy path); then 9 |
| **Normal** | A user-visible behavior with state, an API, a job or an integration; an AI feature whose output a person sees before anything acts on it | All stages |
| **Large** | An irreversible external effect (sending, paying, deleting), money, tenancy, auth or identity, a new subsystem, or an AI feature that acts with no person in between | All stages, plus the design challenge in stage 2 |

Say the size and why in one line (when an approved plan has a Size and why section, use it and do not re-size), and write `.scratch/gates.json` as gates.md specifies: `{ "slug": "<slug>", "size": "<size>", "base": "<branch>", "started": "<now>" }`. `started` (an ISO time with a zone) marks when this loop began, so a live run left over from an earlier feature never counts for this one.
- Add `"demo_by"` whenever the user names a deadline, a demo or a time-boxed trial; ask for it in one line when the work is clearly time-boxed and no time was given. Write it with the UTC offset in force on the deadline's own date (daylight saving may differ from today's), or in UTC with `Z`.
- Add `"evals": "full"` only when the user asks for a full eval suite; the default is `smoke` (see `evals`, "Tiers").
- Add `"max_builders"` when the machine or the user's rate limits call for fewer or more than 3.
- Add `"merge_check"` when CI does not run as GitHub checks on the PR.

When evidence says the work is bigger, escalate: rewrite `size` and run the stages it adds.

**Done when:** `.scratch/gates.json` holds `slug`, `size` (`small`, `normal` or `large`), `base`, `started`, and `demo_by` when the work is time-boxed.

## Roles

- **Lead** (this session). Owns the contract, the specs and the builder briefs. Calls every review skill, decides every gate, verifies every fix personally, and merges.
- **Builders.** Subagents on a cheaper model (Claude Code: `model: "sonnet"`) that write code at confirmed seams only.
- **Reviewers and the design challenge.** Subagents on the strongest model (Claude Code: `model: "opus"`), each with a fresh context, never the builder that wrote the code.

Set the model explicitly on every subagent call.

## Speed rules

These hold at every stage. They exist because a loop that reviews and re-reviews a product nobody has run is slow and still ships surprises.

- **Time box.** With `demo_by` set, run `<this skill>/scripts/check-gates.sh --timebox` before each stage. When it exits 1 (overdue with no passing live run), start no review, eval or hardening work: get the happy path passing in `live-verify`, or set the stage to `blocked: <what stops the live run>` and tell the user.
- **Walking skeleton first.** The first ticket is the thinnest path through the whole journey, real at every layer it touches, with one passing `live-verify` happy-path scenario (stage 4). Every later slice merges only with that scenario still passing.
- **Report the first live run.** When the skeleton passes live, tell the user in a few lines with the evidence (the run's `report.md`; a screen recording when there is a UI), before building further.
- **Builders.** At most `max_builders` (default 3) at once, each in its own worktree with no file overlap. A builder commits and pushes at least every 30 minutes. A process is stopped by the PID that started it, never by image name (`taskkill /IM`, `pkill node`), which kills other people's work.
- **Review budget.**
  - The design challenge (stage 2) is one round.
  - Each slice gets `code-review` only, one slice review at a time (its two axes run together), so builders plus reviewers stay near `max_builders` + 2 agents. `adversarial-review` runs once per feature, in stage 6, after the live run passes.
  - One fix round per review: CRITICAL and HIGH are fixed and re-verified once; MEDIUM and LOW are filed as follow-up issues and do not block.
  - A second BLOCK on the same slice, or a fix that fails its re-verification, becomes `blocked: <the finding>` for the user. It does not start another loop.
- **Checks.** A slice runs its targeted tests (the packages it touched and their direct dependents). The full suite runs once on the integration head before the PR leaves draft and again at the merge gate, never while reviewers or attackers are running tests on the same machine. A suite that is slow because it is forced serial (`-p 1`, `--runInBand`, a single worker) is a finding to fix, not a cost to accept.

## Visibility and the evidence ledger

The user always knows what runs next, and every claim of done carries its evidence.

**At every stage:**
- **Before it runs,** say in one line: `Stage <n> <name>: running <skill>; reads <files>, writes <file>, done when <gate or condition>`.
- **After it runs,** say in one line what it produced, the gate result (green, or red with the reason) and the evidence.

**The ledger, `.scratch/loop-status.md`, is updated before and after every stage.** It is one table with this header, one row per stage:

```markdown
| Stage | Skill | Status | Gate | Evidence | Output | Finished |
```

- **Status** is one of: `pending`, `running`, `done`, `blocked: <decision needed>`, `skipped: <reason>`.
- **Evidence** starts with one of:
  - `measured:` (a test run, a CI run id, a timing, a gate output);
  - `inferred:` (a reading of code or docs);
  - `assumed:`.
- A stage is never `done` on `assumed:` evidence alone (gate G8).

**When a stage needs a decision only the user can make,** set it to `blocked: <decision>`, say which decision and why, and wait. Those decisions are:
- a requirement that is a guess;
- the ticket breakdown and the seams (one stop, in stage 3);
- a CRITICAL or HIGH finding that needs a product call;
- anything irreversible the gates do not already cover.

Every other step runs without stopping. The Stop hook refuses to end a turn while a stage is `running`.

**Done when:** every stage run so far has its before and after lines in the conversation and a ledger row with labelled evidence (gate G8).

## Resume

When `.scratch/gates.json` already exists for this slug, the SessionStart hook prints the ledger. Do not start over:

1. Read `.scratch/loop-status.md`.
2. Run `scripts/check-gates.sh`.
3. Continue from the first stage whose **Done when** does not hold.
4. Say in one line where the loop resumes and why.

**Done when:** the resume point is announced, and every earlier stage is `done` or `skipped: <reason>` in the ledger.

## One feature, one PR

The build follows Matt's `implement-spec`: the whole feature lands on one integration branch with one PR.

- **Tickets are units of work, not PRs.** `to-tickets` cuts them as tracer-bullet vertical slices and publishes them as sub-issues of the feature's issue. The PR closes them.
- **Each ticket is reviewed before it merges into the integration branch,** so the final PR is never reviewed for the first time as a whole.
- **Fix rounds are commits on the same branch and PR,** never a new PR.
- **A shared-contract change (API schema, DB schema, wire format) is the first ticket on the same branch.** It gets its own PR only when other features already in flight need it before this feature merges.
- **Small work** goes through `wp-loop`'s single-issue path: one issue, one branch, one PR.

## Stages

0. **Baseline.**
   - Once per product: read the tenancy model, auth, deploy path, observability and flags. Note each missing enterprise need (tenant scoping, audit log, SSO hook, staged rollout). The first feature that depends on one builds it as a foundation ticket.
   - Every feature (with an approved plan, its External dependencies section is this list and this request already happened; check only that each present item is still present): list each external dependency the live run needs (API keys, sandbox accounts, test workspaces, inboxes, model providers) and check that each is present, by name only, never by printing a secret. Ask the user for every missing one in a single message, now. For each, name the local stand-in the live run uses until it arrives (a `live-verify` stand-in, a local inbox, a local model endpoint), so a missing key never blocks the skeleton.

   **Done when:** each of the five is located or marked missing, each missing one this feature depends on is a ticket, and every external dependency is present or has a named stand-in and an open request to the user.

1. **Understand** (Matt: `grill-with-docs`; fork: `shape`).
   - With an approved plan, its Decisions section is the settled understanding: do not grill again; ask only about a requirement the plan leaves a guess. Otherwise, when any requirement is a guess, call the Skill tool twice, for `grilling` and `domain-modeling`, so the answers land in the glossary and ADRs.
   - When a question needs running code to settle (state, business logic, a UI you have to see), call the Skill tool with `prototype` and fold its answer in.
   - Then call the Skill tool with `shape` (with an approved plan, write the shape file from the plan's Decisions, Skeleton ticket and Tickets and seams; the stage is `done, from approved plan` once the shape file passes G1).
   - Keep stages 1 to 3 in one context window (Matt's context hygiene). Compact only at a stage boundary.

   **Done when:** `.scratch/shape/<slug>.md` has intent, actors and surfaces, the journey map, the success metric, the scope line, and at least one journey case ID `J<n>.<case>` (gate G1).

2. **Design** (fork). **Requires:** the shape file.
   - Call the Skill tool with `deep-engineering`. It builds the system model from repo evidence and calls `behavioral-envelope` (gate G2), `concern-topics` (journey × topic matrix and safety arguments) and, when the envelope's `**Packs:**` line names `llm` or `retrieval`, `evals` (the eval plan, before any prompt exists). It ends with the engineering contract.
   - **Design challenge (adversarial plan review).** With an approved plan this already ran in plan mode ([design-challenge.md](../plan-first/design-challenge.md)) and its findings are in the plan's Design challenge section: do not run it again; fold the plan's resolutions into the contract. Otherwise, for Large work, and for Normal work whose envelope has a Critical Live item (Small work with a Critical item is not Small: escalate it to Normal, so it gets a contract to challenge): before the spec, one reviewer subagent on the strongest model, with a fresh context, attacks the contract. Its brief: break the design against the code, report CONFIRMED and PLAUSIBLE findings with evidence, and list what to cut to reach a working live demo sooner without losing a Critical item. One round: fold every CONFIRMED finding into the contract with its resolution, say which ones changed the design, and take the cuts the user would accept (ask in one line when unsure).

   **Done when:**
   - the contract gives every Live item a mechanism, an enforcement point and a proof, plus the build order;
   - every matrix cell holds a mechanism ID or `none: <reason>`;
   - when evals apply, `.scratch/evals/<slug>.md` has criteria, cases, graders and a gate;
   - for Large, the challenge's findings are resolved in the contract;
   - the contract has no BLOCKING open question.

3. **Plan** (Matt: `to-spec`, `to-tickets`). **Requires:** the contract.
   - Call the Skill tool with `to-spec`, with the contract as input. Then call the Skill tool with `to-tickets`.
   - Tickets are tracer-bullet vertical slices with blocking edges. **Ticket 1 is the walking skeleton**: the thinnest path through the whole journey from the shape file, real at every layer it touches, ending in one `live-verify` happy-path scenario. The prefactor and the shared-contract change come before it only when the skeleton cannot run without them. Each ticket names its journey cases, Live items, topic categories and seams (from the contract's Verification required).
   - `to-tickets`' quiz is the one planned stop: the user approves the breakdown and confirms the seams in the same step. Then the tickets are published as sub-issues of the feature's issue. With an approved plan, the plan's Tickets and seams section already holds that approval: publish the tickets without the quiz, and stop only when the tickets differ from the plan, asking only about the difference.

   **Done when:** the tickets are published, every Critical item's mechanism is in a ticket before any slice that relies on it, and the seams are confirmed.

4. **Build** (Matt: `implement-spec`, `tdd`, `code-review`; fork: attack tests, topic patterns, slice review). **Requires:** the published tickets.
   - When reality differs from the approved plan, write a `Changed:` line in the plan file (see "The approved plan"), in the same commit as the code.
   - Create the integration branch from the latest default branch: `<issue>-<slug>`, or the repo's own branch convention. Open a draft PR after the first slice merges.
   - **The skeleton first.** Build ticket 1 alone, run its happy-path scenario with `live-verify`, and report it to the user (Speed rules). Nothing else is built until it passes, or until it is `blocked:` on something only the user can give.
   - Then for each ticket on the frontier, in parallel where blocking edges allow, up to `max_builders` at once:
     1. **Implement.** A builder subagent in its own worktree off the integration branch calls the Skill tool with `tdd` at the ticket's confirmed seams. It writes each attack test (duplicate delivery, concurrent writer, timeout after success) before the code it attacks. It reads its topic categories' *Build it right* before writing matching code, commits and pushes as it goes, and merges the integration branch tip into its own branch before reporting done.
     2. **Review the slice.** The lead calls the Skill tool with `code-review` on the slice's diff against the integration branch, with the ticket, the contract and the envelope's Live items as the spec. Both axes go to reviewer subagents on the strongest model, with severities assigned within each axis.
     3. **Fix.** CRITICAL and HIGH findings go back to the builder. The lead re-runs each one's targeted test and reads the changed lines. Each MEDIUM is fixed or filed as a follow-up issue.
     4. **Merge** the slice into the integration branch, rerun its targeted tests and the skeleton's happy-path scenario on the integration head, and push. The commit hook runs `slop-check` on every commit.

   - When every ticket is merged, remove the builder worktrees.

   **Done when:** the skeleton's happy-path scenario passed before any other ticket started, every ticket is merged into the integration branch with its slice review resolved, each attack test went red before its code landed, the happy-path scenario still passes on the integration head, the full suite is green on the integration branch, and no builder worktree is left.

5. **Prove** (fork). On the integration branch head:
   - CI is green;
   - `concern-topics/scripts/slop-check.sh --diff <base>` is clean, or its findings are justified (gate G6);
   - when evals apply, call the Skill tool with `evals` at the tier `gates.json` names (`smoke` unless it says `full`) and run the plan's gate (gate G4);
   - call the Skill tool with `live-verify` for every journey case and every Live item with a live proof, with two instances and faults injected (gate G3).

   **Done when:** G3, G4 (when evals apply) and G6 are green, and CI is green on the head.

6. **Attack** (fork). **Requires:** gate G3 green (`check-gates.sh G3`). A product that has not passed its live run is not attacked yet: its first failures are cheaper to find by running it. Call the Skill tool with `adversarial-review` over the whole integration branch, once. Its fixes are new commits, so rerun `live-verify` on the new head before stage 7: G3 needs a run newer than the last commit. Each CONFIRMED finding is fixed as a commit on the same PR, with its reproduction kept, and recorded as an escape from stage 2 or 4.
   **Done when:** `.scratch/review/<slug>.md` has no CONFIRMED CRITICAL or HIGH row with resolution `open` or empty (gate G5).

7. **Merge gate** (fork: `wp-loop`).
   1. Call the Skill tool with `pr` for the body, and mark the PR ready.
   2. Call the Skill tool with `wp-loop` and run only its steps 12 (merge gate) and 13 (report), on this feature's PR and issue:
      - bring the branch up to date;
      - renumber migrations and ADRs at merge time;
      - run `scripts/check-gates.sh` until it exits 0;
      - wait for CI on the exact head (or `merge_check` from `gates.json`);
      - merge with `--match-head-commit <sha>`;
      - post the results comment on the PR and the feature's issue.
   3. Close the tickets the way the tracker closes work.

   The merge hook refuses a merge without green gates, green CI on that exact head, and `--match-head-commit`.

   **Done when:** the PR is merged at the head that was checked, and the results comment is on the PR and the issue.

8. **Ship.**
   - Behind a flag or kill switch.
   - Migrations in expand, then contract order.
   - The envelope's runtime signals are wired to alerts before users get it.
   - Staged enable, with a rollback trigger at each step (the shape file's guardrails).
   - A product with no tenants yet ships behind its flag or profile, and says so.

   **Done when:** the feature is enabled as the shape planned, and the success metric and every guardrail are checked against their baseline.

9. **Learn** (Matt: `retro`; fork: floors).
   - Call the Skill tool with `retro` in this session, before it is cleared. `retro` only proposes; the user picks which proposals become permanent checks (one stop, `blocked: floors to keep`), because deciding what deserves a permanent check takes judgement.
   - Each escape (an escaped bug or a CONFIRMED finding) raises the floor where it should have been caught, at the strongest layer that fits: a lint rule or repo check first, then an envelope pack item, a topic category, a live scenario or an eval case.
   - A review comment that recurs becomes a check, not a reminder.
   - Review every logged bypass for this slug.
   - Run `scripts/check-gates.sh --phase close`. When it exits 0, set `"status": "closed"` in `.scratch/gates.json`, so the hooks stop gating this repo for this slug.

   **Done when:**
   - `.scratch/loop-metrics.md` has the slug's line with findings by stage, live scenarios added, eval deltas, time from start to merge, and `escapes=<n> floors=<m>` with m ≥ n (gate G7);
   - every bypass has a stated cause;
   - `check-gates.sh --phase close` exits 0 and `.scratch/gates.json` has `"status": "closed"`.

## Gate check

Run `<this skill>/scripts/check-gates.sh --phase <phase>` from the target repo root and fix each red line at the file it names. The phases match when each gate's file can exist:

| Phase | Gates | Used by |
|---|---|---|
| `build` | G1, G2, G8 | the push and PR-create hook, during stages 4 to 6 |
| `merge` | G1 to G6, G8 | the merge hook, stage 7 |
| `close` | all, including G7 | stage 9 |

The bypass (`FEATURE_LOOP_GATES=off` with `FEATURE_LOOP_BYPASS_REASON`) is for emergencies only, because it ships unchecked work. The hooks record it in `.scratch/loop-metrics.md`, and Learn reviews it.

## Enforcement

Rules in skill text can be skipped, so the plugin enforces the loop at the strongest layer available.

| Moment | Hook | Refuses when |
|---|---|---|
| `git commit` | commit gate | `slop-check --staged` has findings not listed under `## Justified` |
| `git push`, `gh pr create` | push gate | a `build`-phase gate is red; or the push targets the base branch (merge through the PR) |
| `gh pr merge`, a GraphQL `mergePullRequest` | merge gate | a `merge`-phase gate is red; or CI is not green on the exact head (or `merge_check` fails); or `--match-head-commit` is missing; or the checked-out HEAD is not the head being merged |
| End of a turn | Stop | a ledger row is `running` |
| Session start | SessionStart | never refuses: it prints the ledger and the resume point |

All of them apply only to a repo whose main worktree has `.scratch/gates.json` without `"status": "closed"`, and they cover builder worktrees of that repo too. When a loop is active they fail closed: a hook that cannot run blocks instead of letting the command through. The fork's CI runs the gate, hook, pack, slop and invocation tests, so a skill can never call a user-invoked skill again.

## Hand-offs

| From | File | Read by |
|---|---|---|
| feature-loop | `.scratch/gates.json`, `.scratch/loop-status.md` | `check-gates.sh`, the hooks |
| plan mode (grilling, design challenge) | `docs/plans/<file>.md` (see [plan-template.md](../plan-first/plan-template.md)) | every stage the plan covers, `check-gates.sh --plan`, G8 |
| shape | `.scratch/shape/<slug>.md` | envelope (properties), deep-engineering (journey steps), live-verify (journey cases), evals (criteria) |
| behavioral-envelope | `.scratch/envelope/<slug>.md` | deep-engineering, slice review, adversarial-review |
| deep-engineering | contract | to-spec, to-tickets, builder briefs, reviewers' spec, design challenge |
| to-tickets | the feature's sub-issues | stage 4 frontier, the PR's closing list |
| evals | `.scratch/evals/<slug>.md`, eval suite in repo | stage 5, CI |
| live-verify | `.scratch/live/<run>/report.md`, `report.json` | PR body, adversarial-review |
| adversarial-review | `.scratch/review/<slug>.md`, `.scratch/loop-metrics.md` | retro, G5, G7 |

## Rules

- Every stage the size table lists runs to its **Done when**. Every stage's done is backed by measured or inferred evidence in the ledger.
- Concerns are design inputs: a concern first found in stage 6 is an escape from stage 2.
- Design for real customers now. Concerns that only matter at 10x the load go in the envelope as Later items unless the shape file names that load.
- Depth scales with risk; speed comes from running the product early, never from skipping a gate.
