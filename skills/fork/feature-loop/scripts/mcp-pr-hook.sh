#!/usr/bin/env bash
# Claude Code PreToolUse hook for the GitHub MCP tools that open or merge a pull request (fork.9). gate-hook.sh only sees
# Bash commands, so `mcp__<server>__merge_pull_request` and `mcp__<server>__create_pull_request` would walk around it.
# Register it with a matcher in hooks.json:
#
#   { "matcher": "mcp__.*(merge_pull_request|create_pull_request)",
#     "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/skills/fork/feature-loop/scripts/mcp-pr-hook.sh\"" }] }
#
# Only where a feature loop is active (.scratch/gates.json without "status": "closed"):
#   merge_pull_request   always refused (exit 2): the owner merges, the loop never does. No bypass.
#   create_pull_request  refused unless check-gates.sh --phase pr --require-stages is green (the same rule as `gh pr create`).
# Anything else, and any repository with no active loop, passes. It fails closed: with a loop active, a payload that cannot
# be read or a missing node blocks a create (a merge needs neither).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=loop-root.sh
. "$here/loop-root.sh"
input="$(cat)"

field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1 | sed 's/\\\\/\\/g'; }
tool="$(field tool_name)"
case "$tool" in
  *merge_pull_request) kind=merge ;;
  *create_pull_request) kind=create ;;
  *) exit 0 ;;
esac

dir="$(field cwd)"
rc=0
root="$(loop_root "$dir")" || rc=$?
if [ "$rc" -ne 0 ]; then
  # No active loop. A loop that vanished (gates.json deleted, or closed by hand) still blocks a merge.
  if [ "$kind" = merge ] && command -v node >/dev/null 2>&1 && ! node "$here/stage-guard.mjs" "${dir:-$PWD}" >/dev/null 2>&1; then
    echo "feature-loop merge gate: this merge was blocked, the loop's run file vanished or was closed without a signed close. The owner merges." >&2
    exit 2
  fi
  exit 0
fi

if [ "$kind" = merge ]; then
  {
    echo "feature-loop merge gate: this merge was blocked (repo: $root). While the loop is active the owner merges: the loop never does, whatever the gates say."
    echo "Stop at the PR: give the owner the PR link and the evidence pack and wait. This gate has no bypass."
  } >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "feature-loop PR gate: node not found on PATH, so the pr phase could not be checked and opening a PR was blocked (repo: $root)." >&2
  exit 2
fi
wt="$(loop_work_tree "${dir:-$root}" "$root")"
out="$(cd "$wt" && "$here/check-gates.sh" --phase pr --require-stages 2>&1)"; code=$?
[ "$code" -eq 0 ] && exit 0
{
  echo "feature-loop PR gate: opening a PR was blocked, the pr phase is not green (repo: $root)."
  printf '%s\n' "$out" | grep -E '^(G[0-9]+|PR-[A-Z]+) red:' || printf '%s\n' "$out" | head -n 3
  echo "Fix: CI green on the pushed HEAD, the evidence pack to the owner, and the owner's \"approve pr\" (stop 3). This gate has no bypass."
} >&2
exit 2
