// Reads a PreToolUse payload for a GitHub MCP tool on stdin with JSON.parse and prints three lines for mcp-pr-hook.sh:
//   1. the tool name   2. the session cwd   3. the `branch` argument of the call ("-" when it names none)
// Exit 3 with a message on stderr when the input is not a JSON object (the hook then fails closed while a loop is active).
// Node 22, no dependencies.
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
let input;
try {
  input = JSON.parse(raw);
} catch (e) {
  console.error(`hook input is not valid JSON: ${e.message}`);
  process.exit(3);
}
if (input === null || typeof input !== 'object' || Array.isArray(input)) {
  console.error('hook input is not a JSON object');
  process.exit(3);
}
const line = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').trim();
const branch = typeof input.tool_input?.branch === 'string' ? line(input.tool_input.branch) : '';
process.stdout.write(`${line(input.tool_name)}\n${line(input.cwd)}\n${branch || '-'}\n`);
