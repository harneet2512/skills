#!/usr/bin/env bash
# Second-model review through the Codex CLI: a plan review or a code attack, written to .scratch/review/.
#
#   codex-review.sh plan <plan-file> [--slug S]    attack the plan against the real repo (read-only)
#   codex-review.sh code <base>      [--slug S]    adversarial review and testing of <base>...HEAD in a throwaway worktree
#
# Run from inside the target repo. Environment: CODEX_REVIEW_MODEL (default gpt-6-astra), CODEX_REVIEW_TIMEOUT
# (seconds, default 1800), CODEX_REVIEW_CODEX_BIN (default codex).
#
# Exit codes: 0 it ran and wrote a report; 2 codex is missing or failed, the output is invalid, or usage is wrong;
# 3 timeout. A failed run writes no report, only a timeline line. This script never writes a resolution: the lead
# does, in .scratch/review/codex-<kind>-<slug>.resolutions.md.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill="$(cd "$here/.." && pwd)"
MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
TIMEOUT="${CODEX_REVIEW_TIMEOUT:-1800}"
CODEX="${CODEX_REVIEW_CODEX_BIN:-codex}"
EXIT_FAIL=2
EXIT_TIMEOUT=3

die() { printf 'codex-review: %s\n' "$*" >&2; exit "$EXIT_FAIL"; }
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# native <path>: the path form node and codex understand (Windows drive form under Git Bash, unchanged elsewhere).
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

slugify() { printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//' | cut -c1-60; }

# timeline <text>: one append-only row for the owner's visibility.
timeline() {
  mkdir -p "$ROOT/.scratch"
  printf -- '- %s %s\n' "$(now)" "$1" >> "$ROOT/.scratch/timeline.md"
}

parse_args() {
  KIND="${1:-}"; TARGET="${2:-}"; SLUG=""
  [ "$KIND" = plan ] || [ "$KIND" = code ] || die "usage: codex-review.sh plan <plan-file> | code <base> [--slug S]"
  [ -n "$TARGET" ] || die "missing argument: $([ "$KIND" = plan ] && echo plan file || echo base ref)"
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --slug) [ $# -ge 2 ] || die "--slug needs a value"; SLUG="$2"; shift 2 ;;
      *) die "unknown argument: $1" ;;
    esac
  done
}

# resolve_subject: sets SUBJECT_SHA, BASE, SLUG and, for plan mode, PLAN_ABS.
resolve_subject() {
  BASE=""
  if [ "$KIND" = plan ]; then
    [ -f "$TARGET" ] || die "plan file not found: $TARGET"
    PLAN_ABS="$(cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
    SUBJECT_SHA="$(sha256_file "$PLAN_ABS")"
    [ -n "$SLUG" ] || SLUG="$(basename "${TARGET%.*}")"
  else
    git -C "$ROOT" rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null || die "base is not a commit: $TARGET"
    BASE="$TARGET"
    SUBJECT_SHA="$(git -C "$ROOT" rev-parse HEAD)"
    [ -n "$SLUG" ] || SLUG="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    case "$SLUG" in ""|HEAD) SLUG="${SUBJECT_SHA:0:7}" ;; esac
  fi
  SLUG="$(slugify "$SLUG")"
  [ -n "$SLUG" ] || die "slug is empty"
}

# build_prompt: the prompt template for this kind plus the concrete inputs.
build_prompt() {
  local tpl="$skill/prompts/$([ "$KIND" = plan ] && echo plan-review || echo code-attack).md"
  [ -f "$tpl" ] || die "prompt template missing: $tpl"
  cat "$tpl"
  printf '\n\n## Inputs for this run\n\n'
  if [ "$KIND" = plan ]; then
    printf -- '- Plan file: %s\n- Repo root: %s\n' "$PLAN_ABS" "$ROOT"
  else
    printf -- '- Base: %s\n- Head: %s\n- Diff command: git diff %s...HEAD\n- Plan files, if any, are under docs/plans/ in this checkout.\n' \
      "$BASE" "$SUBJECT_SHA" "$BASE"
  fi
}

# run_codex <sandbox> <workdir> <prompt-file> <out.json> <log>: codex exec with stdin detached; returns codex's status
# (124 when the timeout fired).
run_codex() {
  local sandbox="$1" workdir="$2" prompt_file="$3" out="$4" log="$5" prompt
  prompt="$(cat "$prompt_file")"
  local -a cmd=("$CODEX" exec -m "$MODEL" -s "$sandbox" --ephemeral --skip-git-repo-check
    -C "$(native "$workdir")" --output-schema "$(native "$skill/schemas/findings.schema.json")" -o "$(native "$out")" "$prompt")
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT" "${cmd[@]}" < /dev/null > "$log" 2>&1
  else
    echo "codex-review: no timeout command found, running without a time limit" >&2
    "${cmd[@]}" < /dev/null > "$log" 2>&1
  fi
}

