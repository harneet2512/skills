---
name: feature-loop
description: "Build a feature the way a strong product engineering team does: shape it around real user journeys, design it with every applicable concern topic before code, build it with the right patterns applied just in time, prove it with tests, evals and cloud live verification, attack it adversarially, ship it behind a flag with a staged rollout, and learn from every miss."
disable-model-invocation: true
---

Take one feature from request to shipped. Each stage calls an existing skill, reads the previous stage's file and leaves evidence; this loop fixes the order and the hand-offs. A **gate** is a check on a stage's file, green or red, decided by `scripts/check-gates.sh`. Gate IDs, paths and formats are in [gates.md](gates.md); each **Done when** below names the same condition.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Size it first

| Size | When | Stages |
|---|---|---|
| **Small** | One component, no new state, no new integration (copy, a color, a validation rule) | 3 (envelope only), 5, 6, 7 (code-review plus slop-check), gate check, 8 without a flag |
| **Normal** | A user-visible behavior with state, an API, a job or an integration | All stages; one work package |
| **Large** | A new subsystem, a new external integration, tenancy, money, an AI feature | All stages; several work packages; design challenged by a second model before the spec |

Say the size and why in one line, and write `.scratch/gates.json` as gates.md specifies: `{ "slug": "<slug>", "size": "<size>", "base": "<branch>" }`. When evidence says the work is bigger, escalate: rewrite `size` and run the stages it adds.

**Done when:** `.scratch/gates.json` holds `slug`, `size` (`small`, `normal` or `large`) and `base`.

## Stages

0. **Baseline.** Once per product: read the tenancy model, auth, deploy path, observability and flags. Note each missing enterprise need (tenant scoping, audit log, SSO hook, staged rollout); the first feature that depends on it builds it as its own work package.
   **Done when:** each of the five is located or marked missing, and each missing one this feature depends on is a work package.

1. **Shape.** Call the Skill tool with `shape`; ambiguity goes to `grilling` or `grill-with-docs`.
   **Done when:** `.scratch/shape/<slug>.md` has intent, actors and surfaces, the journey map, the success metric, the scope line, and at least one journey case ID `J<n>.<case>` (gate G1).

2. **Understand the system.** **Requires:** `.scratch/shape/<slug>.md`. Call the Skill tool with `deep-engineering`: section 1 builds the system model from repo evidence, section 3 calls `behavioral-envelope` with the shape file's properties.
   **Done when:** `.scratch/envelope/<slug>.md` has a filled `**Packs:**` line, at least one `## Live` row (Normal and Large), and every `## Live` row has Severity, Mechanism, Enforced at and Proof, none `TBD`, `TODO` or `?` (gate G2).

