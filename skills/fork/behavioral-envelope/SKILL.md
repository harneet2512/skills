---
name: behavioral-envelope
description: Find every concern a change must satisfy to really work, the same way on every run, and turn those concerns into how it gets built. Selects concern packs (UI, API, data, email, webhooks, jobs and time, integrations, LLM output, money, and more) with a deterministic script from the plan and the code, answers every item, then designs a mechanism, enforcement point, build slice, proof and production signal for each live concern. Use as soon as what to build is decided and before deciding how to build it, for any change including a color or a copy edit, when deep-engineering runs, or when asked "what could go wrong", "what am I missing", "what are the concerns", or "how do we build this properly".
---

# Behavioral Envelope

The envelope is everything that must hold for a change to do its job in the real world, on every path. It is the input to the design, written before the design is chosen: a concern found before the design gets a mechanism, one found after gets a patch.

An LLM asked "what could go wrong?" recalls a different list on every run, and a miss ships as a bug. So a script picks the concern packs, every item in every picked pack gets an explicit answer, and judgment only adds on top. The packs are the **floor**.

The output is the **envelope file**, `.scratch/envelope/<slug>.md`, started from [envelope-template.md](envelope-template.md) and filled section by section: the answered concerns, their mechanisms and the build order. Product code comes later.

## When it runs

| Moment | What it does | Script mode |
|---|---|---|
| **What to build is decided** (an issue, a spec, a conversation) | Full envelope and design: sections 1 to 8 | `--plan` on the request text, plus `--paths` on files the system model says it touches |
| **Code is written, before review** | Re-check: section 9 | `--diff <base>` |
| **A bug escaped** | Raise the floor: section 10 | n/a |

## 1. Purpose and properties

State, in one line each:

- **Purpose**: what this change is for, and for whom.
- **Properties**: what must hold for that purpose. A button color must be visible, correct and distinct. An order path must be fast, exact and placed once. An outbound email must reach the right person once, with true content.

Every concern is judged against these properties.

**Done when:** the envelope file's `**Purpose:**` and `**Properties:**` lines are each filled with one line.

## 2. Select packs with the script

**Requires:** the request text in a file, and the files the system model (`deep-engineering` section 1) says the change touches. First save text that lives only in the conversation; with no system model, first list the touched files from the repo.

Run [scripts/detect-packs.sh](scripts/detect-packs.sh) from the target repo's root, by its path inside this skill's folder, and take the union:

- `--plan <file>`: matches what the change is about in plain words ("follow-up emails", "billing", "nightly").
- `--paths <files>`: scans whole files, so it selects a superset.

`core` is always selected. Add a pack by judgment with the reason. Every pack the script selects stays selected; an irrelevant one gets its items answered N/A. The script errs toward inclusion: an extra pack costs a few one-line answers, a missed one a production bug. Packs live in [packs/](packs/README.md).

**Done when:** the `**Packs:**` line lists `core`, every pack either script run printed (each with its triggering line), and every judgment-added pack with its reason.

## 3. Answer every item

For every item in every selected pack, write exactly one answer:

