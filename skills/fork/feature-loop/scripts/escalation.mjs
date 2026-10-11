// Command- and path-based escalations (fork.9, gates.md "Visibility"): things the owner is told about at once, never
// silently. Pure: no file or state access except one git call for `reset --hard`. The state-based ones (the plan's
// `## Changes`, the envelope's Packs line after a red G4) are in visibility.mjs.
import { gitOut } from './vis-root.mjs';
import { segments } from './shell-lex.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
// .scratch/live/, .scratch/evals/ and .scratch/review/codex-*.json: evidence the agent must never make by hand.
const EVIDENCE = String.raw`\.scratch/(?:live/|evals/|review/codex-[^\s'"/]*\.json)`;
const EVIDENCE_PATH = new RegExp(EVIDENCE);
const EVIDENCE_WRITE = new RegExp(String.raw`(?:\b(?:touch|tee|cp|mv|rm|truncate|install)\b[^;&|\n]*${EVIDENCE}|\bsed\s+-[a-zA-Z]*i[^;&|\n]*${EVIDENCE}|>>?\s*['"]?\S*${EVIDENCE})`);
const norm = (p) => String(p ?? '').replaceAll('\\', '/');

// Does the command set FEATURE_LOOP_GATES to off? Read on the lexed tokens, so quotes and escapes (of''f, "o"ff, o\ff,
// FEATURE_LOOP_GATES="off") do not hide it, and into the strings handed to bash -c, eval and the like. A value that is
// not known until run time ($X) counts as off: the owner is told and can look.
const GATES_ASSIGN = /^FEATURE_LOOP_GATES=(.*)$/s;
function setsGatesOff(cmd, depth = 0) {
  for (const seg of segments(cmd)) {
    for (const tok of seg) {
      const m = GATES_ASSIGN.exec(tok);
      if (m && (/^off$/i.test(m[1].trim()) || m[1].startsWith('$'))) return true;
      if (depth < 3 && /\s/.test(tok) && setsGatesOff(tok, depth + 1)) return true;
    }
  }
  return false;
}

// Drop quoted strings so `git commit -m "git push --force"` is not a push.
const unquoted = (cmd) => cmd.replace(/'[^']*'|"[^"]*"/g, ' ');

function gitEscalations(cmd, cwd) {
  const out = [];
  const c = unquoted(cmd);
  if (/\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:\s--force\b|\s--force-with-lease\b|\s-f\b|\s\+[^\s]+)/.test(c)) out.push('git push --force');
  if (/\bgit\b[^;&|\n]*\bpush\b[^;&|\n]*(?:\s--delete\b|\s-d\b|\s:[^\s:]+)/.test(c)) out.push('remote branch delete');
  if (/\bgit\s+branch\s+(?:[^;&|\n]*\s)?(?:-d|-D|--delete)\b/.test(c)) out.push('git branch delete');
  if (/\bgit\b[^;&|\n]*\breset\b[^;&|\n]*--hard\b/.test(c)) {
    const branch = gitOut(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    if (branch && gitOut(cwd, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`])) out.push(`git reset --hard on pushed branch ${branch}`);
  }
  return out;
}

// [{ detail }] for one tool call (a PostToolUse or PostToolUseFailure payload).
export function commandEscalations(input) {
  const ti = input.tool_input ?? {};
  const found = [];
  if (WRITE_TOOLS.has(input.tool_name)) {
    const p = norm(ti.file_path ?? ti.notebook_path ?? ti.path);
    if (EVIDENCE_PATH.test(p)) found.push(`hand edit of ${p.slice(p.indexOf('.scratch/'))}`);
  } else if (input.tool_name === 'Bash' && typeof ti.command === 'string') {
    const cmd = ti.command;
    if (setsGatesOff(cmd)) found.push('FEATURE_LOOP_GATES=off');
    if (EVIDENCE_WRITE.test(norm(cmd))) found.push(`touch or hand edit of ${(norm(cmd).match(EVIDENCE_PATH) ?? ['.scratch evidence'])[0]}`);
    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
    found.push(...gitEscalations(cmd, cwd));
  }
  return found;
}

// A codex run's own result: CONFIRMED CRITICAL or HIGH findings, from its summary text or its output json.
export function codexSevere(text, report) {
  if (report && Array.isArray(report.findings)) {
    const hot = report.findings.filter((f) => f.status === 'CONFIRMED' && /^(CRITICAL|HIGH)$/.test(f.severity));
    return hot.length ? `codex CONFIRMED ${[...new Set(hot.map((f) => f.severity))].join('/')}: ${hot.length} finding(s)` : '';
  }
  const m = /(\d+)\s+CONFIRMED\b[^\n]*?\b(CRITICAL|HIGH)\b/i.exec(text);
  return m && Number(m[1]) > 0 ? `codex CONFIRMED ${m[2].toUpperCase()} (${text.split(/\r?\n/).find((l) => /CONFIRMED/.test(l))?.trim().slice(0, 160)})` : '';
}