3. **Design from concerns.** **Requires:** `.scratch/envelope/<slug>.md` (Small writes it here, to the gate G2 condition, and stops). Still in `deep-engineering`: build the journey x topic matrix from `concern-topics` (each journey step against each applicable topic's design questions), write the safety argument for every step touching shared state, research every pattern you choose (documented failure modes, what the library or provider guarantees), and prefer the design that makes a class of problem impossible over one that guards it. When the envelope's `**Packs:**` line names `llm` or `retrieval` (the change produces, ranks or depends on model output), call the Skill tool with `evals` for the eval plan now, before any prompt exists; every other change skips evals entirely.
   **Done when:** the engineering contract gives every Live item a mechanism, enforcement point and proof, plus the build order; every matrix cell holds a mechanism ID or `none: <reason>`; when evals apply, `.scratch/evals/<slug>.md` has success criteria, cases, graders and a gate.

4. **Plan.** **Requires:** the engineering contract. Call the Skill tool with `to-spec` (contract as input), then `to-tickets`. Foundations (mechanisms several slices depend on, and every mechanism behind a Critical item) are the first tickets.
   **Done when:** every ticket names its journey cases, Live items and topic categories, and every Critical item's mechanism is in a foundation ticket.

5. **Build.** **Requires:** the tickets. For each, call the Skill tool with `wp-loop`. The brief names the slice's topic categories; the builder reads their *Build it right* and snippets before writing code that matches *Spot it in code*. Attack tests (duplicate delivery, concurrent writer, timeout after success) are written first.
   **Done when:** every ticket's `wp-loop` is green and each attack test was red before its code landed.

6. **Prove.** Inside each work package and once more for the whole feature: types, lint, unit and integration tests; `concern-topics/scripts/slop-check.sh --diff <base>`; `evals` with the plan's gate when evals apply; `live-verify` for every journey case and every Live item with a live proof, two instances, faults injected, in the cloud, with the outcome read from assertions.
   **Done when:** types, lint and tests are green; for Normal and Large, the newest `.scratch/live/<run>/report.json` is newer than the last commit, every scenario has `result: "pass"`, and every journey case ID appears in a scenario's `journey` field (gate G3); when evals apply, `.scratch/evals/<slug>/results.json` is newer than the last commit with `ok: true` on every gate (gate G4).

7. **Attack.** Call the Skill tool with `adversarial-review`. Each CONFIRMED finding is fixed with its reproduction kept, and recorded as an escape from stage 3 or 5.
   **Done when:** `.scratch/review/<slug>.md` has no CONFIRMED CRITICAL or HIGH row with resolution `open` or empty (gate G5, Normal and Large), and every slop-check finding is fixed or listed under `## Justified` (gate G6).

**Gate check.** Run `<this skill>/scripts/check-gates.sh` from the target repo root and fix each red line at the file it names. The plugin hook runs the same check before `git push` and `gh pr create`. The bypass (`FEATURE_LOOP_GATES=off` with `FEATURE_LOOP_BYPASS_REASON`) is for emergencies only, because it ships unchecked work; the hook logs it to `.scratch/loop-metrics.md` and Learn reviews it.
**Done when:** `check-gates.sh` exits 0.

8. **Ship.** Behind a flag or kill switch. Migrations in expand then contract order. The envelope's runtime signals wired to alerts before users get it. Staged enable: internal tenant, then a small share of tenants, then everyone, with a stated rollback trigger at each step (the shape file's guardrail metrics).
   **Done when:** the feature is fully enabled and the success metric and every guardrail are checked against their baseline.

9. **Learn.** Call the Skill tool with `retro`. Each escape (an escaped bug or CONFIRMED finding) raises the floor where it should have been caught: a repo check, an envelope pack item, a topic category, a live scenario or an eval case (envelope section 10, topic rules, evals "Learn"). Review every logged bypass for this slug.
   **Done when:** every escape has its floor change, every bypass has a stated cause, and `.scratch/loop-metrics.md` has a line for `<slug>` with findings by stage, live scenarios added, eval deltas and time from start to merge (gate G7).

## Hand-offs

| From | File | Read by |
|---|---|---|
| feature-loop | `.scratch/gates.json` | `check-gates.sh`, the plugin hook |
| shape | `.scratch/shape/<slug>.md` | envelope (properties), deep-engineering (journey steps), live-verify (journey cases), evals (success criteria) |
| behavioral-envelope | `.scratch/envelope/<slug>.md` | deep-engineering, wp-loop step 10, adversarial-review |
| deep-engineering | contract | to-spec, wp-loop builder brief, adversarial-review design axis |
| evals | `.scratch/evals/<slug>.md`, eval suite in repo | wp-loop gate, CI |
| live-verify | `.scratch/live/<run>/report.md`, `report.json` | PR body, adversarial-review |
| adversarial-review | `.scratch/review/<slug>.md`, `.scratch/loop-metrics.md` | retro |

## Rules

- Every stage the size table lists runs to its Done when.
- Concerns are design inputs: a concern first found in stage 7 is an escape from stage 3.
- Size for an enterprise product with real customers now and 10x its load; anything bigger waits for evidence.
