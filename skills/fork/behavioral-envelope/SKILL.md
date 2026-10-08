---
name: behavioral-envelope
description: Find every concern a change must satisfy to really work, the same way on every run, and turn those concerns into how it gets built. Selects concern packs (UI, API, data, email, webhooks, jobs and time, integrations, LLM output, money, and more) with a deterministic script from the plan and the code, answers every item, then designs a mechanism, enforcement point, build slice, proof and production signal for each live concern. Use as soon as what to build is decided and before deciding how to build it, for any change including a color or a copy edit, when deep-engineering runs, or when asked "what could go wrong", "what am I missing", "what are the concerns", or "how do we build this properly".
---

# Behavioral Envelope

The envelope is everything that must hold for a change to do its job in the real world, not just on the happy path. It is not a checklist run after the code: it is the input to the design. A concern found after the design is fixed gets a patch; a concern found before it gets a mechanism.

An LLM asked "what could go wrong?" recalls a different list on every run, and a miss ships as a bug. So a script picks the concern packs, every item in every picked pack gets an explicit answer, and judgment only adds on top.

It writes no product code. Its output is the **envelope file**: the answered concerns, the mechanisms that satisfy them, and the order to build them in.

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

Every concern is judged against these properties. A concern that threatens none of them is not live.

## 2. Select packs with the script, not by memory

Run [scripts/detect-packs.sh](scripts/detect-packs.sh) from the target repo's root, by its path inside this skill's folder, and take the union:

- `<this skill>/scripts/detect-packs.sh --plan <file>`: the request, issue or spec text saved to a file. Matches what the change is about in plain words ("follow-up emails", "billing", "nightly").
- `<this skill>/scripts/detect-packs.sh --paths <files>`: the files the system model (`deep-engineering` section 1) says the change touches. Scans whole files, so it selects a superset.

`core` is always selected. You may add a pack by judgment (say why). You may never drop a pack the script selected; answer its items as N/A instead. The script errs toward inclusion: an extra pack costs a few one-line answers, a missed pack costs a production bug.

Packs live in [packs/](packs/README.md), one file per kind of change.

## 3. Answer every item

For every item in every selected pack, write exactly one of:

- **Live**: it can fail in this change. Write the failure path: in existing code (`path:symbol`), or in the planned design (the component that will own it). Then the right way (the pack's guidance, or a source you checked), the proof, and a severity:
  - **Critical**: getting it wrong loses money or data, breaks security or tenant isolation, or causes an external effect that cannot be taken back (a sent email, a placed order, a charge).
  - **High**: users see wrong behavior, or the feature silently stops working.
  - **Normal**: everything else that is still a real failure path.
- **Later**: real, not reachable by this change. One line, filed as a follow-up.
- **N/A**: one clause saying why. Items sharing a reason can share a line.

**No failure path and no proof means it is not Live.** "Consider performance" with nothing behind it is deleted.

When the guidance does not fit, or the item depends on a library, protocol or provider behavior you cannot confirm from the repo, resolve it against primary sources (repo code and tests first, then official docs; for anything heavy, call the Skill tool with `research`). Unresolved items are marked `(unverified)` and listed as open questions.

## 4. Add what the packs miss

Ask once more from the properties in section 1: what else would stop this change doing its job? Add each finding as an extra item in the same shape. This is the only place recall is used, and it can only add.

## 5. Second pass for risky changes

When any selected pack is `outbound`, `inbound-events`, `money`, `identity-access`, `personal-data` or `data`, or the change is irreversible, run a second independent pass: a fresh subagent (a different model when one is available) gets the purpose, the pack list and the files or plan, never your answers. Take the union of Live items. Where the passes disagree, look again and record the deciding evidence.

## 6. Design a mechanism for every Live item

This is where concerns become the build. For each Live item write:

- **Mechanism**: what makes it hold (an idempotency key store, a suppression check at send time, a version column, a dead-letter queue, a contrast-checked token).
- **Enforced at**: the strongest point that can enforce it, in this order of preference: the type system, a database constraint, a single owning module every path goes through, middleware, a test, a written convention. A rule enforced only by convention is the weakest choice and must say why nothing stronger fits.
- **Proof**: the evidence that it holds (test, live scenario, eval, measurement, screenshot).
- **Runtime signal**: what shows in production that it is still holding (a metric, an alert, a log line), or "none needed" with a reason.

Critical items get a mechanism enforced by structure (type, constraint, single owning module), never by convention alone, and a proof that injects the failure (timeout after success, duplicate delivery, concurrent writer). Normal items may share a proof.

Then group: one mechanism usually covers several items (a single idempotency layer covers OUT-01, API-03, LLM-05 and MON-03). Fewer, stronger mechanisms beat many local guards.

Keep it lean: no mechanism without a Live item behind it, and no item answered by two competing mechanisms.

## 7. Order the build around the mechanisms

Write a build plan of small slices, each ending in a verifiable state:

1. **Foundations**: mechanisms that several items or slices depend on, and every mechanism behind a Critical item (idempotency store, tenant scoping, the queue, the suppression check). Built and proven first, because everything after them assumes they hold.
2. **Feature slices**: thin end-to-end slices, each carrying the proofs of the Live items it touches.
3. **Rollout**: the steps that make deploy safe (migration order, flag, backfill, staged enable).
4. **Operate**: the runtime signals from section 6 wired to alerts before the feature is on for users.

## 8. Write the envelope file and hand off

Write it from [envelope-template.md](envelope-template.md) to `.scratch/envelope/<slug>.md`. It holds every answer, the mechanisms and the build plan, so the reasoning is auditable and the engineer learns from it.

- **Design and contract**: the chosen design must implement every mechanism; alternatives are compared on how they satisfy the Live items. Live items become the contract's Risks; mechanisms its design; proofs its *Verification required*.
- **Tickets and slices**: the build plan's order. Foundations come first.
- **`tdd`**: each Live item with a test proof becomes a behavior to assert at a confirmed seam.
- **Live verification**: each Live item with a live proof becomes a scenario run against the real system.
- **Operations**: each runtime signal becomes an alert or dashboard entry.

The PR shows the Critical and High items with their evidence, and a count of Normal items handled. It does not paste the envelope.

## 9. Re-check against the diff

Before review, run `<this skill>/scripts/detect-packs.sh --diff <base>` from the target repo's root. A pack the diff triggers that the envelope did not cover means the change grew: answer that pack's items, and design their mechanisms, before review starts.

## 10. Every miss raises the floor

When a bug escapes that an item should have caught, fix the floor, in this order of strength:

1. Encode it in the target repo as a check that fails on the real mistake (type, lint, test).
2. Add or sharpen the pack item, with the incident as its source.
3. Add the trigger pattern to `detect-packs.sh` if the pack was not selected, plus a fixture in `scripts/fixtures/` and a line in `scripts/test-detect.sh`.

## Rules

- The envelope is done before the design is chosen, not after the code is written.
- Packs selected by the script are never dropped, only answered.
- Every item gets an answer. Silence is not N/A.
- Live means a failure path and a proof. Every Live item gets a mechanism, an enforcement point and a place in the build plan.
- Unverified claims are labelled.
- The envelope stays in `.scratch/`; the PR carries proof, not the checklist.
- Measure the skill, do not trust it: [bench/README.md](bench/README.md) checks recall and run-to-run agreement.
