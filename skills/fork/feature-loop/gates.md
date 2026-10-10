# Gates

A gate is a check on a file a stage leaves behind. It is either green or red, and `scripts/check-gates.sh` decides which, not the agent. Each stage's **Done when** line in the skills names the same condition the gate checks, so the wording and the script agree.

All files live under `.scratch/` in the target repo. `<slug>` is the feature's slug.

## The run file

`feature-loop` writes `.scratch/gates.json` when it sizes the work:

```json
{ "slug": "reply-options", "size": "normal", "base": "main" }
```

`size` is `small`, `normal` or `large`. An optional `"codex_review": true` opts the repo in to the Codex plan review (G9, see "The Codex plan review" below); without it Codex is never invoked and G9 is not part of a run. An optional `"merge_check"` is the command the merge hook runs instead of `gh pr checks`, for projects whose CI runs elsewhere: `{sha}` and `{pr}` are filled in, and exit 0 means CI is green on exactly that sha (for example `{ "merge_check": "scripts/ci-status.sh {sha}" }`). Without this file the gates do not apply, so the hook stays silent on work that is not running the loop.

`base` is also the branch a push may not target while the loop is active (see "Running them"). The optional `"status": "closed"` ends the loop: set it when the feature is merged and its metrics line is written (the close phase has passed). A closed loop is invisible to every hook and to `check-gates.sh`: they print nothing (`check-gates.sh` says "loop closed" and exits 0), the SessionStart summary is empty, and Stop no longer holds the session. Any other `status`, or none, means the loop is active.

