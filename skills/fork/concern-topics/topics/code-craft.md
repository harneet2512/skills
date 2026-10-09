# Code craft

**Protects:** code that reads as if a careful senior engineer wrote it with the whole system in mind: every fact has one owner, every failure goes somewhere on purpose, and a reader can change it next month without fear. The opposite is generated slop: plausible lines that compile, pass a happy-path test, and quietly add a second source of truth, a swallowed error or a layer nobody needed.
**Read when:** any code is written or reviewed. Plan signals: "add a helper", "make it configurable", "handle errors", "wrap the client", "add a flag", "quick fix", "for now", "refactor while I'm here". Code signals: `catch`/`except` blocks, new files under `utils/` or `helpers/`, new interfaces with one implementation, new config keys, new dependencies, comments added next to new code, mocks in tests, numeric literals near `timeout`, `sleep`, `retry`.
**Prefix:** CRAFT

The mechanical half of this topic has a detector: `scripts/slop-check.sh --diff` lists rule hits as `RULE<TAB>file:line<TAB>snippet`. Rule IDs start with the category they belong to (`CRAFT-03.empty-catch` belongs to CRAFT-03); `SLOP.secret` (hard-coded keys, tokens, private keys and passwords) has no category here because it is a security finding, not a craft one. A clean run proves only that the regex-visible slop is absent; ownership, naming and abstraction still need a reader.

## Design questions

1. For each fact this change reads or writes, which single module, table or column owns it, and what stops a second copy from drifting?
2. Which combinations of fields would be nonsense (paid with no payment id, cancelled and active)? Which type, enum or constraint makes them impossible to construct?
3. For each call that can fail, which layer knows what to do about the failure, and what does every layer below it do (rethrow, wrap, or translate)? Name the layer, not "we handle it".
4. Which words in the code are not words the domain experts or the product spec use? What is the glossary term for each?
5. Which abstraction, option or extension point in this change has exactly one caller or one value today? What breaks if it is inlined?
6. What can this change delete? Is there a restructuring after which the special case, flag or helper is no longer needed at all?
7. Where does untrusted input enter, and is it parsed into a precise type there, so code past that point has no reason to re-check it?
8. What does the neighbouring code already do for this (error type, logger, HTTP client, date library, naming style)? Where does the change differ, and why?
9. Which tests would fail if the behavior broke, and which would fail if only the internals were rearranged? The second set is a cost, not coverage.
10. Which numbers in this change (timeouts, limits, sizes, retries) carry a decision? Where is each decision named and where is its reason written?
11. Which lines of the diff are not needed for the stated change? Can they move to a separate change?

## Categories

### CRAFT-01 One owner per responsibility

**How it fails:** the same fact lives in two writable places: a `status` column and an `is_active` boolean, a price in the database and a copy in a config map, a permission check in the controller and a different one in the service. One path updates its copy and the other does not. Readers see the stale copy (a cancelled customer still billed, a removed admin still allowed), and nobody can say which copy is right because both look authoritative.
**Seen in the wild:** No verified incident. The failure follows directly from storing one fact in two writable places with no transaction or derivation linking them.
**Spot it in a plan:** "also store", "cache the value on the row", "keep in sync", "mirror", "denormalize for convenience", a second module that "also validates" or "also computes" something an existing module owns.
**Spot it in code:** two fields whose names describe the same thing (`status` and `isActive`, `deleted_at` and `is_deleted`); the same constant or literal list defined in two files (`grep -rn "'pro', 'team'"`); a function that recomputes a value another module already exports; writes to the same column from more than one module (`grep -rn "UPDATE accounts SET plan"`).
**Build it right:** pick the owner and derive everything else. Strongest first: a generated or computed column, or a view, so the copy cannot be written; a single module that is the only writer (enforced by import rules or code review); a derived getter instead of a stored field; if a copy must exist for speed, name it as a cache, give it an owner that rebuilds it, and never let other code write it.

Dangerous:
```ts
type Account = { status: "active" | "cancelled"; isActive: boolean };

async function cancel(id: AccountId) {
  await db.account.update({ where: { id }, data: { status: "cancelled" } });
  // isActive is still true; billing reads isActive.
}
```
```python
PLAN_PRICES = {"pro": 2000, "team": 5000}  # billing/prices.py
# ...and in checkout/views.py
PRICES = {"pro": 2000, "team": 4900}
```

Safe:
```ts
type Account = { status: "active" | "cancelled" };
const isActive = (a: Account): boolean => a.status === "active";
```
```python
# billing/prices.py is the only owner; checkout imports it.
from billing.prices import price_for_plan
```

**Prove it:** a test that changes the fact through every public write path and then reads it through every read path; any read that disagrees is a second owner. In review, grep for the field and constant names across the repo and count writers.
**Size for now:** one owner per fact, enforced by convention and review. A read-side cache is fine once a profile shows the read is slow; build the rebuild path with it, not later.

### CRAFT-02 Illegal states unrepresentable

