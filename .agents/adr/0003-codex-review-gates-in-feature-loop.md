# Cross-vendor review gates: Codex reviews as feature-loop gates G9 and G10, not a second orchestrator

HAR-161 asks for a single-command, fail-closed Claude Code plus Codex workflow: a plan, an adversarial plan review (Gate A), implementation, an adversarial pre-PR review of the full diff (Gate B), repair, then a PR that is never merged by the agent. It asks for this to be enforced by executable checks, not skill prose, and it forbids replacing or duplicating skills that already work.

The fork already has most of that machinery in `feature-loop`. This ADR records how HAR-161 maps onto it, what is genuinely missing, and the decisions the later tickets (HAR-163 to HAR-167) build on.

## Inventory (as of 2026-10-10, `main` at `fe89a66`)

**Entry points.** `feature-loop` is the one entry for a feature (it sizes the work, then runs stages 0 to 9). `wp-loop` is the single-issue path for Small work and the merge gate plus report for Normal and Large. Both are model-invoked fork skills shipped in the plugin.

**Enforcement that already exists** (`hooks/hooks.json`, `skills/fork/feature-loop/scripts/`):

| Moment | Mechanism | Refuses when |
|---|---|---|
| `git commit` | PreToolUse on Bash, `gate-hook.sh` | `slop-check --staged` has unjustified findings |
| `git push`, `gh pr create` / `gh pr new`, `gh api` POST to `.../pulls`, GraphQL `createPullRequest` | same hook, `--phase build` | a build-phase gate (G1, G2, G8) is red, or the push targets the base branch |
| `gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, GraphQL `mergePullRequest` | same hook, `--phase merge` | a merge-phase gate is red, CI is not green on the exact head, `--match-head-commit` is missing, or HEAD is not that sha |
| end of turn | Stop hook | a ledger row in `.scratch/loop-status.md` is `running` |

The checker (`check-gates.mjs`) fails closed: a missing or invalid `.scratch/gates.json`, a missing `node`, or unreadable hook input blocks the command while a loop is active. `test-gates.sh` covers it and runs in `fork-ci.yml` on every push and PR. An audited emergency bypass exists (`FEATURE_LOOP_GATES=off` plus `FEATURE_LOOP_BYPASS_REASON`, logged to `.scratch/loop-metrics.md` and reviewed in stage 9).

**Supported shells.** Git Bash on Windows (the maintainer's machine) and bash on `ubuntu-latest` in CI. Node 22, no npm dependencies in the gate scripts.

**Existing reviewers.** All Claude. `adversarial-review` names a "second model" slot but nothing wires a different vendor into it. The only working Codex invocation on the maintainer's machine is in gstack's review skill: `codex exec "<prompt>" -C <repo> -s read-only -c model_reasoning_effort="high"`.

**Gaps the new work must close:**

1. No gate checks that an independent reviewer looked at the plan, or at the exact diff being shipped.
2. The PreToolUse matcher is `Bash` only. A PR created or merged through an MCP tool (for example a GitHub MCP server's `create_pull_request` or `merge_pull_request`) is not intercepted. HAR-163 adds those tool names to the matcher, or denies them while a loop is active.
3. "Stopped" is not "stage complete" for review stages: nothing records which revision a reviewer saw.

## Decision

### 1. Extend feature-loop; do not build a second orchestrator

HAR-161's states map onto the existing stage ledger. No new orchestrator, state file or PR command is added.

| HAR-161 state | Feature-loop equivalent |
|---|---|
| DISCOVER | stages 0 and 1 (baseline, shape) |
| PLAN | stages 2 and 3 (contract, spec, tickets) |
| PLAN_REVIEW | new: Gate A at the end of stage 2, receipt checked by G9 |
| IMPLEMENT | stage 4 (build) |
| VERIFY | stage 5 (prove) |
| CODE_REVIEW | stage 6 (attack), now including Gate B, receipt checked by G10 |
| REPAIR | stage 4 and 6 fix rounds |
| PR_READY | stage 7 up to the merge gate (the agent opens the PR, never merges without the human) |
| BLOCKED | ledger status `blocked: <decision needed>` |
| PAUSED (new, HAR-166) | ledger status `paused: <reason>`, resumable; never satisfies a gate |

HAR-161's "narrow controlled PR creation command" is the existing PR-creation hook plus the new gates in the `build` phase. A separate command would be a second path to the same `gh` call, and the hook already catches the direct one.

### 2. Two receipt gates

- **G9, plan-review receipt (Gate A, HAR-163).** Green when a receipt exists for the current plan hash with a passing verdict. Joins the `build` phase.
- **G10, diff-review receipt (Gate B, HAR-164).** Green when a receipt exists whose base and head sha and content fingerprint (uncommitted changes included) equal what is being shipped, with a passing verdict. Joins the `build` and `merge` phases.

Receipts are versioned JSON under `.scratch/receipts/`, parsed strictly. Missing, malformed, wrong schema version, failing or stale means red. A change to reviewed content, tests, gate configuration or CI configuration after review makes G10 stale. A substantive plan change makes G9 stale. Both apply at every size; `small` uses a concise plan and the same receipt.

### 3. Codex is the reviewer, through `codex exec`

- Invocation: `codex exec -s read-only --output-schema <schema> -o <file>` (and `codex exec review --base <branch>` where a plain diff review fits), run in a separate read-only checkout. Verified on Codex CLI 0.162.1: `exec` accepts `-s read-only|workspace-write|danger-full-access`, `--output-schema`, `-o/--output-last-message`, `--json`, `-C`, `-c`, `--ephemeral`; `exec review` accepts `--base`, `--uncommitted`, `--commit`, `--title`, `--output-schema`, `--json`, `-o`.
- Never passed: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-s danger-full-access`. The maintainer's Codex config sets no `sandbox_mode` or `approval_policy`, so every call passes `-s` explicitly.
- Rejected alternatives:
  - `codex mcp-server`: removed upstream on 2026-09-05 (openai/codex commit `531f383`); 0.162.1 has no such subcommand.
  - OpenAI's `codex-plugin-cc` review gate: a Stop hook with no round cap. It decides only "stop or continue", cannot record which revision it reviewed, and cannot require test-backed findings. Claude's Stop hook is not proof a stage completed.
