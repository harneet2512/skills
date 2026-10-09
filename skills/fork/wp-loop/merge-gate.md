# Merge gate

Run these steps in order. Any push to the branch sends you back to step 2: CI on an old head says nothing about the new one.

1. **Bring the branch up to date.** Merge the latest default branch into it. Renumber sequentially numbered files (migrations, ADRs) to the default branch's highest number plus one. Push. A branch that was green before the default branch moved is not green on the merge result.

2. **Wait for CI on the new head.** Same polling as the loop's CI step.

3. **Check the exact head:**

   ```bash
   gh pr view <pr> --json headRefOid --jq .headRefOid
   gh pr checks <pr>; echo "exit $?"
   ```

   Write down the head SHA the first command prints. Step 5 needs it as a literal value: shell variables do not survive between separate tool calls, and an empty value would silently drop the head check.

   When CI does not report as GitHub checks on the PR (for example, it runs on a mirror repository), `.scratch/gates.json` names a `merge_check` command with `{sha}` and `{pr}` placeholders. Run that instead of `gh pr checks`; its exit `0` is the pass. The merge hook runs the same check before any `gh pr merge`.

   Only exit `0` passes: nothing failed and nothing is pending. Exit `8` means pending, so go back to step 2. Exit `1` means a check failed, or no checks were reported yet (right after a push, wait one interval and check again). If the repo has no CI at all, say so and get the user's explicit approval before merging without it.

   Checking only that the branch merges cleanly is not enough. A scripted loop that checks mergeability alone will merge a red build.

4. **No CRITICAL or HIGH finding is open**, and the lead has verified each fix with a targeted test.

5. **Merge exactly the commit you checked:**

   ```bash
   gh pr merge <pr> --merge --match-head-commit <head SHA from step 3>
   ```

   If anyone pushed after step 3, the merge refuses. Go back to step 2.

## When CI itself is down

Use this only with the user's explicit approval, for this PR:

1. List the jobs that never ran on the exact head commit.
2. Run exactly those jobs' commands locally, on that head, with the same flags and the same shard split.
3. Post the commands and their output as a PR comment before merging.
4. Name every job you skipped, and why.
5. Never merge if any job that did run failed with a real test failure.
