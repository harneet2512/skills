// A stand-in for the Codex CLI, used only by the node tests. Behaviour comes from $MOCK_CODEX_MODE; every call is
// appended as one JSON line to $MOCK_CODEX_LOG (argv, cwd, the files visible in cwd, what arrived on stdin).
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const mode = process.env.MOCK_CODEX_MODE ?? 'valid';
const log = (entry) => { if (process.env.MOCK_CODEX_LOG) appendFileSync(process.env.MOCK_CODEX_LOG, `${JSON.stringify(entry)}\n`); };

function tree(dir, prefix = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...tree(join(dir, e.name), p)); else out.push(p);
  }
  return out;
}

if (argv[0] === '--version') {
  log({ version: true });
  console.log('codex-cli 0.162.1');
  process.exit(0);
}

let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { /* closed or ignored stdin */ }
log({ argv, cwd: process.cwd(), files: tree(process.cwd()), stdin, mode });

const outFile = argv[argv.indexOf('-o') + 1];
const result = (findings, verdict) => writeFileSync(outFile, JSON.stringify({ verdict, summary: 'mock review', findings }));
const blocking = { severity: 'blocking', title: 'Retry loop never ends', location: 'src/a.js:3', failure_scenario: 'When the upstream returns 500 forever the worker retries without a cap and the queue never drains.', recommendation: 'Cap retries.' };

switch (mode) {
  case 'valid': result([{ severity: 'advisory', title: 'Naming', location: '', failure_scenario: '', recommendation: 'Rename.' }], 'pass'); break;
  case 'blocking': result([blocking], 'fail'); break;
  case 'vague-blocking': result([{ ...blocking, failure_scenario: '  ' }], 'fail'); break;
  case 'model-says-fail': result([], 'fail'); break;
  case 'stdout-noise': console.log('Quota exceeded and You’ve hit your usage limit (this is review text)'); result([], 'pass'); break;
  case 'usage': console.error('ERROR: You’ve hit your usage limit. Upgrade to Pro, or try again at 3:14 PM.'); process.exit(1); break;
  case 'quota': console.error('ERROR: Quota exceeded. Check your plan and billing details.'); process.exit(1); break;
  case 'retry429': console.error('ERROR: exceeded retry limit, last status: 429 Too Many Requests'); process.exit(1); break;
  case 'token': console.error('ERROR: Your access token could not be refreshed because your refresh token was already used.'); process.exit(1); break;
  case 'status401': console.error('ERROR: unexpected status 401 Unauthorized: Missing bearer'); process.exit(1); break;
  case 'malformed': writeFileSync(outFile, '{"verdict": "pass", "summ'); break;
  case 'wrong-shape': writeFileSync(outFile, JSON.stringify({ verdict: 'pass', summary: 'x', findings: [{ severity: 'blocking', title: 5 }] })); break;
  case 'no-file': break;
  case 'crash': console.error('thread panicked at boom'); process.exit(1); break;
  case 'sleep': {
    // A grandchild too, so the test can prove the whole tree was killed.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
    if (process.env.MOCK_CODEX_PIDFILE) writeFileSync(process.env.MOCK_CODEX_PIDFILE, String(child.pid));
    setTimeout(() => {}, 120000);
    break;
  }
  default: console.error(`mock: unknown mode ${mode}`); process.exit(9);
}
