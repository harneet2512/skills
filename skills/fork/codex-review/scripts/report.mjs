#!/usr/bin/env node
// Validate codex's output against the findings schema, then stamp it and render it. No dependencies.
//
//   report.mjs validate <schema.json> <raw.json>
//       exit 0 when valid; exit 1 and one problem per line on stderr otherwise.
//   report.mjs build <schema.json> <raw.json> <meta.json> <out.json> <out.md>
//       validate, merge the meta (kind, model, ...) with the findings, write out.json and out.md, and print the
//       one-line summary. Exit 1 when invalid. Never writes a resolution.
import { readFileSync, writeFileSync } from 'node:fs';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (t, v) => t === typeOf(v) || (t === 'number' && typeof v === 'number');

// Validates the subset of JSON Schema the findings schema uses: type, enum, required, properties,
// additionalProperties:false, items.
export function validateAgainst(schema, value, path = '$') {
  const errs = [];
  const types = [].concat(schema.type ?? []);
  if (types.length && !types.some((t) => typeMatches(t, value))) {
    return [`${path}: expected ${types.join('|')}, got ${typeOf(value)}`];
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  }
  if (typeOf(value) === 'object' && schema.properties) {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}.${k}: missing`);
    for (const k of Object.keys(value)) {
      if (!(k in schema.properties)) {
        if (schema.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
        continue;
      }
      errs.push(...validateAgainst(schema.properties[k], value[k], `${path}.${k}`));
    }
  }
  if (typeOf(value) === 'array' && schema.items) {
    value.forEach((item, i) => errs.push(...validateAgainst(schema.items, item, `${path}[${i}]`)));
  }
  return errs;
}

// Rules the schema cannot express.
export function validateSemantics(report, kind) {
  const errs = [];
  const seen = new Set();
  for (const [i, f] of (report.findings ?? []).entries()) {
    if (seen.has(f.id)) errs.push(`$.findings[${i}].id: duplicate id ${f.id}`);
    seen.add(f.id);
    if (!/^[A-Za-z0-9_-]+$/.test(f.id)) errs.push(`$.findings[${i}].id: ${JSON.stringify(f.id)} must be letters, digits, _ or -`);
    if (f.status === 'CONFIRMED' && !f.evidence.trim()) errs.push(`$.findings[${i}]: CONFIRMED needs evidence`);
    if (kind === 'code' && f.status === 'CONFIRMED' && !(f.repro ?? '').trim()) {
      errs.push(`$.findings[${i}]: a CONFIRMED code finding needs a repro`);
    }
  }
  return errs;
}

export function summaryLine(meta, findings) {
  const confirmed = findings.filter((f) => f.status === 'CONFIRMED');
  const plausible = findings.length - confirmed.length;
  const hot = ['CRITICAL', 'HIGH']
    .map((s) => [s, confirmed.filter((f) => f.severity === s).length])
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  const counts = `${confirmed.length} CONFIRMED${hot.length ? ` (${hot.join(', ')})` : ''}, ${plausible} PLAUSIBLE`;
  const subject = meta.kind === 'plan' ? `${meta.slug} (${meta.subject_sha.slice(0, 7)})` : meta.subject_sha.slice(0, 7);
  const what = meta.kind === 'plan' ? 'plan review of' : 'code attack on';
  return `codex ${what} ${subject} by ${meta.model}: ${counts}`;
}

const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

export function renderMarkdown(report) {
  const head = [
    `# codex ${report.kind} review: ${report.slug}`,
    '',
    `Model ${report.model} (${report.codex_version}), subject ${report.subject_sha}${report.base ? `, base ${report.base}` : ''}.`,
    `Started ${report.started}, finished ${report.finished}.`,
    '',
    report.summary,
    '',
    '| id | severity | status | title | where |',
    '| --- | --- | --- | --- | --- |',
    ...report.findings.map((f) => `| ${cell(f.id)} | ${f.severity} | ${f.status} | ${cell(f.title)} | ${cell(f.where)} |`),
    '',
  ];
  const detail = report.findings.flatMap((f) => [
    `## ${f.id} (${f.severity}, ${f.status}): ${f.title}`,
    '',
    `Where: ${f.where}`,
    '',
    'Evidence:',
    '',
    '```',
    f.evidence,
    '```',
    '',
    ...(f.repro ? [`Repro: ${f.repro}`, ''] : []),
  ]);
  return [...head, ...detail].join('\n');
}

function check(schemaPath, rawPath, kind) {
  let raw;
  try {
    raw = readJson(rawPath);
  } catch (e) {
    return { errs: [`output is not valid JSON: ${e.message}`] };
  }
  const errs = validateAgainst(readJson(schemaPath), raw);
  return { raw, errs: errs.length ? errs : validateSemantics(raw, kind) };
}

function main(argv) {
  const [cmd, schemaPath, rawPath, metaPath, outJson, outMd] = argv;
  const meta = cmd === 'build' ? readJson(metaPath) : {};
  const { raw, errs } = check(schemaPath, rawPath, meta.kind);
  if (errs.length) {
    console.error(errs.join('\n'));
    return 1;
  }
  if (cmd !== 'build') return 0;
  const { slug, ...stamp } = meta;
  const report = { ...stamp, summary: raw.summary, findings: raw.findings };
  writeFileSync(outJson, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(outMd, renderMarkdown({ ...report, slug }));
  console.log(summaryLine(meta, raw.findings));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('report.mjs')) {
  if (!['validate', 'build'].includes(process.argv[2])) {
    console.error('usage: report.mjs validate <schema> <raw> | build <schema> <raw> <meta> <out.json> <out.md>');
    process.exit(2);
  }
  process.exit(main(process.argv.slice(2)));
}
