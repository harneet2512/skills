---
name: plan-first
description: The planning half of the owner's workflow for a set of issues the reviewer already created. Use whenever the user grills a feature plan (grill-me, grilling, "grill me", stress-testing a plan) or enters plan mode (/plan, Shift+Tab) to plan a feature, a change with several files, or a set of issues. Caps the grilling, ends it with 3 to 5 acceptance tests the owner confirms (stop 1), fills the plan template in plan mode, hands the plan to the codex plan review (gpt-6-astra) instead of implementing, and shows the owner the findings and the revised plan (stop 2) before wp-loop builds the first issue. Never creates, edits or closes an issue, and never commits the plan.
---

The owner's workflow: **the reviewer's issues → grill → acceptance tests (stop 1) → plan mode → codex plan review → revised plan (stop 2) → `wp-loop` builds each existing issue in plan order, one branch and one PR each, the PR opened only when everything is green → the reviewer merges.** This skill is everything up to stop 2. The owner is told every step as it happens (the hooks print it and write `.scratch/timeline.md`); the owner decides only at the stops.

## The reviewer's rules

These hold through planning and through every `wp-loop` run that follows:

- **The issues already exist and belong to the reviewer.** Read them; refer to them by number (`#N`). Never create, edit, label, assign, comment on or close an issue, and never call `to-tickets` or `to-spec` (both publish new issues). The "tickets" in the plan are the existing issues.
- **One issue, one branch, one PR.** A PR names its issue with `Closes #N`; the issue closes when the reviewer merges. Nobody but the reviewer merges.
- **Only the issue's work goes in a PR.** The plan, the acceptance tests, `.claude/settings.local.json` and everything under `.scratch/` stay on the owner's machine. Before planning, append these lines to the target repo's `.git/info/exclude` (create it if missing, skip lines already there):

  ```
  docs/plans/
  docs/acceptance/
  .scratch/
  .claude/settings.local.json
  .claude/worktrees/
  CLAUDE.md
  ```

  Skip `CLAUDE.md` when the target repo already tracks one (`git ls-files CLAUDE.md` prints it): never hide or change a tracked file.
- **Make the forbidden commands impossible, not just forbidden.** The feature-loop hooks guard only a started feature loop, so in this flow nothing else stops a merge or an issue write. In the same step, before any planning, write the target repo's `.claude/settings.local.json` (merge into it if it exists) with:

  ```json
  {
    "plansDirectory": "docs/plans",
    "permissions": { "deny": [
      "Bash(gh pr merge:*)", "Bash(gh pr ready:*)", "Bash(gh issue create:*)", "Bash(gh issue edit:*)",
      "Bash(gh issue comment:*)", "Bash(gh issue close:*)", "Bash(gh issue reopen:*)", "Bash(gh label:*)"
    ],
    "ask": [ "Bash(gh pr create:*)", "Bash(gh pr comment:*)", "Bash(gh pr edit:*)", "Bash(gh pr review:*)" ] }
  }
  ```

  The `ask` list makes Claude Code prompt the owner before any PR is opened, commented on or edited, on top of the owner's `approve pr` in `wp-loop`. If a Slack connector is attached, add its send-message tool to `deny`: the loop drafts Slack posts and the owner sends them.

  Then ask the owner to restart the session once (`/exit`, then resume) so both settings load before plan mode. Never create `.scratch/gates.json` to get protection: that starts a feature loop and turns on gates this flow does not use.

- **The reviewer's product rules hold too.** The eight rules in `wp-loop` ("The reviewer's product rules") go into the plan: each one the issues touch is a line under `## Decisions` and, where it can break, under `## Failure modes`.

- **Codex is a budget, not a given.** The owner's codex usage is limited and a limit mid-build stops the flow. Before planning, run `codex --version` and one tiny read-only codex call to confirm it works now; if it is already limited, tell the owner before the grill, not at the first code attack. The plan's `## Time box` states the codex budget and the risky issues in priority order.
- **No posts before the build.** Grilling, acceptance tests and planning show nothing a reviewer can see, so they produce no Slack or status posts. The owner's own "here" is the only message before the first issue's build starts.

## 1. Grill, capped

- Run `date` and say the start time. A **round** is one batch of questions and the owner's answers.
- Read every issue the owner names (`gh issue view <N>`) and every doc they point to before the first question, so no question asks what an issue or doc already says.
- Ask with the AskUserQuestion tool where a question has a few clear options, recommended option first and marked `(Recommended)`, so the owner can answer in one click.
- After **3 rounds or 20 minutes, whichever comes first**, stop asking: list every open question with your recommended default as one numbered list and ask for one reply (`yes` or edits by number). A question whose answer changes the size or an irreversible effect is not capped.
- Record each settled answer as one line under `## Decisions`. Never reopen an answered question.

