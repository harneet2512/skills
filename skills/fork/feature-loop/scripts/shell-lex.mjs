// Shell-ish lexer shared by hook-command.mjs (what a command does) and escalation.mjs (what the owner is told). Node 22, no
// dependencies.
//
// Segments split on unquoted ; & | newline ( ) ` and $( ; tokens split on unquoted whitespace. A heredoc (<<, <<-, with a
// bare, quoted or backslashed delimiter) is not code: its body, from the line after the command up to the delimiter line,
// is skipped, and the commands that follow it are lexed as usual. It does not expand variables or globs. Unterminated
// quotes and heredocs run to the end, as the shell reads them.

const WORD_END = /[\s;&|()<>`]/;

// The heredoc operator at cmd[i] ("<<", "<<-", not "<<<"): { delim, dash, next } (next = index after the delimiter word), or null.
function heredocAt(cmd, i) {
  if (cmd[i] !== '<' || cmd[i + 1] !== '<' || cmd[i + 2] === '<') return null;
  let j = i + 2;
  const dash = cmd[j] === '-';
  if (dash) j++;
  while (cmd[j] === ' ' || cmd[j] === '\t') j++;
  let delim = '';
  while (j < cmd.length && !WORD_END.test(cmd[j])) {
    const c = cmd[j];
    if (c === "'" || c === '"') {
      const end = cmd.indexOf(c, j + 1);
      const stop = end < 0 ? cmd.length : end;
      delim += cmd.slice(j + 1, stop);
      j = stop + 1;
    } else if (c === '\\' && j + 1 < cmd.length) { delim += cmd[j + 1]; j += 2; }
    else { delim += c; j++; }
  }
  return delim ? { delim, dash, next: j } : null;
}

// The index just after the delimiter line that ends a heredoc whose body starts at `from`, or cmd.length.
function bodyEnd(cmd, from, { delim, dash }) {
  let pos = from;
  while (pos < cmd.length) {
    let eol = cmd.indexOf('\n', pos);
    if (eol < 0) eol = cmd.length;
    let line = cmd.slice(pos, eol).replace(/\r$/, '');
    if (dash) line = line.replace(/^\t+/, '');
    if (line === delim) return Math.min(eol + 1, cmd.length);
    pos = eol + 1;
  }
  return cmd.length;
}

// { segments: string[][], text } where text is the command with the heredoc bodies cut out.
export function lex(cmd) {
  const out = [];
  let toks = [], cur = '', has = false, q = '';
  const pending = []; // heredocs whose body starts after the current line
  const cuts = [];
  const endTok = () => { if (has) toks.push(cur); cur = ''; has = false; };
  const endSeg = () => { endTok(); if (toks.length) out.push(toks); toks = []; };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = ''; else cur += c; continue; }
    if (q === '"') {
      if (c === '\\' && i + 1 < cmd.length && '"\\$`'.includes(cmd[i + 1])) { cur += cmd[++i]; continue; }
      if (c === '"') q = ''; else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === '\\' && i + 1 < cmd.length) { if (cmd[i + 1] !== '\n') { cur += cmd[i + 1]; has = true; } i++; continue; }
    if (c === '#' && !has && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== '\n') i++; i--; continue; }
    if (c === '<' && cmd.startsWith('<<<', i)) { endTok(); i += 2; continue; } // a here-string, not a heredoc
    const hd = heredocAt(cmd, i);
    if (hd) { endTok(); pending.push(hd); i = hd.next - 1; continue; }
    if (c === '\n' && pending.length) {
      endSeg();
      let at = i + 1;
      for (const h of pending) at = bodyEnd(cmd, at, h);
      pending.length = 0;
      cuts.push([i + 1, at]);
      i = at - 1;
      continue;
    }
    if (c === '$' && cmd[i + 1] === '(') { endSeg(); i++; continue; }
    if (';&|\n()`'.includes(c)) { endSeg(); continue; }
    if (/\s/.test(c)) { endTok(); continue; }
    cur += c; has = true;
  }
  endSeg();
  let text = '', from = 0;
  for (const [a, b] of cuts) { text += cmd.slice(from, a); from = b; }
  return { segments: out, text: text + cmd.slice(from) };
}

export const segments = (cmd) => lex(cmd).segments;