# collect_repros <worktree> <report.json> <repro-dir>: copy the files codex added or changed in the worktree into
# <repro-dir>/<id>/ for each CONFIRMED finding whose repro names them; the rest go to _unassigned.
collect_repros() {
  local wt="$1" report="$2" dest="$3" f id
  local -a ids files
  while IFS= read -r f; do
    [ -f "$wt/$f" ] && files+=("$f")
  done < <(git -C "$wt" ls-files -m -o --exclude-standard)
  [ "${#files[@]}" -gt 0 ] || return 0
  for f in "${files[@]}"; do
    local matched=0
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      mkdir -p "$dest/$id/$(dirname "$f")"; cp "$wt/$f" "$dest/$id/$f"; matched=1
    done < <(node "$(native "$here/repro-ids.mjs")" "$(native "$report")" "$f")
    if [ "$matched" = 0 ]; then mkdir -p "$dest/_unassigned/$(dirname "$f")"; cp "$wt/$f" "$dest/_unassigned/$f"; fi
  done
}

fail_run() { # fail_run <exit> <message>
  timeline "codex $KIND review of $SLUG by $MODEL FAILED (exit $1): $2"
  printf 'codex-review: %s\n' "$2" >&2
  exit "$1"
}

main() {
  parse_args "$@"
  command -v "$CODEX" >/dev/null 2>&1 || { ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"; SLUG="${SLUG:-$KIND}"; fail_run "$EXIT_FAIL" "codex CLI not found ($CODEX)"; }
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
  resolve_subject
  command -v node >/dev/null 2>&1 || die "node is required to validate the output"
  local started finished out_dir raw log meta status=0
  wt=""
  tmp="$(mktemp -d)"
  cleanup() { [ -n "$wt" ] && git -C "$ROOT" worktree remove --force "$wt" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
  trap cleanup EXIT
  out_dir="$ROOT/.scratch/review"; mkdir -p "$out_dir"
  raw="$tmp/raw.json"; log="$tmp/codex.log"; meta="$tmp/meta.json"
  build_prompt > "$tmp/prompt.md"
  started="$(now)"
  if [ "$KIND" = plan ]; then
    run_codex read-only "$ROOT" "$tmp/prompt.md" "$raw" "$log" || status=$?
  else
    wt="$tmp/wt"; git -C "$ROOT" worktree add --detach "$wt" HEAD >/dev/null 2>&1 || die "could not create worktree"
    run_codex workspace-write "$wt" "$tmp/prompt.md" "$raw" "$log" || status=$?
  fi
  finished="$(now)"
  [ "$status" -ne 124 ] || fail_run "$EXIT_TIMEOUT" "codex timed out after ${TIMEOUT}s"
  [ "$status" -eq 0 ] || fail_run "$EXIT_FAIL" "codex exited $status: $(tail -n 3 "$log" | tr '\n' ' ')"
  [ -s "$raw" ] || fail_run "$EXIT_FAIL" "codex wrote no output"

  node "$(native "$here/report.mjs")" validate "$(native "$skill/schemas/findings.schema.json")" "$(native "$raw")" 2> "$tmp/invalid.txt" \
    || fail_run "$EXIT_FAIL" "invalid output: $(tr '\n' ';' < "$tmp/invalid.txt")"
  node -e 'const [k,m,v,s,b,st,fi,sl]=process.argv.slice(1);console.log(JSON.stringify({kind:k,slug:sl,model:m,codex_version:v,subject_sha:s,base:b||null,started:st,finished:fi,exit_code:0}))' \
    "$KIND" "$MODEL" "$("$CODEX" --version 2>/dev/null | head -n 1)" "$SUBJECT_SHA" "$BASE" "$started" "$finished" "$SLUG" > "$meta"
  local json="$out_dir/codex-$KIND-$SLUG.json" summary
  summary="$(node "$(native "$here/report.mjs")" build "$(native "$skill/schemas/findings.schema.json")" "$(native "$raw")" "$(native "$meta")" \
    "$(native "$json")" "$(native "$out_dir/codex-$KIND-$SLUG.md")")" || fail_run "$EXIT_FAIL" "could not write the report"
  [ "$KIND" = code ] && collect_repros "$wt" "$json" "$out_dir/codex-repros"
  timeline "$summary -> .scratch/review/codex-$KIND-$SLUG.md"
  printf '%s\n' "$summary"
}

main "$@"
