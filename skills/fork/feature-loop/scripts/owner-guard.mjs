// Bash checks for the owner's workflow (fork.9.16, from dry run 3, HAR-182). Called by gate-hook.sh before its fast
// path, for every Bash command that mentions a worktree, a mutation run or a git identity. Active where a feature loop
// runs or where the owner's signed store exists (plan-first's approvals); elsewhere it passes everything.
//
//   identity   commits are the owner's. Setting GIT_AUTHOR_* or GIT_COMMITTER_* (also through `env` or `export`),
//              `git -c user.name|user.email`, `git commit --author`, or `git config user.name|user.email <value>` is
//              refused; reading them is not. In dry run 3 git had no identity, and the loop committed as "Claude"
//              instead of asking.
//   worktree   `git worktree add <path>` inside the repo folder is refused (dry run 3 put a parallel issue's worktree
//              in .claude/worktrees/). Worktrees go outside the repo folder. A path it cannot resolve passes.
//   mutation   a mutation run is refused in a working copy that holds work: the main worktree, or any worktree with a
//              branch checked out. A mutation run is a mutation tool's run (mutmut, stryker, cosmic-ray, a pitest goal),
//              also behind npx, uv run, poetry run or python -m, or an interpreter running a script whose name says
//              mutat or mutant. In dry run 3 a kill mid-run left a mutant in nano/report.py. Run it in a throwaway
//              copy: sandbox.sh makes a detached worktree outside the repo and removes it after.
//
// The command is read by shell-lex.mjs: words, not a shell. Redirections are dropped; $VAR, ${VAR} and ~ in a worktree
// path are expanded from this process's environment.
//
//   node owner-guard.mjs < hook payload    exit 0 pass, 2 refused (the reason on stderr)
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { lex } from './shell-lex.mjs';
import { storeStatus } from './stage-log.mjs';
import { gitOut, loopRoot, repoRoot } from './vis-root.mjs';

const IDENTITY_VARS = /^(GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL)=/;
const IDENTITY_KEYS = /^user\.(name|email)$/i;
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'command', 'exec', 'timeout']);
const LAUNCHERS = { npx: 1, bunx: 1, pipx: 2, uv: 2, poetry: 2, pdm: 2, hatch: 2, pnpm: 2, yarn: 1 }; // words before the tool
const MUTATION_TOOLS = new Set(['mutmut', 'stryker', 'cosmic-ray', 'mutatest']);
const TOOL_READ_ONLY = new Set(['install', 'add', 'show', 'results', 'html', 'browse', 'version', 'init', '--help', '-h', '--version']);
const INTERPRETERS = new Set(['python', 'python3', 'py', 'node', 'bash', 'sh', 'zsh', 'deno', 'bun', 'ruby', 'perl', 'tsx', 'ts-node']);
const MUTATION_SCRIPT = /mutat|mutant/i;
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
const CONFIG_OPTS_WITH_VALUE = new Set(['--file', '-f', '--blob', '--type', '--default', '--comment']);
const WORKTREE_ADD_OPTS_WITH_VALUE = new Set(['-b', '-B', '--reason', '--orphan']);

