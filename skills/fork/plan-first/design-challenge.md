# Design challenge inside plan mode

The adversarial review of the design runs **before the plan is approved**, as a read-only subagent against the draft plan, so the plan the user approves has already survived it. There is no second approval after stage 2.

## When it runs

Large work, and normal work whose envelope has a Critical Live item (small work with a Critical item is not small: escalate it first). Otherwise the plan's `## Design challenge` says `n/a: <reason>`.

## How to launch it

1. The plan file is in `docs/plans/`, with every section except `Design challenge` filled, and `detect-packs.sh --plan` has been run and its output is in `## Concerns`.
2. Launch **one** subagent on the strongest model (`model: "opus"`) with a fresh context. Use Claude Code's built-in `Plan` subagent: its Write and Edit tools are denied (see FORK.md section 8), but it keeps Bash, so it is **read-only by instruction** for shell commands: the brief forbids any command that changes files, the repo or the network, and the lead checks `git status` is unchanged after it returns. When a hard guarantee is needed, use a subagent whose `tools` list is only `Read, Grep, Glob`. The agent reads the plan file and the repo; it writes nothing. It returns its findings as text and the lead writes them into the plan.
3. The brief, in full:
   > Attack this draft plan against the code. Read `docs/plans/<file>.md` and the files it names. Break the design: for each Critical and High concern in the plan, find where the plan's mechanism fails against the real code, and for each ticket whether its seam exists and can catch what the plan says it catches. Report CONFIRMED findings (with the file and line or the command that shows it) and PLAUSIBLE findings (what you could not confirm). Then list what to cut to reach a working live demo sooner without losing a Critical item. You may not edit anything and may run only read-only commands (no writes, no installs, no network, no git commands that change state). One round.
4. The lead folds every CONFIRMED finding into the plan with its resolution, records PLAUSIBLE ones with a decision, lists the accepted cuts, and writes all of it under `## Design challenge`. One round only.
5. Run the `feature-loop` skill's `scripts/check-gates.sh --plan` until it exits 0, then present the plan for approval (see `plan-first`, step 5).

## If subagents cannot run in plan mode

The documented behaviour is that they can (the Plan subagent exists for exactly this). If a session or an admin setting blocks it, the closest documented alternative is: write the draft to `docs/plans/`, run the same brief in a fresh session started with `claude --permission-mode plan` (or any read-only agent) against that file, paste its findings under `## Design challenge`, and return to the planning session. The challenge is never skipped, and it is never run by the same context that wrote the plan.
