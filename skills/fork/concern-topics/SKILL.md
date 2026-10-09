---
name: concern-topics
description: Thirteen fixed engineering topics (user journey, concurrency, scale, data integrity, reliability, security, multi-tenancy, AI behavior, latency, cost, operability, compliance, code craft), each with categories that say how a thing fails, how to spot it in a plan and in code, how to build it right, how to prove it, and how to attack it. Use at design time to decide mechanisms per journey step, just in time while writing code that touches a topic, and in adversarial review to attack the result. Also use when asked how to make something concurrency-safe, scalable, tenant-safe, reliable, secure or clean.
---

# Concern topics

A fixed list of concerns gets skimmed, and a model asked "what could go wrong" recalls a different list every run. Topics fix the **areas** (breadth) and give each one **categories with depth**: the failure mechanism, a real incident, what it looks like in a plan and in code, the safe construction with dangerous and safe snippets, the proof that injects the failure, and how much of it v1 needs.

The behavioral envelope is the floor. Topics are the depth behind it: they are where the mechanism, the code shape and the attack come from.

Each topic file is in [topics/](topics/) and follows [topic-template.md](topic-template.md).

| Topic | File | Prefix |
|---|---|---|
| User journey | [user-journey.md](topics/user-journey.md) | UJ |
| Concurrency | [concurrency.md](topics/concurrency.md) | CONC |
| Scale | [scale.md](topics/scale.md) | SCALE |
| Data integrity | [data-integrity.md](topics/data-integrity.md) | DI |
| Reliability | [reliability.md](topics/reliability.md) | REL |
| Security | [security.md](topics/security.md) | SEC |
| Multi-tenancy | [multi-tenancy.md](topics/multi-tenancy.md) | TEN |
| AI behavior | [ai-behavior.md](topics/ai-behavior.md) | AI |
| Latency | [latency.md](topics/latency.md) | LAT |
| Cost | [cost.md](topics/cost.md) | COST |
| Operability | [operability.md](topics/operability.md) | OPS |
| Compliance | [compliance.md](topics/compliance.md) | COMP |
| Code craft | [code-craft.md](topics/code-craft.md) | CRAFT |

## Which topics apply

**Requires:** `.scratch/envelope/<slug>.md` with its `**Packs:**` line filled. If it is missing, call the Skill tool with `behavioral-envelope` first.

`user-journey` and `code-craft` apply to every change. The rest follow from the envelope's selected packs, so the choice is as deterministic as the pack selection:

| Envelope pack | Topics it pulls in |
|---|---|
| `ui-visual`, `ui-behavior` | user-journey, latency |
| `api` | security, concurrency, latency, reliability |
| `data` | data-integrity, concurrency, scale |
| `outbound` | reliability, concurrency, cost, compliance |
| `inbound-events` | concurrency, reliability, security |
| `jobs-time` | reliability, concurrency, operability |
| `integrations-auth` | security, multi-tenancy, reliability |
| `llm`, `retrieval` | ai-behavior, cost, latency, security |
| `identity-access` | security, multi-tenancy, compliance |
| `files` | security, scale, data-integrity |
| `personal-data` | compliance, security, multi-tenancy |
| `infra-config` | operability, reliability, security |
| `dependencies` | security, code-craft |
| `money` | data-integrity, concurrency, reliability, compliance |

Any change with more than one tenant's data in the system pulls in `multi-tenancy`. Any change that ships to users pulls in `operability`. Add a topic by judgment and say why. Every topic the table selects stays selected.

**Done when:** the topic list holds `user-journey`, `code-craft`, every topic the table maps from every pack on the envelope's `**Packs:**` line, `multi-tenancy` and `operability` where their conditions hold, and each judgment-added topic with its reason.

## Three ways to use a topic

### At design: the journey x topic matrix

**Requires:** `.scratch/shape/<slug>.md`. If it is missing, stop and name the missing stage: `shape`.

Take the journey map from `shape` (steps x actors x states). For each journey step, walk the **Design questions** of each applicable topic and answer each one with a mechanism. Write the result as a matrix in the design: one row per journey step, one column per topic, each cell either a mechanism ID or `none: <reason>`. A step that touches shared state also gets a **safety argument** (actors x shared state x interleavings x guard, see `concurrency.md`).

Read the categories the question leads to. The goal is that the design already contains the right mechanism, so the adversarial pass later finds nothing.

**Done when:** every step of every journey case in `.scratch/shape/<slug>.md` has a cell in every applicable topic column, each a mechanism ID or `none: <reason>`, and every step touching shared state has a safety argument.

### Just in time: while writing code

Before writing or changing code that matches a category's **Spot it in code** patterns (a state update, an outbound call, a queue consumer, a query on tenant data, a model call), read that category's **Build it right** and **Dangerous / Safe** snippets and write the safe shape the first time. The builder's brief names the categories in play for each slice.

**Done when:** for every category the brief names or the new code's patterns match, the code takes that category's **Safe** shape.

### In review: attack

**Requires:** `.scratch/envelope/<slug>.md` and the diff.

The adversarial pass gives one attacker per applicable topic (as `adversarial-review` section 4 caps them by size) its **Attack recipes**. A finding counts once it is reproduced by a failing test or a live scenario; see `adversarial-review`.

**Done when:** every chosen topic's attacker has reported, and every CONFIRMED row in `.scratch/review/<slug>.md` `## Findings` names its reproduction.

## Code craft is checked mechanically too

[scripts/slop-check.sh](scripts/slop-check.sh) flags the mechanical signs of careless code in added lines: swallowed errors, log-and-continue, `any`, unexplained ignores, debug output, commented-out code, narration comments, sleeps used as synchronization, magic timeouts and hard-coded secrets. Run it from the target repo root:

```
<this skill>/scripts/slop-check.sh --diff <base>     # added lines vs base, plus untracked files
<this skill>/scripts/slop-check.sh --paths <files>   # whole files
```

Exit 0 means clean, 1 means findings (one per line: rule, `file:line`, snippet). Design judgment belongs to the `CRAFT` categories and the review. `scripts/test-slop.sh` is its regression suite.

**Done when:** gate G6 is green: `slop-check.sh --diff <base>` reports nothing, or every finding's `file:line` is listed under `## Justified` in `.scratch/review/<slug>.md` with a reason.

## Rules

- Topics are fixed; categories grow. A miss that escaped to production becomes a new or sharper category with the incident as its source, the same way envelope packs grow.
- Every answer to a design question is a mechanism plus its Enforced at, or `none: <reason>`.
- Size for an enterprise product with real customers now. Each category's **Size for now** says what waits for evidence.
- Sources in each topic were opened by the author; unverified claims are labelled in the file.
