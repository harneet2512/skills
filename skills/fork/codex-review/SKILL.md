---
name: codex-review
description: Get a second model's attack on a plan or a finished change through the Codex CLI (gpt-6-astra). Plan mode reviews an approved plan against the real repo before anything is built; code mode does adversarial review and adversarial testing of the branch head in an isolated worktree, writing repro tests for what it claims. Use when asked for a "codex review", a "plan review", "adversarial review" or "adversarial testing" with codex or gpt-6, right after plan mode finishes, and after live-verify and before the PR.
---

# Codex review

A second model, with no shared context and a different set of blind spots, attacks the work. Two modes, both run by `scripts/codex-review.sh` from the target repo root.

A finding is **CONFIRMED** only with proof: a `file:line` or command output for a plan finding, a repro test that fails on HEAD for a code finding. Everything else is **PLAUSIBLE**.

## Where it runs in the loop

- **After plan mode (plan review).** The plan is approved, nothing is built yet. Run plan mode on the plan file, fold every CONFIRMED finding into the plan, then show the owner the findings and the revised plan (stop 2) and wait.
- **After live-verify (code attack).** The integration branch head has passed its live run. Run code mode against the base the feature branched from. Fix every CONFIRMED CRITICAL or HIGH, watch its repro go red to green, and run the attack again on the new head. Repeat until none remain or each is rejected with a reason.

## Run it

From the target repo root:

```
<this skill>/scripts/codex-review.sh plan docs/plans/<file>.md --slug <slug>
<this skill>/scripts/codex-review.sh code <base> --slug <slug>
```

- Needs the `codex` CLI on PATH and `node`. The model is `gpt-6-astra`; set `CODEX_REVIEW_MODEL` to change it. `CODEX_REVIEW_TIMEOUT` is the limit in seconds (default 1800).
- Plan mode runs `codex exec` read-only in the repo. Code mode runs it with `workspace-write` in a throwaway `git worktree` at HEAD and removes the worktree afterwards. Your working tree is never touched. Uncommitted changes are not reviewed: commit first.
- **The slug is the `slug` of `.scratch/gates.json`.** Gates G10 and G11 read `codex-<plan|code>-<that slug>.json`, so a report under any other slug is invisible to them. Pass `--slug <slug from gates.json>`. The default is that slug when `.scratch/gates.json` exists, else the plan file's name (plan) or the branch name (code). Before a loop has started there is no `gates.json`: use the plan file's name, and make it the `slug` when the loop starts.
- A run takes from about half a minute (small plan) to the full timeout (large code attack). **Run it in the foreground**, never in the background: the hook that tells the owner reads the run's own output (the summary line and the `ESCALATION:` line), and a result that arrives later is not seen at the step it belongs to. Wait for it.
- Output, in `.scratch/review/`:
  - `codex-<plan|code>-<slug>.json`: `{kind, model, codex_version, subject_sha, base, started, finished, exit_code, summary, findings}`, checked against `schemas/findings.schema.json`. `subject_sha` is the sha256 of the plan file with its line endings normalised to LF (plan; the same number on Windows with CRLF and on Linux, and the number of the blob Git stores) or the HEAD commit (code).
  - `codex-<plan|code>-<slug>.md`: the same, readable.
  - `codex-repros/<finding id>/`: the repro test files codex wrote for each CONFIRMED code finding (`_unassigned/` for files no finding names). Port each into the repo's real test suite as part of the fix.
- It appends one row to `.scratch/timeline.md` (the feature loop's table format, through its `timeline.mjs`) and prints one summary line, such as `codex code attack on 1a2b3c4 by gpt-6-astra: 2 CONFIRMED (1 HIGH), 3 PLAUSIBLE`. Repeat that line to the owner. When the report holds a CONFIRMED CRITICAL or HIGH finding it prints one more line, starting `ESCALATION:`: tell the owner at once.

Exit codes: `0` it ran and wrote a report; `2` codex is missing or failed, its output was invalid, or usage was wrong; `3` timeout. **A failed run is reported, never faked**: tell the owner it failed and why, write no report by hand, and either re-run or log the skip as a bypass in `.scratch/loop-metrics.md`. Never edit the JSON.

## Resolutions

The script never writes a resolution. After reading the findings, the lead writes `.scratch/review/codex-<kind>-<slug>.resolutions.md`: one row per finding id, every id, PLAUSIBLE ones included.

```
| id | resolution |
| --- | --- |
| P1 | fixed: 4f2c1ab |
| P2 | rejected: the endpoint is read-only, see src/api.ts:40 |
```

`fixed: <commit>` names the commit that fixes it (for plan findings, the commit that changes the plan). `rejected: <reason>` needs a reason that cites evidence. Reject only with an argument, never because a finding is inconvenient.

## The owner sees everything

Show the owner the summary line and every CONFIRMED finding (id, severity, title, where) when a run finishes, before acting on them, and say which you will fix and which you will reject. A CONFIRMED CRITICAL or HIGH is told immediately. Rejections are decisions the owner can overrule.

## Tests

`scripts/test-codex-review.sh` runs the script against a stub `codex` (no model calls): stamping, worktree cleanup, schema rejection, exit codes, and an untouched target working tree.
