---
name: deep-engineering
description: Senior/staff engineering reasoning before implementation. Builds a system model from repository evidence, derives invariants, discovers which engineering concerns matter for this change (and marks the rest irrelevant), researches uncertain technical semantics, compares alternatives, judges architectural fit, and ends with a concise engineering contract. Use before building or fixing anything non-trivial - a feature, a stateful or concurrent bug, a change touching persistence, external systems, async work, APIs, or other components' boundaries - or when asked to "think like a staff engineer", "design this properly", or "what could go wrong". Scales down to a few lines for tiny changes.
---

# Deep Engineering

Make the implementation follow from engineering reasoning grounded in evidence. This skill runs **after** the request is understood (Matt's `grilling`, `diagnosing-bugs`, `domain-modeling`) and **before** a spec or any code. Its one output is the **engineering contract**, written from [contract-template.md](contract-template.md); product code, the spec and tickets come later from the skills downstream.

Requirements interviews stay with `grilling`, the glossary and ADRs with `domain-modeling`, the spec with `to-spec`, red/green with `tdd`. This skill's job is *system truth* from code and primary sources, which those skills assume and leave unchecked.

## 0. Size the ceremony first

Pick a tier in one sentence, with the reason, and state it at the top of the contract.

| Tier | When | Output |
|---|---|---|
| **Tiny** | Local, one component, no state/IO/contract change, one sensible implementation | 3-8 lines: intended behavior, invariant touched (if any), the envelope's Live items in one line (the full envelope stays in `.scratch/`, section 3), verification. Stop. |
| **Normal** | One subsystem, some state, an external call or a boundary | Full contract, each section 1-5 bullets. |
| **Major** | New subsystem, cross-component contract, migration, concurrency, money/permissions | Full contract plus alternatives table and a design-challenge pass (Adversarial Engineering, if installed) before the spec. |

Escalate a tier the moment evidence says so (a tiny change that turns out to write shared state is Normal). Every section kept says something real; delete the rest.

**Done when:** the contract's `**Tier:**` line names Tiny, Normal or Major with a one-sentence reason.

## 1. Build the system model from evidence

Read before judging. Cite `path:symbol` for every claim; mark a claim from a filename or a guess `(unverified)`.

Cover what the change touches: entry points and call paths; who owns each piece of state and where it persists; component boundaries and external systems; async/background paths; existing abstractions that already own this behavior; existing tests and contracts (schemas, ADRs, glossary: use `GLOSSARY.md` vocabulary); conventions visible in neighbouring code; **assumptions the subsystem currently relies on** (clock source, status machines, transaction scope, token lifetimes, uniqueness constraints). Read DB constraints and triggers alongside application code.

Hunt for **what is unbuilt**: the seam your change must call that is still missing, or a guard that covers a sibling path and skips yours.

**Done when:** the contract's System model covers every item above the change touches, every claim cites `path:symbol` or is marked `(unverified)`, and every unbuilt seam or uncovered guard found is named (or the line `unbuilt: none found`).

## 2. Derive invariants

State what must remain true, from this domain and this code. Each invariant gets: the statement, where it is (or should be) enforced, and the strongest boundary that can enforce it (type, DB constraint, single writer, test). Mark which already hold, which the change could break, and which are new. Prefer invariants that survive retries, restarts and concurrent callers.

**Done when:** every row of the contract's Invariants table has a statement, a status (holds, at risk, or new) and an Enforced at cell naming the strongest boundary.

## 3. Discover the relevant concerns

**Envelope, every tier.** Call the Skill tool with `behavioral-envelope`, Tiny included: a color change has concerns too, just different ones. Pass it the request text, the purpose and the files from section 1. It returns every Live item with its mechanism, Enforced at, proof and runtime signal, plus the build order; sections 5 to 7 design around that output as given.

**Topics and matrix, Normal and Major.** Call the Skill tool with `concern-topics` and take the topics its table selects from the envelope's packs.

**Requires (matrix):** `.scratch/shape/<slug>.md`. When it is missing, the matrix waits, and Open questions names the missing stage `shape`.

Build the **journey x topic matrix**: one row per journey step, one column per topic, each cell a mechanism ID or `none: <reason>`, answered from the topic's design questions. Every step that touches shared state gets a written safety argument (actors x shared state x interleavings x guard). Check every chosen mechanism against the topic's *Build it right* and its documented failure modes before it enters the contract.

**Evals, only when the envelope's `**Packs:**` line names `llm` or `retrieval`** (the change produces, ranks or depends on model output): call the Skill tool with `evals` for the eval plan here, before any prompt exists.

**Discovery prompts.** Use [concerns.md](concerns.md) as prompts on top of the envelope and topics. For each prompt the system model makes live, write one line: the concern, the specific way it bites here, and how it is handled. Fold the rest into one line: `Irrelevant: <name> - <one-clause reason>`, so silence is explicit and auditable. Add concerns the list lacks; it is incomplete on purpose.

**Done when:** gate G2 is green for `.scratch/envelope/<slug>.md`; for Normal and Major, every step of every journey case in `.scratch/shape/<slug>.md` has a cell in every applicable topic column, each a mechanism ID or `none: <reason>`, and every step touching shared state has a safety argument (or, with no shape file, Open questions names `shape`); when the Packs line names `llm` or `retrieval`, `.scratch/evals/<slug>.md` exists; and the contract's Concerns section has a line for every live prompt plus one `Irrelevant:` line.

## 4. Research uncertain semantics

List every assumption that, if wrong, breaks correctness and that the repo leaves unconfirmed (DB isolation/locking, queue delivery, framework lifecycle, SDK guarantees, protocol rules). Resolve each against primary sources: repo code and tests first, then official docs/source (for anything heavy, call the Skill tool with `research`). Record `claim -> source -> design decision that depends on it`.

**Done when:** every such assumption is a row in the contract's Researched claims table with its source and dependent decision, or sits in Open questions marked BLOCKING or non-blocking.

## 5. Compare alternatives (only where the choice is consequential)

For decisions that are hard to reverse or shape ownership, compare the 2-3 simplest credible options on: correctness against the invariants, how each satisfies the envelope's Live items (an option that cannot host a needed mechanism loses), failure behavior, fit with existing architecture, complexity, compatibility, maintainability. Pick one and say why the others lost. Where there is one sensible option, write one sentence saying so. Compare only credible options, and add extensibility only where evidence asks for it.

**Done when:** every hard-to-reverse decision in Chosen design has either the comparison with a reason each loser lost, or the one-sentence statement that one option is sensible.

## 6. Judge architectural fit and root cause

Answer, tersely, the ones that apply: Is the responsibility in the right layer? Does an existing abstraction already own it? Does this create a second source of truth? Are illegal states unrepresentable, or at least rejected at the boundary? Is failure behavior explicit? Root-cause fix or symptom patch? Anything speculative? An answer that exposes a flaw is a finding: change the design itself, then answer again.

**Done when:** every applicable question has an answer in Chosen design, and every answer that exposed a flaw points to the design change that fixed it.

## 7. Emit the engineering contract

**Requires:** `.scratch/envelope/<slug>.md`. If it is missing, run section 3 first.

Use [contract-template.md](contract-template.md). Required sections, in this order: **Invariants, Constraints, Risks (each with why), Verification required, Open questions**; preceded by a short system model, chosen design with rationale (naming the envelope's mechanisms and where each is enforced), the build order from the envelope, and the tier line. Target length: Tiny a few lines, Normal about one page, Major about two. Every risk says *why it happens in this code*.

**Done when:** the contract has every required section in that order, names every mechanism from the envelope's `## Mechanisms` with its Enforced at, carries the envelope's build order, gives every risk a why in this code, and its `**Status:**` line reads `resolved` or `draft` with the blocking questions listed.

## How it composes with Matt's skills

- **Before:** consume `grilling` answers, `diagnosing-bugs` root cause, `domain-modeling` terms (reuse `GLOSSARY.md` names). When a requirement is genuinely ambiguous, call the Skill tool with `grilling` (batched, with a recommended answer) to settle it.
- **`to-spec`:** the contract's *Chosen design* and *Constraints* become Implementation Decisions; *Invariants* and *Risks* feed user stories and Out of Scope; *Verification required* becomes Testing Decisions. File paths and snippets stay in the contract, as `to-spec` requires.
- **`tdd` / `implement`:** *Verification required* names the **seams** (public boundaries) and, per invariant, the behavior to assert and the form of proof (example, table, state-transition, property, concurrency, integration). Expected values come from the invariant, by a route independent of the algorithm under test. Seams are proposed here and confirmed with the user, as `tdd` requires.
- **`code-review`:** the contract is the "originating spec" for the Spec axis; reviewers check invariants and constraints.
- **Feedback:** when implementation or review invalidates the model, update the contract (cause and model), then the spec and tests, so the fix lands in the model rather than around it.
- **`behavioral-envelope`:** called in section 3; its Live items feed Risks and *Verification required*.
- **Optional sibling:** Adversarial Engineering (challenges design and slices) consumes this contract if installed; this skill stands alone without it.

## Rules

- Evidence over assertion; unverified claims are labelled.
- Depth scales with risk; concision is a quality criterion.
- The model counts as right on cited evidence (sections 1 and 4). Reviewer silence and a green test run are no proof of it.
