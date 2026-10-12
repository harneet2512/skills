#!/usr/bin/env bash
# Run a command that edits source files (a mutation run, a fault injected into the code) in a throwaway copy of HEAD,
# never in a working copy that holds work (fork.9.16, from dry run 3: a kill in the middle of a mutation run left a
# mutant in nano/report.py). The copy is a detached worktree outside the repo folder, removed when the command ends,
# also on Ctrl-C or a kill the shell sees. A copy left behind by a hard kill holds no work: the next sandbox.sh run
# removes every leftover wp-sandbox-* worktree of the repo older than 6 hours before making its own.
#
#   bash sandbox.sh <command...>     run from inside the repo (any worktree); the command runs in the copy's root
#   SANDBOX_REF=<ref>                copy that commit instead of HEAD
#
# Commit what the run should see first: the copy is HEAD, without uncommitted changes. Exit status is the command's.
set -uo pipefail

[ "$#" -gt 0 ] || { echo "usage: sandbox.sh <command...>" >&2; exit 64; }
top="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "sandbox.sh: not inside a git repository" >&2; exit 64; }
ref="${SANDBOX_REF:-HEAD}"
sha="$(git rev-parse --verify --quiet "$ref^{commit}")" || { echo "sandbox.sh: $ref is not a commit" >&2; exit 64; }
base="${TMPDIR:-${TEMP:-/tmp}}"
copy="$(mktemp -d "$base/wp-sandbox-XXXXXX")" || exit 70
rmdir "$copy"
case "$(cd "$base" && pwd -P)/" in "$(cd "$top" && pwd -P)/"*)
  echo "sandbox.sh: the temp folder $base is inside the repo; set TMPDIR to a folder outside it" >&2; exit 64 ;;
esac

git -C "$top" worktree list --porcelain | sed -n 's/^worktree //p' | grep -E '/wp-sandbox-[A-Za-z0-9]{6}$' |
  while IFS= read -r old; do
    # Older than 6 hours only, so a sandbox another issue is running right now is left alone.
    [ ! -e "$old" ] || [ -n "$(find "$old" -maxdepth 0 -mmin +360 2>/dev/null)" ] || continue
    git -C "$top" worktree remove --force "$old" >/dev/null 2>&1 || rm -rf "$old"
  done
git -C "$top" worktree prune >/dev/null 2>&1

cleanup() { git -C "$top" worktree remove --force "$copy" >/dev/null 2>&1 || rm -rf "$copy"; git -C "$top" worktree prune >/dev/null 2>&1; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

git -C "$top" worktree add --detach --quiet "$copy" "$sha" || { echo "sandbox.sh: could not make the copy" >&2; exit 70; }
echo "sandbox: $copy (detached at ${sha:0:10}); removed after" >&2
(cd "$copy" && "$@")