**How it fails:** a type with loose optional fields or free-form strings allows combinations the domain forbids: an order with `paidAt` but no `paymentId`, a status of `"canceled"` next to `"cancelled"`, a quantity in the wrong unit. Every reader must remember the unwritten rules, and the one that forgets corrupts data. `any`, unchecked casts and blanket type-ignores switch the checker off exactly where it would have caught this.
**Seen in the wild:** Mars Climate Orbiter (lost 23 September 1999): ground software produced thruster impulse in pound-force seconds while the trajectory software expected newton-seconds, and the plain numbers passed between them with nothing to tell them apart [10].
**Spot it in a plan:** "status string", "flags for each state", "optional fields filled in later", "we'll validate it", units described only in prose ("the value is in ms").
**Spot it in code:** several optional fields that are only valid together; `status: string`; `str` columns holding a closed set; numbers named without a unit (`timeout`, `amount`). Detector: `CRAFT-02.any` (`: any`, `as any`, `<any>`), `CRAFT-02.type-ignore` (`@ts-ignore`, bare `# type: ignore`, bare `# noqa`, `eslint-disable` with no `-- reason`).
**Build it right:** model each state as its own variant: a TypeScript discriminated union, a Python `Enum` plus frozen dataclasses per state. Put the same rule in the database: a Postgres enum or `CHECK` constraint, `NOT NULL` where the field is required, a `CHECK` that ties fields together (`CHECK ((status = 'paid') = (payment_id IS NOT NULL))`). Put units in names or types (`timeoutMs`, `Cents`). When the checker must be silenced, say why on the same line.

Dangerous:
```ts
type Order = { status: string; paidAt?: Date; paymentId?: string; refundId?: string };
const order = JSON.parse(body) as any;
```
```python
@dataclass
class Order:
    status: str                 # "pending", "paid", "refunded"... maybe "canceled"
    paid_at: datetime | None = None
    payment_id: str | None = None
```

Safe:
```ts
type Order =
  | { status: "pending" }
  | { status: "paid"; paidAt: Date; paymentId: PaymentId }
  | { status: "refunded"; paidAt: Date; paymentId: PaymentId; refundId: RefundId };
const order = OrderSchema.parse(JSON.parse(body)); // zod or similar at the boundary
```
```python
class OrderStatus(Enum):
    PENDING = "pending"
    PAID = "paid"

@dataclass(frozen=True)
class PaidOrder:
    paid_at: datetime
    payment_id: PaymentId
```

**Prove it:** try to construct each forbidden combination in a test; it must fail to compile, fail to parse, or be rejected by the database constraint (insert the row with raw SQL and expect the constraint error).
**Size for now:** unions or enums for every closed set and a database constraint for every invariant that money or access depends on. Branded or newtype IDs can wait until two ID types have actually been mixed up.

### CRAFT-03 Errors handled at the right layer

**How it fails:** a low layer catches an error it cannot handle and keeps going: an empty `catch {}`, `except Exception: pass`, or a catch that logs and returns as if nothing happened. The caller then works on missing or half-written data, and the first visible symptom shows up far from the cause. The opposite failure is a broad catch high up that turns every bug, including programming errors, into the same generic retry or 500.
**Seen in the wild:** a study of 198 user-reported failures in Cassandra, HBase, HDFS, MapReduce and Redis found that 92% of the catastrophic ones came from incorrect handling of non-fatal errors, and 35% from trivial mistakes: 25% ignored the error (including handlers that only logged it), 8% aborted on an overly general exception, 2% had a TODO in the handler [1].
**Spot it in a plan:** "catch and log", "fail silently", "best effort" with no statement of what is lost, "wrap everything in try/except", "retry on any error".
**Spot it in code:** detector rules `CRAFT-03.empty-catch` (`catch {}`, `.catch(() => {})`, `except ...: pass`), `CRAFT-03.log-and-continue` (a catch whose only statement is a log call, `.catch(console.error)`), `CRAFT-03.bare-except` (`except:`). Also by hand: `except Exception` or `catch (e)` below the request or job boundary; `return null` or `return []` inside a catch.
**Build it right:** decide per error who can act on it. Lower layers either let it propagate, or wrap it with context (`raise X from exc`, `new Error(msg, { cause })`) when the low-level type would leak an implementation detail. One boundary per entry point (HTTP handler, job runner, CLI main) catches broadly, logs once with context, and maps to a response or a retry. A swallowed error is allowed only for a named, expected case, with a comment that says what is lost and why that is acceptable, and preferably a metric.

Dangerous:
```ts
try {
  await ledger.record(charge);
} catch (err) {
  console.error("ledger failed", err);
}
return { ok: true };
```
```python
try:
    ledger.record(charge)
except Exception:
    pass
```

Safe:
```ts
try {
  await ledger.record(charge);
} catch (err) {
  throw new LedgerWriteFailed(charge.id, { cause: err });
}
```
```python
try:
    ledger.record(charge)
except LedgerUnavailable as exc:
    raise ChargeNotRecorded(charge.id) from exc
```

**Prove it:** inject the failure (stub the dependency to raise, or kill it in a live run) and assert the caller sees an error or a retry, not a success. For each remaining swallow, a test shows the documented loss is the only effect.
**Size for now:** one boundary handler per entry point, typed errors only where a caller branches on them. A full error taxonomy can wait until callers need to tell more cases apart.

