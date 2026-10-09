# Topic file template

Every file in `topics/` has this shape, in this order. A topic is a **fixed area with breadth (the categories) and depth (how each one fails, how to spot it, how to build it right, how to prove it)**. It is read just in time: when a design decision or a piece of code touches the topic, the agent reads the categories that apply, not the whole file.

```markdown
# <Topic>

**Protects:** <the property this topic keeps true, in one or two sentences>
**Read when:** <plain-language plan signals and code signals that mean this topic applies>
**Prefix:** <ID prefix, e.g. CONC>

## Design questions

<5 to 12 questions to answer per journey step at design time. Each one is answered with a mechanism, not "be careful". Phrase them so a wrong answer is visible.>

## Categories

### <PREFIX>-01 <short name>

**How it fails:** <the mechanism of failure, concretely: which actors, which state, which interleaving or input, what the user sees>
**Seen in the wild:** <one real incident or well-documented failure, with a link to a primary or reputable source you opened. If you could not verify one, write "No verified incident; failure follows from <documented semantics>, see <source>">
**Spot it in a plan:** <phrases or design shapes that mean this category is in play>
**Spot it in code:** <grep-able patterns, per stack where they differ>
**Build it right:** <the mechanism, and where to enforce it: type, DB constraint, single owning module, middleware, test, convention (strongest first)>

Dangerous:
```<lang>
<short realistic snippet>
```

Safe:
```<lang>
<the same thing done right>
```

**Prove it:** <the test or live scenario that injects this failure and shows the mechanism holds>
**Size for now:** <what an enterprise v1 needs, and what can wait until there is evidence of need. Never design for a scale nobody has.>

(8 to 14 categories per topic. Mix stacks across categories: TypeScript/Node, Python, SQL (Postgres), Go where it matters.)

## Rationalizations to reject

| Rationalization | Why it is wrong | Do instead |
|---|---|---|

## Attack recipes

<For the adversarial pass: 5 to 10 concrete, runnable recipes. Each says what to do to the running system or the code, and what observation means the defense failed. Example: "Deliver the same webhook twice within 50 ms; more than one row in outbound_sends means CONC-03 failed.">

## Sources

<Numbered list. Only sources you actually opened. Official docs, engineering blogs, postmortems, standards.>
```

## Rules for authors

- Own words. Structure ideas from Trail of Bits `sharp-edges` (CC BY-SA 4.0) are fine to follow; do not copy its text.
- No em-dashes anywhere. Rewrite the sentence with a comma, colon, period or parentheses instead.
- No claims you did not check. A version-specific behavior names the version.
- Snippets are short, realistic and correct. The safe version must actually be safe.
- Size for an enterprise product with real customers today, not for billions of users.
