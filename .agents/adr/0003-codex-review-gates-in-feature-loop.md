# Cross-vendor review gates: Codex reviews as feature-loop gates G9 and G10, not a second orchestrator

HAR-161 asks for a single-command, fail-closed Claude Code plus Codex workflow: a plan, an adversarial plan review (Gate A), implementation, an adversarial pre-PR review of the full diff (Gate B), repair, then a PR that the agent never merges. It asks for this to be enforced by executable checks, not skill prose, and it forbids replacing or duplicating skills that already work.

The fork already has most of that machinery in `feature-loop`. This ADR records how HAR-161 maps onto it, where HAR-161 changes current behaviour, and the decisions the later tickets (HAR-163 to HAR-167) build on.

## Inventory (as of 2026-10-09, `main` at `fe89a66`)

**Entry points.** `feature-loop` is the single user-invoked entry for a feature (`disable-model-invocation: true`); it sizes the work, then runs stages 0 to 9. `wp-loop` is model-invoked: `feature-loop` calls it for the whole single-issue path on Small work, and for the merge gate plus report (its steps 12 and 13) on Normal and Large.

**Enforcement that already exists** (`hooks/hooks.json`, `skills/fork/feature-loop/scripts/`):

| Moment | Mechanism | Refuses when |
|---|---|---|
| `git commit` | PreToolUse on Bash, `gate-hook.sh` | `slop-check --staged` has unjustified findings |
| `git push`, `gh pr create` / `gh pr new`, `gh api` POST to `.../pulls`, GraphQL `createPullRequest` | same hook, `--phase build` | a build-phase gate (G1, G2, G8) is red, or the push targets the base branch |
| `gh pr merge`, `gh api -X PUT .../pulls/<n>/merge`, GraphQL `mergePullRequest` | same hook, `--phase merge` | a merge-phase gate is red, CI is not green on the exact head, `--match-head-commit` is missing, or HEAD is not that sha |
| end of turn | Stop hook | a ledger row in `.scratch/loop-status.md` is `running` |

While a loop is active, `gate-hook.sh` fails closed: a missing `node`, unreadable hook input, a `gates.json` that is not valid JSON, or a chained `git add` that fails blocks the command (exit 2). With no `.scratch/gates.json` there is no active loop and the hooks stay silent. `test-gates.sh` covers the checker and hooks and runs in `fork-ci.yml` on every push and PR. An audited emergency bypass exists (`FEATURE_LOOP_GATES=off` plus `FEATURE_LOOP_BYPASS_REASON`, logged to `.scratch/loop-metrics.md` and reviewed in stage 9).

**Current PR and merge behaviour.** The agent opens a draft PR during stage 4 (Build), after the first slice, and pushes slices to it. In stage 7 it marks the PR ready and merges it itself through `wp-loop` step 12. The only human stops are those in `feature-loop`'s "Visibility and the evidence ledger" section: a requirement that is a guess, the ticket breakdown and seams (stage 3), a CRITICAL or HIGH finding needing a product call, anything irreversible, and the floors to keep in stage 9.