### CRAFT-04 Names from the domain glossary

**How it fails:** code invents its own words: `item`, `data`, `entity`, `processRecord`, `client` meaning three different things, or `user` where the product says "member" and "seat" are different concepts. Readers translate on every line, two developers pick two words for one concept and a later change updates one of them. Product and engineering stop being able to talk about the same thing.
**Seen in the wild:** No verified incident. Fowler's write-up of Evans's Ubiquitous Language explains why a shared, rigorous vocabulary between developers and users matters and why names should change when the model changes [6].
**Spot it in a plan:** the plan uses one word and the schema another; "for now call it X"; generic nouns (`manager`, `handler`, `processor`, `info`, `data`).
**Spot it in code:** `grep -rnE "\b(data|info|item|obj|tmp|result|manager|helper|utils?)\b"` in new identifiers; two names for one table or concept across modules; abbreviations the domain does not use.
**Build it right:** keep a glossary (a `CONTEXT.md` or the domain section of the spec) and use its terms for types, tables, functions and events. When the domain word changes, rename in code too, in a dedicated change. Name functions for what they mean in the domain (`cancelSubscription`), not what they do mechanically (`updateRow`).

Dangerous:
```ts
async function processItem(data: Record<string, unknown>) {
  const obj = await mgr.get(data.id as string);
  return handle(obj);
}
```
```python
def handle_data(info: dict) -> dict:
    rec = repo.fetch(info["id"])
    return transform(rec)
```

Safe:
```ts
async function renewSubscription(id: SubscriptionId): Promise<Invoice> {
  const subscription = await subscriptions.get(id);
  return billing.invoiceRenewal(subscription);
}
```
```python
def renew_subscription(subscription_id: SubscriptionId) -> Invoice:
    subscription = subscriptions.get(subscription_id)
    return billing.invoice_renewal(subscription)
```

**Prove it:** read the change aloud to someone who knows the domain but not the code; every word they ask about is a naming bug. Grep the glossary terms and check each appears in the code that implements it.
**Size for now:** a short glossary for the nouns that cross module boundaries. A full domain model document can wait.

### CRAFT-05 No speculative abstraction or configuration

**How it fails:** the change builds for futures nobody asked for: an interface with one implementation, a factory for one class, a plugin registry, a config key with one value, a `strategy` parameter every caller passes the same way. Each one is code that must be read, tested and kept compatible, and each one hides the real flow behind indirection. When the real second case arrives it rarely fits the guessed shape.
**Seen in the wild:** No verified incident. Fowler breaks the cost of presumptive features into cost of build, delay, carry and repair [5]; Google's review guide names over-engineering (code more generic than needed, or functionality the system does not need yet) as something reviewers should push back on [8].
**Spot it in a plan:** "make it pluggable", "in case we need", "generic", "configurable", "future-proof", "framework for", an options object with more fields than callers.
**Spot it in code:** an `interface`/`Protocol`/`ABC` with one implementation; `Factory`, `Registry`, `Strategy`, `Provider`, `BaseX` with one subclass; new config keys or env vars read in one place with one value; boolean parameters every caller passes the same way; wrapper functions that only forward arguments.
**Build it right:** write the direct code for the case in front of you. Introduce the abstraction when the second real case arrives, shaped by both. A config value exists only when someone needs to change it without a deploy; otherwise it is a named constant. Delete pass-through wrappers.

Dangerous:
```ts
interface NotificationStrategy { send(msg: Message): Promise<void> }
class EmailStrategy implements NotificationStrategy { /* the only one */ }
const strategy = StrategyFactory.create(config.notificationStrategy ?? "email");
```
```python
class BaseExporter(ABC):
    @abstractmethod
    def export(self, rows: list[Row]) -> bytes: ...

class CsvExporter(BaseExporter):  # the only subclass
    ...
```

Safe:
```ts
await email.send(message);
```
```python
def export_csv(rows: list[Row]) -> bytes:
    ...
```

**Prove it:** for each new abstraction, inline it in a scratch branch; if the tests pass and the code is shorter and no caller changed meaning, the abstraction was speculative.
**Size for now:** zero speculative extension points. An interface is justified by a second implementation that exists (a fake used in tests counts only when the real one is slow or external).

### CRAFT-06 No dead code, commented-out code or debug leftovers

**How it fails:** unreachable functions, unused flags, commented-out blocks, stray `console.log` and `TODO` notes accumulate. Readers cannot tell which paths are live, a later change reactivates an old path by accident, debug output leaks data into logs, and TODOs become permanent because nothing tracks them.
**Seen in the wild:** Knight Capital, 1 August 2012: an order router still contained an old function that was no longer meant to be used; a new deployment triggered it, the router sent more than 4 million orders in 45 minutes while trying to fill 212 customer orders, and the firm lost more than $460 million [2].
**Spot it in a plan:** "leave the old path in just in case", "comment it out for now", "we'll clean it up later", flags that are never removed after rollout.
**Spot it in code:** detector rules `CRAFT-06.commented-code` (comment lines that parse as code), `CRAFT-06.debug-output` (`console.log`, `debugger`, `print(`, `breakpoint()` outside tests and CLI tools), `CRAFT-06.todo` (`TODO`, `FIXME`, `XXX`). By hand: exported symbols with no importers (`ts-prune`, `vulture`), feature flags at 100% for weeks, branches on conditions that cannot be true.
**Build it right:** delete it; version control keeps history. Remove a feature flag in the change after rollout completes. Use the project logger at a debug level for diagnostics you want to keep. A TODO is acceptable only with an issue link (`TODO(#123)`), so it is tracked somewhere other than the code.

