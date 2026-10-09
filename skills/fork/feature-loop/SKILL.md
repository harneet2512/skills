---
name: feature-loop
description: "Take one feature from request to merged and shipped, end to end: Matt's main flow (understand, spec, tracer-bullet tickets, TDD build, review, retro) with this fork's upgrades at every step: journey shape, engineering contract, behavioral envelope, concern topics, evals, live verification, adversarial review, gates enforced by hooks, and one PR per feature."
disable-model-invocation: true
---

Take one feature from request to shipped, without stopping except for decisions only the user can make.

**The flow:**
- **The spine is Matt's main flow:** understand, `to-spec`, `to-tickets`, build each ticket with `tdd` and `code-review`, then `retro`.
- **This fork adds a layer at every step:** the journey shape, the engineering contract, the behavioral envelope, the concern topics, evals, live verification, adversarial review, the evidence ledger, and gates.

**How done is decided:**
- Each stage calls existing skills, reads the previous stage's files, and leaves evidence.
- A **gate** is a check on a stage's file, green or red, decided by `scripts/check-gates.sh`. Gate IDs, paths and formats are in [gates.md](gates.md), and each **Done when** below names the same condition.
- The plugin's hooks enforce the gates whether or not this text is followed (see Enforcement).

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Size it first

| Size | When | Stages |
|---|---|---|
| **Small** | One component, no new state, no new integration (copy, a color, a validation rule) | 2 (envelope only), then the single-issue path: call the Skill tool with `wp-loop`; then 9 |
| **Normal** | A user-visible behavior with state, an API, a job or an integration | All stages |
| **Large** | A new subsystem, a new external integration, tenancy, money, an AI feature | All stages, plus the design challenge in stage 2 |

Say the size and why in one line, and write `.scratch/gates.json` as gates.md specifies: `{ "slug": "<slug>", "size": "<size>", "base": "<branch>" }`. Add `"merge_check"` when CI does not run as GitHub checks on the PR (see gates.md). When evidence says the work is bigger, escalate: rewrite `size` and run the stages it adds.

**Done when:** `.scratch/gates.json` holds `slug`, `size` (`small`, `normal` or `large`) and `base`.

## Roles

- **Lead** (this session). Owns the contract, the specs and the builder briefs. Calls every review skill, decides every gate, verifies every fix personally, and merges.
- **Builders.** Subagents on a cheaper model (Claude Code: `model: "sonnet"`) that write code at confirmed seams only.
- **Reviewers and the design challenge.** Subagents on the strongest model (Claude Code: `model: "opus"`), each with a fresh context, never the builder that wrote the code.

Set the model explicitly on every subagent call.

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

0. **Baseline.** Once per product: read the tenancy model, auth, deploy path, observability and flags. Note each missing enterprise need (tenant scoping, audit log, SSO hook, staged rollout). The first feature that depends on one builds it as a foundation ticket.
   **Done when:** each of the five is located or marked missing, and each missing one this feature depends on is a ticket.

1. **Understand** (Matt: `grill-with-docs`; fork: `shape`).
   - When any requirement is a guess, call the Skill tool twice, for `grilling` and `domain-modeling`, so the answers land in the glossary and ADRs.
   - When a question needs running code to settle (state, business logic, a UI you have to see), call the Skill tool with `prototype` and fold its answer in.
   - Then call the Skill tool with `shape`.
   - Keep stages 1 to 3 in one context window (Matt's context hygiene). Compact only at a stage boundary.

   **Done when:** `.scratch/shape/<slug>.md` has intent, actors and surfaces, the journey map, the success metric, the scope line, and at least one journey case ID `J<n>.<case>` (gate G1).

2. **Design** (fork). **Requires:** the shape file.
   - Call the Skill tool with `deep-engineering`. It builds the system model from repo evidence and calls `behavioral-envelope` (gate G2), `concern-topics` (journey × topic matrix and safety arguments) and, when the envelope's `**Packs:**` line names `llm` or `retrieval`, `evals` (the eval plan, before any prompt exists). It ends with the engineering contract.
   - **Large:** before the spec, a reviewer subagent on the strongest model, with a fresh context, attacks the contract. Its brief: break the design against the code, report CONFIRMED and PLAUSIBLE findings with evidence, and say what to cut. Fold every CONFIRMED finding into the contract, with its resolution, and say which ones changed the design.

   **Done when:**
   - the contract gives every Live item a mechanism, an enforcement point and a proof, plus the build order;
   - every matrix cell holds a mechanism ID or `none: <reason>`;
   - when evals apply, `.scratch/evals/<slug>.md` has criteria, cases, graders and a gate;
   - for Large, the challenge's findings are resolved in the contract;
   - the contract has no BLOCKING open question.

3. **Plan** (Matt: `to-spec`, `to-tickets`). **Requires:** the contract.
   - Call the Skill tool with `to-spec`, with the contract as input. Then call the Skill tool with `to-tickets`.
   - Tickets are tracer-bullet vertical slices with blocking edges. The prefactor and the shared-contract change come first. Each ticket names its journey cases, Live items, topic categories and seams (from the contract's Verification required).
   - `to-tickets`' quiz is the one planned stop: the user approves the breakdown and confirms the seams in the same step. Then the tickets are published as sub-issues of the feature's issue.

   **Done when:** the tickets are published, every Critical item's mechanism is in a ticket before any slice that relies on it, and the seams are confirmed.

4. **Build** (Matt: `implement-spec`, `tdd`, `code-review`; fork: attack tests, topic patterns, slice review). **Requires:** the published tickets.
   - Create the integration branch from the latest default branch: `<issue>-<slug>`, or the repo's own branch convention. Open a draft PR after the first slice merges.
   - For each ticket on the frontier, in parallel where blocking edges allow:
     1. **Implement.** A builder subagent in its own worktree off the integration branch calls the Skill tool with `tdd` at the ticket's confirmed seams. It writes each attack test (duplicate delivery, concurrent writer, timeout after success) before the code it attacks. It reads its topic categories' *Build it right* before writing matching code, commits and pushes as it goes, and merges the integration branch tip into its own branch before reporting done.
     2. **Review the slice.** The lead calls the Skill tool with `code-review` on the slice's diff against the integration branch, with the ticket, the contract and the envelope's Live items as the spec. Both axes go to reviewer subagents on the strongest model, with severities assigned within each axis.
     3. **Fix.** CRITICAL and HIGH findings go back to the builder. The lead re-runs each one's targeted test and reads the changed lines. Each MEDIUM is fixed or filed as a follow-up issue.
     4. **Merge** the slice into the integration branch and push. The commit hook runs `slop-check` on every commit.

   - When every ticket is merged, remove the builder worktrees.

   **Done when:** every ticket is merged into the integration branch with its slice review resolved, each attack test went red before its code landed, the full suite is green on the integration branch, and no builder worktree is left.

5. **Prove** (fork). On the integration branch head:
   - CI is green;
   - `concern-topics/scripts/slop-check.sh --diff <base>` is clean, or its findings are justified (gate G6);
   - when evals apply, call the Skill tool with `evals` and run the plan's gate (gate G4);
   - call the Skill tool with `live-verify` for every journey case and every Live item with a live proof, with two instances and faults injected (gate G3).

   **Done when:** G3, G4 (when evals apply) and G6 are green, and CI is green on the head.

6. **Attack** (fork). Call the Skill tool with `adversarial-review` over the whole integration branch. Each CONFIRMED finding is fixed as a commit on the same PR, with its reproduction kept, and recorded as an escape from stage 2 or 4.
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
- Size for an enterprise product with real customers now and 10x its load. Anything bigger waits for evidence.
