#!/usr/bin/env node
// Lint for the model-invoked / user-invoked split (see .agents/invocation.md). Node 22, no dependencies.
//
//   node scripts/check-invocation.mjs [--root <repo>]
//
// A skill is user-invoked when its SKILL.md frontmatter has `disable-model-invocation: true`. Reported, one per line:
//   <file>:<line>: calls user-invoked skill <name> via the Skill tool
//       a SKILL.md body that tells the agent to call the Skill tool with a user-invoked skill: "Skill tool with
//       `x`", with "x", with x, or "Skill tool twice, for x and y". No other skill can reach a user-invoked one.
//   <file>:<line>: user-invoked skill <name> lacks allow_implicit_invocation: false in agents/openai.yaml
//   <file>:<line>: model-invoked skill <name> has allow_implicit_invocation: false in agents/openai.yaml
//       the Claude Code and Codex flags must stay in sync.
// Exit: 0 clean, 1 violations, 2 usage error.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--root' && args[i + 1]) root = args[++i];
  else { console.error('usage: check-invocation.mjs [--root <repo>]'); process.exit(2); }
}
if (!existsSync(join(root, 'skills'))) { console.error(`check-invocation: no skills/ directory under ${root}`); process.exit(2); }

function skillFiles(dir) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...skillFiles(p));
    else if (e.name === 'SKILL.md') found.push(p);
  }
  return found.sort();
}

// { name, userInvoked, body, bodyStart } from a SKILL.md: frontmatter between the first two `---` lines.
function parse(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const meta = {};
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(l);
        if (m) meta[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
      }
      bodyStart = end + 1;
    }
  }
  return {
    name: meta.name || basename(dirname(file)),
    userInvoked: String(meta['disable-model-invocation']).toLowerCase() === 'true',
    body: lines.slice(bodyStart).join('\n'),
    bodyStart,
  };
}

const skills = skillFiles(join(root, 'skills')).map((file) => ({ file, rel: relative(root, file).split('\\').join('/'), ...parse(file) }));
const userInvoked = skills.filter((s) => s.userInvoked).map((s) => s.name);
const violations = [];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The name as a whole token: not glued to more name characters on either side.
const token = (n) => `(?<![\\w-])${esc(n)}(?![\\w-])`;
const quoted = (n) => `[\`"']?${token(n)}[\`"']?`;

for (const s of skills) {
  const lineOf = (index) => s.bodyStart + s.body.slice(0, index).split('\n').length;
  for (const name of userInvoked) {
    const hits = new Set();
    // Skill tool with `x` / "x" / x, the name possibly on the next line.
    for (const m of s.body.matchAll(new RegExp(`Skill\\s+tool\\s+with\\s+${quoted(name)}`, 'gi'))) hits.add(lineOf(m.index));
    // Skill tool twice, for x and y: the names run to the end of the sentence.
    for (const m of s.body.matchAll(/Skill\s+tool\s+(?:twice|three\s+times),?\s+for\s+([^\n]*(?:\n(?!\n)[^\n]*)?)/gi)) {
      const sentence = m[1].split(/\.(?:\s|$)/)[0];
      if (new RegExp(quoted(name)).test(sentence)) hits.add(lineOf(m.index));
    }
    for (const line of [...hits].sort((a, b) => a - b)) {
      violations.push({ rel: s.rel, line, text: `${s.rel}:${line}: calls user-invoked skill ${name} via the Skill tool` });
    }
  }

  const yamlPath = join(dirname(s.file), 'agents', 'openai.yaml');
  const yamlRel = relative(root, yamlPath).split('\\').join('/');
  const yaml = existsSync(yamlPath) && statSync(yamlPath).isFile() ? readFileSync(yamlPath, 'utf8').split(/\r?\n/) : null;
  const flagLine = yaml ? yaml.findIndex((l) => /^\s*allow_implicit_invocation:\s*false\s*(#.*)?$/.test(l)) : -1;
  if (s.userInvoked && flagLine < 0) {
    violations.push({ rel: yamlRel, line: 1, text: `${yamlRel}:1: user-invoked skill ${s.name} lacks allow_implicit_invocation: false in agents/openai.yaml` });
  } else if (!s.userInvoked && flagLine >= 0) {
    violations.push({ rel: yamlRel, line: flagLine + 1, text: `${yamlRel}:${flagLine + 1}: model-invoked skill ${s.name} has allow_implicit_invocation: false in agents/openai.yaml` });
  }
}

violations.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : a.line - b.line));
for (const v of violations) console.log(v.text);
if (violations.length) {
  console.error(`check-invocation: ${violations.length} violation${violations.length > 1 ? 's' : ''} (see .agents/invocation.md)`);
  process.exit(1);
}
console.log(`check-invocation: ${skills.length} skills, ${userInvoked.length} user-invoked, no violations`);