Dangerous:
```ts
export function total(lines: Line[]): number {
  // const legacy = lines.map(toLegacy);
  console.log("lines", lines);
  return lines.reduce((sum, l) => sum + l.cents, 0); // TODO tax
}
```
```python
def total(lines: list[Line]) -> int:
    # return legacy_total(lines)
    print("lines", lines)
    return sum(line.cents for line in lines)
```

Safe:
```ts
export function total(lines: Line[]): Cents {
  return lines.reduce((sum, l) => sum + l.cents, 0); // tax is applied by the invoice, see #482
}
```
```python
def total(lines: list[Line]) -> Cents:
    return sum(line.cents for line in lines)
```

**Prove it:** run `slop-check.sh --diff` and a dead-code tool; zero unexplained hits. For removed flags or paths, a test exercises the remaining path for the inputs that used to take the old one.
**Size for now:** the detector on every change and dead-code tooling when the codebase is large enough that nobody knows what is used.

### CRAFT-07 Comments say why, not what

**How it fails:** comments restate the code (`// increment counter`), narrate the edit (`// Added retry logic`, `// Fixed bug`), or describe a function by its mechanics (`// This function loops over users`). They add reading time, go stale the moment the code changes, and drown the few comments that matter: the reason a strange-looking line must stay strange.
**Seen in the wild:** No verified incident. Google's review guide says comments should explain why code exists rather than what it does, and that unclear code should be simplified instead of explained [8].
**Spot it in a plan:** "add comments everywhere", "document each step".
**Spot it in code:** detector rule `CRAFT-07.narration` (comments starting with `Added`, `Updated`, `Changed`, `Fixed`, `This function`, `This method`, `Now we`, `Here we`, `We now`; docstrings that narrate the edit). By hand: a comment that would still be true if you deleted it and read only the next line.
**Build it right:** a comment answers a question the code cannot: why this order, why this constant, why the obvious approach is wrong, which external constraint forces it, with a link when there is one. The history of the change belongs in the commit message and the PR. If the code needs a "what" comment, rename or extract until it does not.

Dangerous:
```ts
// Added retry logic for the webhook
// This function loops over the events and saves each one
for (const event of events) await save(event); // save the event
```
```python
# Updated to use the new client
# Now we check if the user is active
if user.is_active:
    notify(user)
```

Safe:
```ts
// Stripe redelivers for up to three days, so save() must treat a seen event id as success.
for (const event of events) await save(event);
```
```python
# Inactive users keep their data for 30 days (contract clause 7.2) but must not be contacted.
if user.is_active:
    notify(user)
```

**Prove it:** delete each new comment and reread the code; if nothing is lost, the comment goes. If a reader would now ask "why?", the comment stays and should answer exactly that.
**Size for now:** why-comments where the code surprises; nothing else.

### CRAFT-08 Small functions at one level of abstraction

**How it fails:** one function parses input, queries the database, applies business rules, formats a response and sends an email, switching between domain intent and byte-level detail line by line. Readers cannot see the rule for the mechanics, edge cases get bolted into the middle, and testing one rule means setting up all of it.
**Seen in the wild:** No verified incident. Google's review guide asks reviewers to check complexity at the line, function and class level and defines "too complex" as code readers cannot understand quickly or are likely to break when changing it [8].
**Spot it in a plan:** "one endpoint that does everything", "add a branch for this case".
**Spot it in code:** functions over roughly 40 lines; nesting deeper than three; a function that mixes SQL or HTTP calls with business decisions; boolean parameters that switch behavior (`render(x, true, false)`); new `if` branches inserted into an already long function.
**Build it right:** the top-level function reads as a list of domain steps, each a call to a function at the next level down. Pure decision logic is separate from I/O so it can be tested with plain values. Replace boolean mode parameters with two named functions. Use early returns instead of nesting.

Dangerous:
```ts
async function checkout(req: Request) {
  const body = await req.json();
  if (!body.items?.length) return new Response("empty", { status: 400 });
  let total = 0;
  for (const i of body.items) { const p = await db.query("select price from products where id=$1", [i.id]); total += p.rows[0].price * i.qty; }
  if (body.coupon && body.coupon.startsWith("VIP")) total *= 0.9;
  await fetch(MAILER_URL, { method: "POST", body: JSON.stringify({ to: body.email, total }) });
  return Response.json({ total });
}
```
```python
def checkout(request):
    body = request.json
    total = 0
    for item in body["items"]:
        row = db.execute("select price from products where id = %s", [item["id"]]).fetchone()
        total += row[0] * item["qty"]
    if body.get("coupon", "").startswith("VIP"):
        total = total * 9 // 10
    requests.post(MAILER_URL, json={"to": body["email"], "total": total})
    return {"total": total}
```

