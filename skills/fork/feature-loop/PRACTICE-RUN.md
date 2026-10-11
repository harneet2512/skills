# Practice run: the plan-first workflow on a toy repo

HAR-170 Phase 2 "Done when" asks for one practice run. It runs **in a cloud session, never on the maintainer's laptop**, after the A/B results are in and the plan-first PR is merged (or the session installs the branch).

## Setup

1. A new private toy repo (for example `harneet2512/plan-first-toy`) from `skills/fork/live-verify/bench/inbox-assist/`, or any small app with a test suite and one runnable entry point. No real keys.
2. In the toy repo, `.claude/settings.json`:
   ```json
   { "plansDirectory": "docs/plans" }
   ```
   `docs/plans/` is **tracked** (never in `.gitignore`), so builders commit the plan's `Changed:` lines with the code and the PR shows the plan diff. `.scratch/` stays ignored.
3. A cloud session with the fork plugin at `1.3.1-fork.7` or later, attached to the toy repo only.
4. The feature to build, as a brief (a few lines): a **normal** one with state and a Critical item, so the design challenge runs. Example: "A Regenerate draft button that is safe against double clicks and Slack retries."

## Steps (one session, in this order)

1. **Grill.** Grill the brief (`grilling`; the `plan-first` skill must load and enforce the cap). It must stop at 3 rounds or 20 minutes and list open questions with recommended defaults. Answer them in one reply: `yes` or an edit.
2. **Plan mode.** Enter plan mode (`/plan` or Shift+Tab). Fill `skills/fork/plan-first/plan-template.md` into `docs/plans/`. During planning:
   - run `behavioral-envelope/scripts/detect-packs.sh --plan <draft>` and put the result under `## Concerns`;
   - launch the design challenge as one read-only subagent (`skills/fork/plan-first/design-challenge.md`) and fold its findings into `## Design challenge`;
   - **plant one deliberate error now, as the last edit before the check**: make the plan wrong about one thing the build will find (name a file that does not exist, or a seam the code lacks). If the design challenge already caught the planted error, plant another;
   - run `scripts/check-gates.sh --plan` until it exits 0.
3. **One approval, taken outside the approve prompt.** The plan-mode approve prompt switches to a mode that starts editing outside the loop, so at the prompt choose **No, keep planning** (or reject). That leaves the session in plan mode, where the loop cannot write files, so press Shift+Tab to a normal mode (this gives no second approval prompt). Commit `docs/plans/<file>.md`. Starting the loop on the plan in the next step is the approval; this is the last question the user is asked about requirements, seams or the breakdown.
4. **Run the loop.** `/mattpocock-skills:feature-loop` with the same brief. Answer nothing that the plan covers. Count every question the loop asks.
5. **Watch the planted error surface.** When the build finds it, the build must append `- Changed: <what> because <why>` to the plan file in the same commit as the code, and the PR must show the plan diff.
6. Let the loop finish through the PR (merge gate not required for the practice run).

## What must be true afterwards

Record each line below as pass or fail, with the evidence:

| Check | Evidence |
|---|---|
| Grilling stopped at its cap and listed open questions with defaults | the session transcript |
| `detect-packs.sh --plan` ran during planning | `## Concerns` lists the packs and triggering lines |
| The design challenge ran as a read-only subagent inside plan mode, before approval | transcript shows the subagent call before the approval prompt; `## Design challenge` has its findings and resolutions; **also record whether the subagent was allowed in plan mode** (this settles the docs question in FORK.md section 8) |
| Exactly one approval | the plan-mode approve prompt was declined ("No, keep planning"), the loop was started on the committed plan, and there was no second approval after stage 2 |
| `scripts/check-gates.sh --plan` exits 0 | output |
| The ledger `.scratch/loop-status.md` shows the covered stages (0, 1 and 3 only) as `done, from approved plan` with `inferred: docs/plans/<file>.md#<Section>` evidence | the ledger; `scripts/check-gates.sh G8` exits 0 |
| No repeated question: no grilling in stage 1, `shape` or `wp-loop` step 1; no seam check in `to-spec` or `wp-loop` step 4; no `to-tickets` quiz (unless the tickets differed from the plan, and then only about the difference); no re-sizing; no stage 0 dependency request | transcript search; the count of questions asked after approval is 0 for these, and every other question is listed with why |
| Work that still runs, did run | `deep-engineering`'s check, the envelope, the walking skeleton with a passing live scenario, tests and reviews appear in the ledger with `measured:` or `inferred:` evidence, not `from approved plan` |
| Deviation written back | the plan file has a `Changed: ... because ...` line; `scripts/check-gates.sh --plan` reports 1 deviation line; the plan file is tracked and the PR diff includes it, with the `Changed:` line in the same commit as the code that differs from the plan |

Ledger shape expected (stage numbers follow `feature-loop`; the ones the plan covers carry the plan evidence):

```markdown
| Stage | Skill | Status | Gate | Evidence | Output | Finished |
|---|---|---|---|---|---|---|
| 0 | baseline | done, from approved plan | | inferred: docs/plans/<file>.md#External dependencies | docs/plans/<file>.md | <time> |
| 1 | shape | done, from approved plan | G1 | inferred: docs/plans/<file>.md#Decisions | .scratch/shape/<slug>.md | <time> |
| 2 | deep-engineering | done | G2 | measured: <the deeper check and gate output> | .scratch/envelope/<slug>.md | <time> |
| 3 | to-tickets | done, from approved plan | | inferred: docs/plans/<file>.md#Tickets and seams | <published tickets> | <time> |
| 4 | tdd | done | | measured: <skeleton scenario passed, CI run id> | <PR> | <time> |
```

Stage 2 is `done`, not `from approved plan`, because the deeper check against the code still runs.

## Report

Post the results (pass or fail per check above, the question count, the ledger, the PR link and the plan diff) as a comment on HAR-170, and file each failed check as a fork.8 sub-issue of HAR-133.
