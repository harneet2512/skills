// Every stand-in records each inbound call and each outbound delivery here.
// Calls carry a global sequence number so a scenario can slice "calls since I started".
let globalSeq = 0;

export class Recorder {
  constructor(service) {
    this.service = service;
    this.calls = [];
  }

  record(call) {
    const entry = { seq: ++globalSeq, service: this.service, at: Date.now(), ...call };
    this.calls.push(entry);
    return entry;
  }

  // filter: { method, team, mailbox, since, outcome } or a predicate.
  find(filter = {}) {
    if (typeof filter === 'function') return this.calls.filter(filter);
    return this.calls.filter((c) =>
      (filter.method == null || c.method === filter.method) &&
      (filter.team == null || c.team === filter.team) &&
      (filter.mailbox == null || c.mailbox === filter.mailbox) &&
      (filter.since == null || c.seq > filter.since) &&
      (filter.outcome == null || c.outcome === filter.outcome));
  }
}

export const currentSeq = () => globalSeq;
