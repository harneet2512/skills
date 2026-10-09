---
name: shape
description: Pin down what a feature is for and how people will actually use it before any design: the intent, who uses it on which surfaces, the journey map (steps x actors x states, including the double click, the second user, the stale message and the failure the user sees), the success metric, and what is out of scope. Use at the start of any feature or user-visible change, before deep-engineering, or when asked "what are we building", "how will users use this", or "map the user journey".
---

# Shape

Every request starts by re-deriving what it is for. Shape turns a request into a **shape file**, `.scratch/shape/<slug>.md`: intent, users and surfaces, the journey map, the success metric and the scope line. Later stages read it: the envelope judges concerns against its properties, design walks its journey steps, live verification turns its journey cases into scenarios, evals turn its success criteria into graders. Shape's output is this file alone; design and code come later.

## 1. Intent

In one line each:

- **Job**: what the user is trying to get done, in their words (the feature's name comes later).
- **Why now**: what is broken or missing today.
- **Properties**: what must hold for the job to be done (fast, exact, private, sent once, visible, explainable). The behavioral envelope judges against these.

When any of these is a guess, call the Skill tool with `grilling` (or `grill-with-docs` when the repo has a glossary) and resolve it with the user.

**Done when:** job, why now and properties each have one line the user stated or confirmed.

## 2. Users and surfaces

List every actor (end user, a second user on the same object, an admin who installs or approves, the system itself on a schedule, an external sender, an attacker) and every surface they touch (web, Slack, email, API, CLI, mobile, a notification). For an enterprise product, name who installs it, who approves it, and what one tenant is (a workspace, an org, an account).

**Done when:** every actor in the list above is named or marked absent, each with its surfaces, and installer, approver and tenant are named for an enterprise product.

## 3. Journey map

Follow `user-journey.md` category UJ-01 in `concern-topics`. Write a table of journey steps, in order, from first contact (install, consent, empty state) to the job being done and after (undo, history, uninstall):

| Step | Actor | Surface | What they do | What they see | What they see when it fails | Platform deadline |
|---|---|---|---|---|---|---|

Then cross every step with the interaction cases and keep the ones that apply:

- **twice**: double click, resubmit, redelivered event
- **two actors**: two users act on the same object at once
- **stale**: the user acts on a view that changed elsewhere
- **abandoned**: navigate away, close the modal, uninstall mid-flow
- **slow or failed**: a dependency is slow, rate-limited or down; what the user sees
- **hostile**: input that tries to change who receives what, or to read another tenant's data
- **first and empty**: no data yet, first run, nothing to show

Each kept pair is a **journey case** with an ID `J<n>.<case>`, where `<n>` is the step number (`J3.two-actors`). Each journey case is written so a scenario could check it: it becomes one live verification scenario, and a case involving model output also becomes an eval case.

**Done when:** every journey step has a filled "What they see when it fails" cell, and every kept pair has a `J<n>.<case>` ID with an expected outcome a scenario could assert.

## 4. Success metric

How we will know it works for users, measured: one primary metric (replies sent from suggestions per week, time from email to reply) and the guardrails that must hold (wrong-recipient sends: zero; p95 time to options; cost per suggestion). For any model-generated output, list the success criteria the `evals` skill will grade.

**Done when:** the primary metric and every guardrail each have a number or a baseline to compare against, and model-generated output has its success criteria listed.

## 5. Scope line

- **In**: the journeys above.
- **Out, on purpose**: what waits, with the trigger that would bring it in (SSO when the first enterprise customer asks; sharding when one table passes a size we can name).
- **Size**: today's load and 10x it. Design for 10x.

**Done when:** every Out item has a trigger and the size line has both numbers.

## 6. Write the shape file

Write `.scratch/shape/<slug>.md` with sections 1 to 5, about one page; the journey map is the long part. Use the user's words for the job and the glossary's words for the domain. Hand off to `deep-engineering` (which calls `behavioral-envelope`), and tell the user the journey case count and the success metric in two lines.

**Done when:** `.scratch/shape/<slug>.md` has sections 1 to 5 and at least one journey case ID `J<n>.<case>` (gate G1, see `feature-loop/gates.md`).

Shape stays small: a shape file that reads like a spec has moved into `to-spec`'s job.
