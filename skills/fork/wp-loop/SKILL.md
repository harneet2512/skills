---
name: wp-loop
description: "Ship one work package end to end: issue, engineering contract, branch, TDD, PR, green CI, two-axis review, verified fixes, gated merge, results comment."
disable-model-invocation: true
---

Take one **work package** (one issue, one branch, one PR, its own review) from issue to merged, with **proof** at every **gate**: a green run on the exact head, a re-run test, a quoted spec line. A builder's "fixed" is a claim until the lead checks its proof. Reviewer silence and green tests speak for the code; the contract is proven right against the spec.

The issue tracker should have been provided to you. If it is missing, tell the user to run `/setup-matt-pocock-skills`.

If the user passes an issue reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

## Roles

- **Lead**: this session. Owns the contract, seam confirmation, the review, every gate, fix verification and the merge.
- **Builder**: a subagent that writes code. Use a cheaper model (Claude Code: `model: "sonnet"`, or `"haiku"` for mechanical edits). A builder has no channel to the user, so it works only at seams the lead already confirmed.
- **Reviewers**: the two axis subagents that `code-review` spawns. Brief them to use the strongest model available (Claude Code: `model: "opus"`). They start from fresh contexts, so each reviews code written by someone else.

Set the model explicitly on every subagent call. The lead calls `code-review` itself: subagents usually cannot spawn subagents of their own, and `code-review` needs two.

## Steps

1. **Read the issue in full**, plus its parent or any spec it cites, and write the checklist. If the domain terms are still fuzzy, stop and tell the user to run `/grill-with-docs`.
   **Done when:** every requirement and acceptance criterion in the issue and its cited specs is a checklist line.

2. **Contract.** **Requires:** the step 1 checklist. Call the Skill tool with `deep-engineering`. Resolve its blocking open questions with the user. A shared-contract change (API schema, DB schema, wire format) lands first, as its own PR.
   **Done when:** the contract has zero open blocking questions, and any shared-contract change is merged in its own PR.

3. **Spec.** **Requires:** the checklist and the contract. When they say what to build, they are the spec for every later gate. When they leave gaps on work larger than Tiny, tell the user to run `/to-spec` with the contract as input, then resume from that spec.
   **Done when:** the spec says what to build for every checklist line.

4. **Confirm seams.** **Requires:** the contract's *Verification required* section. Show the user each proposed seam with a line on what it catches; `tdd` and the builder need confirmed seams.
   **Done when:** the user has confirmed every seam.

5. **Branch** from the latest default branch as `wp<issue>-<slug>`. Parallel work packages get separate worktrees.
   **Done when:** `git branch --show-current` prints `wp<issue>-<slug>`, branched from the latest default branch head.

6. **Build with TDD.** **Requires:** the confirmed seams. The builder calls the Skill tool with `tdd` at the confirmed seams; for a new seam it stops and reports back, and the lead confirms it with the user. Follow the repo's documented standards; proof paths use real integration tests. Wherever time, replay or historical data is involved, add a **leakage test**: everything computed as of time T reads only data from T or earlier. The brief names the `concern-topics` categories in play (from the contract's journey x topic matrix); the builder reads their *Build it right* and snippets before writing code that matches their *Spot it in code*, and writes each attack test (duplicate delivery, concurrent writer, timeout after success) before the code it attacks.
   **Done when:** every confirmed seam has a test that went red then green, every attack test in the brief exists, and the full suite is green.

6b. **Prove beyond unit tests.** **Requires:** `.scratch/envelope/<slug>.md`, plus `.scratch/shape/<slug>.md` when the work touches a journey; if one is missing, stop and name the stage that writes it (`behavioral-envelope`, `shape`). Before the PR:
   - run `concern-topics/scripts/slop-check.sh --diff <default branch>` and fix each finding or justify it under `## Justified` in `.scratch/review/<slug>.md`;
   - when the envelope's `**Packs:**` line names `llm` or `retrieval`, run its `evals` suite with the gate from the eval plan;
   - for every normal and large change, run `live-verify` with two instances, with a scenario for each new journey case or Live item that has a live proof.

   **Done when:** gates G6, G3 (every normal and large change; small skips it) and G4 (when `**Packs:**` names `llm` or `retrieval`) are green: `feature-loop/scripts/check-gates.sh G3 G4 G6` exits 0, or, without `.scratch/gates.json`, their conditions in [gates.md](../feature-loop/gates.md) hold by inspection.

7. **Commit with traceability.** Before each commit, check the diff against the issue checklist; record deviations in the commit body and later in the results comment.
   **Done when:** every commit in `git log <default branch>..HEAD` carries `Refs: #<issue>` and names its deviations from the checklist in its body.

8. **Open the PR.** Call the Skill tool with `pr` for the body.
   **Done when:** `gh pr view <pr>` shows the issue number in the title and `Refs #<issue>` in the body (`Closes #<issue>` if the tracker closes work through PRs).

9. **Wait for CI.** `gh pr checks <pr>` exits 0 when everything passed, 1 when something failed, and 8 while checks are pending. Right after a push it can exit 1 with "no checks reported": wait one interval and recheck before calling it red. Poll at most every 5 minutes. In Claude Code run `gh pr checks <pr> --watch --interval 300` in the background, since a watch outlasts most tool timeouts. A red check stops the loop: if the cause is unclear, call the Skill tool with `diagnosing-bugs`.
   **Done when:** `gh pr checks <pr>` exits 0 on the current head.

10. **Review.** **Requires:** `.scratch/envelope/<slug>.md`. First call the Skill tool with `behavioral-envelope` and run only its "Re-check against the diff" section; answer every concern pack it flags before review starts. For Tiny work, call the Skill tool with `code-review`, with the default branch as the fixed point and the issue checklist, the contract and the envelope's Live items as the spec; put the strongest model and [review-checks.md](review-checks.md) in both axis briefs. For Normal and Major work, call the Skill tool with `adversarial-review`: it runs `code-review` with that same spec and briefs, adds the design-applied, topic attacker, code craft and blast radius axes, and counts only reproduced findings. Severities are assigned within each axis.
    **Done when:** every finding carries CRITICAL, HIGH, MEDIUM or LOW, `file:line` and a concrete fix, and for Normal and Major work `.scratch/review/<slug>.md` has its `## Findings` table (the file gate G5 reads).

11. **Fix round.** Every CRITICAL or HIGH finding goes back to the builder first. The lead then **verifies each fix personally**: re-run the targeted test for each HIGH and read the changed lines. LOW is the builder's call. Fixes push a new head, so repeat step 9.
    **Done when:** gate G5 is green, the lead has re-run each HIGH's targeted test, every MEDIUM is fixed or filed as a follow-up issue, and `gh pr checks <pr>` exits 0 on the new head.

12. **Merge gate.** **Requires:** whenever `.scratch/gates.json` exists, a 0 exit from `feature-loop/scripts/check-gates.sh` on this head; run it first and fix each red gate it prints until it exits 0. Follow [merge-gate.md](merge-gate.md): bring the branch up to date, renumber migrations and ADRs, wait for CI on that head, check it, and merge exactly the commit you checked.
    **Done when:** `gh pr view <pr> --json state` shows `MERGED`, merged with `--match-head-commit` set to the head SHA that `gh pr checks` exited 0 on.

13. **Report.** Post the results comment from [check-comment.md](check-comment.md) on the PR and on the issue, then close the issue the way the tracker closes work.
    **Done when:** the results comment is on both the PR and the issue with test counts, coverage of the touched packages and every metric the issue defines, and the issue is closed.