- Codex runs on the maintainer's ChatGPT login. A quota or rate-limit response pauses the stage (HAR-166); there is no fallback to a paid API key.
- The Codex binary is injectable so every gate test runs against a mock. No test calls the real CLI or creates a real PR.

### 4. Roles: Claude authors, Codex reviews read-only

Default: Claude plans and builds, Codex reviews. A `builder: claude|codex` setting in `.scratch/gates.json` is reserved for a later A/B comparison; receipts record author and reviewer identity so the metrics (HAR-166) can compare them.

### 5. Only test-backed findings block

The one controlled study of this pairing (arXiv 2607.21656, LiveCodeBench, 116 tasks) measured Codex reviewing Claude's drafts lowering the pass rate from 91.4% to 82.8%, because the reviewer discarded working solutions. Read-only review removes the rewrite path; the rule below removes the argument path:

- Gate A: a finding blocks only with a concrete failure scenario.
- Gate B: a finding blocks only with a repro (failing test or runnable command) that the wrapper runs and sees fail on the reviewed revision.
- Anything else is advisory: recorded in the receipt, shown to the human at the PR, never a reason to loop.
- Caps: 2 Codex rounds on the plan, 3 on the diff. A finding re-raised after an evidence-backed rebuttal escalates to the human (`blocked:`), never loops.
- Reviewer silence is not a pass. A receipt records a completed review or the gate is red.

Test strength (tests before implementation, seeded bugs the suite must catch) is HAR-165.

### 6. Limits of local enforcement

The hooks run inside Claude Code on the maintainer's machine. They cannot stop:

- a PR opened in GitHub's web UI, from another machine, or by a human typing `gh` in a terminal outside Claude Code;
- a person with local git access editing a receipt by hand.

Receipts make an agent skipping a gate detectable and blocked; they are not a defence against a malicious actor with unrestricted local access. Server-side enforcement needs GitHub branch protection on the default branch: require a pull request, require the fork CI job as a status check, require the branch to be up to date, and disallow force pushes. HAR-167 documents the exact settings, and CI re-validates the receipts it can check portably.

## Requirement map

| HAR-161 item | Delivered by |
|---|---|
| req 1 inventory, minimal modifications | this ADR (HAR-162) |
| req 2 state machine, no recursive hooks, no indefinite loops | decision 1 here; caps in HAR-163, HAR-164 |
| req 3 Gate A | HAR-163 |
| req 4 Gate B | HAR-164 |
| req 5 receipts, fail closed, guarded PR creation | HAR-163 (G9, MCP matcher gap), HAR-164 (G10) |
| req 6 project checks, bounded retries, no silent skips | HAR-164, HAR-165 |
| req 7 separate read-only reviewer, untrusted output | HAR-163, HAR-164 |
| req 8 risk tiers, audited exceptions | HAR-163 to HAR-165 (sizes); existing bypass logging |
| req 9 negative-path tests | split across HAR-163 to HAR-166, all in `test-gates.sh` |
| req 10 docs and walkthrough | HAR-167 |
| A1 test-backed findings | HAR-163, HAR-164 |
| A2 tests first, seeded bugs | HAR-165 |
| A3 PAUSED on quota | HAR-166 |
| A4 metrics | HAR-166 |
| A5 roles, caps, human gates | HAR-163, HAR-164 |
| A6 cleanup | HAR-162 (done on the maintainer's machine; see below) |

## Cleanup done under HAR-162 (outside this repo)

- `~/.claude/skills/collab` and `~/.claude/skills/council-setup.md` moved to `~/.claude/skills-archive/` with a README saying why. `collab` depended on a missing scripts directory and tmux and launched agents with full-bypass flags; `council-setup` wired an MCP server whose directory no longer exists.
- The `octo` plugin is already disabled in `~/.claude/settings.json`, so it is not selectable. It is left installed rather than uninstalled, because uninstalling deletes it.
- Codex CLI upgraded from 0.160.0 to 0.162.1.

## Invariants this creates

- No second orchestrator: a new review stage is a gate in `check-gates.mjs` plus a phase entry, tested in `test-gates.sh`.
- Every Codex call goes through one wrapper that sets `-s` explicitly and never passes a bypass flag.
- A gate that depends on a model's output checks a receipt bound to an exact revision, never the model's verdict text alone.
