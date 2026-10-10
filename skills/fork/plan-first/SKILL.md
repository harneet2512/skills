---
name: plan-first
description: The planning half of the plan-first workflow for a feature. Use whenever the user grills a feature plan (grilling, "grill me", stress-testing a plan) or enters plan mode (/plan, Shift+Tab) to plan a feature, a change with several files, or a ticket breakdown. Caps the grilling at 3 rounds or 20 minutes, fills the plan template in plan mode (decisions, size, dependencies, files, skeleton ticket, tickets with seams, skill per stage, verification, failure modes, time box), runs pack detection on the draft, has a read-only subagent attack the draft before approval, and writes the plan to a tracked file that feature-loop then follows without re-asking.
---

The plan-first workflow: **the user's brief, then `grilling` (capped), then plan mode (one plan, attacked before approval), then `feature-loop` follows the approved plan.** This skill is the first two steps. `feature-loop` is user-invoked and is not in context while the user is still grilling or planning, so every rule for those phases lives here.

## 1. Cap the grilling

Upstream `grilling` has no limit, so this skill enforces one while grilling a feature plan.

- At the start, run `date` and say the start time. A **round** is one batch of questions followed by the user's answers.
- After **3 rounds or 20 minutes, whichever comes first**, stop asking. List every remaining open question, each with your recommended default, as one numbered list, and ask for one reply: `yes` (take all defaults) or edits by number.
- Record the answers that settled something as one line each under `## Decisions` in the plan; record unanswered questions you defaulted under `## Open questions` until the user replies.
- Never reopen a question the user already answered. A question whose answer would change the size or an irreversible effect is not capped: ask it.

## 2. Plan in plan mode

The plan is a **tracked file** so every builder and the PR see it. Target repos set this in `.claude/settings.json`:

```json
{ "plansDirectory": "docs/plans" }
```

Claude Code picks the file name. Do not put it in `.scratch/` (untracked and not copied to worktrees).

1. **Fill the template** [plan-template.md](plan-template.md) in plan mode, keeping its headings exactly (the loop finds sections by heading text). Sections: Decisions, Size and why, External dependencies, Files to create or change, Skeleton ticket, Tickets and seams, Skill per stage, Verification, Failure modes, Time box, Concerns, Design challenge, plus Open questions and Changes. A section that does not apply says `n/a: <reason>`. Size by risk (see `feature-loop`, "Size it first"); an AI feature is not large by itself.
2. **Pack detection.** Run the `behavioral-envelope` skill's `scripts/detect-packs.sh --plan <draft or the brief>` and put the packs and their triggering lines under `## Concerns`. Read-only, so it is allowed in plan mode.
3. **Design challenge before approval** (large work, and normal work with a Critical Live item; otherwise write `n/a: <reason>`). Follow [design-challenge.md](design-challenge.md): one read-only subagent on the strongest model attacks the draft; fold every CONFIRMED finding into the plan with its resolution; list the accepted cuts. One round. There is no second approval after this.
4. **Check the plan.** Run the `feature-loop` skill's `scripts/check-gates.sh --plan` until it exits 0. It names every missing or empty section and every `Changed:` line without a reason.
5. **One approval.** Present the plan. The plan-mode approve prompt switches to a mode that starts editing, outside the loop, so tell the user to choose **No, keep planning** (or reject) at that prompt, commit the plan file, and start `/mattpocock-skills:feature-loop`. Starting the loop on the plan is the approval. The loop reads the plan and asks only about sections the check names.

## 3. After approval

- The lead commits the plan file (on the integration branch, before any builder starts) so it is tracked.
- When the build finds reality differs from the plan, the lead or builder appends `- Changed: <what> because <why>` under `## Changes` **in the same commit as the code**, so the PR shows the plan diff. Code and plan never silently diverge.
- `feature-loop` marks the stages the plan covers (0, 1 and 3) as `done, from approved plan` and still runs the deeper check, envelope, skeleton, tests and reviews.

**Done when:** the plan file has every required section filled (`check-gates.sh --plan` exits 0), the design challenge's findings are resolved in it (or it says `n/a: <reason>`), the grilling stopped at its cap with defaults listed, and the user has started the loop on it.
