// Fault plan shared by every stand-in. A rule targets a method name (or '*'),
// optionally only calls matching `where(call)`, and fires on the nth matching
// call for `times` calls (Infinity for always).
//
// Kinds applied to inbound API calls (see http.mjs applyFault):
//   status               respond with { status, retryAfter?, headers?, body? }, no side effect
//   delay                wait delayMs, then behave normally
//   slowResponse         behave normally now, deliver the response delayMs later (stale snapshot)
//   hang                 hold the socket open, no side effect (until client gives up or hangMs)
//   reset                close the socket immediately, no side effect
//   timeoutAfterSuccess  perform the side effect, then close the socket without responding
//   truncate             perform the side effect, send the status and half the body, then close
// Kinds applied to outbound deliveries from a platform to the app (see Delivery):
//   duplicate            deliver { copies } times; `concurrent: true` fires them together
//   reorder              hold this delivery and release it right after the next one
export class Faults {
  #rules = [];

  inject(method, spec) {
    if (!spec?.kind) throw new Error('fault spec needs a kind');
    const rule = { method, nth: 1, times: 1, ...spec, seen: 0, fired: 0 };
    this.#rules.push(rule);
    return rule;
  }

  take(method, call = {}) {
    for (const rule of this.#rules) {
      if (rule.method !== method && rule.method !== '*') continue;
      if (rule.where && !rule.where(call)) continue;
      rule.seen += 1;
      if (rule.seen >= rule.nth && rule.fired < rule.times) {
        rule.fired += 1;
        return rule;
      }
    }
    return null;
  }

  // Rules that never fired: a scenario asserting on a fault it never triggered proves nothing.
  unfired() {
    return this.#rules.filter((r) => r.fired === 0).map((r) => ({ method: r.method, kind: r.kind }));
  }

  reset() { this.#rules = []; }
}

// Delivery from a stand-in platform (Slack, Pub/Sub) to the app, with
// duplicate and reorder faults. send() performs one HTTP delivery.
export class Delivery {
  #held = [];
  constructor(faults) { this.faults = faults; }

  async deliver(method, call, send) {
    const fault = this.faults.take(method, call);
    if (fault?.kind === 'reorder') {
      this.#held.push(send);
      return { held: true };
    }
    const copies = fault?.kind === 'duplicate' ? (fault.copies ?? 2) : 1;
    let results;
    if (fault?.concurrent) {
      results = await Promise.all(Array.from({ length: copies }, (_, i) => send(i)));
    } else {
      results = [];
      for (let i = 0; i < copies; i++) results.push(await send(i));
    }
    const held = this.#held.splice(0);
    for (const h of held) results.push(await h(0));
    return results.length === 1 ? results[0] : { results };
  }

  reset() { this.#held = []; }
}