- **Live**: it can fail in this change. Write the failure path, in existing code (`path:symbol`) or in the planned design (the component that will own it); the right way (the pack's guidance, or a source you checked); the proof; and a severity:
  - **Critical**: getting it wrong loses money or data, breaks security or tenant isolation, or causes an irreversible external effect (a sent email, a placed order, a charge).
  - **High**: users see wrong behavior, or the feature silently stops working.
  - **Normal**: every other real failure path.
- **Later**: real, but unreachable from this change. One line, filed as a follow-up.
- **N/A**: one clause saying why. Items sharing a reason can share a line.

Live requires both a failure path and a proof. An item with only a vague worry behind it ("consider performance") is deleted.

When the guidance misfits, or the item depends on library, protocol or provider behavior the repo leaves unconfirmed, resolve it against primary sources: repo code and tests first, then official docs; for anything heavy, call the Skill tool with `research`. Mark what stays unresolved `(unverified)` and list it as an open question.

**Done when:** every item of every pack on the `**Packs:**` line has exactly one answer, Live, Later or N/A, in its section of the envelope file; every Live row has a failure path, a severity and a proof; and every `(unverified)` item is listed under `## Open questions`.

## 4. Add what the packs miss

Ask once more from the properties in section 1: what else would stop this change doing its job? Add each finding as an extra item in the same shape. This is the only place recall is used, and it only adds.

**Done when:** `## Extra` holds every finding of this pass with a failure path, mechanism and proof, or the single line `none found`.

## 5. Second pass for risky changes

When any selected pack is `outbound`, `inbound-events`, `money`, `identity-access`, `personal-data` or `data`, or the change is irreversible, run a second independent pass: a fresh subagent (a different model when one is available) gets only the purpose, the pack list and the files or plan, so its answers stay independent of yours. Take the union of Live items. Where the passes disagree, look again and record the deciding evidence.

**Done when:** the `**Second pass:**` line reads `not required` (no risky pack, change reversible) or `done:` with the model, the Live items it added or disputed, and the deciding evidence for each disagreement.

## 6. Design a mechanism for every Live item

This is where concerns become the build. For each Live item write:

- **Mechanism**: what makes it hold (an idempotency key store, a suppression check at send time, a version column, a dead-letter queue, a contrast-checked token).
- **Enforced at**: the strongest point that fits, in this order of preference: the type system, a database constraint, a single owning module every path goes through, middleware, a test, a written convention. A convention states why nothing stronger fits.
- **Proof**: the evidence that it holds (test, live scenario, eval, measurement, screenshot).
- **Runtime signal**: what shows in production that it still holds (a metric, an alert, a log line), or `none needed: <reason>`.

Critical items are enforced at a type, a constraint or a single owning module, and their proof injects the failure (timeout after success, duplicate delivery, concurrent writer). Normal items may share a proof.

Then group: one mechanism usually covers several items (a single idempotency layer covers OUT-01, API-03, LLM-05 and MON-03). Fewer, stronger mechanisms beat many local guards.

**Done when:** gate G2 is green: the `**Packs:**` line is filled, the `## Live` table has at least one row on a normal or large change (a small one may leave it empty), and every row has non-empty Severity, Mechanism, Enforced at and Proof cells, none of them `TBD`, `TODO` or `?`. Beyond G2: every Live row has a Runtime signal, every Critical row is enforced at a type, constraint or single owning module with a failure-injecting proof, every Live ID appears in the Covers cell of exactly one row of `## Mechanisms`, and every row there covers at least one Live ID.

## 7. Order the build around the mechanisms

Write a build plan of small slices, each ending in a verifiable state:

1. **Foundations**: mechanisms that several items or slices depend on, and every mechanism behind a Critical item (idempotency store, tenant scoping, the queue, the suppression check). Built and proven first, because everything after them assumes they hold.
2. **Feature slices**: thin end-to-end slices, each carrying the proofs of the Live items it touches.
3. **Rollout**: the steps that make deploy safe (migration order, flag, backfill, staged enable).
4. **Operate**: the runtime signals from section 6 wired to alerts before the feature is on for users.

**Done when:** `## Build plan` has all four parts, every mechanism ID is in exactly one slice, every mechanism behind a Critical item is in Foundations, and every Live ID is carried by a slice.

## 8. Hand off

The envelope file keeps the reasoning auditable. It feeds:

- **Design and contract**: the chosen design implements every mechanism; alternatives are compared on how they satisfy the Live items. Live items become the contract's Risks, mechanisms its design, proofs its *Verification required*.
- **Tickets and slices**: the build plan's order, Foundations first.
- **`tdd`**: each Live item with a test proof becomes a behavior to assert at a confirmed seam.
- **Live verification**: each Live item with a live proof becomes a scenario run against the real system.
- **Operations**: each runtime signal becomes an alert or dashboard entry.

The envelope stays in `.scratch/`. The PR carries proof: the Critical and High items with their proof, and a count of Normal items handled.

**Done when:** every template section in the envelope file is filled (an empty one reads `none`) and `<feature-loop>/scripts/check-gates.sh G2` reports G2 green.

## 9. Re-check against the diff

**Requires:** `.scratch/envelope/<slug>.md`. If it is missing, run sections 1 to 8 first.

Before review, run `<this skill>/scripts/detect-packs.sh --diff <base>` from the target repo's root. A pack the diff triggers that the envelope lacks means the change grew: answer that pack's items, and design their mechanisms, before review starts.

**Done when:** every pack the `--diff` run prints is on the `**Packs:**` line, its items meet the section 3 condition, and gate G2 is green.

## 10. Every miss raises the floor

**Requires:** the escaped bug's report or failing reproduction.

When a bug escapes that an item should have caught, raise the floor, in this order of strength:

1. Encode it in the target repo as a check that fails on the real mistake (type, lint, test).
2. Add or sharpen the pack item, with the incident as its source.
3. When the pack was unselected, add the trigger pattern to `detect-packs.sh`, plus a fixture in `scripts/fixtures/` and a line in `scripts/test-detect.sh`.

**Done when:** the target repo has a check that goes red on the real mistake, or (when no check can catch it) a pack item cites the incident as its source; and, when the pack was unselected, `scripts/test-detect.sh` passes with a fixture that selects it.

## Measure it

[bench/README.md](bench/README.md) checks the skill's recall and run-to-run agreement; trust its numbers over any single run.
