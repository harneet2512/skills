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
| G3 live | all (small may waive it with `"live": "none: <reason>"`) | the newest `.scratch/live/<run>/report.json` is newer than the last commit, it has at least one scenario, and every scenario in it has `result: "pass"`; on normal and large work, every journey case ID from the shape file also appears in at least one scenario's `journey` field (small work proves its happy path only) |
| G4 evals | any size whose envelope `**Packs:**` line names `llm` or `retrieval` | `.scratch/evals/<slug>/results.json` exists, is newer than the last commit, and every entry in its `gates` array has `ok: true` |
| G5 review | normal, large | `.scratch/review/<slug>.md` exists; no row in its `## Findings` table is `CONFIRMED` with severity `CRITICAL` or `HIGH` and resolution `open` or empty |
| G6 craft | all | `concern-topics/scripts/slop-check.sh --diff <base> --justified .scratch/review/<slug>.md` reports nothing: every finding's `file:line` is listed under `## Justified` with a reason (the commit hook runs the same code with `--staged`, so the two never disagree about a review file) |
| G7 metrics | normal, large | `.scratch/loop-metrics.md` has a line containing `<slug>` (bypass records do not count); and when `.scratch/review/<slug>.md` has any `CONFIRMED` finding, the **last** such line carries `escapes=<n>` and `floors=<m>` with `n` at least the number of `CONFIRMED` rows in the review's Findings table (every confirmed finding is an escape) and `m` at least `n` (each escape raised a floor: a check, pack item, scenario or eval case) |
| G8 ledger | all, once `.scratch/loop-status.md` exists (n/a before) | every row of the stage table with status `done` has an Evidence cell that starts with `measured:`, `inferred:` or `assumed:`, and not one that is only `assumed:` (a stage cannot be done on an assumption); a row whose status is `done, from approved plan` must be stage 0, 1 or 3 (baseline, shape, to-tickets; stage 2 and every build, prove and later stage still run) and its evidence must be `inferred:` followed by one or more `docs/plans/<file>.md#<Section>` citations separated by `;`, each naming a file that exists and a section with content; `running` rows are ignored here, the Stop hook holds them |

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
<feature-loop>/scripts/check-gates.sh --phase build    # G1 G2 G8
<feature-loop>/scripts/check-gates.sh --phase merge    # G1 to G6 and G8
<feature-loop>/scripts/check-gates.sh --phase close    # all eight, as with no phase
<feature-loop>/scripts/check-gates.sh --timebox        # only the time box; exit 1 when demo_by passed with no passing live run
<feature-loop>/scripts/check-gates.sh --plan [FILE]    # only the approved plan (default: the newest docs/plans/*.md); needs no gates.json
```

Each red gate prints one line: the gate ID, what is missing, and the file to fix. Every gate is still subject to its size (the "Applies to" column), and a phase together with gate IDs checks the gates in both.

### Phases

The gates are not all due at the same time. Feature-loop pushes slices and opens the draft PR during Build, before the live run, the review and the metrics exist, and G7 is written after the merge. So each moment asks for the gates that can be green by then:

| Phase | Gates | Asked by |
|---|---|---|
| `build` | G1, G2, G8 | the hook on `git push`, `gh pr create`, `gh api` POST to `.../pulls` and a `createPullRequest` mutation |
| `merge` | G1, G2, G3, G4, G5, G6, G8 | the hook on a merge (`gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, a `mergePullRequest` mutation) |
| `close` | G1 to G8, G7 included | you, after the merge, once the metrics line is written; also what `check-gates.sh` runs with no phase |

### The hooks

The plugin hooks (hooks/hooks.json) act only while a loop is active (`.scratch/gates.json`, not closed; worktrees resolve to the main worktree's, see "The run file"):

- **push and PR creation** run `--phase build`. A `git push` whose target is the `base` branch (`git push origin HEAD:main`, `git push origin main`, `--all`, or a plain `git push` while the base branch is checked out) is refused: merge through the PR so the merge gate runs.
- **commit** runs `slop-check.sh --staged` on what the commit will contain, in the worktree the commit runs in, with the review file of the loop root.
- **merge** needs the sha being merged (`--match-head-commit`, `sha=`, `expectedHeadOid`); refuses unless the checked-out HEAD is that sha ("check out the PR head <sha> first", because the gates read the local tree); runs `--phase merge`; and needs green CI on exactly that sha.
- **fail closed**: with a loop active, a missing `node`, a hook that cannot read its input, a `gates.json` that is not valid JSON, or a chained `git add` that fails blocks the command (exit 2) and says why. Only with no loop active do these end in a warning.

A deliberate bypass is `FEATURE_LOOP_GATES=off` with a reason in `FEATURE_LOOP_BYPASS_REASON`; the hook appends the bypass and its reason to `.scratch/loop-metrics.md`, so every skipped gate is on record.
