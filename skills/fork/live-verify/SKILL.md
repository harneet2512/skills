---
name: live-verify
description: Prove a feature works end to end by running the real app in the cloud (a CI runner or this container) against high-fidelity stand-ins for every external system (Slack, Gmail, an LLM provider, webhooks), driving every journey case and every injected fault, and asserting on recorded calls and stored state. Nobody reads a Slack message to know it works, and nothing reaches a real workspace. Use after the build and before review for any feature with a user journey, an external integration or async work, or when asked to "test it live", "test the whole flow", or "prove it works end to end".
---

# Live verify

Unit tests prove functions. This proves the **product**: the real process, started the way it starts in production, receiving the real wire formats (signed Slack requests, Pub/Sub push, provider API shapes), with external systems replaced by stand-ins that record every call and can fail on demand. Each journey case from `shape` and each Live envelope item with a live proof becomes a scenario. Evidence is kept as files.

The reusable harness and a full reference product are in this folder: [README.md](README.md) has the commands, the layout, how to write a scenario and the proof standards. The reference product (`bench/inbox-assist/`, a Slack agent that drafts Gmail replies) runs 40 scenarios across 2 app instances in about 50 seconds.

## 1. Inventory the boundaries

From the system model (`deep-engineering` section 1), list every external system the feature talks to, in both directions: who calls us (Slack events and interactions, provider webhooks, push subscriptions, cron) and whom we call (Slack Web API, Gmail, a model provider, a payment API). For each, note the wire format, the auth (signature, bearer, OIDC), the platform deadline and the failure modes the provider documents (429 with Retry-After, 5xx, redelivery, out of order).

## 2. Get a stand-in for each

Use the harness stand-ins in `harness/standins/` when they cover the system; extend them when they do not; write a new one in the same shape when the system is new. A stand-in must:

- speak the real protocol (paths, auth, response shapes, error shapes), checked against the provider's docs, not invented;
- record every call it receives and every delivery it makes;
- inject faults per method and per nth call: status codes, delay, hang, connection reset, timeout after the side effect happened, duplicate and reordered delivery;
- keep state the way the provider does (Gmail history ids and threads, Slack message ts), so follow-up calls are realistic.

Mocks inside the app are not stand-ins. The app under test runs unmodified, with only base URLs and credentials pointed at the stand-ins through config.

## 3. Write the scenarios

One file per journey case or attack, tagged with the journey step and the concern IDs it proves (from `concern-topics` and the envelope). Cover, at minimum:

- every journey step's happy path, from install and first run to done;
- every journey case from the shape file (twice, two actors, stale, abandoned, slow or failed, hostile, first and empty);
- every Critical and High envelope item with a live proof, with the failure injected (timeout after success, duplicate delivery, concurrent writer on another instance, instance killed mid-step);
- platform deadlines measured on every request (Slack's 3 second ack is checked automatically);
- tenant isolation: a request from tenant B naming tenant A's objects.

Run at least two app instances against shared storage, so in-process state and cross-instance races show up. Assert observable outcomes only: what the stand-ins recorded, what the app answered, the rows users' answers come from. No fixed sleeps: wait on a predicate.

## 4. Run it in the cloud

`node <this skill>/harness/runner.mjs --app <app-dir> --instances 2` from the target repo, locally or in CI. [ci/live-verify.yml](ci/live-verify.yml) is a GitHub Actions workflow that runs it on every pull request and uploads `.scratch/live/` as an artifact. When the feature calls a model, run the happy path once more with the real model (`--llm claude` in the reference harness) so prompts and parsing meet real output; model quality itself is measured by `evals`, not here.

Before trusting the suite, **break each safeguard once** (remove the conditional update, the signature window check, the tenant filter, the reconciliation) and confirm the matching scenario fails. A scenario that passes with its safeguard removed proves nothing and gets fixed.

## 5. Report

The console shows scenario names, pass or fail, and counts. The PR gets the `report.md` table (scenario, journey step, concern IDs, result) and the run's artifact link. Nobody has to read the messages the agent would have posted; the assertions did.

## Tier 2: the real platform

Stand-ins prove the app against the protocol as documented. Before release, a nightly run against a dedicated sandbox workspace and test mailbox, read back by API and cleaned up after, proves it against the real platform. The README describes the setup. It is not run on every PR: real APIs rate-limit and add flake.

## Rules

- The app under test is the production build with config changes only.
- Every fault a scenario injects is asserted to have fired.
- Evidence survives teardown; teardown kills only what the run started.
- A failing scenario is a bug in the product or in the stand-in; find out which before changing either.
- Real customer workspaces and mailboxes are never used for verification.
