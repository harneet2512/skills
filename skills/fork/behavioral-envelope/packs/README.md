# Concern packs

One file per kind of change. `scripts/detect-packs.sh` selects them from the code; the skill answers every item in every selected pack.

| Pack | Selected when the change touches |
|---|---|
| [core](core.md) | Always |
| [ui-visual](ui-visual.md) | Styles, colors, design tokens, layout, themes, translations |
| [ui-behavior](ui-behavior.md) | Components with state, forms, client-side requests |
| [api](api.md) | HTTP routes, handlers, RPC, public interfaces |
| [data](data.md) | Schemas, migrations, queries that write, ORMs |
| [outbound](outbound.md) | Email, SMS, push, outbound webhooks, any message to a person or system outside |
| [inbound-events](inbound-events.md) | Webhooks received, queues consumed, event handlers |
| [jobs-time](jobs-time.md) | Scheduled or background work, timers, dates, time zones |
| [integrations-auth](integrations-auth.md) | Third-party APIs, OAuth, tokens, API keys |
| [llm](llm.md) | Model calls, prompts, agents, tool use, generated text |
| [retrieval](retrieval.md) | Search, embeddings, vector stores, ranking, scraping for context |
| [identity-access](identity-access.md) | Users, roles, permissions, tenants, sessions |
| [files](files.md) | Uploads, downloads, object storage, images, documents |
| [personal-data](personal-data.md) | Personal data stored, logged, exported or deleted |
| [infra-config](infra-config.md) | Deploy config, CI, containers, environment variables, DNS, certificates, feature flags |
| [dependencies](dependencies.md) | Package manifests and lockfiles |
| [money](money.md) | Prices, amounts, currency, payments, quantities, rounding, trading |

## Item format

Each item has an ID, a title, and three lines:

- **Ask**: the question the envelope must answer for this change.
- **Right way**: how mature teams handle it.
- **Proof**: the evidence that shows it holds.

Items cite [sources](SOURCES.md) as `S<n>`. An item with no `S` is general engineering practice; check it against the target stack before relying on it.

## Adding an item

Add an item only for a failure that has happened (an incident, an escaped bug, a review finding) or that a cited source names. Give it the next free ID in its pack, never reuse a retired ID, and add its source. If a pack would need a new trigger, add the pattern to `scripts/detect-packs.sh` with a fixture.