**Supported shells.** Git Bash on Windows (the maintainer's machine) and bash on `ubuntu-latest` in CI. Node 22, no npm dependencies in the gate scripts.

**Existing reviewers.** All Claude. `adversarial-review` names a "second model" slot but nothing wires a different vendor into it. The only working Codex invocation on the maintainer's machine is in gstack's review skill: `codex exec "<prompt>" -C <repo> -s read-only -c model_reasoning_effort="high"`.

**Security boundaries today.** Everything runs locally with the maintainer's credentials. No hook restricts which model vendor sees the source: any reviewer the lead calls can read the whole checkout.

**Gaps the new work must close:**

1. No gate checks that an independent reviewer looked at the plan, or at the exact diff being shipped.
2. The PreToolUse matcher is `Bash` only. A PR created or merged through an MCP tool (for example a GitHub MCP server's `create_pull_request` or `merge_pull_request`) is not intercepted.
3. Nothing records which revision a reviewer saw, so "the reviewer stopped" cannot be told apart from "the reviewer approved this exact code".
4. The agent merges its own PR (stage 7), which HAR-161 forbids.

## Decision

### 1. Extend feature-loop; do not build a second orchestrator

HAR-161's states map onto the existing stage ledger. No new orchestrator, state file or PR command is added.

| HAR-161 state | Feature-loop equivalent |
|---|---|
| DISCOVER | stages 0 and 1 (baseline, shape) |
| PLAN | stage 2 (contract) and the `to-spec` half of stage 3 |
| PLAN_REVIEW | new: Gate A, inside stage 3 after `to-spec` and before `to-tickets`; receipt checked by G9 |
| IMPLEMENT | stage 4 (build) |
| VERIFY | stage 5 (prove) |
| CODE_REVIEW | stage 6 (attack), now including Gate B; receipt checked by G10 |
| REPAIR | the fix rounds of stages 4 and 6 |
| PR_READY | **changed:** stage 7 ends with the PR marked ready and the results comment posted; the human merges |
| BLOCKED | ledger status `blocked: <decision needed>` |
| PAUSED | **new** ledger status `paused: <reason>`, resumable, never satisfies a gate. The status grammar in `SKILL.md` and `loop-hooks.mjs` does not know it yet (it falls through as "other"); HAR-166 extends the grammar, the Stop hook and the SessionStart summary. |

HAR-161's "narrow controlled PR creation command" is the existing PR-creation hook plus the new gates. A separate command would be a second path to the same `gh` call, and the hook already catches the direct one.

### 2. What Gate A hashes, and where it sits

The plan Gate A reviews is the spec `to-spec` writes in stage 3, together with the engineering contract it was built from. G9's plan hash covers both files. Gate A runs after `to-spec` and before `to-tickets`, so tickets are never cut from a plan Codex has not attacked, and the user's one planned stop in stage 3 (approve the breakdown and seams) now also approves the attacked spec. That is HAR-161 amendment A5's "spec approval once per feature".

For Small work, which has no `to-spec`, the plan is `wp-loop`'s step 2 contract, and Gate A runs before step 5 (branch).

A later edit to either file makes G9 stale, so a substantive design change during repair re-runs Gate A.

### 3. Two receipt gates

- **G9, plan-review receipt (Gate A, HAR-163).** Green when a receipt exists for the current plan hash with a passing verdict. Joins the `build` phase: every push and PR creation happens after the plan, so it can be green by then.
- **G10, diff-review receipt (Gate B, HAR-164).** Green when a receipt exists whose base and head sha and content fingerprint (uncommitted changes included) equal what is being shipped, with a passing verdict. G10 **does not** join the `build` phase, because slices are pushed during stage 4, before Gate B exists. It is checked:
  - when the PR is marked ready for review (`gh pr ready`, its `gh api` and GraphQL equivalents), a moment the hook does not intercept today; HAR-164 adds it;
  - in the `merge` phase, for any merge that still goes through the hook;
  - in fork CI, for the parts of the receipt that can be checked portably, because the human merge happens in GitHub's UI where no local hook runs.

Receipts are versioned JSON under `.scratch/receipts/`, parsed strictly. Missing, malformed, wrong schema version, failing or stale means red. A change to reviewed content, tests, gate configuration or CI configuration after review makes G10 stale. Both gates apply at every size; `small` uses a concise plan and the same receipts.

### 4. The agent never merges

HAR-161 says "create PR (never merge)". Stage 7 changes: after `check-gates.sh --phase merge` exits 0 and CI is green on the head, the agent marks the PR ready, posts the results comment, and stops. The human merges. `wp-loop` keeps its merge steps for work run outside `feature-loop`. HAR-164 makes this change, since it is the ticket that adds the ready-for-review check.

### 5. Codex is the reviewer, through `codex exec -s read-only`

- Invocation: `codex exec -s read-only --output-schema <schema> -o <file> -C <review checkout> "<review prompt>"`. Both gates use this one form: the prompt carries the plan or the diff range.
- `codex exec review` is not used: it rejects `-s` (`error: unexpected argument '-s' found`), and whether `codex exec -s read-only review` carries the sandbox into the review is unverified.
- Never passed: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `-s danger-full-access`. The maintainer's Codex config sets no `sandbox_mode` or `approval_policy`, so every call passes `-s` explicitly.
- Rejected alternatives:
  - `codex mcp-server`: removed upstream on 2026-09-05 (openai/codex commit `531f383`); 0.162.1 has no such subcommand.
  - OpenAI's `codex-plugin-cc` review gate: a Stop hook with no round cap. It decides only "stop or continue", cannot record which revision it reviewed, and cannot require test-backed findings. A Stop hook is not proof a stage completed.
- Codex runs on the maintainer's ChatGPT login. A quota or rate-limit response pauses the stage (HAR-166); there is no fallback to a paid API key.
- The Codex binary is injectable so every gate test runs against a mock. No test calls the real CLI or creates a real PR.

Flags relied on, from `codex exec --help` on Codex CLI 0.162.1:

```
  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands
          [possible values: read-only, workspace-write, danger-full-access]
  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root
      --ephemeral
          Run without persisting session files to disk
      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape
      --json
          Print events to stdout as JSONL
  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written
```

### 6. Security boundary: what Codex sees, and consent

- Codex reviews from a separate checkout made with `git worktree add` at the reviewed sha, so it sees tracked files only: an untracked `.env` or local credentials file in the working tree is not there. A secret that is committed is still visible, and the existing slop and secret checks remain the defence for that.
- Every gated review sends the repo's tracked source to OpenAI. That needs explicit consent per repo: the Codex gates run only when `.scratch/gates.json` has `"codex_review": true`, which the user sets once for a repo they are allowed to send to OpenAI. Without it, Codex is never called, G9 and G10 do not apply, and the loop keeps its Claude-only review (G5). For a work-trial or company repo, the lead asks before writing that flag. HAR-163 implements the flag.
- Codex output is untrusted input: the gates read only schema-validated fields, and no free-text verdict can turn a gate green.

### 7. Roles: Claude authors, Codex reviews read-only

Claude plans and builds; Codex reviews. Receipts record author and reviewer identity, so swapping the builder later can be compared on the HAR-166 metrics. No builder setting is added until a ticket needs it.

### 8. Only test-backed findings block

The one controlled study of this pairing found (arXiv 2607.21656, LiveCodeBench, 116 tasks) that Codex reviewing Claude's drafts lowered the pass rate from 91.4% to 82.8%, because the reviewer discarded working solutions. Read-only review removes the rewrite path; the rules below remove the argument path:

- Gate A: a finding blocks only with a concrete failure scenario.
- Gate B: a finding blocks only with a repro (failing test or runnable command) that the wrapper runs and sees fail on the reviewed revision.
- Anything else is advisory: recorded in the receipt, shown to the human at the PR, never a reason to loop.
- Caps: 2 Codex rounds on the plan, 3 on the diff. A finding re-raised after an evidence-backed rebuttal escalates to the human (`blocked:`), never loops.
- Reviewer silence is not a pass. A receipt records a completed review or the gate is red.

Test strength (tests before implementation, seeded bugs the suite must catch) is HAR-165.

### 9. Limits of local enforcement

The hooks run inside Claude Code on the maintainer's machine. They cannot stop:

- a PR opened or merged in GitHub's web UI, from another machine, or by a human typing `gh` in a terminal outside Claude Code;
- a person with local git access editing a receipt by hand.

Receipts make an agent skipping a gate detectable and blocked; they are not a defence against a malicious actor with unrestricted local access. Server-side enforcement needs GitHub branch protection on the default branch: require a pull request, require the fork CI job as a status check, require the branch to be up to date, and disallow force pushes. HAR-167 documents the exact settings.

## Requirement map

| HAR-161 item | Delivered by |
|---|---|
| req 1 inventory, minimal modifications | this ADR (HAR-162) |
| req 2 state machine, no recursive hooks, no indefinite loops | decision 1; caps in HAR-163, HAR-164 |
| req 3 Gate A | HAR-163 |
| req 4 Gate B | HAR-164 |
| req 5 receipts, fail closed, guarded PR creation | HAR-163 (G9, MCP matcher gap, consent flag), HAR-164 (G10, ready-for-review check, CI check, stage 7 stops before merge) |
| req 6 project checks, bounded retries, no silent skips | HAR-164, HAR-165 |
| req 7 separate read-only reviewer, untrusted output, consent | decision 6; HAR-163, HAR-164 |
| req 8 risk tiers, audited exceptions | HAR-163 to HAR-165 (sizes); existing bypass logging |
| req 9 negative-path tests | split across HAR-163 to HAR-166, all in `test-gates.sh` |
| req 10 docs and walkthrough | HAR-167 |
| A1 test-backed findings | HAR-163, HAR-164 |
| A2 tests first, seeded bugs | HAR-165 |
| A3 PAUSED on quota | HAR-166 |
| A4 metrics | HAR-166 |
| A5 roles, caps, human gates | decisions 2, 4, 7; HAR-163, HAR-164 |
| A6 cleanup | HAR-162, on the maintainer's machine; recorded on the ticket, not in this repo |

## Invariants this creates

- No second orchestrator: a new review stage is a gate in `check-gates.mjs` plus a phase or hook entry, tested in `test-gates.sh`.
- Every Codex call goes through one wrapper that sets `-s read-only` explicitly and never passes a bypass flag.
- A gate that depends on a model's output checks a receipt bound to an exact revision, never the model's verdict text alone.
- No source reaches a second vendor without the repo's recorded consent.
