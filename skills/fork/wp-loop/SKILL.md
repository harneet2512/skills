---
name: wp-loop
description: "Ship one work package end to end: issue, engineering contract, branch, TDD, PR, green CI, two-axis review, verified fixes, gated merge, results comment."
disable-model-invocation: true
---

Take one **work package** (one issue, one branch, one PR) from issue to merged, with evidence at every gate.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

If the user passes an issue reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask.

## Roles

- **Lead**: this session. Owns the contract, confirms seams with the user, runs the review, runs every gate, verifies fixes, merges. Never trusts a summary it did not check.
- **Builder**: a subagent that writes code. Use a cheaper model (Claude Code: `model: "sonnet"`, or `"haiku"` for mechanical edits). A builder cannot ask the user anything, so it works only at seams the lead already confirmed.
- **Reviewers**: the two axis subagents that `code-review` spawns. Brief them to use the strongest model available (Claude Code: `model: "opus"`). They start from fresh contexts, so they never review code they wrote.

Set the model explicitly on every subagent call. The lead, not a subagent, calls `code-review`: subagents usually cannot spawn subagents of their own, and `code-review` needs two.

## Steps

1. **Read the issue in full**, plus its parent or any spec it cites. Turn every requirement and acceptance criterion into a checklist. If the domain terms are still fuzzy, stop and tell the user to run `/grill-with-docs`.

2. **Contract.** Call the Skill tool with `deep-engineering`. Resolve its blocking open questions with the user before going further. If the work changes a shared contract (API schema, DB schema, wire format), land that change first, as its own PR.

3. **Spec.** When the issue checklist plus the contract say what to build, together they are the spec for every later gate. When they don't, and the work is not tiny, tell the user to run `/to-spec` with the contract as input, then resume from that spec.

4. **Confirm seams.** Show the user the seams the contract's *Verification required* section proposes, each with a line on what it catches. Get them confirmed. `tdd` requires confirmed seams, and the builder cannot ask.

5. **Branch** from the latest default branch as `wp<issue>-<slug>`. One work package, one branch, one PR. Parallel work packages get separate worktrees.

6. **Build with TDD.** The builder calls the Skill tool with `tdd`, at the confirmed seams only. If it needs a new seam, it stops and reports back; the lead confirms it with the user. Follow the repo's documented standards. Proof paths use real integration tests, not mocks. Wherever time, replay or historical data is involved, add a **leakage test**: nothing computed as of time T may read data from after T.

7. **Commit with traceability.** Every commit message carries `Refs: #<issue>`. Before each commit, check the diff against the issue checklist. A deviation is written down (in the commit body, and later in the results comment), never made silently.

8. **Open the PR.** Call the Skill tool with `pr` for the body. Put the issue number in the title and `Refs #<issue>` in the body (`Closes #<issue>` if the tracker closes work through PRs).

9. **Wait for CI.** `gh pr checks <pr>` exits 0 when everything passed, 1 when something failed, and 8 while checks are pending. Right after a push it can also exit 1 with "no checks reported": wait one interval and check again before treating it as red. Poll no more often than every 5 minutes. A watch outlasts most tool timeouts, so in Claude Code run `gh pr checks <pr> --watch --interval 300` in the background. A red check stops the loop: if the cause is not obvious, call the Skill tool with `diagnosing-bugs`.

10. **Review.** First call the Skill tool with `behavioral-envelope` and run only its "Re-check against the diff" section (the diff against the existing envelope): a concern pack the diff triggers that the envelope did not cover gets answered before review starts. Then call the Skill tool with `code-review`, with the default branch as the fixed point and the issue checklist, the contract and the envelope's Live items as the spec. Put the strongest model and [review-checks.md](review-checks.md) in both axis briefs. Then, **inside each axis** (never across them), tag every finding CRITICAL, HIGH, MEDIUM or LOW, each with `file:line` and a concrete fix.

11. **Fix round.** Any CRITICAL or HIGH finding goes back to the builder first. The lead then **verifies each fix personally**: re-run the targeted test for each HIGH and read the changed lines. A builder's "fixed" is a claim, not evidence. MEDIUM findings are fixed in this round or filed as follow-up issues, never dropped. LOW is the builder's call. Fixes push a new head, so wait for CI again (step 9) before the merge gate.

12. **Merge gate.** Follow [merge-gate.md](merge-gate.md): bring the branch up to date, renumber migrations and ADRs, wait for CI on that head, check it, and merge exactly the commit you checked.

13. **Report.** Post the results comment from [check-comment.md](check-comment.md) on the PR and on the issue, then close the issue the way the tracker closes work. Every work package reports its numbers: test counts, coverage of the touched packages, and any metric the issue defines.

## Rules

- Evidence over claims at every gate: a green run on the exact head, a re-run test, a quoted spec line.
- Reviewer silence or a green test run is not proof the contract is right.
- Never batch several work packages into one PR to save a review.
