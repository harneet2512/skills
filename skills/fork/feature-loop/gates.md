# Gates

A gate is a check on a file a stage leaves behind. It is either green or red, and `scripts/check-gates.sh` decides which, not the agent. Each stage's **Done when** line in the skills names the same condition the gate checks, so the wording and the script agree.

All files live under `.scratch/` in the target repo. `<slug>` is the feature's slug.

## The run file

`feature-loop` writes `.scratch/gates.json` when it sizes the work:

```json
{ "slug": "reply-options", "size": "normal", "base": "main" }
```

`size` is `small`, `normal` or `large`. Optional fields, each validated strictly: a bad value, or a field name the script does not know (`demoBy`, `Live`), is a usage error (exit 2), never a rule silently turned off. The known fields are `slug`, `size`, `base`, `status`, `merge_check` and the ones below.

| Field | Value | What it does |
|---|---|---|
| `started` | an ISO 8601 time with a zone, for example `"2026-10-12T09:00:00-04:00"` | When this loop began. Only a live run newer than it counts for the time box, so a run left over from an earlier feature never does. Without it, the run file's own modification time is used |
| `demo_by` | an ISO 8601 time with a zone, for example `"2026-10-12T17:00:00-04:00"` or `"2026-10-12T21:00:00Z"` | The time box: by then the happy path must have passed a live run (newer than `started`). `check-gates.sh --timebox` prints minutes left, `met`, `n/a` when the live run is waived, or `OVERDUE` (exit 1), and the SessionStart summary carries the same line. Impossible dates (February 30) are refused |
| `evals` | `"smoke"` (default) or `"full"` | How big the eval plan is when the `llm` or `retrieval` pack applies (see `evals`, "Tiers"). G4 checks the same way at both tiers |
| `max_builders` | a whole number from 1 to 8 (default 3) | The most builder subagents running at once. Advisory: the skills follow it, no hook counts agents |
| `live` | `"none: <reason>"` | Small work only: waives the live run (G3 becomes n/a and prints the reason). Normal and large work may not waive it |

An optional `"merge_check"` is the command the merge hook runs instead of `gh pr checks`, for projects whose CI runs elsewhere: `{sha}` and `{pr}` are filled in, and exit 0 means CI is green on exactly that sha (for example `{ "merge_check": "scripts/ci-status.sh {sha}" }`). Without this file the gates do not apply, so the hook stays silent on work that is not running the loop.

`base` is also the branch a push may not target while the loop is active (see "Running them"). The optional `"status": "closed"` ends the loop: set it when the feature is merged and its metrics line is written (the close phase has passed). A closed loop is invisible to every hook and to `check-gates.sh`: they print nothing (`check-gates.sh` says "loop closed" and exits 0), the SessionStart summary is empty, and Stop no longer holds the session. Any other `status`, or none, means the loop is active.

