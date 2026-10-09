# Review: reply options

## Findings

| ID | Axis | Category | Severity | Status | Resolution |
|---|---|---|---|---|---|
| F1 | concurrency | CONC-09 | CRITICAL | CONFIRMED | fixed in a1b2c3d, test `two-users-race` |
| F2 | security | SEC-04 | HIGH | PLAUSIBLE | open |
| F3 | craft | CRAFT-06 | MEDIUM | CONFIRMED | |

## Justified

- `src/slop.js:2` CRAFT-06.todo: tracked as issue #42, empty threads are rejected upstream for now
- src/slop.js:3 CRAFT-06.debug-output: the CLI prints the draft on purpose
