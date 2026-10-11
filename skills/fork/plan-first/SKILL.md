---
name: plan-first
description: The planning half of the owner's workflow for a feature. Use whenever the user grills a feature plan (grill-me, grilling, "grill me", stress-testing a plan) or enters plan mode (/plan, Shift+Tab) to plan a feature, a change with several files, or a ticket breakdown. Caps the grilling, ends it with 3 to 5 acceptance tests the owner confirms (stop 1), fills the plan template in plan mode, hands the plan to the codex plan review (gpt-6-astra) instead of implementing, and shows the owner the findings and the revised plan (stop 2) before feature-loop builds anything.
---

The owner's workflow: **brief → grill → acceptance tests (stop 1) → plan mode → codex plan review → revised plan (stop 2) → `feature-loop` builds, attacks and tests everything → evidence (stop 3) → PR. The owner merges.** This skill is everything up to stop 2. The owner is told every step as it happens (the hooks print it and write `.scratch/timeline.md`); the owner decides only at the three stops.

## 1. Grill, capped

- Run `date` and say the start time. A **round** is one batch of questions and the owner's answers.
- Ask with the AskUserQuestion tool where a question has a few clear options, recommended option first and marked `(Recommended)`, so the owner can answer in one click.
- After **3 rounds or 20 minutes, whichever comes first**, stop asking: list every open question with your recommended default as one numbered list and ask for one reply (`yes` or edits by number). A question whose answer changes the size or an irreversible effect is not capped.
- Record each settled answer as one line under `## Decisions`. Never reopen an answered question.

## 2. Acceptance tests: stop 1

End the grill with **3 to 5 acceptance tests** in the owner's words, one line each, `AT<n>: <observable behaviour>`: what someone could watch happen to know the feature works. Not implementation details. Show them and ask the owner to reply `approve acceptance` (or edit them). They go into the plan's `## Acceptance tests` section and become the final check: gate G12 refuses the PR until each has a passing test or live-verify scenario named after it.

Only the owner's own message approves (the hook signs it); never write an approval yourself.

## 3. Plan in plan mode

The plan is a **tracked file**. The target repo's `.claude/settings.json` has `{ "plansDirectory": "docs/plans" }` (add it if missing, before planning). Never put the plan in `.scratch/`.

1. Fill [plan-template.md](plan-template.md) in plan mode, keeping its headings exactly. A section that does not apply says `n/a: <reason>`. Size by risk (`feature-loop`, "Size it first").
2. Run the `behavioral-envelope` skill's `scripts/detect-packs.sh --plan <draft>` (read-only, allowed in plan mode) and put the packs and their triggering lines under `## Concerns`.
3. Leave `## Design challenge` as `pending: codex plan review` for now. Present the plan with ExitPlanMode.

## 4. Hand-off: review, do not implement

When the owner accepts the plan to leave plan mode, the hook tells you this too: **do not implement.**

1. Commit the plan file.
2. Call the Skill tool with `codex-review` in plan mode on the plan file. It runs `gpt-6-astra` read-only against the real repo and writes `.scratch/review/codex-plan-<slug>.json`.
3. Fold every CONFIRMED finding into the plan (change the section it concerns) and write each resolution in `.scratch/review/codex-plan-<slug>.resolutions.md`. Fill `## Design challenge` with the report path, the findings and how each is resolved. Run `feature-loop`'s `scripts/check-gates.sh --plan` until it exits 0. Commit.
4. If codex is unavailable, say so to the owner; the fallback is the read-only subagent in [design-challenge.md](design-challenge.md), recorded as a bypass.

## 5. Stop 2: the reviewed plan

Show the owner, in this order: the codex summary line, every CONFIRMED finding with its resolution, the PLAUSIBLE ones with your decision, and what changed in the plan (the diff of the plan file since the hand-off). Ask the owner to reply `approve plan` (or say what to change). After `approve plan`, call the Skill tool with `feature-loop` on the plan. Starting the loop with an approved plan marks stages 0, 1 and 3 `done, from approved plan`.

## After stop 2

- When the build finds reality differs from the plan, append `- Changed: <what> because <why>` under `## Changes` in the same commit as the code. The owner is told immediately (an escalation line); no approval is needed unless the change touches an acceptance test, which needs a fresh `approve acceptance`.

**Done when:** the acceptance tests are approved, the plan passes `check-gates.sh --plan`, the codex plan review ran on it with every CONFIRMED finding resolved, the owner typed `approve plan`, and `feature-loop` has started on it.
