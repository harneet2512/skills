---
name: behavioral-envelope
description: Find every concern a change must satisfy to really work, the same way on every run. Derives concerns from what the change is for, selects concern packs (UI, API, data, email, webhooks, jobs and time, integrations, LLM output, money, and more) with a deterministic script, answers every item in each pack, and hands the live ones to tests and live verification. Use before building or fixing anything, including small changes such as a color or a copy edit, when deep-engineering runs, or when asked "what could go wrong", "what am I missing", or "what are the concerns".
---

# Behavioral Envelope

The envelope is everything that must hold for a change to do its job in the real world, not just on the happy path. An LLM asked "what could go wrong?" recalls a different list on every run, and a miss in that list ships as a bug. This skill removes recall from the floor: a script picks the concern packs from the code, every item in every picked pack gets an explicit answer, and judgment only adds on top.

It writes no product code. Its output is the **envelope file**, and its live items feed the engineering contract, `tdd`, and live verification.

## 1. Derive from purpose

State, in one line each:

- **Purpose**: what this change is for, and for whom.
- **Properties**: what must hold for that purpose. A button color must be visible, correct and distinct. An order path must be fast, exact and placed once. An outbound email must reach the right person once, with true content.

Every concern below is judged against these properties. A concern that threatens none of them is not live.

## 2. Select packs with the script, not by memory

Run [scripts/detect-packs.sh](scripts/detect-packs.sh) from the target repo's root, by its path inside this skill's folder:

- **Before code exists**: `<this skill>/scripts/detect-packs.sh --paths <files the change will touch>` (take the files from the system model, `deep-engineering` section 1). It scans those whole files, so it selects a superset; answer the extra packs as N/A.
- **After code exists**: `<this skill>/scripts/detect-packs.sh --diff <base>` scans only the added lines, and ignores `.scratch/`.

It prints each selected pack with the line that triggered it. `core` is always selected. You may add a pack by judgment (say why). You may never drop a pack the script selected; answer its items as `N/A` instead. The script errs toward inclusion on purpose: an extra pack costs a few one-line answers, a missed pack costs a production bug.

Packs live in [packs/](packs/README.md), one file per kind of change.

## 3. Answer every item

For every item in every selected pack, write exactly one of:

- **Live**: it can fail in this change. Write the failure path *in this code* (`path:symbol`), the right way to handle it (the pack's guidance, or a source you checked), and the proof (test, live scenario, eval, screenshot, measurement).
- **Later**: real, not reachable by this change. One line, filed as a follow-up.
- **N/A**: one clause saying why.

The rule that keeps it lean: **no failure path in this code and no proof means it is not Live.** "Consider performance" with nothing behind it is deleted, not written.

When the pack's guidance does not fit, or the item depends on a library, protocol or provider behavior you cannot confirm from the repo, resolve it against primary sources (repo code and tests first, then official docs; for anything heavy, call the Skill tool with `research`). Unresolved items are marked `(unverified)` and listed as open questions.

## 4. Add what the packs miss

After the packs, ask once more from the properties in step 1: what else would stop this change doing its job? Add each finding as an extra item with the same Live/Later/N/A shape. This is the only place recall is used, and it can only add.

## 5. Second pass for risky changes

When any selected pack is `outbound`, `inbound-events`, `money`, `identity-access`, `personal-data` or `data`, or the change is irreversible, run a second independent pass: a fresh subagent (a different model when one is available) gets the purpose, the pack list and the touched files, never your answers. Take the union of Live items. Where the passes disagree on an item, look at the code again and record the deciding evidence.

## 6. Write the envelope file

Write it from [envelope-template.md](envelope-template.md) to `.scratch/envelope/<slug>.md`. It is a working file for the engineer, not PR content. It holds every answer, so the reasoning is auditable and the engineer learns from it.

Hand off only the Live items:

- To the contract: Live items become its Risks, and their proofs become *Verification required*.
- To `tdd`: each Live item with a test proof becomes a behavior to assert at a confirmed seam.
- To live verification: each Live item with a live proof becomes a scenario run against the real system.

The PR shows the handled Live items and their evidence. It does not paste the envelope.

## 7. Re-check against the diff

Before review, run `<this skill>/scripts/detect-packs.sh --diff <base>` again from the target repo's root. A pack the diff triggers that the envelope did not cover means the change grew: answer that pack's items before review starts.

## 8. Every miss raises the floor

When a bug escapes that an item should have caught, fix the floor, in this order of strength:

1. Encode it in the target repo as a check that fails on the real mistake (type, lint, test).
2. Add or sharpen the pack item, with the incident as its source.
3. Add the trigger pattern to `detect-packs.sh` if the pack was not selected, plus a fixture in `scripts/fixtures/` and a line in `scripts/test-detect.sh`.

## Rules

- Packs selected by the script are never dropped, only answered.
- Every item gets an answer. Silence is not N/A.
- Live means a failure path in this code and a proof. Nothing else is Live.
- Unverified claims are labelled.
- The envelope stays in `.scratch/`; the PR carries proof, not the checklist.
- Measure the skill, do not trust it: [bench/README.md](bench/README.md) checks recall and run-to-run agreement.
