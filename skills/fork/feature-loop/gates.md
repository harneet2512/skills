# Gates

A gate is a check on a file a stage leaves behind. It is either green or red, and `scripts/check-gates.sh` decides which, not the agent. Each stage's **Done when** line in the skills names the same condition the gate checks, so the wording and the script agree.

All files live under `.scratch/` in the target repo. `<slug>` is the feature's slug.

## The run file

`feature-loop` writes `.scratch/gates.json` when it sizes the work:

```json
{ "slug": "reply-options", "size": "normal", "base": "main" }
```

`size` is `small`, `normal` or `large`. Without this file the gates do not apply, so the hook stays silent on work that is not running the loop.

## The gates

| ID | Applies to | Green when |
|---|---|---|
| G1 shape | normal, large | `.scratch/shape/<slug>.md` exists and lists at least one journey case ID of the form `J<n>.<case>` (for example `J3.two-actors`) |
| G2 envelope | all | `.scratch/envelope/<slug>.md` exists; its `**Packs:**` line is filled; its `## Live` table has at least one row on a normal or large change (a small change may leave it empty); every row has non-empty Severity, Mechanism, Enforced at and Proof cells, none of them `TBD`, `TODO` or `?` |
| G3 live | normal, large | the newest `.scratch/live/<run>/report.json` is newer than the last commit, every scenario in it has `result: "pass"`, and every journey case ID from the shape file appears in at least one scenario's `journey` field |
| G4 evals | any size whose envelope `**Packs:**` line names `llm` or `retrieval` | `.scratch/evals/<slug>/results.json` exists, is newer than the last commit, and every entry in its `gates` array has `ok: true` |
| G5 review | normal, large | `.scratch/review/<slug>.md` exists; no row in its `## Findings` table is `CONFIRMED` with severity `CRITICAL` or `HIGH` and resolution `open` or empty |
| G6 craft | all | `concern-topics/scripts/slop-check.sh --diff <base>` reports nothing, or every finding's `file:line` is listed under `## Justified` in `.scratch/review/<slug>.md` with a reason |
| G7 metrics | normal, large | `.scratch/loop-metrics.md` has a line containing `<slug>` |

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
<feature-loop>/scripts/check-gates.sh            # every gate that applies, exit 0 green, 1 red, 2 usage
<feature-loop>/scripts/check-gates.sh G2 G6      # only these
```

Each red gate prints one line: the gate ID, what is missing, and the file to fix. The plugin hook runs the script before `git push` and `gh pr create` whenever `.scratch/gates.json` exists. A deliberate bypass is `FEATURE_LOOP_GATES=off` with a reason in `FEATURE_LOOP_BYPASS_REASON`; the hook appends the bypass and its reason to `.scratch/loop-metrics.md`, so every skipped gate is on record.
