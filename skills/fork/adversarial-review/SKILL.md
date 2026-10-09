---
name: adversarial-review
description: Attack a finished change before it merges, axis by axis, and count only what is reproduced. Runs code-review's Standards and Spec axes, then a design-applied axis (every contracted mechanism exists where the contract says), one attacker per applicable concern topic using that topic's attack recipes, a code-craft axis (slop-check plus the CRAFT categories), a second model on the riskiest topic, and a blast-radius pass. Use after the build and live verification, before merge, or when asked for an adversarial, thorough or "miss nothing" review.
---

# Adversarial review

The aim is that design and build were good enough that this pass finds close to nothing. It is still run in full every time, because "close to nothing" is a measurement, not a hope: the count of reproduced findings per change is the loop's quality metric (see section 7).

Reviewers start from fresh contexts, never review code they wrote, and use the strongest model available. The lead (this session) spawns them; subagents usually cannot spawn their own.

## Inputs

- The diff against a fixed point (`git diff <base>...HEAD`), the commit list.
- The spec: issue checklist, engineering contract, envelope file (`.scratch/envelope/<slug>.md`), shape file (`.scratch/shape/<slug>.md`).
- The live verification report and the eval results, when they exist.

## 1. Mechanical gates first

Run, from the target repo root, and fix before spending reviewers on it:

- `behavioral-envelope` section 9 (re-check against the diff): a pack the diff triggers that the envelope missed is answered first.
- `concern-topics/scripts/slop-check.sh --diff <base>`: every finding fixed or justified in one line.
- The repo's own types, lint and tests.

## 2. Standards and Spec

Call the Skill tool with `code-review`, the base as the fixed point, and the contract, envelope Live items and issue checklist as the spec. Keep its two axes as they are.

## 3. Design applied

One reviewer gets the contract's mechanisms table and the journey x topic matrix, and checks for each mechanism: it exists, it is enforced where the contract says (constraint, single owning module, type), every path goes through it (search for paths that bypass it), and its proof exists and injects the failure. A mechanism enforced weaker than contracted is a finding.

## 4. Topic attackers

Pick topics with the table in `concern-topics`. Spawn one attacker per topic, in parallel, each with: the diff, the topic file path, the envelope's Live items for that topic, and this brief:

> You are attacking this change on <topic>. Read <topic file>. For each category whose "Spot it in code" matches the diff, try to break it using the topic's attack recipes. For each suspected flaw, write a reproduction: a failing test at a public seam, or a live-verify scenario that fails against the current code. Run it. Report each flaw as CONFIRMED (the reproduction fails now; include it) or PLAUSIBLE (you could not reproduce; say what stopped you). Include file:line, the category ID, the concrete failure a user would see, and the fix. Do not report style. Under 500 words plus reproductions.

Run a **second model** (a different model, or the same model with no shared context if only one is available) as an extra attacker on the topic with the most Critical items. Take the union; where the two disagree, the lead runs the reproduction.

## 5. Code craft

One reviewer reads the diff against `code-craft.md`: second sources of truth, representable illegal states, errors handled at the wrong layer, speculative abstraction, code that should have been deleted instead of added ("code judo"), inconsistency with neighbouring code. Findings cite the CRAFT ID and quote the hunk.

## 6. Blast radius

One reviewer answers: what else calls or depends on what changed (callers, consumers of the changed schema or event, other tenants, scheduled jobs), what happens to in-flight work during deploy (old and new versions running together, queued jobs in the old format), and how to roll it back. Each unhandled case is a finding.

## 7. Triage and record

- Severity: CRITICAL (data loss, security or tenant break, irreversible external effect), HIGH (users see wrong behavior), MEDIUM, LOW. Per axis, never reranked across axes.
- CONFIRMED findings are fixed, and their reproduction stays as a regression test or scenario. PLAUSIBLE CRITICAL or HIGH findings get a reproduction attempt by the lead before being dismissed.
- Every CONFIRMED finding is also an escape from design and build: add it to the envelope pack or topic category that should have caught it (envelope section 10).
- Append one line to `.scratch/loop-metrics.md`: date, change, CONFIRMED count by severity, PLAUSIBLE count, and which stage should have caught each. A falling count over changes is the evidence the loop works.

## Rules

- A finding without a reproduction is PLAUSIBLE, never CONFIRMED.
- A green test run or reviewer silence is not proof of correctness.
- Fixes are verified by the lead re-running the reproduction, not by a builder's "fixed".
- Never batch several changes into one review to save time.