Safe:
```ts
async function checkout(req: Request) {
  const cart = parseCart(await req.json());
  const prices = await catalog.pricesFor(cart.items);
  const total = applyCoupon(subtotal(cart.items, prices), cart.coupon);
  await receipts.send(cart.email, total);
  return Response.json({ total });
}
```
```python
def checkout(request) -> dict:
    cart = parse_cart(request.json)
    prices = catalog.prices_for(cart.items)
    total = apply_coupon(subtotal(cart.items, prices), cart.coupon)
    receipts.send(cart.email, total)
    return {"total": total}
```

**Prove it:** the business rules (`subtotal`, `applyCoupon`) have tests that use plain values with no database or network. A reviewer can state what the top-level function does from its body alone.
**Size for now:** extract when a function mixes levels or a rule needs its own test. Do not split a clear 30-line function into ten 3-line ones.

### CRAFT-09 Deleting code beats adding code

**How it fails:** each change is solved by adding: another flag, another special case, another helper next to an almost identical one. The local fix works, but the number of concepts a reader must hold grows with every change, and bugs live in the interactions between special cases. The better move, restructuring so the problem no longer exists, is never considered because adding is always locally cheaper.
**Seen in the wild:** No verified incident. The failure follows from complexity that only grows: every added branch multiplies the paths that need to be reasoned about and tested.
**Spot it in a plan:** "add a special case for", "add a flag so that", "handle this one customer", "copy the existing function and tweak it".
**Spot it in code:** new `if` checks on a specific id, tenant or name; a new function that differs from an existing one by a few lines; a diff that is all additions in a module that already handles the concept; repeated conditionals on the same field across files (a missing type or table).
**Build it right:** before adding, ask what restructuring would make the new case an ordinary case: data instead of branches (a table of rules), a type that makes the special case a variant, moving the decision to the module that already owns the concept, or fixing the upstream shape so the downstream workaround is unnecessary. Prefer the change whose net line count goes down.

Dangerous:
```ts
function shippingCost(order: Order): Cents {
  if (order.customerId === "acme") return 0;
  if (order.region === "EU" && order.total > 10_000) return 0;
  if (order.region === "US" && order.total > 7_500) return 0;
  return order.region === "EU" ? 900 : 700;
}
```
```python
def send_invoice(invoice):
    ...
def send_invoice_with_cc(invoice, cc):
    ...  # same 40 lines plus one header
```

Safe:
```ts
// Per-region rules live in data; Acme's free shipping is a contract term stored on the account.
function shippingCost(order: Order, rules: ShippingRules, account: Account): Cents {
  if (account.freeShipping) return 0;
  const rule = rules[order.region];
  return order.total >= rule.freeAbove ? 0 : rule.flatFee;
}
```
```python
def send_invoice(invoice: Invoice, cc: Sequence[str] = ()) -> None:
    ...
```

**Prove it:** compare the line count and the number of branches before and after; for a restructure, the existing tests pass unchanged and the new case is covered by adding a row of data or a test, not a branch.
**Size for now:** take the restructuring when it is local and the tests cover it. A cross-module rewrite to remove one branch needs its own change and its own review.

### CRAFT-10 Fit the neighbourhood: local conventions and a minimal diff

