#!/usr/bin/env bash
# Claude Code Stop hook, registered in the plugin's hooks/hooks.json. While the feature loop is running
# (.scratch/gates.json) and .scratch/loop-status.md has a stage with status `running`, the session may not stop: exit 2
# with the reason on stderr, which Claude Code shows to the model. A stage that is `blocked: ...`, `done`, `pending`
# or `skipped: ...` never blocks, and neither does a Stop that a Stop hook already caused (stop_hook_active).
# Anything unexpected (no node, unreadable input) lets the session stop.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v node >/dev/null 2>&1 || exit 0
exec node "$here/loop-hooks.mjs" stop
