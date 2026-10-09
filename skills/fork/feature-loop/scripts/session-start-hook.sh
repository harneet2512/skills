#!/usr/bin/env bash
# Claude Code SessionStart hook, registered in the plugin's hooks/hooks.json. When the project has
# .scratch/gates.json it prints a short summary to stdout, which Claude Code adds to the model's context: the slug,
# the size, the stages of .scratch/loop-status.md that are not done, and where to resume. Prints nothing otherwise.
# It never fails the session: every error ends in exit 0.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || exit 0
node "$here/loop-hooks.mjs" session-start || true
exit 0