**How it fails:** the change uses its own style instead of the codebase's: a second HTTP client, a new error type next to the established one, `camelCase` in a `snake_case` module, a different logger. Or the diff reformats, renames and refactors code the change did not need to touch. Reviewers cannot find the real change, conventions fork, and a later reader has two ways to do everything.
**Seen in the wild:** No verified incident. Google's review guide says that when no rule applies the author should match the existing code [8], and its small-CL guide asks for one self-contained change with refactorings in a separate CL from feature work [7].
**Spot it in a plan:** "while I'm in there", "clean up the file", "I prefer X so I used X", a new library for something the codebase already does.
**Spot it in code:** a diff with whitespace or formatting churn outside the changed functions; renames unrelated to the change; a second import for the same job (`axios` next to the project's `fetch` wrapper, `requests` next to `httpx`); new code whose naming or error style differs from the file it lives in.
**Build it right:** before writing, read the neighbouring code and reuse its helpers, error types, logger and naming. If the convention is wrong, change it everywhere in a dedicated change, not partly in this one. Keep each diff to what the change needs; put refactors and formatting in their own commit or PR.

Dangerous:
```ts
// The repo uses apiClient with retries and auth; this adds a second path.
import axios from "axios";
const res = await axios.get(`${BASE}/accounts/${id}`);
```
```python
# Module uses snake_case and raises AccountError everywhere else.
def getAccountData(accountId):
    raise Exception("not found")
```

Safe:
```ts
const account = await apiClient.get<Account>(`/accounts/${id}`);
```
```python
def get_account(account_id: AccountId) -> Account:
    raise AccountNotFound(account_id)
```

**Prove it:** `git diff --stat` shows only files the change needs; a review of each hunk can state which requirement it serves. Grep for the job the new code does (HTTP, logging, dates) and confirm only one way exists.
**Size for now:** match local conventions always; separate-PR refactors when they exceed a few lines.

### CRAFT-11 Defensive checks only at boundaries

**How it fails:** generated code checks everything everywhere: `if (!user) return null` deep inside a function that only receives users from a typed caller, `x?.y?.z ?? ""` on values that cannot be missing, `isinstance` checks on internal arguments. The checks hide real bugs by turning them into silent defaults, make every reader wonder whether the value can really be missing, and still miss the place that matters: the boundary where untrusted input enters unparsed.
**Seen in the wild:** No verified incident. Alexis King's "Parse, don't validate" names scattered checks "shotgun parsing" and argues for parsing input into precise types at the edge so the rest of the program cannot see invalid data [4].
**Spot it in a plan:** "add null checks", "be defensive", "handle the case where it's undefined" for values that come from your own code.
**Spot it in code:** optional chaining or `?? default` on non-optional types; `if (!x) return` at the top of internal functions; `isinstance`/`typeof` checks on internal arguments; `try/catch` around pure code; request bodies used without a schema parse.
**Build it right:** parse untrusted input once at the boundary (request handler, queue consumer, file reader, third-party response) into a precise type, and reject it there with a clear error. Inside, trust the types. If an internal value can really be absent, make that explicit in the type and handle it where the meaning of "absent" is known. An internal invariant that must hold can be an assertion that fails loudly, not a silent default.

Dangerous:
```ts
function invoiceTotal(invoice: Invoice): number {
  if (!invoice) return 0;
  return (invoice?.lines ?? []).reduce((s, l) => s + (l?.cents ?? 0), 0);
}
```
```python
def invoice_total(invoice: Invoice) -> int:
    if invoice is None or not isinstance(invoice, Invoice):
        return 0
    return sum(getattr(line, "cents", 0) or 0 for line in (invoice.lines or []))
```

Safe:
```ts
// The handler parses with InvoiceSchema; past that point an Invoice always has lines.
function invoiceTotal(invoice: Invoice): Cents {
  return invoice.lines.reduce((s, l) => s + l.cents, 0);
}
```
```python
def invoice_total(invoice: Invoice) -> Cents:
    return sum(line.cents for line in invoice.lines)
```

**Prove it:** send malformed input to each boundary and assert a 4xx (or a dead-lettered message) with a clear error; confirm no internal function returns a default for it. Remove an internal check and confirm the type checker still proves the value present.
**Size for now:** a schema parse at every external boundary. Internal assertions only for invariants that would corrupt data if broken.

### CRAFT-12 Tests that test behavior at seams

**How it fails:** tests mock the internals of the unit under test (every collaborator, private methods, the ORM) and assert on calls rather than results. They pass while the real system is broken, because the mocks encode the author's assumptions, and they fail on every harmless refactor, so people learn to update tests until they pass. The suite gives confidence that is not backed by behavior.
**Seen in the wild:** No verified incident. Google's Testing on the Toilet episode on mocks explains that mock-heavy tests encode implementation details, break on internal changes, and only prove the code works if the mocks match reality; it recommends real dependencies, hermetic servers or fakes [9].
**Spot it in a plan:** "mock everything", "unit test each function", coverage targets with no mention of behaviors.
**Spot it in code:** `jest.mock` / `vi.mock` / `unittest.mock.patch` on modules owned by the same codebase; `toHaveBeenCalledWith` / `assert_called_with` as the main assertion; tests that mock the database for logic that is mostly queries; tests that need updating when a private function is renamed.
**Build it right:** test through public seams (the HTTP handler, the service's public function, the CLI) with real collaborators where they are fast (a real Postgres in a container, an in-memory fake you own) and fakes only at the edge of the system (third-party APIs, clocks, randomness). Assert on outcomes a user or caller can observe: responses, stored rows, emitted events.

Dangerous:
```ts
vi.mock("../src/repo");
test("cancel", async () => {
  await cancel("a1");
  expect(repo.update).toHaveBeenCalledWith("a1", { status: "cancelled" });
});
```
```python
@patch("app.billing.repo")
def test_cancel(repo):
    cancel("a1")
    repo.update.assert_called_with("a1", status="cancelled")
```

Safe:
```ts
test("a cancelled account is not billed at renewal", async () => {
  const account = await seed.account({ plan: "pro" });
  await api.post(`/accounts/${account.id}/cancel`);
  await runRenewals(clock.at("2026-11-01"));
  expect(await invoices.for(account.id)).toEqual([]);
});
```
```python
def test_cancelled_account_is_not_billed_at_renewal(db, clock):
    account = seed_account(db, plan="pro")
    client.post(f"/accounts/{account.id}/cancel")
    run_renewals(clock.at("2026-11-01"))
    assert invoices_for(db, account.id) == []
```

**Prove it:** break the behavior on purpose (comment out the write, flip a condition) and confirm a test fails; refactor internals without changing behavior and confirm no test fails.
**Size for now:** one behavior test per user-visible rule through the nearest seam, a real database in tests, fakes for third parties. Contract tests against third parties can wait until a provider has actually changed under you.

### CRAFT-13 Named numbers, named timeouts, no sleeping as synchronization

**How it fails:** literals like `30000`, `86400`, `0.85`, `3` appear inline with no name and no unit. Nobody knows whether `5000` is milliseconds or seconds, whether two `30000`s are the same decision, or why it is that value, so they are never tuned together. A `sleep(2)` waits for something else to finish by guessing how long it takes; it is too short under load and wastes time when idle.
**Seen in the wild:** an AWS DynamoDB disruption on a Sunday, September 20, in US-East: metadata requests grew until they approached the storage servers' retrieval time allowance, servers that missed it disqualified themselves and retried, and the retries kept the metadata service overloaded; separately, a console login call had a very long timeout that blocked logins for tens of seconds when it should have failed fast [11].
**Spot it in a plan:** "wait a couple of seconds for it to be ready", "set a long timeout to be safe", thresholds stated without a reason.
**Spot it in code:** detector rules `CRAFT-13.magic-timeout` (a literal of 1000 or more passed to `setTimeout`, `setInterval`, `AbortSignal.timeout`, or a `timeout`-named key or argument) and `CRAFT-13.sleep-wait` (`sleep(`, `time.sleep(`, `asyncio.sleep(`, `new Promise(... setTimeout ...)` outside tests, unless it is a computed backoff). By hand: other unexplained numeric literals in business logic.
**Build it right:** give every decision-carrying number a name with its unit (`SEAT_SYNC_TIMEOUT_MS`, `MAX_RETRIES`) next to a comment saying where the value comes from (an SLA, a provider limit, a measurement). Derive related values from each other (`CLIENT_TIMEOUT_MS < LB_IDLE_TIMEOUT_MS`). Replace sleeps with the event you are waiting for: await the promise, poll a readiness condition with a deadline, subscribe to the event, or use a lock.

Dangerous:
```ts
await svc.start();
await new Promise((r) => setTimeout(r, 2000));
const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
```
```python
svc.start()
time.sleep(2)
resp = client.get(url, timeout_ms=30000)
```

Safe:
```ts
// The provider's p99 is 4 s and our load balancer cuts idle requests at 60 s.
const PROFILE_FETCH_TIMEOUT_MS = 10_000;
await svc.start();
await svc.ready(); // resolves on the health check, rejects after its own deadline
const res = await fetch(url, { signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS) });
```
```python
# The provider's p99 is 4 s and our load balancer cuts idle requests at 60 s.
PROFILE_FETCH_TIMEOUT_MS = 10_000
svc.start()
wait_until(svc.is_ready, deadline_s=READY_DEADLINE_S)
resp = client.get(url, timeout_ms=PROFILE_FETCH_TIMEOUT_MS)
```

**Prove it:** slow the dependency (a proxy that adds latency) and check the timeout fires at the named value and the caller handles it; make startup slower than the old sleep and confirm the code still waits correctly.
**Size for now:** names and reasons for every timeout, retry count and threshold. Making them runtime-configurable can wait until someone needs to change one without a deploy.

### CRAFT-14 Boring dependencies, standard library first

**How it fails:** the change adds a package for something the standard library or an existing dependency already does (padding a string, deep-cloning an object, a date helper next to the one the project already uses). Each new dependency is code you did not review that runs with your permissions, can be unpublished or compromised, needs upgrades, and grows install size and attack surface.
**Seen in the wild:** on 22 March 2016 the author of the npm package `kik` unpublished it and 272 other packages, among them `left-pad`; many thousands of projects that depended on it directly or through packages like `babel` failed to install for about two and a half hours [3].
**Spot it in a plan:** "there's a package for that", "pull in X for this one helper", a framework added for one feature.
**Spot it in code:** new entries in `package.json`, `requirements*.txt`, `pyproject.toml`; small single-purpose packages; a second library for a job the codebase already does (two date libraries, two HTTP clients, two validation libraries).
**Build it right:** check in order: the standard library (`structuredClone`, `String.prototype.padStart`, `Intl`, Python `dataclasses`, `pathlib`, `itertools`), then a dependency already in the lockfile, then a few lines of your own code, and only then a new, widely used, maintained package with a lockfile pin. Record why a new dependency was chosen in the PR.

Dangerous:
```ts
import leftPad from "left-pad";
import cloneDeep from "lodash.clonedeep";
const id = leftPad(String(n), 6, "0");
const copy = cloneDeep(settings);
```
```python
import arrow  # the project already uses datetime + zoneinfo everywhere
due = arrow.utcnow().shift(days=30)
```

Safe:
```ts
const id = String(n).padStart(6, "0");
const copy = structuredClone(settings);
```
```python
from datetime import datetime, timedelta, timezone
due = datetime.now(timezone.utc) + timedelta(days=30)
```

**Prove it:** the dependency diff in the PR is empty, or each new entry has a written reason and a pinned version. Run the project's audit tool (`npm audit`, `pip-audit`) on the lockfile.
**Size for now:** standard library and existing dependencies first, a lockfile always. A dependency review policy with allowlists can wait until there is a team large enough to need it.

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|
| "The catch just logs, so we'll see it" | Nobody reads logs for errors that did not break anything visible; the caller still gets a success. | Rethrow or wrap; log once at the boundary that decides. |
| "It's more flexible this way" | Flexibility nobody uses is code everyone reads and maintains. | Write the direct version; abstract when the second case is real. |
| "I'll leave the old code commented out in case we need it" | Git keeps it. The comment rots and confuses readers about what is live. | Delete it; link the commit in the PR if it matters. |
| "The comments make it easier to follow" | Comments that restate code double the reading and go stale. | Rename and extract until the code reads clearly; comment only the why. |
| "Extra null checks can't hurt" | They turn bugs into silent defaults and hide which values can really be missing. | Parse at the boundary; trust types inside. |
| "Mocking makes the test fast and isolated" | It isolates the test from the behavior it should prove. | Test through the seam with real or fake collaborators you own. |
| "`any` is temporary" | Temporary casts outlive their authors and switch the checker off where it matters. | Write the type or parse into it; if impossible, say why on the line. |
| "Just bump the sleep a bit" | A longer guess is still a guess and slows every run. | Wait on the actual event or condition, with a named deadline. |
| "It's only a small package" | Small packages are exactly the ones nobody audits, and they can disappear. | Use the standard library or a few lines of your own. |
| "I cleaned up the file while I was there" | Unrelated churn hides the real change from review. | Separate commit or PR for cleanup. |
| "Adding a flag is the safest change" | Each flag doubles the states to reason about and is rarely removed. | Look for the restructure that makes the case ordinary; if a flag is needed, set its removal date. |

## Attack recipes

1. Run `scripts/slop-check.sh --diff <base>` on the change. Any finding without a reason on the line or in the PR means the category named by the rule prefix failed.
2. For each `catch`/`except` in the diff, make the guarded call raise (stub, or stop the dependency in a live run). If the request or job reports success, or the only trace is a log line, CRAFT-03 failed.
3. For each fact the change writes, list every module that writes it (`grep -rn` the column, key or constant). More than one writer, or a stored value that can be derived, means CRAFT-01 failed.
4. Try to build each forbidden state: construct the type in a test, and insert the row with raw SQL. If either succeeds, CRAFT-02 failed.
5. Inline every new interface, factory, wrapper and config key in a scratch branch. If the tests pass, the code is shorter, and no caller changed meaning, CRAFT-05 failed.
6. Rename or move a private helper the change added, without changing behavior. If any test fails, CRAFT-12 failed. Then break the behavior on purpose (skip the write); if no test fails, CRAFT-12 failed the other way.
7. Send malformed and missing fields to each new boundary. A 500, a stack trace, or a silent default instead of a clear 4xx means CRAFT-11 failed; an internal `?? default` that fires means the boundary parse is incomplete.
8. Add 5 seconds of latency to the dependency behind each new timeout and each removed or remaining sleep. A hang, an unnamed timeout, or a race when startup is slower than the sleep means CRAFT-13 failed.
9. Read `git diff --stat` and each hunk. A hunk that serves no stated requirement, or a second library for an existing job, means CRAFT-10 or CRAFT-14 failed.
10. Delete every comment the change added and reread. If nothing is lost for a given comment, CRAFT-07 failed for it; if a reader would now ask "why?" about a line that had no comment, CRAFT-07 failed the other way.

## Sources

1. Ding Yuan et al., "Simple Testing Can Prevent Most Critical Failures: An Analysis of Production Failures in Distributed Data-Intensive Systems", OSDI 2014. https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf
2. U.S. Securities and Exchange Commission, "SEC Charges Knight Capital With Violations of Market Access Rule", press release 2013-222. https://www.sec.gov/newsroom/press-releases/2013-222
3. npm, Inc., "kik, left-pad, and npm", npm blog, March 2016. https://blog.npmjs.org/post/141577284765/kik-left-pad-and-npm
4. Alexis King, "Parse, don't validate", 2019. https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/
5. Martin Fowler, "Yagni". https://martinfowler.com/bliki/Yagni.html
6. Martin Fowler, "Ubiquitous Language". https://martinfowler.com/bliki/UbiquitousLanguage.html
7. Google Engineering Practices, "Small CLs". https://google.github.io/eng-practices/review/developer/small-cls.html
8. Google Engineering Practices, "What to look for in a code review". https://google.github.io/eng-practices/review/reviewer/looking-for.html
9. Google Testing Blog, "Testing on the Toilet: Don't Overuse Mocks", May 2013. https://testing.googleblog.com/2013/05/testing-on-toilet-dont-overuse-mocks.html
10. Wikipedia, "Mars Climate Orbiter" (summarizing the Mishap Investigation Board Phase I report, 10 November 1999). https://en.wikipedia.org/wiki/Mars_Climate_Orbiter
11. Amazon Web Services, "Summary of the Amazon DynamoDB Service Disruption and Related Impacts in the US-East Region". https://aws.amazon.com/message/5467D2/
