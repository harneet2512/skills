// Checks an approved plan file (see ../plan-template.md) for the sections the loop reads from it, and for the
// `Changed: X because Y` deviation lines. Used by check-gates.mjs (--plan-check) and by its G8 ledger rule
// ("done, from approved plan"). Node 22, no dependencies.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { section, norm } from './md-table.mjs';

// The sections the loop reads, as the heading text normalized (lower case, words only), with the name shown to people.
export const PLAN_SECTIONS = [
  ['decisions', 'Decisions'],
  ['size and why', 'Size and why'],
  ['external dependencies', 'External dependencies'],
  ['files to create or change', 'Files to create or change'],
  ['skeleton ticket', 'Skeleton ticket'],
  ['tickets and seams', 'Tickets and seams'],
  ['skill per stage', 'Skill per stage'],
  ['verification', 'Verification'],
  ['failure modes', 'Failure modes'],
  ['time box', 'Time box'],
  ['concerns', 'Concerns'],
  ['design challenge', 'Design challenge'],
];
const PLACEHOLDER = /^(tbd|todo|\?|<[^>]*>)$/i;
const CHANGED_RE = /^\s*(?:[-*]\s*)?Changed:\s*(.*)$/i;

// Does the section have a line that is not blank, an HTML comment or a placeholder (see PLACEHOLDER)?
function bodyHasContent(lines) {
  if (!lines) return false;
  const text = lines.join('\n').replace(/<!--[\s\S]*?-->/g, '');
  return text.split('\n').some((l) => {
    const s = l.trim().replace(/^[-*]\s+/, '').trim();
    return s !== '' && !PLACEHOLDER.test(s) && !/^[-|:\s]+$/.test(s);
  });
}

export function planSectionHasBody(md, name) {
  return bodyHasContent(section(md, norm(name)));
}

// The newest .scratch/plan/*.md under root, or null.
function newestPlan(root) {
  const dir = join(root, '.scratch', 'plan');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ f: join(dir, f), t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? files[0].f : null;
}

// -> { code, lines }. code 0 complete, 1 sections missing or deviation lines malformed, 2 no plan file.
export function checkPlan(root, file) {
  const path = file || newestPlan(root);
  if (!path || !existsSync(path)) {
    return { code: 2, lines: [`plan: no plan file (${file || '.scratch/plan/*.md'}); plan mode writes it there when plansDirectory is ".scratch/plan"`] };
  }
  const md = readFileSync(path, 'utf8');
  const lines = [];
  const missing = [];
  for (const [key, label] of PLAN_SECTIONS) {
    const sec = section(md, key);
    if (!sec) { missing.push(label); lines.push(`plan red: missing section "${label}" (${path})`); }
    else if (!bodyHasContent(sec)) { missing.push(label); lines.push(`plan red: empty section "${label}" (${path})`); }
  }
  // Deviation lines live in "## Changes": `Changed: <what> because <why>`.
  const changes = (section(md, 'changes') ?? []).join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
  const changed = changes.map((l) => CHANGED_RE.exec(l)).filter(Boolean).map((m) => m[1].trim());
  const noReason = changed.filter((c) => !/\sbecause\s+\S/i.test(c) || /^because\b/i.test(c));
  for (const c of noReason) lines.push(`plan red: Changed line without "because <reason>": ${JSON.stringify(c)} (${path})`);
  const bad = missing.length + noReason.length;
  lines.push(bad
    ? `plan: red, ${missing.length} section${missing.length === 1 ? '' : 's'} missing or empty${missing.length ? ` (${missing.join(', ')})` : ''}${noReason.length ? `, ${noReason.length} Changed line${noReason.length === 1 ? '' : 's'} without a reason` : ''}`
    : `plan: complete (${PLAN_SECTIONS.length} sections, ${changed.length} deviation line${changed.length === 1 ? '' : 's'}) (${path})`);
  return { code: bad ? 1 : 0, lines };
}
