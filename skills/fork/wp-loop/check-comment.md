# Results comment

Post this on the PR only, once it is open and green; never on the issue (the reviewer owns it). Quote the issue's own words for each criterion. An unmet criterion stays unchecked, with the reason.

```markdown
## Work package check: #<issue>

**PR:** #<pr> | **Closes:** #<issue> | **Base:** <base branch> | **CI:** success on <head sha>

### Acceptance

- [x] <criterion quoted from the issue>: <evidence: test name, output, or screenshot>
- [ ] <criterion not met>: <why, and the follow-up listed below>

### Deviations from the issue

<none, or: what changed, why, and who approved it>

### Review findings fixed

| Axis | Severity | Finding | Fix | Verified by |
|---|---|---|---|---|
| Standards | HIGH | <finding> | <commit> | <re-run test> |

### Numbers

- Tests: <passed>/<total> (<n> new)
- Coverage of touched packages: <percent>
- <metric the issue defines>: <value>

### Follow-ups

- <deferred MEDIUM finding>: <file:line> (for the reviewer to decide; no issue was filed)
```
