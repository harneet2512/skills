// Reads a Claude Code PreToolUse hook payload on stdin and decides whether the Bash command ships code:
// `git push`, `gh pr create` (or its alias `gh pr new`), a POST to a `.../pulls` endpoint through `gh api`,
// or a `createPullRequest` mutation through `gh api graphql`. Used by gate-hook.sh. Node 22, no dependencies.
//
// Prints four lines:
//   1. 1 when the command ships code, else 0
//   2. the directory to check: the session cwd, moved by any `cd <dir>` or `git -C <dir>` before the push
//   3. the effective FEATURE_LOOP_GATES value (an assignment in the command wins over the environment)
//   4. the effective FEATURE_LOOP_BYPASS_REASON, on one line
import { resolve } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input = {};
try { input = JSON.parse(raw); } catch { /* not JSON: nothing to gate */ }

const startDir = (typeof input.cwd === 'string' && input.cwd) || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const command = input?.tool_name === 'Bash' && typeof input?.tool_input?.command === 'string' ? input.tool_input.command : '';

// Shell-ish lexer: segments split on unquoted ; & | newline ( ) ` and $( ; tokens split on unquoted whitespace.
// It does not expand variables or globs. Unterminated quotes run to the end, which is the safe direction.
function segments(cmd) {
  const out = [];
  let toks = [], cur = '', has = false, q = '';
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
    if (c === '#' && !has && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== '\n') i++; endSeg(); continue; }
    if (c === '$' && cmd[i + 1] === '(') { endSeg(); i++; continue; }
    if (';&|\n()`'.includes(c)) { endSeg(); continue; }
    if (/\s/.test(c)) { endTok(); continue; }
    cur += c; has = true;
  }
  endSeg();
  return out;
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const WRAPPERS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'time', 'nohup',
  'command', 'builtin', 'exec', 'sudo', 'env', 'xargs', 'nice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const base = (t) => t.split('/').pop();

// Effective variables: the hook's environment, overridden by `export X=...` or `X=... cmd` in the command.
const vars = {
  FEATURE_LOOP_GATES: process.env.FEATURE_LOOP_GATES ?? '',
  FEATURE_LOOP_BYPASS_REASON: process.env.FEATURE_LOOP_BYPASS_REASON ?? '',
};
const setVar = (k, v) => { if (k in vars) vars[k] = v; };

const GIT_OPTS_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const GH_API_OPTS_WITH_ARG = new Set(['-X', '--method', '-f', '--raw-field', '-F', '--field', '-H', '--header', '--input',
  '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview', '--cache']);

function isGitPush(args, dir) {
  let i = 0, d = dir;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C' && i + 1 < args.length) d = resolve(d, args[i + 1]);
    i += GIT_OPTS_WITH_ARG.has(a) ? 2 : 1;
  }
  if (args[i] !== 'push') return null;
  const rest = args.slice(i + 1);
  // A dry run or a remote branch deletion ships nothing.
  if (rest.some((a) => a === '--dry-run' || a === '-n' || a === '--delete' || a === '-d')) return null;
  return d;
}

function isGhCreate(args) {
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] === 'pr' && (pos[1] === 'create' || pos[1] === 'new')) return true;
  if (args[0] !== 'api' && pos[0] !== 'api') return false;
  const rest = args.slice(args.indexOf('api') + 1);
  let method = '', fields = false, endpoint = '';
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, null];
    if (/^-X./.test(a)) { method = a.slice(2); continue; }
    if (GH_API_OPTS_WITH_ARG.has(flag)) {
      const v = inline ?? rest[++i] ?? '';
      if (flag === '-X' || flag === '--method') method = v;
      if (['-f', '--raw-field', '-F', '--field', '--input'].includes(flag)) fields = true;
      continue;
    }
    if (a.startsWith('-')) continue;
    if (!endpoint) endpoint = a;
  }
  method = (method || (fields ? 'POST' : 'GET')).toUpperCase();
  if (endpoint === 'graphql') return rest.some((a) => a.includes('createPullRequest'));
  const path = endpoint.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return method === 'POST' && /(^|\/)pulls$/.test(path);
}

let match = false, matchDir = startDir;

function analyze(cmd, dir, depth) {
  for (const seg of segments(cmd)) {
    if (match) return dir;
    let i = 0;
    const local = {};
    // Leading assignments and wrappers: `FOO=1 env -i sudo git push`.
    for (;;) {
      if (i >= seg.length) break;
      const t = seg[i];
      const m = ASSIGN.exec(t);
      if (m) { local[m[1]] = m[2]; i++; continue; }
      if (WRAPPERS.has(base(t))) { i++; while (i < seg.length && seg[i].startsWith('-') && base(seg[i - 1]) !== '{') i++; continue; }
      break;
    }
    const name = i < seg.length ? base(seg[i]) : '';
    const args = seg.slice(i + 1);
    if (name === '') { for (const [k, v] of Object.entries(local)) setVar(k, v); continue; }
    if (name === 'export') { for (const a of args) { const m = ASSIGN.exec(a); if (m) setVar(m[1], m[2]); } continue; }
    if (name === 'cd') { if (args[0] && args[0] !== '-' && !args[0].startsWith('$')) dir = resolve(dir, args[0]); continue; }
    if ((SHELLS.has(name) || name === 'eval') && depth < 3) {
      const ci = name === 'eval' ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      const inner = name === 'eval' ? args.join(' ') : ci >= 0 ? args[ci + 1] : undefined;
      if (inner !== undefined) {
        const saved = { ...vars };
        for (const [k, v] of Object.entries(local)) setVar(k, v);
        analyze(inner, dir, depth + 1);
        if (!match) Object.assign(vars, saved);
      }
      continue;
    }
    let hit = false, d = dir;
    if (name === 'git') { const r = isGitPush(args, dir); if (r) { hit = true; d = r; } }
    else if (name === 'gh') hit = isGhCreate(args);
    if (hit) {
      for (const [k, v] of Object.entries(local)) setVar(k, v);
      match = true; matchDir = d;
      return dir;
    }
  }
  return dir;
}

if (command) analyze(command, startDir, 0);
const oneLine = (s) => String(s).replace(/[\r\n]+/g, ' ').trim();
process.stdout.write(`${match ? 1 : 0}\n${oneLine(matchDir)}\n${oneLine(vars.FEATURE_LOOP_GATES)}\n${oneLine(vars.FEATURE_LOOP_BYPASS_REASON)}\n`);