// One spelling for a path on any shell: D:\a, D:/a and /d/a are the same folder on Windows.
export function norm(p) {
  let s = String(p).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    s = s.replace(/^\/([a-zA-Z])(\/|$)/, (_, d, rest) => `${d}:/${rest}`);
    s = s.toLowerCase();
  }
  return s.replace(/\/+$/, '');
}
const inside = (p, root) => { const a = norm(p), b = norm(root); return a === b || a.startsWith(`${b}/`); };
const at = (dir, p) => (isAbsolute(p) || /^\/[a-zA-Z]\//.test(p) ? norm(p) : resolve(dir, p));
const binName = (t) => String(t ?? '').replace(/\\/g, '/').split('/').pop().replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

// $VAR, ${VAR} and a leading ~ from this environment; null when something is left that only a shell could expand.
function expand(p) {
  let s = String(p).replace(/^~(?=$|[\\/])/, homedir());
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => process.env[a || b] ?? m);
  return /[$`]/.test(s) ? null : s;
}

// The words of a command without its redirections (`>f`, `2>&1`, `> f`, `<in`).
function dropRedirects(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d*(>>?|<|>&|<&)$/.test(t) || /^&>>?$/.test(t)) { i++; continue; }
    if (/^(\d*(>>?|<|>&|<&)|&>>?)./.test(t)) continue;
    out.push(t);
  }
  return out;
}

// Splits leading assignments and wrappers (env NAME=v, time, nice ...) off a command: { assigns, toks }.
function unwrap(words) {
  const assigns = [];
  let toks = words;
  for (;;) {
    let k = 0;
    while (k < toks.length && ASSIGN.test(toks[k])) assigns.push(toks[k++]);
    toks = toks.slice(k);
    if (!WRAPPERS.has(binName(toks[0]))) return { assigns, toks };
    let j = 1;
    while (j < toks.length && (toks[j].startsWith('-') || (binName(toks[0]) === 'timeout' && /^\d/.test(toks[j])))) j++;
    toks = toks.slice(j);
  }
}

// The git subcommand of a command: { sub, args, dir, config } with -C followed, or null when it is not git.
function gitCall(toks, dir) {
  if (binName(toks[0]) !== 'git') return null;
  let i = 1, d = dir;
  const config = [];
  while (i < toks.length && toks[i].startsWith('-')) {
    const t = toks[i];
    if (t === '-C' && toks[i + 1] !== undefined) d = at(d, expand(toks[i + 1]) ?? toks[i + 1]);
    if (t === '-c' && toks[i + 1] !== undefined) config.push(toks[i + 1]);
    if (t.startsWith('-c') && t.length > 2) config.push(t.slice(2));
    i += GIT_OPTS_WITH_VALUE.has(t) ? 2 : 1;
  }
  return { sub: toks[i], args: toks.slice(i + 1), dir: d, config };
}

function identityProblem(assigns, toks, git) {
  if (assigns.some((a) => IDENTITY_VARS.test(a))) return 'it sets a commit identity in the environment';
  if (toks[0] === 'export' && toks.slice(1).some((a) => IDENTITY_VARS.test(a))) return 'it exports a commit identity';
  if (!git) return '';
  if (git.config.some((c) => IDENTITY_KEYS.test(c.split('=')[0]))) return 'it sets user.name or user.email with git -c';
  if (git.sub === 'commit' && git.args.some((a) => a === '--author' || a.startsWith('--author='))) return 'it sets the commit author with --author';
  if (git.sub === 'config') {
    const words = [];
    let reading = false;
    for (let i = 0; i < git.args.length; i++) {
      const a = git.args[i];
      if (/^--(get|get-all|get-regexp|get-urlmatch|list|unset|unset-all|show-origin|show-scope|name-only)$/.test(a) || a === '-l') reading = true;
      if (CONFIG_OPTS_WITH_VALUE.has(a)) { i++; continue; }
      if (!a.startsWith('-')) words.push(a);
    }
    if (!reading && words.length >= 2 && IDENTITY_KEYS.test(words[0])) return 'it sets user.name or user.email with git config';
  }
  return '';
}

function worktreeProblem(git, root) {
  if (!git || git.sub !== 'worktree' || git.args[0] !== 'add') return '';
  const rest = git.args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '--') { i++; }
    else if (t.startsWith('-')) { if (WORKTREE_ADD_OPTS_WITH_VALUE.has(t)) i++; continue; }
    const path = expand(rest[i] ?? '');
    if (path === null) return '';
    const r = repoRoot(git.dir) || root;
    if (r && inside(at(git.dir, path), r)) return `the worktree path ${rest[i]} is inside the repo folder (${r})`;
    return '';
  }
  return '';
}

// Is this command a mutation run? The tool is the first word, past launchers (npx, uv run, poetry run, python -m).
function isMutationRun(toks) {
  let t = toks;
  for (;;) {
    const name = binName(t[0]);
    if (LAUNCHERS[name] && t.length > LAUNCHERS[name]) {
      const skip = name === 'pnpm' || name === 'yarn' ? (['exec', 'dlx', 'run'].includes(t[1]) ? 2 : 1) : LAUNCHERS[name];
      t = t.slice(skip).filter((w, k) => k > 0 || !w.startsWith('-'));
      continue;
    }
    if (['python', 'python3', 'py'].includes(name) && t[1] === '-m' && t[2]) { t = t.slice(2); continue; }
    break;
  }
  const name = binName(t[0]);
  if (MUTATION_TOOLS.has(name) || /^@?stryker/.test(name)) return !TOOL_READ_ONLY.has(t[1] ?? '');
  if (['mvn', 'mvnw', 'gradle', 'gradlew'].includes(name)) return t.some((w) => /pitest|mutationCoverage/i.test(w));
  if (INTERPRETERS.has(name)) {
    const script = t.slice(1).find((w) => !w.startsWith('-'));
    return Boolean(script) && MUTATION_SCRIPT.test(binName(script));
  }
  return false;
}

function mutationProblem(toks, dir, viaSandbox) {
  if (viaSandbox || !isMutationRun(toks)) return '';
  const top = gitOut(dir, ['rev-parse', '--show-toplevel']);
  if (!top) return '';
  const main = repoRoot(dir);
  const branch = gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (main && inside(top, main)) return `it would change files in the main working copy (${top})`;
  if (branch && branch !== 'HEAD') return `it would change files in the worktree of branch ${branch} (${top})`;
  return '';
}

// The workflow root that governs a folder: a feature loop, or the owner's signed store in the main worktree.
const seen = new Map();
function activeAt(dir) {
  if (!seen.has(dir)) {
    const repo = repoRoot(dir);
    seen.set(dir, loopRoot(dir) || (repo && storeStatus(repo).kind === 'ok' ? repo : null));
  }
  return seen.get(dir);
}

const identityRefusal = (why) => `owner workflow: refused, ${why}. Commits are the owner's: never make up an author. If git has no identity here, stop and ask the owner to set one (git config user.name and user.email); keep building meanwhile and commit once it is set.`;

export function check(command, cwd) {
  let dir = cwd;
  for (const seg of lex(command).segments) {
    const { assigns, toks } = unwrap(dropRedirects(seg));
    if (!toks.length) {
      if (activeAt(dir) && assigns.some((a) => IDENTITY_VARS.test(a))) return identityRefusal('it sets a commit identity in the environment');
      continue;
    }
    if ((toks[0] === 'cd' || toks[0] === 'pushd') && toks[1]) { const p = expand(toks[1]); if (p !== null) dir = at(dir, p); continue; }
    if (binName(toks[0]) === 'sandbox.sh' || ((binName(toks[0]) === 'bash' || binName(toks[0]) === 'sh') && binName(toks[1]) === 'sandbox.sh')) continue;
    const git = gitCall(toks, dir);
    const root = activeAt(git?.dir ?? dir);
    if (!root) continue;
    const who = identityProblem(assigns, toks, git);
    if (who) return identityRefusal(who);
    const wt = worktreeProblem(git, root);
    if (wt) return `owner workflow: refused, ${wt}. A worktree inside the repo folder mixes with the owner's files and shows up in their git status. Put it outside: git worktree add <dir outside ${repoRoot(git.dir) || root}> <branch>.`;
    const mut = mutationProblem(toks, dir, false);
    if (mut) return `owner workflow: refused, a mutation run edits source files, and ${mut}; a kill in the middle leaves a mutant behind (dry run 3). Run it in a throwaway copy: bash "<plugin>/skills/fork/feature-loop/scripts/sandbox.sh" <command...> (a detached worktree of HEAD outside the repo, removed after).`;
  }
  return '';
}

if (/[\\/]owner-guard\.mjs$/.test(process.argv[1] ?? '')) {
  let payload;
  try { payload = JSON.parse(readFileSync(0, 'utf8')); } catch { process.exit(0); }
  const command = payload?.tool_input?.command;
  if (typeof command !== 'string') process.exit(0);
  const why = check(command, payload.cwd || process.cwd());
  if (why) { process.stderr.write(`${why}\n`); process.exit(2); }
  process.exit(0);
}
