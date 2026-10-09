// Writes the run evidence: report.json (everything) and report.md (summary).
// The console never sees message bodies: only scenario names, results and counts.
import fs from 'node:fs';
import path from 'node:path';

export function writeReport(outDir, run) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(run, null, 2));
  const rows = run.scenarios.map((s) =>
    `| ${s.name} | ${s.journey ?? ''} | ${(s.concerns ?? []).join(', ')} | ${s.result.toUpperCase()} | ${s.durationMs} ms |`);
  const failures = run.scenarios.filter((s) => s.result !== 'pass').map((s) => {
    const failed = s.assertions.filter((a) => !a.pass).map((a) => `  - assertion failed: ${a.name}`);
    return [`- **${s.name}**: ${s.error ?? 'assertion failed'}`, ...failed].join('\n');
  });
  const md = [
    `# Live verification run ${run.runId}`,
    '',
    `App: \`${run.app}\`, instances: ${run.instances}, LLM: ${run.llm}, started ${run.startedAt}, ${run.durationMs} ms.`,
    '',
    `Result: **${run.totals.failed === 0 ? 'PASS' : 'FAIL'}** (${run.totals.passed} passed, ${run.totals.failed} failed, ${run.totals.assertions} assertions).`,
    '',
    '| Scenario | Journey step | Concerns | Result | Time |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    ...(failures.length ? ['## Failures', '', ...failures, ''] : []),
    '## Evidence in this folder',
    '',
    '- `report.json`: every scenario with steps, assertions (pass/fail with evidence) and ack timings.',
    '- `calls.json`: every call recorded by the stand-ins (Slack, Gmail, LLM) and every delivery to the app.',
    '- `app-<n>.log`: structured logs of each app instance.',
    '- `db.sqlite`: the shared database as it was at teardown.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
}
