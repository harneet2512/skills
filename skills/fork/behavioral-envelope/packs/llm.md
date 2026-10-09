# LLM

Model calls, prompts, agents, tool use, generated text that reaches a person or triggers an action.

### LLM-01 Graded on a task set, not one run
- **Ask:** How is "it works" measured when output differs every run?
- **Right way:** A fixed set of representative inputs with a rubric; several runs each; score quality and consistency.
- **Proof:** Eval results before and after the change.

### LLM-02 Made-up facts
- **Ask:** Can the output claim a feature, price, name or commitment that is not true?
- **Right way:** Ground answers in retrieved, current facts; check claims against the source; refuse or hand off when unsupported (S8).
- **Proof:** Eval items that tempt a false claim, scored.

### LLM-03 Prompt injection
- **Ask:** Can text the model reads (emails, web pages, documents, CRM notes, tool output) instruct it to do something else?
- **Right way:** Treat all retrieved text as data; separate it from instructions; limit what tools can do regardless of what the model says (S8).
- **Proof:** Eval items with injected instructions in inputs; the action does not happen.

### LLM-04 Tool permissions
- **Ask:** What is the worst action a tool call can take, and who approves it?
- **Right way:** Least privilege per tool; human approval or hard limits for irreversible actions such as sends, refunds and deletes (S8).
- **Proof:** Test that a disallowed tool call is blocked.

### LLM-05 Tool retries
- **Ask:** If a tool call times out and the agent retries, does the effect happen twice?
- **Right way:** Idempotency keys on side-effecting tools (S4); see `outbound` OUT-01.
- **Proof:** Test with a tool timeout after success.

### LLM-06 Leaking data
- **Ask:** Can one customer's data appear in another's output, or secrets appear in a response?
- **Right way:** Scope retrieval and memory per tenant; keep secrets out of prompts (S8).
- **Proof:** Cross-tenant eval case.

### LLM-07 Cost and size limits
- **Ask:** What happens with a huge input, a long conversation, or a loop of calls?
- **Right way:** Cap input size, conversation length and calls per task; budget per tenant; alert on spend spikes (S8).
- **Proof:** Test with an oversized input and a capped loop.

### LLM-08 Model or provider failure
- **Ask:** What happens on timeout, rate limit, refusal or malformed output?
- **Right way:** Timeouts, retries with backoff, validated structured output, a fallback model or a visible failure.
- **Proof:** Tests with each failure injected.

### LLM-09 Model updates
- **Ask:** Will a new model version change behavior without anyone noticing?
- **Right way:** Pin model versions; re-run the eval set before switching.
- **Proof:** Pinned model id and the eval run that approved it.

### LLM-10 Handing off to a human
- **Ask:** When should the system stop and pass to a person, and does that actually happen?
- **Right way:** Explicit hand-off rules (low confidence, sensitive topic, repeated failure, user asks); stop acting after hand-off.
- **Proof:** Eval cases that must hand off.

### LLM-11 Traceable
- **Ask:** Can you see, for any output, the input, retrieved context, model, prompt version and tool calls?
- **Right way:** Log each run with its versions and cost, without storing secrets.
- **Proof:** One run inspected end to end from the log.