`.scratch/` is untracked, so `git worktree add` does not copy it. A command that runs in a linked worktree of the repository (a builder's worktree) therefore uses the run file, the notes and the review file of the **main worktree**: the hooks look for `.scratch/gates.json` in the working directory, then in the git top level, then in the main worktree (the directory holding the common `.git`). The code they check is the worktree's own: the staged diff for a commit, the diff against `base` for G6, the checked-out HEAD for a merge.

## The gates

| ID | Applies to | Green when |
|---|---|---|
| G1 shape | normal, large | `.scratch/shape/<slug>.md` exists and lists at least one journey case ID of the form `J<n>.<case>` (for example `J3.two-actors`) |
| G2 envelope | all | `.scratch/envelope/<slug>.md` exists; its `**Packs:**` line is filled; its `## Live` table has at least one row on a normal or large change (a small change may leave it empty); every row has non-empty Severity, Mechanism, Enforced at and Proof cells, none of them `TBD`, `TODO` or `?` |
| G3 live | all (small may waive it with `"live": "none: <reason>"`) | the newest `.scratch/live/<run>/report.json` names, in its `head` field, the commit it ran on, and that commit is HEAD (or HEAD differs from it only by non-source files; file times never count), it has at least one scenario, and every scenario in it has `result: "pass"`; on normal and large work, every journey case ID from the shape file also appears in at least one scenario's `journey` field (small work proves its happy path only) |
| G4 evals | any size whose envelope `**Packs:**` line names `llm` or `retrieval` | `.scratch/evals/<slug>/results.json` exists, its `head` is HEAD (same rule as G3), and every entry in its `gates` array has `ok: true` |
| G5 review | normal, large | `.scratch/review/<slug>.md` exists; no row in its `## Findings` table is `CONFIRMED` with severity `CRITICAL` or `HIGH` and resolution `open` or empty |
| G6 craft | all | `concern-topics/scripts/slop-check.sh --diff <base> --justified .scratch/review/<slug>.md` reports nothing: every finding's `file:line` is listed under `## Justified` with a reason (the commit hook runs the same code with `--staged`, so the two never disagree about a review file) |
| G7 metrics | normal, large | `.scratch/loop-metrics.md` has a line containing `<slug>` (bypass records do not count); and when `.scratch/review/<slug>.md` has any `CONFIRMED` finding, the **last** such line carries `escapes=<n>` and `floors=<m>` with `n` at least the number of `CONFIRMED` rows in the review's Findings table (every confirmed finding is an escape) and `m` at least `n` (each escape raised a floor: a check, pack item, scenario or eval case) |
| G8 ledger | all, once `.scratch/loop-status.md` exists (n/a before) | every row of the stage table with status `done` has an Evidence cell that starts with `measured:`, `inferred:` or `assumed:`, and not one that is only `assumed:` (a stage cannot be done on an assumption); a row whose status is `done, from approved plan` must be stage 0, 1 or 3 (baseline, shape, to-tickets; stage 2 and every build, prove and later stage still run) and its evidence must be `inferred:` followed by one or more `docs/plans/<file>.md#<Section>` citations separated by `;`, each naming a file that exists and a section with content; `running` rows are ignored here, the Stop hook holds them |
| G9 stages | all; left out of a general check only where no stage log ever existed, and mandatory (red) at push and PR creation | the stages ran, in order, proven by the hook-owned signed logs, not by files: see "G9 stages" below. At the `merge`, `pr` and `close` phases a skill call alone is not enough: `code-review` needs `.scratch/review/<slug>.md` with a `## Findings` table and a `Head: <sha>` line for HEAD, and `live-verify` needs a G3 report on HEAD |
| G10 codex plan review | all, when `gates.json` has `plan_sha` (every loop started from an approved plan) and always in the `pr` phase | `.scratch/review/codex-plan-<slug>.json` has `kind: plan`, `exit_code: 0` and the configured model (`CODEX_REVIEW_MODEL`, default `gpt-6-astra`); the approved plan is whatever a signed `approve plan` holds, and it must be a committed version of the plan file (commit the plan before the owner approves it); the report's `subject_sha` is a committed version of the same file at or before the approved one (the findings are folded in after the review); the plan file now differs from the approved version only inside `## Changes` (the loop writes `Changed:` lines there), so those lines never need a new approval, while any edit of another section is red and says a changed plan needs `approve plan` again; every CONFIRMED finding has `fixed: <commit>` or `rejected: <reason>` in `codex-plan-<slug>.resolutions.md`. `plan_sha` in `gates.json` is informational and is not read for the decision |
| G11 codex code attack | all, as G10 | `.scratch/review/codex-code-<slug>.json` has `exit_code: 0`, the configured model, and `subject_sha` equal to HEAD (or HEAD differs only by non-source files); no CONFIRMED CRITICAL or HIGH without `fixed:` or `rejected:` in `codex-code-<slug>.resolutions.md`; each `fixed:` finding's repro is in `.scratch/review/codex-repros/<id>/` and the repo has an equivalent test (the repro file is tracked, or the fixing commit touched a test) |
| G12 acceptance | all, as G10 | every item under the plan's `## Acceptance tests` (ids `AT<n>`, else numbered in order) has a row in `.scratch/acceptance.md` (`\| AT id \| test path or scenario name \| last result on <sha> \|`) whose test cell is exactly one of: a live-verify scenario name (matched first, so a name with a dot or slash is still a name); a tracked test file path (`tests/a.test.js`, optionally with `:line`); or `path::test name` (also `path#name`, or a path followed by prose), and the result cell is `pass <sha>` for HEAD; the signed log has the owner's `approve acceptance` for exactly these tests (keyed to the tests, so an edited test needs a fresh approval) |

## G9 stages

The other gates check that files exist. G9 checks that the stages ran, because a file proves nothing about how it was made (a pilot ran every gate green with no stage skill invoked: the fix was written first and the shape, envelope, spec and ticket files were backfilled when the commit gate blocked it).

**The rule:** no source change before the planning skills for the size have run. Source is every path outside `.scratch/`, `docs/plans/`, `docs/agents/`, `docs/adr/`, `GLOSSARY.md` and `.claude/settings.json`. The planning skills are:

| Size | Before the first source change |
|---|---|
| small | `behavioral-envelope` |
| normal, large | one of `grilling`, `grill-with-docs`, `shape`; and `deep-engineering`, `behavioral-envelope`, `to-spec`, `to-tickets` |

`plan-first` also meets the first slot and the `to-tickets` slot. A stage whose ledger row says `done, from approved plan` (G8 checks it) counts for its slot only when the plan file existed when the loop started and is unchanged since (hashed at init, with its `## Changes` section left out): a plan written or edited mid-loop waives nothing.

**The log** is one chained, signed file, `.scratch/.loop/log.jsonl`, written only by hooks (`scripts/stage-hook.sh`, registered in `hooks/hooks.json`) while a loop is active. Record kinds:

- `init`: the signed start of the loop: slug, size, base and its sha, the merge-base with `base`, the commit the session started on (see below) and the start sha, which is that commit when it descends from the merge-base, else the merge-base itself, the plan file and its hash, the branches and worktree count. A new loop starts a new `init` only after the last one closed; a larger size in `gates.json` appends `size`, and a base that resolves later appends `base`. **The size used is the largest ever recorded or asked for: it cannot be lowered.**
- `skill`: every Skill tool call (PostToolUse) and every typed `/skill` (UserPromptExpansion, `"via":"slash"`, because typing a skill bypasses the Skill tool). Failed calls (PostToolUseFailure) are not logged.
- `agent`: `subagent_type`, `model`, `resolved` (the model the subagent started on), `description` for every Agent call.
- `violation` and `cleared`: after every tool call, successful or failed, the hook lists source changed since the start sha (`git status --porcelain` with untracked files, plus `git diff <start sha>`, so committed source counts). If source changed and a planning skill for the size is missing, it appends a violation with the paths and the git blob hashes of what was written, and exits 2 so the model sees why. A violation is cleared only when no source change is left against the start sha, every planning skill is logged, **and** nothing was hidden away: no `git stash` entry, no `git worktree` and no branch holding source made after the loop started. If a violation's content (same blob hash) reappears after a clear, the violation is reopened: restore does not count, write it again.
- `close`: appended by `check-gates.sh` when a full close phase passes with G9 evaluated.

Every line carries `seq`, `prev` (the HMAC of the line before) and `mac` (HMAC-SHA256 under the loop key). The key lives in `<repo>/.claude/.loop/key`, in a directory that ignores itself. The log tip (`seq` and `mac`) and the loop-active marker live outside the repo, in `$FEATURE_LOOP_STATE_DIR/<repo id>/state.json` (else `$HOME/.cache/feature-loop/<repo id>/state.json`, else `.claude/.loop/out/` when HOME cannot be written). `check-gates.sh` rejects, each as red: a wrong HMAC, a removed or inserted line, a non-JSON line, a log shorter than its tip (truncated), a log that is gone after init, a missing key (never regenerated: the hook says so and exits 2) and a missing state file.

**Green when** (phase `build`): the log verifies; `gates.json` still names the loop that was started; its base resolved at init and still resolves; no open violation; and the tree has no source change while a planning skill is missing (G9 re-checks the tree itself, so a source change no hook caught is still red). Phases `merge` and `close` add, from the log, each logged **after the last source change** (a 2 second margin absorbs commit-time rounding):

- every size: `code-review` and `live-verify` (and its report, G3); normal and large also `adversarial-review`; small also `wp-loop` (not ordered).
- large: a subagent on `opus` (the requested or the resolved model) whose description names the design challenge, logged before the first `to-spec`, and `.scratch/design-challenge/<slug>.md` written after it. A plan that existed at init with a filled Design challenge section meets both parts (plan mode ran it before the loop could log).
- close only: `retro`.

**Mandatory at push and merge:** the push, PR-create and merge hooks call `check-gates.sh --require-stages`, with which a loop that has no signed init entry is **red**, not n/a. Where the log has never existed, and without the flag, G9 is left out of a general check and says `n/a` only when named. The hooks also refuse a push or a merge when the loop was started here but `.scratch/gates.json` is gone, or says `"status": "closed"` with no signed `close` entry (`stage-guard.mjs`): close a loop by passing `check-gates.sh --phase close`, then set `closed`.

**The baseline (N1, N2).** Code committed in this session before `gates.json` exists must not become the baseline, so the SessionStart hook records, outside the repo (`<state dir>/sessions/<session id>.json`), the commit each repository was on when the session began. The init diffs from that commit, so commits from before the session are allowed and commits made in this session are not. A record not made by SessionStart (a tool call made it, because SessionStart did not run or the record had been deleted) is not trusted, and the baseline is then the merge-base with `base`: every commit of the branch counts. G9 is red when a signed init's baseline is neither the merge-base nor the recorded session start descending from it. Reviews count when logged at or after the last source commit time less 1 second of clock rounding; none earlier.

Not logged: anything before the loop's `gates.json` exists (grilling, plan mode); the very first tool call after `gates.json` appears creates the init, so code written in that same call is baseline. For repos that vendor the skills instead of installing the plugin, the hooks block is in FORK.md section 9.

## The review file

`adversarial-review` writes `.scratch/review/<slug>.md`:

```markdown
## Findings

| ID | Axis | Category | Severity | Status | Resolution |
|---|---|---|---|---|---|
| F1 | concurrency | CONC-09 | CRITICAL | CONFIRMED | fixed in a1b2c3d, test `two-users-race` |
| F2 | security | SEC-04 | MEDIUM | PLAUSIBLE | filed #42 |

## Justified

- `src/jobs.mjs:142` CRAFT-13.sleep-wait: drain loop during shutdown, bounded by SHUTDOWN_GRACE_MS
```

## The approved plan

The plan is a tracked file, so builders commit its `Changed:` lines with the code and the PR shows the plan diff. Plan mode writes it to `docs/plans/<file>.md` when the target repo's `.claude/settings.json` sets `"plansDirectory": "docs/plans"`. It follows [plan-template.md](../plan-first/plan-template.md), written by the model-invoked `plan-first` skill, which holds the planning rules. `check-gates.sh --plan` is not a gate (the loop can run without a plan): it reports, one line each, every required section (Decisions, Size and why, External dependencies, Files to create or change, Skeleton ticket, Tickets and seams, Skill per stage, Verification, Failure modes, Time box, Concerns, Design challenge) that is missing or empty (blank, comments only, `TBD`, `TODO`, `?` or a `<placeholder>`), and every `Changed:` line under `## Changes` that has no `because <reason>`. Exit 0 complete, 1 red, 2 no plan file. The loop asks the user only about the sections it names. G8 reads the plan too, for the ledger rows marked `done, from approved plan`.

## Running them

```
<feature-loop>/scripts/check-gates.sh                  # every gate that applies (the close phase), exit 0 green, 1 red, 2 usage
<feature-loop>/scripts/check-gates.sh G2 G6            # only these
<feature-loop>/scripts/check-gates.sh --phase build    # G1 G2 G8 G9
<feature-loop>/scripts/check-gates.sh --phase merge    # G1 to G6, G8 and G9
<feature-loop>/scripts/check-gates.sh --phase close    # all nine, as with no phase
<feature-loop>/scripts/check-gates.sh --timebox        # only the time box; exit 1 when demo_by passed with no passing live run
<feature-loop>/scripts/check-gates.sh --plan [FILE]    # only the approved plan (default: the newest docs/plans/*.md); needs no gates.json
```

Each red gate prints one line: the gate ID, what is missing, and the file to fix. Every gate is still subject to its size (the "Applies to" column), and a phase together with gate IDs checks the gates in both.

### Phases

The gates are not all due at the same time. Feature-loop pushes slices during Build, before the live run, the review and the metrics exist; no PR exists until the `pr` phase is green and the owner approves; G7 is written after the owner merges. So each moment asks for the gates that can be green by then:

| Phase | Gates | Asked by |
|---|---|---|
| `build` | G1, G2, G8, G9 | the hook on `git push` |
| `merge` | G1, G2, G3, G4, G5, G6, G8, G9 | you, before stop 3, as a quick check of the build's evidence |
| `pr` | G1 to G6 and G8 to G12, then `PR-CI` (CI green on the exact pushed HEAD, via `gh run list --commit <sha>`, or, only when GitHub reports no CI workflows for the repository, `merge_check` from `gates.json`, printed as `PR-CI green (merge_check, no CI workflows)`) and `PR-APPROVAL` (the owner's signed `approve pr` for exactly HEAD: a later commit, even of a file that is not source, needs a new approval) | the hook on PR creation: `gh pr create` or `gh pr new` (draft or not), `gh api` POST to `.../pulls`, a `createPullRequest` mutation, and the GitHub MCP `create_pull_request` tool |
| `close` | G1 to G9, G7 included | you, after the merge, once the metrics line is written; also what `check-gates.sh` runs with no phase |

### The hooks

The plugin hooks (hooks/hooks.json) act only while a loop is active (`.scratch/gates.json`, not closed; worktrees resolve to the main worktree's, see "The run file"):

- **push** runs `--phase build`; **PR creation** runs `--phase pr --require-stages` and has no bypass. A `git push` whose target is the `base` branch (`git push origin HEAD:main`, `git push origin main`, `--all`, or a plain `git push` while the base branch is checked out) is refused: merge through the PR so the merge gate runs. This has no bypass, not even `FEATURE_LOOP_GATES=off`. The repository a push acts on is the one the command names: `git -C <dir>`, `--git-dir`, `--work-tree` and `GIT_DIR=` / `GIT_WORK_TREE=` prefixes are followed.
- **commit** runs `slop-check.sh --staged` on what the commit will contain, in the worktree the commit runs in, with the review file of the loop root.
- **merge** is refused while a loop is active, through every route (`gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, `gh api -X POST .../merges`, a `mergePullRequest` or `enablePullRequestAutoMerge` mutation, the GitHub MCP `merge_pull_request` and auto-merge tools), with no bypass: the owner merges. A `gh api graphql` call whose query is read from a file or stdin (`-F query=@file`, `-f query=@...`, `--input`) cannot be inspected and is refused too while a loop is active.
- **GitHub MCP tools** (every tool of a server with `github` in its name) are checked by `mcp-pr-hook.sh`: reads pass; merge-like tools and `update_pull_request_branch` are refused; `create_or_update_file`, `push_files` and `delete_file` are refused when their `branch` is the base branch or is not named; `create_pull_request` needs the `pr` phase green.
- **Every PR asks the owner; wp-loop merges are refused** (`wp-pr-guard.mjs`, called by the gate hook and the MCP hook, fork.9.7 to 9.14): every PR creation by any route, from the main folder or any worktree, returns `permissionDecision: "ask"`, so Claude Code asks the owner in every permission mode and the PR opens only on their yes (in the feature loop, after the pr phase is green). Where the owner's workflow is running (the approvals store, no `init`), a PR is refused outright, without asking, until `tdd`, `code-review`, `adversarial-review` and `pr` were called with that branch's name in the args, no tracked file has an uncommitted edit, `.scratch/checks/<branch>/countdown.md` exists and the newest `.scratch/posts/<branch>-<n>.md` carries `7 of 8 done` (fork.9.16), and every merge is refused.
- **The owner's workflow rules on Bash** (`owner-guard.mjs`, called by the gate hook before its fast path, fork.9.16; active where a loop runs or the signed store exists): a made-up commit author or committer is refused (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`, `git -c user.name|user.email`, `--author`, `git config user.name|user.email <value>`); `git worktree add` with a path inside the repo folder is refused; a mutation run (a runner such as python, pytest, node or mutmut with mutat/mutant/mutmut/stryker in the command) is refused in the main working copy and in any worktree with a branch checked out, and runs through `sandbox.sh` (a detached copy of HEAD outside the repo, removed after). `cd` and `git -C` are followed.
- **Agent tool with `isolation: "worktree"`** is checked by `agent-base-hook.mjs` (fork.9.3): such a worktree starts from the default branch, not HEAD, so while a loop is active and HEAD is ahead of that branch the call is refused and told to cut the worktree from HEAD (`git worktree add --detach <dir> HEAD`). Where a loop runs or the signed store exists (fork.9.16) it also refuses `run_in_background: true` (a background subagent dies when the turn ends) and the `EnterWorktree` tool (its worktree is inside the repo folder). It needs node; without node the call passes.
- **visibility** (PostToolUse): one line to the owner per stage change, gate result, codex result, test, CI or live run, push and PR, and a row in `.scratch/timeline.md`; `ESCALATION:` lines for a change to the approved plan's `## Changes`, a codex CONFIRMED CRITICAL or HIGH, `FEATURE_LOOP_GATES=off`, an edit of the envelope Packs line after a red G4, a touch or hand edit of `.scratch/live/`, `.scratch/evals/` or `.scratch/review/codex-*.json`, and a force push, branch delete or `reset --hard` of a pushed branch.
- **hand-off** (PostToolUse on ExitPlanMode): tells Claude not to implement, to commit the plan, run the codex plan review, fold its findings in and show the owner the result (stop 2).
- **approvals** (UserPromptSubmit): a line of the owner's prompt that starts with `approve acceptance`, `approve plan` or `approve pr` is signed into the stage log with its subject (the acceptance tests' key, the plan file's sha256, HEAD). The hook's message to the owner names the file and the full sha or key. With more than one candidate file (several `docs/plans/*.md`, or several files in `docs/acceptance/`, else `docs/plans/`) files that the default branch (`origin/HEAD`) already holds with the same content are dropped first, since an earlier feature shipped them; if more than one is still left, the prompt must name one, `approve plan docs/plans/x.md`; otherwise nothing is recorded and the message says so. Plan hashes are of the file with CRLF turned into LF (`tr -d '\r' < plan.md | sha256sum`), so they are the same on Windows and Linux; A `plan_sha` in `gates.json` is that number, kept for reading; it is not what G10 decides by. Gates read only verified entries; a hand-written approval counts for nothing.
- **fail closed**: with a loop active, a missing `node`, a hook that cannot read its input, a `gates.json` that is not valid JSON, or a chained `git add` that fails blocks the command (exit 2) and says why. Only with no loop active do these end in a warning.

A deliberate bypass (commits and pushes only; never a push to the base branch, PR creation or a merge) is `FEATURE_LOOP_GATES=off` with a reason in `FEATURE_LOOP_BYPASS_REASON`; the hook appends the bypass and its reason to `.scratch/loop-metrics.md`, so every skipped gate is on record.

## Limits: tamper-evident, not tamper-proof

The hooks, the signed log and the gates run as the same OS user as the agent. They guide the agent and record what happened, and they make a skipped step visible (an `ESCALATION:` line, a timeline row, a red gate), but they cannot stop a determined agent: an agent that can run commands can run the approval hook itself, forge an evidence file or call a command by a route the hooks do not read (a script it wrote, a variable that holds the command). This is by design a tamper-evident system, not a tamper-proof one. Do not read a green gate as proof that no one cheated; read it as proof that no one cheated by accident or in the open.

The hard guarantee for "the owner merges" is not in this plugin. It is GitHub branch protection on the base branch with a required review (and no bypass for admins), and an agent token that has no merge rights. With both, no hook failure, missing `node` or clever command line can merge. Set them up on any repository where the owner's merge must hold.
