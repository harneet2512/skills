---
name: shape
description: Pin down what a feature is for and how people will actually use it before any design: the intent, who uses it on which surfaces, the journey map (steps x actors x states, including the double click, the second user, the stale message and the failure the user sees), the success metric, and what is out of scope. Use at the start of any feature or user-visible change, before deep-engineering, or when asked "what are we building", "how will users use this", or "map the user journey".
---

# Shape

Concerns change with every request, so every request starts by re-deriving what it is for. Shape turns a request into a **shape file**: intent, users and surfaces, the journey map, the success metric and the scope line. Every later stage reads it: the envelope judges concerns against its properties, design walks its journey steps, live verification turns its journeys into scenarios, evals turn its success criteria into graders.

It writes no design and no code.

## 1. Intent

In one line each:

- **Job**: what the user is trying to get done, in their words, not the feature's name.
- **Why now**: what is broken or missing today.
- **Properties**: what must hold for the job to be done (fast, exact, private, sent once, visible, explainable). These are the properties the behavioral envelope judges against.

If any of these is a guess, call the Skill tool with `grilling` (or `grill-with-docs` when the repo has a glossary) and resolve it with the user. Do not invent intent.

## 2. Users and surfaces

List every actor (end user, a second user on the same object, an admin who installs or approves, the system itself on a schedule, an external sender, an attacker) and every surface they touch (web, Slack, email, API, CLI, mobile, a notification). For an enterprise product, name who installs it, who approves it, and what one tenant is (a workspace, an org, an account).

## 3. Journey map

Follow `user-journey.md` category UJ-01 in `concern-topics`. Write a table of journey steps, in order, from first contact (install, consent, empty state) to the job being done and after (undo, history, uninstall):

| Step | Actor | Surface | What they do | What they see | Platform deadline |
|---|---|---|---|---|---|

Then cross every step with the interaction cases and keep the ones that apply:

- **twice**: double click, resubmit, redelivered event
- **two actors**: two users act on the same object at once
- **stale**: the user acts on a view that changed elsewhere
- **abandoned**: navigate away, close the modal, uninstall mid-flow
- **slow or failed**: a dependency is slow, rate-limited or down; what the user sees
- **hostile**: input that tries to change who receives what, or to read another tenant's data
- **first and empty**: no data yet, first run, nothing to show

Each kept pair is a **journey case** with an ID (`J3.two-actors`). Journey cases become live verification scenarios one for one, and the cases involving model output also become eval cases.

## 4. Success metric

How we will know it works for users, measured, not felt: one primary metric (replies sent from suggestions per week, time from email to reply) and the guardrails that must not get worse (wrong-recipient sends: zero; p95 time to options; cost per suggestion). For any model-generated output, list the success criteria the `evals` skill will grade.

## 5. Scope line

- **In**: the journeys above.
- **Out, on purpose**: what we are not building now, with the trigger that would bring it in (SSO when the first enterprise customer asks; sharding when one table passes a size we can name).
- **Size**: today's load and 10x it. Design for 10x, not for a billion.

## 6. Write the shape file

Write `.scratch/shape/<slug>.md` with sections 1 to 5. Keep it to about one page; the journey map is the long part. Hand off to `deep-engineering` (which calls `behavioral-envelope`), and tell the user the journey cases count and the success metric in two lines.

## Rules

- Users' words for the job, the glossary's words for the domain.
- Every journey step names what the user sees when it fails, not only when it works.
- A case nobody can verify is not a journey case; rewrite it until a scenario could check it.
- Shape stays small. A shape file that reads like a spec is doing `to-spec`'s job.
