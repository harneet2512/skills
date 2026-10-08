---
name: deep-engineering
description: Senior/staff engineering reasoning before implementation. Builds a system model from repository evidence, derives invariants, discovers which engineering concerns matter for this change (and marks the rest irrelevant), researches uncertain technical semantics, compares alternatives, judges architectural fit, and ends with a concise engineering contract. Use before building or fixing anything non-trivial - a feature, a stateful or concurrent bug, a change touching persistence, external systems, async work, APIs, or other components' boundaries - or when asked to "think like a staff engineer", "design this properly", or "what could go wrong". Scales down to a few lines for tiny changes.
---

# Deep Engineering

Make the implementation the consequence of engineering reasoning, not coding intuition. This skill runs **after** the request is understood (Matt's `grilling`, `diagnosing-bugs`, `domain-modeling`) and **before** a spec or any code. It produces one artifact: the **engineering contract**. It writes no product code.

It does not duplicate Matt's skills. It does not interview the user about requirements (`grilling`), maintain the glossary/ADRs (`domain-modeling`), write the spec (`to-spec`), or run red/green (`tdd`). Its distinct job is establishing *system truth* from code and primary sources, which those skills assume but do not enforce.

## 0. Size the ceremony first

Pick a tier in one sentence, with the reason, and state it at the top of the contract.

| Tier | When | Output |
|---|---|---|
| **Tiny** | Local, one component, no state/IO/contract change, one sensible implementation | 3-8 lines: intended behavior, invariant touched (if any), the envelope's Live items in one line (the full envelope stays in `.scratch/`, section 3), verification. Stop. |
| **Normal** | One subsystem, some state, an external call or a boundary | Full contract, each section 1-5 bullets. |
| **Major** | New subsystem, cross-component contract, migration, concurrency, money/permissions | Full contract plus alternatives table and a design-challenge pass (Adversarial Engineering, if installed) before the spec. |

Escalate a tier the moment evidence says so (a tiny change that turns out to write shared state is Normal). Never pad. A section with nothing real to say is deleted, not filled.

## 1. Build the system model from evidence

Read before judging. Cite `path:symbol` for every claim; a claim from a filename or a guess is marked `(unverified)`.

Cover only what the change touches: entry points and call paths; who owns each piece of state and where it persists; component boundaries and external systems; async/background paths; existing abstractions that already own this behavior; existing tests and contracts (schemas, ADRs, glossary: use `GLOSSARY.md` vocabulary); conventions visible in neighbouring code; **assumptions the subsystem currently relies on** (clock source, status machines, transaction scope, token lifetimes, uniqueness constraints). Read DB constraints and triggers, not only application code.

Look specifically for **what is NOT built**: the seam your change must call but which does not exist yet, or a guard that covers a sibling path but not yours.

## 2. Derive invariants

State what must remain true, from this domain and this code, not from a template. Each invariant gets: the statement, where it is (or should be) enforced, and the strongest boundary that can enforce it (type, DB constraint, single writer, test). Mark which already hold, which the change could break, and which are new. Prefer invariants that survive retries, restarts and concurrent callers.

## 3. Discover the relevant concerns

Call the Skill tool with `behavioral-envelope`, for every tier, Tiny included: a color change has concerns too, just different ones. Pass it the request text, the purpose and the files from section 1. Its packs are the floor, chosen by a script and answered item by item, so a concern is never skipped because a run forgot it. It returns, for every Live item, a mechanism, where it is enforced, its proof and its runtime signal, plus a build order with shared mechanisms first. Sections 5 to 7 design around that output; they do not re-derive it.

For Normal and Major, then use [concerns.md](concerns.md) as a source of discovery prompts on top of the envelope, **not a checklist to emit**. For each prompt the system model makes live, write one line: the concern, the specific way it bites here, and how it is handled. List irrelevant dimensions as one line: `Irrelevant: <name> - <one-clause reason>`. This makes silence explicit and auditable. Add concerns the list lacks; it is incomplete on purpose.

## 4. Research uncertain semantics

List every assumption that, if wrong, breaks correctness and that you cannot confirm from the repo (DB isolation/locking, queue delivery, framework lifecycle, SDK guarantees, protocol rules). Resolve each against primary sources: repo code and tests first, then official docs/source (for anything heavy, call the Skill tool with `research`). Record `claim -> source -> design decision that depends on it`. If it cannot be resolved, it goes to Open questions, flagged blocking or not.

## 5. Compare alternatives (only where the choice is consequential)

For decisions that are hard to reverse or shape ownership, compare the 2-3 simplest credible options on: correctness against the invariants, how each satisfies the envelope's Live items (an option that cannot host a needed mechanism loses), failure behavior, fit with existing architecture, complexity, compatibility, maintainability. Pick one and say why the others lost. Where there is one sensible option, write one sentence saying so. No performative options; no extensibility without evidence.

## 6. Judge architectural fit and root cause

Answer, tersely, only the ones that apply: Is the responsibility in the right layer? Does an existing abstraction already own it? Does this create a second source of truth? Are illegal states unrepresentable, or at least rejected at the boundary? Is failure behavior explicit? Root-cause fix or symptom patch? Anything speculative? A "no" is a finding: fix the design, not the wording.

## 7. Emit the engineering contract

Use [contract-template.md](contract-template.md). Required sections, in this order: **Invariants, Constraints, Risks (each with why), Verification required, Open questions**; preceded by a short system model, chosen design with rationale (naming the envelope's mechanisms and where each is enforced), the build order from the envelope, and the tier line. Target length: Tiny a few lines, Normal about one page, Major about two. Every risk says *why it happens in this code*, not a generic warning.

## How it composes with Matt's skills

- **Before:** consume `grilling` answers, `diagnosing-bugs` root cause, `domain-modeling` terms (reuse `GLOSSARY.md` names; do not invent vocabulary). If a requirement is genuinely ambiguous, call the Skill tool with `grilling` (batched, with a recommended answer); do not guess.
- **`to-spec`:** the contract's *Chosen design* and *Constraints* become Implementation Decisions; *Invariants* and *Risks* feed user stories and Out of Scope; *Verification required* becomes Testing Decisions. Keep file paths and snippets out of the spec, as `to-spec` requires; they stay in the contract.
- **`tdd` / `implement`:** *Verification required* names the **seams** (public boundaries) and, per invariant, the behavior to assert and the form of evidence (example, table, state-transition, property, concurrency, integration). Expected values come from the invariant, never from re-deriving the algorithm. Seams are proposed here but still confirmed with the user, as `tdd` requires.
- **`code-review`:** the contract is the "originating spec" for the Spec axis; reviewers check invariants and constraints.
- **Feedback:** if implementation or review invalidates the model, update the contract (cause and model, not the symptom), then the spec and tests. Do not patch around it.
- **`behavioral-envelope`:** called in section 3. It selects concern packs from the code with a script and answers every item, and its Live items feed Risks and *Verification required*.
- **Optional sibling:** Adversarial Engineering (challenges design and slices) consumes this contract if installed; this skill stands alone without it.

## Rules

- Evidence over assertion; unverified claims are labelled.
- Depth scales with risk; concision is a quality criterion.
- No product code, no spec writing, no ticket creation here.
- Never present reviewer silence or a green test run as proof the model is right.