## 2. Acceptance tests: stop 1

End the grill with **3 to 5 acceptance tests** in the owner's words, one line each, `AT<n>: <observable behaviour>`: what someone could watch happen to know the feature works. Not implementation details. **Before you show them**, write them to `docs/acceptance/<slug>.md` under a `## Acceptance tests` heading (the approval hook reads that file and is keyed to its items; with no such file it refuses `approve acceptance`; the file stays local), show them, and ask the owner to reply `approve acceptance` (or edit them). They go into the plan's `## Acceptance tests` section and become the final check: no PR opens until each one that the issue covers has a passing test or live-verify scenario named after it.

Only the owner's own message approves (the hook signs it); never write an approval yourself.

## 3. Plan in plan mode

After `approve acceptance`, enter plan mode yourself (call the EnterPlanMode tool; load it with ToolSearch if it is deferred), so the owner does not have to switch modes. The plan lives in `docs/plans/`, kept local by the exclude lines above. `plansDirectory` is already set by the rules step above; if the session did not restart since, plan mode may save elsewhere, so check where ExitPlanMode wrote the plan and copy it to `docs/plans/` if needed. Never write it into a tracked `.claude/settings.json`, and never put the plan in `.scratch/`.

1. Fill [plan-template.md](plan-template.md) in plan mode, keeping its headings exactly. A section that does not apply says `n/a: <reason>`. Size by risk (`feature-loop`, "Size it first").
2. Run the `behavioral-envelope` skill's `scripts/detect-packs.sh --plan <draft>` (read-only, allowed in plan mode) and put the packs and their triggering lines under `## Concerns`.
3. Leave `## Design challenge` as `pending: codex plan review` for now. Present the plan with ExitPlanMode.

## 4. Hand-off: review, do not implement

When the owner accepts the plan to leave plan mode, the hook tells you this too: **do not implement.**

1. Save the plan file, and copy it to `.scratch/plan-at-handoff.md` so stop 2 can show what changed. Never commit it.
2. Call the Skill tool with `codex-review` in plan mode on the plan file, in the foreground, with `--slug <slug>` (the plan file's name), because the review reports are read by it. It runs `gpt-6-astra` read-only against the real repo and writes `.scratch/review/codex-plan-<slug>.json`.
3. Fold every CONFIRMED finding into the plan (change the section it concerns) and write each resolution in `.scratch/review/codex-plan-<slug>.resolutions.md` as `fixed: plan revised (<section>)` or `rejected: <evidence>`. The plan is never committed, so never write a commit there and never `git add -f` the plan. Fill `## Design challenge` with the report path, the findings and how each is resolved. Run `feature-loop`'s `scripts/check-gates.sh --plan` until it exits 0.
4. If codex is unavailable, say so to the owner; the fallback is the read-only subagent in [design-challenge.md](design-challenge.md), recorded as a bypass.

## 5. Stop 2: the reviewed plan

Show the owner, in this order: the codex summary line, every CONFIRMED finding with its resolution, the PLAUSIBLE ones with your decision, and what changed in the plan (`diff .scratch/plan-at-handoff.md <plan file>`). Ask the owner to reply `approve plan docs/plans/<file>.md` with the file named (a bare `approve plan` is refused when `docs/plans/` holds more than one plan), or say what to change. After `approve plan`, call the Skill tool with `wp-loop` on the first issue in the plan's `## Tickets and seams` order, passing the plan file. Do not call `feature-loop`.

## After stop 2

- **Build never pauses for a PR.** While one issue's PR waits for the reviewer, `wp-loop` starts the next issue in plan order on a branch stacked on the previous one.
- **Plan check after every PR.** Before the next issue starts, compare the plan with what the last issue built and with the reviewer's comments on open PRs. When they differ, append `- Changed: <what> because <why>` under `## Changes` in the plan file and tell the owner in one line. No approval is needed unless the change touches an acceptance test, which needs a fresh `approve acceptance`.

**The acceptance map (`.scratch/acceptance.md`).** One row per acceptance test, `| AT id | test path or scenario name | last result on <sha> |`. The test cell is exactly one of: a live-verify scenario name; a tracked test file path (`tests/a.test.js`, optionally `:line`); or `path::test name`. The result cell is `pass <sha>` for the HEAD it ran on.

**Done when:** the acceptance tests are approved, the plan passes `check-gates.sh --plan`, the codex plan review ran on it with every CONFIRMED finding resolved, the owner typed `approve plan`, and `wp-loop` has started on the first issue. No issue was created or changed, and `git status` in the target repo shows none of the plan files.
