---
name: live-verify
description: Prove a feature works end to end by running the real app in the cloud (a CI runner or this container) against high-fidelity stand-ins for every external system (Slack, Gmail, an LLM provider, webhooks), driving every journey case and every injected fault, and asserting on recorded calls and stored state. Assertions replace reading Slack messages, and nothing reaches a real workspace. Also runs in happy-path mode: one scenario through the running app for a walking skeleton or small work, so the product runs live before the rest is built. Use for the skeleton, after each slice, and before review for any feature with a user journey, an external integration or async work, or when asked to "test it live", "test the whole flow", or "prove it works end to end".
---

# Live verify

Unit tests prove functions. This proves the **product**: the real process, started the way it starts in production, receiving the real wire formats (signed Slack requests, Pub/Sub push, provider API shapes), with each external system replaced by a **stand-in** that records every call and fails on demand. Each journey case from `shape` and each Live envelope item with a live proof becomes a scenario. Evidence is kept as files.

## Two modes

| Mode | When | What it needs | What it proves |
|---|---|---|---|
| **Happy path** | the walking skeleton (`feature-loop` stage 4, ticket 1); after each slice merges; small work (`wp-loop` step 6b) | the envelope, plus the shape file when there is one | the main journey runs end to end on the real process: one scenario (or a few), stand-ins for every external system the path touches, one instance |
| **Full** | `feature-loop` stage 5 and `wp-loop` step 6b on normal and large work | the shape file and the envelope | every journey case and every Critical and High Live item with a live proof, two instances, faults injected |

Happy path runs steps 1 to 4 for the systems on that path only, with a single scenario file whose `meta.journey` names the main journey case when the shape file has one. Write it so it keeps passing as the feature grows: it is the check every later slice merges against. Full mode is the whole skill below.

[README.md](README.md) has the harness commands, the layout, how to write a scenario and the proof standards. The reference product (`bench/inbox-assist/`, a Slack agent that drafts Gmail replies) runs 40 scenarios across 2 app instances in about 50 seconds.

## 1. Inventory the boundaries

From the system model (`deep-engineering` section 1), list every external system the feature talks to, in both directions: who calls us (Slack events and interactions, provider webhooks, push subscriptions, cron) and whom we call (Slack Web API, Gmail, a model provider, a payment API).

**Done when:** every external system, inbound and outbound, has an entry with its wire format, auth (signature, bearer, OIDC), platform deadline and the failure modes the provider documents (429 with Retry-After, 5xx, redelivery, out of order).

## 2. Get a stand-in for each

**Requires:** the step 1 inventory. Use `harness/standins/`, extend it where it falls short, or write a new stand-in in the same shape. A stand-in:

- speaks the real protocol (paths, auth, response shapes, error shapes), checked against the provider's docs;
- records every call it receives and every delivery it makes;
- injects faults per method and per nth call: status codes, delay, hang, connection reset, timeout after the side effect happened, duplicate and reordered delivery;
- keeps state the way the provider does (Gmail history ids and threads, Slack message ts), so follow-up calls are realistic.

The app under test is the production build, unmodified, with only base URLs and credentials pointed at the stand-ins through config.

**Done when:** every inventoried system has a stand-in meeting all four points, reached by the app through config alone.

## 3. Write the scenarios

**Requires:** `.scratch/envelope/<slug>.md`, and in full mode `.scratch/shape/<slug>.md`; if one is missing, stop and name the stage that writes it (`behavioral-envelope`, `shape`).

One file per journey case or attack. Its `meta.journey` lists the journey case ID(s) it proves, in the shape file's form `J<n>.<case>` (for example `J3.two-actors`), plus the journey step; its `meta.concerns` lists the concern IDs (from `concern-topics` and the envelope). Cover:

- every journey step's happy path, from install and first run to done;
- every journey case from the shape file (twice, two actors, stale, abandoned, slow or failed, hostile, first and empty);
- every Critical and High envelope item with a live proof, with the failure injected (timeout after success, duplicate delivery, concurrent writer on another instance, instance killed mid-step);
- platform deadlines measured on every request (Slack's 3 second ack is checked automatically);
- tenant isolation: a request from tenant B naming tenant A's objects.

Assert observable outcomes: what the stand-ins recorded, what the app answered, the rows users' answers come from. Every wait is on a predicate (`waitFor`), and every fault a scenario injects is asserted to have fired.

**Done when:** in happy-path mode, the one scenario drives the main journey through every layer the path touches and asserts its observable outcome. In full mode, every journey case ID in the shape file appears in at least one scenario's `meta.journey`, and every Critical and High Live item with a live proof has a scenario naming its ID in `meta.concerns`.

## 4. Run it in the cloud

**Requires:** the step 3 scenarios. Run `node <this skill>/harness/runner.mjs --app <app-dir> --instances 2` (`--instances 1` in happy-path mode) from the target repo, locally or in CI. Two instances against shared storage surface in-process state and cross-instance races. [ci/live-verify.yml](ci/live-verify.yml) is a GitHub Actions workflow that runs it on every pull request and uploads `.scratch/live/` as an artifact. When the feature calls a model, run the happy path once more with the real model (`--llm claude` in the reference harness) so prompts and parsing meet real output; `evals` measures model quality.

In full mode, before trusting the suite, **break each safeguard once** (remove the conditional update, the signature window check, the tenant filter, the reconciliation) and confirm the matching scenario goes red. A scenario that stays green with its safeguard removed is fixed until it goes red.

A red scenario is a bug in the product or in the stand-in; find out which before changing either. Evidence survives teardown, and teardown kills only what the run started.

**Done when:** gate G3 is green: the newest `.scratch/live/<run>/report.json` is newer than the last commit, it has at least one scenario, every scenario in it has `result: "pass"`, and on normal and large work every journey case ID from the shape file appears in at least one scenario's `journey` field. In full mode, each safeguard was also broken once and its scenario went red.

## 5. Report

**Requires:** the `report.md` from the step 4 run. The assertions are the proof, so nobody reads the messages the agent would have posted.

**Done when:** the PR carries the run's `report.md` table (scenario, journey step, concern IDs, result) and its artifact link.

## Tier 2: the real platform

Stand-ins prove the app against the protocol as documented. A nightly and pre-release run against a dedicated sandbox workspace and test mailbox, read back by API and cleaned up after, proves it against the real platform; the README describes the setup. It stays outside the PR loop because real APIs rate-limit and add flake.

Never point a run at a real customer workspace or mailbox: what it posts and sends there is real and irreversible. Dedicated sandboxes and test mailboxes only.
