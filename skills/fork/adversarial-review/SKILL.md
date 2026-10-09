---
name: adversarial-review
description: Attack a finished change before it merges, axis by axis, and count only what is reproduced. Runs code-review's Standards and Spec axes, then a design-applied axis (every contracted mechanism exists where the contract says), one attacker per applicable concern topic using that topic's attack recipes, a code-craft axis (slop-check plus the CRAFT categories), a second model on the riskiest topic, and a blast-radius pass. Use after the build and live verification, before merge, or when asked for an adversarial, thorough or "miss nothing" review.
---

# Adversarial review

The aim is that design and build were good enough that this pass finds close to nothing. It runs in full every time, because "close to nothing" is a measurement: the count of reproduced findings per change is the loop's quality metric (section 7).

Reviewers start from fresh contexts, review code another session wrote, and use the strongest model available. The lead (this session) spawns them, since subagents usually cannot spawn their own. Each review covers one change.

A finding is **CONFIRMED** when its reproduction (a failing test at a public seam, or a live-verify scenario) fails against the current code, and **PLAUSIBLE** otherwise. Every finding is a row in the `## Findings` table of `.scratch/review/<slug>.md` (columns ID, Axis, Category, Severity, Status, Resolution), and every justified slop-check finding is a `file:line` and reason under `## Justified`; the format is in `feature-loop/gates.md`.

## Inputs

**Requires:** the diff against a fixed point (`git diff <base>...HEAD`), the commit list, the issue checklist, the engineering contract, `.scratch/envelope/<slug>.md` and `.scratch/shape/<slug>.md`; when one is missing, stop and name the feature-loop stage that produces it. Also read the live verification report and eval results when they exist.

## 1. Mechanical gates first

Run, from the target repo root, and fix before spending reviewers:

- `behavioral-envelope` section 9 (re-check against the diff);
- `concern-topics/scripts/slop-check.sh --diff <base>`;
- the repo's own types, lint and tests.

**Done when:** every pack the diff triggers is answered in the envelope, slop-check reports nothing or every finding's `file:line` is under `## Justified` with a reason (gate G6), and types, lint and tests are green.

## 2. Standards and Spec

Call the Skill tool with `code-review`, the base as the fixed point, and the contract, envelope Live items and issue checklist as the spec. Keep its two axes as they are.

**Done when:** every `code-review` finding is a row with Axis `standards` or `spec`.

## 3. Design applied

One reviewer gets the contract's mechanisms table and the journey x topic matrix, and checks each mechanism: it exists, it is enforced where the contract says (constraint, single owning module, type), every path goes through it (search for bypassing paths), and its proof exists and injects the failure. A mechanism enforced weaker than contracted is a finding.

**Done when:** every mechanism in the contract has a verdict on all four checks, and each failed check is a row with Axis `design`.

## 4. Topic attackers

Pick topics with the table in `concern-topics`, then cap them by size so the pass costs no more than the change is worth: **Normal** work gets attackers only for the (at most three) topics holding the envelope's Critical or High Live items; **Large** work gets every selected topic. Spawn one attacker per chosen topic, in parallel, each with the diff, the topic file path, the envelope's Live items for that topic, and this brief:

> You are attacking this change on <topic>. Read <topic file>. For each category whose "Spot it in code" matches the diff, try to break it using the topic's attack recipes. For each suspected flaw, write a reproduction: a failing test at a public seam, or a live-verify scenario that fails against the current code. Run it. Report each flaw as CONFIRMED (the reproduction fails now; include it) or PLAUSIBLE (you could not reproduce; say what stopped you). Include file:line, the category ID, the concrete failure a user would see, and the fix. Report behavior flaws only; style is out of scope. Under 500 words plus reproductions.

Run a **second model** (a different model, or the same model with no shared context if only one is available) as an extra attacker on the topic with the most Critical items. Take the union; where the two disagree, the lead runs the reproduction.

**Done when:** every chosen topic's attacker and the second model have reported, every disagreement has the lead's reproduction result, and every flaw is a row with its topic as Axis and its category ID.

## 5. Code craft

One reviewer reads the diff against `code-craft.md`: second sources of truth, representable illegal states, errors handled at the wrong layer, speculative abstraction, code that should have been deleted instead of added ("code judo"), inconsistency with neighbouring code.

**Done when:** every craft finding is a row with Axis `craft`, its CRAFT ID as Category, and a quote of its hunk.

## 6. Blast radius

One reviewer answers: what else calls or depends on what changed (callers, consumers of the changed schema or event, other tenants, scheduled jobs), what happens to in-flight work during deploy (old and new versions running together, queued jobs in the old format), and how to roll it back.

**Done when:** all three questions are answered and each unhandled case is a row with Axis `blast-radius`.

## 7. Triage and record

- Severity: CRITICAL (data loss, security or tenant break, irreversible external effect), HIGH (users see wrong behavior), MEDIUM, LOW, ranked within each axis.
- Each CONFIRMED finding is fixed, its reproduction kept as a regression test or scenario. A fix counts once the lead re-runs the reproduction and it passes; a builder's "fixed", a green test run or reviewer silence leaves the row as it was.
- Each PLAUSIBLE CRITICAL or HIGH finding gets a reproduction attempt by the lead before it is dismissed.
- Each CONFIRMED finding is also an escape from design and build: add it to the envelope pack or topic category that should have caught it (envelope section 10).
- Append one line to `.scratch/loop-metrics.md`: date, `<slug>`, CONFIRMED count by severity, PLAUSIBLE count, and the stage that should have caught each. A falling count over changes is the evidence the loop works.

**Done when:** every CONFIRMED CRITICAL or HIGH row has a Resolution other than `open` or empty (gate G5), every slop-check finding is fixed or under `## Justified` (gate G6), every CONFIRMED finding's escape is added to its envelope pack or topic category, and `.scratch/loop-metrics.md` has the line for `<slug>` (gate G7).
