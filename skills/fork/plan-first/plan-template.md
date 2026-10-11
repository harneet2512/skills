# Plan: <feature name>

<!-- Fill every section below in plan mode, then approve once. `scripts/check-gates.sh --plan` lists any section that
is missing or empty. Keep the headings exactly as written: the loop finds each section by its heading text.
A section that does not apply says `n/a: <reason>`. Never leave TBD or a placeholder. -->

## Decisions

<!-- What `grilling` settled with the user: one line each, the requirement or choice and who confirmed it.
Open questions go in "Open questions" with a recommended default, never in this section. -->

## Acceptance tests

<!-- 3 to 5 checks in the owner's words that say the feature is done, written at the end of grilling and confirmed by
the owner (stop 1: the owner types `approve acceptance`). One line each: `AT<n>: <observable behaviour>`. Each one
needs a passing automated test or a live-verify scenario named after it before the PR (gate G12). -->

## Size and why

<!-- small, normal or large, with the risk reasoning (see feature-loop "Size it first"), and the slug. -->

## External dependencies

<!-- Every key, sandbox account, test workspace, inbox and model provider the live run needs: present or missing
(by name only, never a secret), and the local stand-in used until a missing one arrives. -->

## Files to create or change

<!-- Paths, one line each, with what changes. A shared-contract change (API schema, DB schema, wire format) comes first. -->

## Skeleton ticket

<!-- The existing issue (#N) whose PR first runs the thinnest path through the whole journey, real at every layer
it touches, ending in one happy-path live-verify scenario. Name the issue and the scenario. Never a new ticket. -->

## Tickets and seams

<!-- A table (Issue, Blocked by, Branch base, ATs, Journey cases, Live items, Seams) with one row per EXISTING issue (#N), in
build order. Never invent or split issues: a big issue is broken into steps inside its own row. Branch base is the
previous issue's branch when that PR is not merged yet (stacked), else the default branch. ATs are the acceptance
tests (AT<n>) this issue's tests prove; every AT is covered by at least one issue. For each: journey cases,
Live items, topic categories, and the seams where its tests attach (existing seams preferred, the highest possible).
Approving the plan confirms these seams. -->

## Skill per stage

<!-- The skill that runs at each step, so nobody guesses. Once for all issues: grill-me, deep-engineering,
behavioral-envelope and concern-topics (and shape for a user journey) in plan mode, then codex-review on the plan.
Per issue, through wp-loop: tdd with attack tests first, live-verify scenarios, behavioral-envelope re-check,
adversarial-review, codex-review code attack on the risky issues (name them), then the PR only when every test, type
check, lint and scenario is green. Never to-spec or to-tickets (they publish new issues); the reviewer merges. -->

## Verification

<!-- How each Live item is proved (test, live-verify scenario, eval gate) and the command or scenario name. -->

## Failure modes

<!-- What breaks, for whom, and what the product does: the Critical and High items from the concerns, each with its
mechanism. -->

## Time box

<!-- The demo_by time (with a zone) when there is one, else `none`, and the order of cuts if time runs short. -->

## Concerns

<!-- Output of `behavioral-envelope/scripts/detect-packs.sh --plan <this file or the request>`: the packs selected and
the triggering lines. Run it while planning, so the concern checklist is part of the approved plan. -->

## Design challenge

<!-- The codex plan review (codex-review skill, plan mode, gpt-6-astra) that ran on this file right after plan mode:
the report path, each CONFIRMED finding with how this plan now resolves it, PLAUSIBLE ones with the decision, and the
cuts accepted. Required for every size. Filled before stop 2; the owner approves the plan with `approve plan`. -->

## Open questions

<!-- Only when grilling hit its cap (3 rounds or 20 minutes): each open question with the recommended default, for one
yes-or-edit answer. Empty once approved. -->

## Changes

<!-- Written during the build, never before. One line per deviation from the plan, appended as it happens:
- Changed: <what differs from the plan> because <what the build found>
-->
