#!/usr/bin/env bash
# Claude Code PostToolUse, UserPromptExpansion and SessionStart hook for the stage logs (fork.8): see stage-hook.mjs.
# Usage: stage-hook.sh post-tool | prompt-expansion | init. It never fails the session: no node means no logging
# (gate G9 then reports the missing logs, it does not pretend the stages ran).
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || exit 0
node "$here/stage-hook.mjs" "${1:-post-tool}"
exit $?
