#!/usr/bin/env bash
# Claude Code PreToolUse hook for the GitHub MCP tools (fork.9, widened in fork.9.1). gate-hook.sh only sees Bash commands,
# so the MCP tools that open or merge a pull request, move its branch or write to the base branch would walk around it.
# Register it with a matcher in hooks.json:
#
#   { "matcher": "mcp__.*github.*",
#     "hooks": [{ "type": "command", "command": "bash \"${CLAUDE_PLUGIN_ROOT}/skills/fork/feature-loop/scripts/mcp-pr-hook.sh\"" }] }
#
# Only where a feature loop is active (.scratch/gates.json without "status": "closed"). The tool is the part of its name
# after the last "__":
#   get_* list_* search_*                reads: always pass
#   *merge*  (merge_pull_request, enable_pull_request_auto_merge, ...)
#                                        always refused (exit 2): the owner merges, the loop never does. No bypass.
#   update_pull_request_branch           refused: it moves the PR branch on GitHub without the gates.
#   create_or_update_file, push_files, delete_file
#                                        refused when the call's `branch` is the base branch of gates.json or names none (that
#                                        is the default branch); a feature branch passes.
#   create_pull_request                  refused unless check-gates.sh --phase pr --require-stages is green (the same rule as
#                                        `gh pr create`).
# Anything else, and any repository with no active loop, passes. It fails closed: with a loop active, a payload that cannot be
# read, or a missing node (which reads the branch and the base), blocks a create or a file write; a merge needs neither.
# The payload is parsed with JSON.parse (mcp-payload.mjs); only without node does a sed read the tool name.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=loop-root.sh
. "$here/loop-root.sh"
input="$(cat)"

tool=""; dir=""; branch="-"; readable=1
if command -v node >/dev/null 2>&1; then
  if parsed="$(printf '%s' "$input" | node "$here/mcp-payload.mjs" 2>/dev/null)"; then
    { IFS= read -r tool; IFS= read -r dir; IFS= read -r branch; } <<< "$parsed"
  else
    readable=0
  fi
else
  # No node: a best-effort read of the tool name and cwd, and no branch (so a file write cannot be judged).
  field() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1 | sed 's/\\\\/\\/g'; }
  tool="$(field tool_name)"; dir="$(field cwd)"; branch="?"
fi

name="${tool##*__}"
kind=""
if [ "$readable" -eq 1 ]; then
  case "$name" in
    get_*|list_*|search_*) exit 0 ;;
    *merge*) kind=merge ;;
    create_pull_request) kind=create ;;
    update_pull_request_branch) kind=update ;;
    create_or_update_file|push_files|delete_file) kind=write ;;
    *) exit 0 ;;
  esac
fi

rc=0
root="$(loop_root "$dir")" || rc=$?
if [ "$rc" -ne 0 ]; then
  # No active loop. A loop that vanished (gates.json deleted, or closed by hand) still blocks a merge.
  if [ "$kind" = merge ] && command -v node >/dev/null 2>&1 && ! node "$here/stage-guard.mjs" "${dir:-$PWD}" >/dev/null 2>&1; then
    echo "feature-loop merge gate: this merge was blocked, the loop's run file vanished or was closed without a signed close. The owner merges." >&2
    exit 2
  fi
  # wp-loop (the kl flow): the owner's approvals made a signed store. A merge is refused and a PR needs approve pr for HEAD.
  if { [ "$kind" = merge ] || [ "$kind" = create ]; } && command -v node >/dev/null 2>&1; then
    if ! why="$(node "$here/wp-pr-guard.mjs" "${dir:-$PWD}" "$kind" 2>&1)"; then
      echo "feature-loop MCP gate: $why" >&2
      exit 2
    fi
  fi
  exit 0
fi

if [ "$readable" -eq 0 ]; then
  echo "feature-loop MCP gate: the hook input could not be read, so this GitHub tool call was blocked while the loop is active (repo: $root)." >&2
  exit 2
fi

if [ "$kind" = merge ]; then
  {
    echo "feature-loop merge gate: this merge was blocked (repo: $root). While the loop is active the owner merges: the loop never does, whatever the gates say."
    echo "Stop at the PR: give the owner the PR link and the evidence pack and wait. This gate has no bypass."
  } >&2
  exit 2
fi

if [ "$kind" = update ]; then
  {
    echo "feature-loop MCP gate: $name was blocked (repo: $root). It moves the PR branch on GitHub without the gates, so while the loop is active it is refused."
    echo "Update the branch locally, push it through the gates, and let the owner decide. This gate has no bypass."
  } >&2
  exit 2
fi

if [ "$kind" = write ]; then
  if ! command -v node >/dev/null 2>&1; then
    echo "feature-loop MCP gate: node not found on PATH, so the branch of $name could not be judged and it was blocked (repo: $root)." >&2
    exit 2
  fi
  base="$(node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).base; process.stdout.write(typeof v === "string" ? v : "");' "$root/.scratch/gates.json" 2>/dev/null)" || {
    echo "feature-loop MCP gate: cannot read \"base\" from $root/.scratch/gates.json, so $name was blocked." >&2
    exit 2
  }
  bare() { local b="${1#refs/heads/}"; printf '%s' "${b#origin/}"; }
  if [ "$branch" = "-" ] || { [ -n "$base" ] && [ "$(bare "$branch")" = "$(bare "$base")" ]; }; then
    {
      echo "feature-loop MCP gate: $name was blocked (repo: $root): its branch is $([ "$branch" = "-" ] && echo 'not named, which writes to the default branch' || echo "the base branch ($(bare "$base"))"), and the base moves only by the owner's merge of the PR."
      echo "Write to a feature branch, or commit and push locally through the gates. This gate has no bypass."
    } >&2
    exit 2
  fi
  exit 0
fi

# kind = create
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
