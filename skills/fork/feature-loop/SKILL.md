---
name: feature-loop
description: "Build a feature the way a strong product engineering team does: shape it around real user journeys, design it with every applicable concern topic before code, build it with the right patterns applied just in time, prove it with tests, evals and cloud live verification, attack it adversarially, ship it behind a flag with a staged rollout, and learn from every miss."
disable-model-invocation: true
---

Take one feature from request to shipped, with each stage reading the previous stage's file and leaving evidence. Each stage calls an existing skill; this loop only fixes their order and the hand-offs.

The issue tracker should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`.

## Size it first

| Size | When | Stages |
|---|---|---|
| **Small** | One component, no new state, no new integration (copy, a color, a validation rule) | 3 (envelope only), 5, 6, 7 (code-review plus slop-check), 8 without a flag |
| **Normal** | A user-visible behavior with state, an API, a job or an integration | All stages; one work package |
| **Large** | A new subsystem, a new external integration, tenancy, money, an AI feature | All stages; several work packages; design challenged by a second model before the spec |

Say the size and why in one line. Escalate the moment evidence says so.

## Stages

0. **Baseline.** Once per product, not per feature: read the product's tenancy model, auth, deploy path, observability and flags. When something enterprise customers need is missing (tenant scoping, audit log, SSO hook, staged rollout), note it; build it when a feature first depends on it, as its own work package.

1. **Shape.** Call the Skill tool with `shape`. Output: `.scratch/shape/<slug>.md` with intent, actors and surfaces, the journey map and journey cases, the success metric and the scope line. Ambiguity goes to `grilling` or `grill-with-docs`, never to a guess.

2. **Understand the system.** Call the Skill tool with `deep-engineering`. Its section 1 builds the system model from repo evidence. Its section 3 calls `behavioral-envelope` with the shape file's properties.

3. **Design from concerns.** Still in `deep-engineering`: build the journey x topic matrix from `concern-topics` (each journey step against each applicable topic's design questions, answered with a mechanism), write the safety argument for every step that touches shared state, research every pattern you are about to choose (how its failure modes are documented, what the library or provider guarantees), and look for the design that makes a class of problem impossible instead of guarded. For any model-generated output, call the Skill tool with `evals` for the eval plan (success criteria, cases, graders, gate) now, not after the prompt exists. Output: the engineering contract with mechanisms, enforcement points, proofs and build order.

4. **Plan.** Call the Skill tool with `to-spec` (contract as input), then `to-tickets`. Foundations (the mechanisms several slices depend on, and every mechanism behind a Critical item) are the first tickets. Each ticket names its journey cases, Live items and topic categories.

5. **Build.** For each ticket, call the Skill tool with `wp-loop`. Its builder writes the safe shape the first time: the brief names the topic categories in play for that slice, and the builder reads their *Build it right* and snippets before writing code that matches *Spot it in code*. Attack tests (duplicate delivery, concurrent writer, timeout after success) are written before the code they attack.

6. **Prove.** Inside each work package and once more for the whole feature:
   - types, lint, unit and integration tests;
   - `concern-topics/scripts/slop-check.sh --diff <base>`;
   - `evals` for every model-generated output, with the gate from the eval plan;
   - `live-verify` for every journey case and every Live item with a live proof, two instances, faults injected, in the cloud. The user never reads a Slack message to know it worked.

7. **Attack.** Call the Skill tool with `adversarial-review`. CONFIRMED findings are fixed with their reproduction kept; each one is also recorded as an escape from stage 3 or 5.

8. **Ship.** Behind a flag or kill switch. Migrations in expand then contract order. Runtime signals from the envelope wired to alerts before users get it. Staged enable: internal tenant first, then a small share of tenants, then everyone, with a stated rollback trigger at each step (the guardrail metrics from the shape file). After full enable, check the success metric and the guardrails against their baseline.

9. **Learn.** Call the Skill tool with `retro`. Every escaped bug or CONFIRMED review finding raises the floor where it should have been caught: a check in the target repo, an envelope pack item, a topic category, a live scenario, or an eval case (envelope section 10, topic rules, evals "Learn"). Append the change's numbers to `.scratch/loop-metrics.md`: findings by stage, live scenarios added, eval deltas, time from start to merge.

## Hand-offs

| From | File | Read by |
|---|---|---|
| shape | `.scratch/shape/<slug>.md` | envelope (properties), deep-engineering (journey steps), live-verify (journey cases), evals (success criteria) |
| behavioral-envelope | `.scratch/envelope/<slug>.md` | deep-engineering, wp-loop step 10, adversarial-review |
| deep-engineering | contract | to-spec, wp-loop builder brief, adversarial-review design axis |
| evals | `.scratch/evals/<slug>.md`, eval suite in repo | wp-loop gate, CI |
| live-verify | `.scratch/live/<run>/report.md` | PR body, adversarial-review |
| adversarial-review | `.scratch/loop-metrics.md` | retro |

## Rules

- No stage is skipped because the previous one felt thorough. Small changes run fewer stages by the size table, not by mood.
- Concerns are design inputs: a concern first found in stage 7 is an escape from stage 3 and gets recorded as one.
- Size for an enterprise product with real customers now and 10x its load. Everything bigger waits for evidence.
- Evidence over claims at every gate.
