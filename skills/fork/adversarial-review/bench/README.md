# Planted-bug bench

Measures whether the loop's proving and attacking stages catch real mistakes in the reference product (`../../live-verify/bench/inbox-assist/`).

- `answer-key.json`: 13 planted bugs, one or more per concern topic, with the user-visible failure each causes. Keep it away from reviewers.
- `patches/bug-NN.patch`: each bug as a patch against the current app.
- `product-description.md`: the only context blind reviewers get.
- `run-mutants.sh`: applies each patch alone to a copy of the app and runs the full live suite plus the unit tests. `./run-mutants.sh` runs the control and every bug; `./run-mutants.sh 08 11` runs a subset; `REPEAT_01=5` repeats the timing-dependent race. Output goes to `.scratch/`.
- `mutant-results-v1.md` and `.json`: the first run (25 scenarios). `mutant-results-v2.md`: after the learn step (40 scenarios), rerun from this folder.

For a blind review run, put the app with all patches applied in a fresh git repo whose first commit holds only `product-description.md` as its README, then point reviewers at that repo and nothing else. The scorecard in `../../feature-loop/bench/` records the results of the first run.

When a patch stops applying after the app changes, re-create the same bug by hand and regenerate its patch.
