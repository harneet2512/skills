# kl: the owner's workflow in one command

Branch `kal-trial-workflow`, version **1.3.1-fork.9.13**. Linear: HAR-180 (dry run 1), HAR-181 (dry run 2).

`kl` takes a set of issues (or a task) to reviewed, stacked PRs that the reviewer merges. It goes through grill, acceptance tests, plan, codex plan review, then build, attack and test per issue. **Nothing reaches GitHub or Slack without the owner knowing**, and the owner sees every step.

## Install (Claude Code)

```sh
git clone -b kal-trial-workflow https://github.com/harneet2512/skills.git skills-kal-trial
claude plugin marketplace add ./skills-kal-trial          # registers the "mattpocock-fork" marketplace
claude plugin install mattpocock-skills@mattpocock-fork --scope user
# restart Claude Code
```

To update: `git -C skills-kal-trial pull`, then `claude plugin marketplace update mattpocock-fork`, then `claude plugin update mattpocock-skills@mattpocock-fork`, then restart.

Needs: `gh` logged in, `node`, and the `codex` CLI logged in (for the `gpt-6-astra` reviews).

## Use

```text
/mattpocock-skills:kl 51 52 53 on owner/repo
/mattpocock-skills:kl <a task in plain words>
```

| Step | What happens | The owner does |
|---|---|---|
| 1. Read | Reads every issue, `CLAUDE.md`, `AGENTS.md` and the code | n/a |
| 2. Grill | Questions with a recommended answer first, capped at 3 rounds or 20 minutes | Answers, or says "pick the recommended answer" |
| 3. Stop 1 | Writes `docs/acceptance/<slug>.md` (3 to 5 acceptance tests) and shows them | `approve acceptance` |
| 4. Plan | One plan for all the issues in plan mode; codex (`gpt-6-astra`) reviews it read-only; findings are folded in | `approve plan docs/plans/<file>.md` (stop 2) |
| 5. Per issue | `wp-loop`: stacked branch, TDD, live check, `adversarial-review` (plus codex code attack on the issues the plan names risky), every check saved, branch pushed | `approve pr` opens the PR; pastes each **"Post this now in Slack:"** text |
| 6. Done | Every PR open with `Closes #N` and a results comment | Merges, in stack order |

Ask **"where are we"** at any time to see the 8-gate countdown before the current PR.

## What is enforced (hooks; no bypass)

| Action | Rule |
|---|---|
| Open a PR by any route (`gh pr create`, `gh api` to `/pulls`, `createPullRequest`, the GitHub MCP), from the main folder or any worktree | Needs the owner's signed `approve pr` for that exact commit (`approve pr <branch>` for an issue built in a worktree), plus `adversarial-review` and `pr` called with that branch's name. A new commit needs a new `approve pr`. |
| Merge by any route | Refused. The owner merges. |
| GitHub issue writes, `gh label`, `gh pr ready` | Denied (`.claude/settings.local.json`, written by `plan-first`) |
| `gh pr comment` / `edit` / `review` | Claude Code asks the owner first |
| Slack | The loop never posts. It says "Post this now in Slack:" and the owner pastes. |
| Codex out of usage | Exits 4 with an `ESCALATION:` line and the reset time. The owner chooses: wait, add credits, or skip (logged). |
| Approvals | Only the owner's own prompt counts (`approve acceptance`, `approve plan <file>`, `approve pr`), signed into `.scratch/.loop/`. A hand-written approval counts for nothing. |

**What the owner sees:** one line per test run, push, PR, stage and approval; `.scratch/timeline.md` (the full log); and `ESCALATION:` lines for anything unusual (a confirmed CRITICAL or HIGH finding, a force push, an edited plan, codex out of usage).

**Limit:** the hooks run as the same OS user as the agent, so they are tamper-evident, not tamper-proof. The hard guarantee that only the owner merges is GitHub branch protection on the default branch.

## Dry runs (gt-harness issues 51 to 56: six small CLI fixes)

| | Dry run 1 (HAR-180, fork.9.1) | Dry run 2 (HAR-181, fork.9.6) |
|---|---|---|
| Result | 6 PRs, after a push blocker was fixed mid-run | 6 stacked PRs (`63` to `68`), end to end, no guard refusals |
| Time | 2h00m | 2h45m (about 2h20m of it the skill's own time) |
| Owner gates | n/a | No PR before `approve pr`, no post before `post it` |
| False tamper alarms | about 15 | 0 |
| Issues touched | none | none |
| Codex | plan + #55 code attack | plan (1 CONFIRMED) + #55 (1 PLAUSIBLE, fixed). The re-run hit the usage limit; the owner accepted the skip. |
| Gaps | push blocker; skills ignored | the review skills were skipped after the first issue (fixed in 9.7); no countdown file |

## Versions

| Version | Commit | Change |
|---|---|---|
| 9.5 | `8c1680f` | Files the default branch already holds are never approval or hand-off candidates |
| 9.7 | `8db9733` | A hook requires the `adversarial-review` and `pr` skills before each PR |
| 9.8 | `078d7f5` | Codex usage limit: stop and ask the owner |
| 9.10 | `6b69b84` | The owner posts to Slack; the loop gives the text (the 9.9 webhook was removed) |
| 9.11 | `774087b` | `/kl`; no PR by any route without `approve pr` for HEAD; every merge refused |
| 9.12 | `4acbcf0` | Codex budget in the plan; pushing needs no go; the next issue starts while a go is pending; no posts before the build |
| 9.13 | see log | Parallel issues: the PR guard finds the approvals from any worktree (before, a PR from a worktree passed with no `approve pr`); `approve pr <branch>` signs that branch's head; each review is tied to its branch by the Skill args |

## Still open

1. The countdown is shown in chat but no `countdown.md` is kept.
2. Posts get drafted during grill and plan (they are not sent).
3. The loop does not start the next issue while waiting for `approve pr`.
4. The first push waits for the owner, though wp-loop says to push first.
5. The plan-mode hook proposes a random plan file name, which the loop renames.
6. The full test suite runs on every issue. Proposal: run the touched tests per issue, and the full suite once at the top of the stack.
