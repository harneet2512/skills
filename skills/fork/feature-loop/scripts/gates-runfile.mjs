// The optional fields of .scratch/gates.json (gates.md, "The run file"). Each is checked strictly, and so are the names:
// a misspelt field ("demoBy", "Live") would otherwise turn its rule off without a word. Throws an Error whose message is
// the complete line to print. Returns the live waiver's reason, '' when there is none.
import { parseDemoBy, parseStarted } from './timebox.mjs';

export const KNOWN = ['slug', 'size', 'base', 'status', 'merge_check', 'started', 'demo_by', 'evals', 'max_builders', 'live', 'plan_sha'];
const PREFIX = 'gates: .scratch/gates.json:';
const fail = (msg) => { throw new Error(`${PREFIX} ${msg}`); };

export function validateRunFields(run, size) {
  const unknown = Object.keys(run).filter((k) => !KNOWN.includes(k));
  if (unknown.length) fail(`unknown field${unknown.length > 1 ? 's' : ''} ${unknown.map((k) => JSON.stringify(k)).join(', ')} (known: ${KNOWN.join(', ')})`);
  try { parseDemoBy(run); parseStarted(run); } catch (e) { fail(e.message); }
  if (run.plan_sha !== undefined && !(typeof run.plan_sha === 'string' && /^[0-9a-f]{64}$/i.test(run.plan_sha))) {
    fail('"plan_sha" must be the sha256 (64 hex digits) of the approved plan');
  }
  if (run.evals !== undefined && !['smoke', 'full'].includes(run.evals)) fail('"evals" must be smoke or full');
  if (run.max_builders !== undefined && !(Number.isInteger(run.max_builders) && run.max_builders >= 1 && run.max_builders <= 8)) {
    fail('"max_builders" must be a whole number from 1 to 8');
  }
  // A live waiver is "none: <reason>", and only small work may waive the live run.
  if (run.live === undefined) return '';
  const m = typeof run.live === 'string' ? /^none:\s*(\S.*)$/.exec(run.live) : null;
  if (!m) fail('"live" must be "none: <reason>" (leave it out to run live-verify)');
  if (size !== 'small') fail('"live": "none: ..." is only allowed on small work; normal and large always run live-verify');
  return m[1].trim();
}
