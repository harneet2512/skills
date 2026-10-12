---
name: kl
description: The owner's whole flow in one command, from issues or a task to reviewed, stacked PRs the reviewer merges. Grill, acceptance tests (stop 1), plan mode, codex plan review (stop 2), then wp-loop per issue with the owner's go before every PR and every Slack post. Nothing reaches GitHub or Slack without the owner knowing.
disable-model-invocation: true
---

`/kl <issue numbers or a task> [on <owner/repo>]`. Run it from the target repo. Say `.venv` or the repo's own check command if the repo needs one.

## The flow

1. **Read first.** Read every issue (`gh issue view <N>`), `CLAUDE.md`, `AGENTS.md` and the code they touch. Never create, edit, comment on, label or close an issue.
2. **Grill.** Call the Skill tool with `plan-first`, then with `grilling`. Grill as `grilling` says, within `plan-first`'s cap, asking the owner (recommended answer first). If the owner said "pick the recommended answer", do that and list every decision.
3. **Stop 1: acceptance tests.** As `plan-first` step 2 says: write `docs/acceptance/<slug>.md` first, show the tests, wait for `approve acceptance`.
4. **Plan, codex plan review, stop 2.** As `plan-first` steps 3 to 5 say: one plan for all the issues, codex (`gpt-6-astra`) reviews it, show the findings and the revised plan, wait for `approve plan docs/plans/<file>.md`.
5. **Build each issue.** Call the Skill tool with `wp-loop` for each issue in plan order, stacked branches off the default branch. Per issue, `wp-loop` calls `tdd`, `adversarial-review` and `pr`, runs every check, pushes the branch, then stops: **the owner's `approve pr`** opens the PR, and for every post **"Post this now in Slack:"** with the exact text, which the owner pastes. While waiting, start the next issue.
6. **Done.** Every PR is open, stacked, with `Closes #N` and its results comment. The owner merges, in stack order.

## What the owner always sees

- Every step as it happens: the hooks print one line per test run, push, PR, stage and approval, and keep `.scratch/timeline.md`.
- `ESCALATION:` lines for anything unusual (a confirmed CRITICAL or HIGH finding, a force push, an edited plan, codex out of usage).
- "where are we" at any time: the countdown of the 8 gates before the current PR.

## What the hooks enforce (no bypass)

- No PR by any route (`gh pr create`, `gh api` to `/pulls`, `createPullRequest`, the GitHub MCP) without the owner's signed `approve pr` for that exact commit, and the `adversarial-review` and `pr` skills logged for that issue. A new commit needs a new `approve pr`.
- No merge by any route: the owner merges.
- No GitHub issue writes and no `gh pr merge`, `gh pr ready` or `gh label` (`.claude/settings.local.json` deny rules that `plan-first` writes). `gh pr comment`, `edit` and `review` ask the owner first.
- No Slack post by the loop: it says "Post this now in Slack:" and the owner posts.
- Codex out of usage stops the flow and asks the owner: wait for the reset, add credits, or continue without codex (logged).

Limits: the hooks run as the same user as the agent, so they are tamper-evident, not tamper-proof (see `feature-loop` gates.md). Branch protection on the default branch is the hard guarantee that only the owner merges.
