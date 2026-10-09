// Markdown helpers shared by check-gates.mjs and loop-hooks.mjs: tables and sections, tolerant of leading and
// trailing pipes, padding, backticks and bold in cells. Node 22, no dependencies.
const PLACEHOLDER = /^(tbd|todo|\?|<[^>]*>)$/i;

// Split one table row into cells. Pipes inside backtick spans or escaped as \| do not split.
export function splitRow(line) {
  let s = line.trim();
  if (!s.includes('|')) return null;
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      if (tick === 0) tick = n; else if (tick === n) tick = 0;
      cur += '`'.repeat(n); i += n - 1; continue;
    }
    if (c === '|' && tick === 0) { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  return cells;
}
export const isSeparator = (line) => {
  const cells = splitRow(line);
  return !!cells && cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
};
// Cell text without markup: surrounding backticks, bold or italic markers, padding.
export function clean(cell) {
  let s = (cell ?? '').trim();
  for (let k = 0; k < 3; k++) {
    s = s.replace(/^(\*\*|__|\*|_)(.*)\1$/s, '$2').trim();
    s = s.replace(/^(`+)(.*)\1$/s, '$2').trim();
  }
  return s;
}
export const norm = (h) => clean(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export const blank = (cell) => { const s = clean(cell); return s === '' || PLACEHOLDER.test(s); };

// Lines of a section whose heading text is `title` (any level), up to the next heading of the same or higher level.
// Fenced code blocks are skipped so an example inside ``` does not count.
export function section(md, title) {
  const lines = md.split(/\r?\n/);
  let level = 0, out = null, fence = false;
  for (const line of lines) {
    if (/^\s{0,3}(```|~~~)/.test(line)) { fence = !fence; if (out) out.push(''); continue; }
    if (fence) { if (out) out.push(''); continue; }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      if (out) { if (h[1].length <= level) break; out.push(line); continue; }
      if (norm(h[2]) === title) { level = h[1].length; out = []; }
      continue;
    }
    if (out) out.push(line);
  }
  return out;
}
// Every table in some lines: [{ header: [normalized names], rows: [[cells]] }].
export function tables(lines) {
  const found = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const head = splitRow(lines[i]);
    if (!head || !isSeparator(lines[i + 1])) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length; j++) {
      if (!lines[j].trim() || !lines[j].includes('|')) break;
      const r = splitRow(lines[j]);
      if (r) rows.push(r);
    }
    found.push({ header: head.map(norm), rows });
    i = j;
  }
  return found;
}
// The first table in some lines, or null.
export const firstTable = (lines) => tables(lines)[0] ?? null;