`.scratch/` is untracked, so `git worktree add` does not copy it. A command that runs in a linked worktree of the repository (a builder's worktree) therefore uses the run file, the notes and the review file of the **main worktree**: the hooks look for `.scratch/gates.json` in the working directory, then in the git top level, then in the main worktree (the directory holding the common `.git`). The code they check is the worktree's own: the staged diff for a commit, the diff against `base` for G6, the checked-out HEAD for a merge.

## The gates

| ID | Applies to | Green when |
|---|---|---|
| G1 shape | normal, large | `.scratch/shape/<slug>.md` exists and lists at least one journey case ID of the form `J<n>.<case>` (for example `J3.two-actors`) |
| G2 envelope | all | `.scratch/envelope/<slug>.md` exists; its `**Packs:**` line is filled; its `## Live` table has at least one row on a normal or large change (a small change may leave it empty); every row has non-empty Severity, Mechanism, Enforced at and Proof cells, none of them `TBD`, `TODO` or `?` |
| G3 live | normal, large | the newest `.scratch/live/<run>/report.json` is newer than the last commit, every scenario in it has `result: "pass"`, and every journey case ID from the shape file appears in at least one scenario's `journey` field |
| G4 evals | any size whose envelope `**Packs:**` line names `llm` or `retrieval` | `.scratch/evals/<slug>/results.json` exists, is newer than the last commit, and every entry in its `gates` array has `ok: true` |
| G5 review | normal, large | `.scratch/review/<slug>.md` exists; no row in its `## Findings` table is `CONFIRMED` with severity `CRITICAL` or `HIGH` and resolution `open` or empty |
| G6 craft | all | `concern-topics/scripts/slop-check.sh --diff <base> --justified .scratch/review/<slug>.md` reports nothing: every finding's `file:line` is listed under `## Justified` with a reason (the commit hook runs the same code with `--staged`, so the two never disagree about a review file) |
| G7 metrics | normal, large | `.scratch/loop-metrics.md` has a line containing `<slug>` (bypass records do not count); and when `.scratch/review/<slug>.md` has any `CONFIRMED` finding, the **last** such line carries `escapes=<n>` and `floors=<m>` with `n` at least the number of `CONFIRMED` rows in the review's Findings table (every confirmed finding is an escape) and `m` at least `n` (each escape raised a floor: a check, pack item, scenario or eval case) |
| G8 ledger | all, once `.scratch/loop-status.md` exists (n/a before) | every row of the stage table with status `done` has an Evidence cell that starts with `measured:`, `inferred:` or `assumed:`, and not one that is only `assumed:` (a stage cannot be done on an assumption); `running` rows are ignored here, the Stop hook holds them |
| G9 plan review | all, only when `.scratch/gates.json` has `"codex_review": true` (n/a with that reason when asked for by name without it) | `.scratch/receipts/<slug>/G9.json` is a completed, schema-valid receipt with a passing verdict whose plan hash equals the hash of `.scratch/contract/<slug>.md` plus `.scratch/spec/<slug>.md` (for a small change the contract file alone) |

## The Codex plan review (G9)

For a repo that opted in with `"codex_review": true`, the lead runs `scripts/codex-review.mjs gate-a` once the contract is written and the spec snapshot is saved. It is the only code that starts Codex, and `scripts/receipts.mjs` is the only code that reads its receipt.

- **Consent.** Without the flag the wrapper exits 2 before starting anything. Source leaves the machine only for opted-in repos.
- **Isolation.** Codex runs with `--ignore-user-config` in a scratch export of the tracked files at the reviewed sha, outside the repo, without `.codex/`, `AGENTS.md` and `CLAUDE.md` at any depth. Codex gets a scratch `CODEX_HOME` holding only a copy of the login (`--ignore-user-config` does not skip `$CODEX_HOME/AGENTS.md`); a login Codex refreshes is written back. The one mode is `stdin-no-tools`: the plan goes in on stdin, every tool that can touch a file is switched off, and a review that shows any tool activity is invalid. A permission-profile mode was dropped because Codex 0.162.1 refuses to start with one on Windows, so it has no live proof. Codex is found only in absolute PATH entries, never by a bare name that Windows would look up in the export. The wrapper exports only the repository `--root` belongs to. The receipt records the mode and keeps round counts per plan hash.
- **Failures.** Codex exits 1 for every failure, so the wrapper reads the error lines (stderr lines starting `ERROR` or `Error`, and top-level `error` or `turn.failed` events; never the banner or the model's text): usage limit, `Quota exceeded` or a 429 retry limit end as `paused` (rerun later, nothing is lost); an unrefreshable token or a 401 end as `blocked: codex login`; a timeout (the whole process tree is killed), a crash or malformed output end as `blocked` with the cause.
- **Rounds.** At most 2 Codex rounds per plan hash. A third attempt on the same plan prints `blocked:` with the open findings and stops: escalate to the human. Editing the contract or spec starts a new hash. A finding blocks only if it carries a concrete failure scenario; otherwise it is advisory, and the wrapper, not the model's verdict, decides pass or fail.
- **Receipt.** `.scratch/receipts/<slug>/G9.json`, written to a temp file and renamed, with a schema version, a `completed` flag, the verdict (`pass`, `fail`, `paused`, `blocked`), the round, the plan hash, the model, the Codex CLI version, the isolation mode and timestamps.

The mock-driven tests are `scripts/test-codex-review.mjs` and `scripts/test-receipts.mjs` (`node --test`); no test calls real Codex.

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

## Running them

```
<feature-loop>/scripts/check-gates.sh                  # every gate that applies (the close phase), exit 0 green, 1 red, 2 usage
<feature-loop>/scripts/check-gates.sh G2 G6            # only these
<feature-loop>/scripts/check-gates.sh --phase build    # G1 G2 G8, and G9 when codex_review is on
<feature-loop>/scripts/check-gates.sh --phase merge    # G1 to G6 and G8
<feature-loop>/scripts/check-gates.sh --phase close    # every gate, as with no phase
```

Each red gate prints one line: the gate ID, what is missing, and the file to fix. Every gate is still subject to its size (the "Applies to" column), and a phase together with gate IDs checks the gates in both.

### Phases

The gates are not all due at the same time. Feature-loop pushes slices and opens the draft PR during Build, before the live run, the review and the metrics exist, and G7 is written after the merge. So each moment asks for the gates that can be green by then:

| Phase | Gates | Asked by |
|---|---|---|
| `build` | G1, G2, G8, G9 | the hook on `git push`, `gh pr create`, `gh api` POST to `.../pulls` and a `createPullRequest` mutation |
| `merge` | G1, G2, G3, G4, G5, G6, G8 | the hook on a merge (`gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, a `mergePullRequest` mutation) |
| `close` | G1 to G9 (G9 only with `codex_review`), G7 included | you, after the merge, once the metrics line is written; also what `check-gates.sh` runs with no phase |

### The hooks

The plugin hooks (hooks/hooks.json) act only while a loop is active (`.scratch/gates.json`, not closed; worktrees resolve to the main worktree's, see "The run file"):

- **push and PR creation** run `--phase build`. A `git push` whose target is the `base` branch (`git push origin HEAD:main`, `git push origin main`, `--all`, or a plain `git push` while the base branch is checked out) is refused: merge through the PR so the merge gate runs.
- **commit** runs `slop-check.sh --staged` on what the commit will contain, in the worktree the commit runs in, with the review file of the loop root.
- **merge** needs the sha being merged (`--match-head-commit`, `sha=`, `expectedHeadOid`); refuses unless the checked-out HEAD is that sha ("check out the PR head <sha> first", because the gates read the local tree); runs `--phase merge`; and needs green CI on exactly that sha.
- **fail closed**: with a loop active, a missing `node`, a hook that cannot read its input, a `gates.json` that is not valid JSON, or a chained `git add` that fails blocks the command (exit 2) and says why. Only with no loop active do these end in a warning.

A deliberate bypass is `FEATURE_LOOP_GATES=off` with a reason in `FEATURE_LOOP_BYPASS_REASON`; the hook appends the bypass and its reason to `.scratch/loop-metrics.md`, so every skipped gate is on record.
