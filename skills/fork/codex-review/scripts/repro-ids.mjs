#!/usr/bin/env node
// repro-ids.mjs <report.json> <file>: print the id of every CONFIRMED finding whose repro names <file>, one per line.
import { readFileSync } from 'node:fs';

const [reportPath, file] = process.argv.slice(2);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
for (const f of report.findings) {
  if (f.status === 'CONFIRMED' && f.repro && f.repro.includes(file)) console.log(f.id);
}
