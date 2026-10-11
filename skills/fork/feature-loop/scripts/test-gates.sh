#!/usr/bin/env bash
# Tests for check-gates.sh and gate-hook.sh. Each case builds a throwaway git repo in a temp dir from the files in
# fixtures/gates/, runs the script, and checks the exit code and the expected line.
# Run: skills/fork/feature-loop/scripts/test-gates.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fx="$here/fixtures/gates"
check="$here/check-gates.sh"
hook="$here/gate-hook.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
unset FEATURE_LOOP_GATES FEATURE_LOOP_BYPASS_REASON CLAUDE_PROJECT_DIR
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
fail=0
total=0
SLUG=reply-options

# ---- repo builders

# A repo with a main branch and a feature branch that adds clean code. Prints its path.
new_repo() {
  local d="$work/$1"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q -b main
    printf '.scratch/\n' > .gitignore
    printf '# demo\n' > README.md
    git add -A && git commit -q -m base
    git checkout -q -b feature
    mkdir -p src && cp "$fx/src/clean.js" src/clean.js
    git add -A && git commit -q -m feature
  ) || { echo "FAIL could not build repo $1"; exit 1; }
  printf '%s' "$d"
}

last_ct() { git -C "$1" log -1 --format=%ct; }
# fork.9: live reports and eval results are fresh by the commit they name ("head"), not by file time.
# stamp_head <dir> <file relative to dir> [sha]: set "head" in a JSON file to the sha (default: HEAD of <dir>).
stamp_head() {
  node -e 'const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8")); j.head = process.argv[2]; fs.writeFileSync(f, JSON.stringify(j, null, 2));' "$1/$2" "${3:-$(git -C "$1" rev-parse HEAD)}"
}
# Put a file's mtime clearly after the last commit (newer); a report.json or results.json is also stamped with HEAD.
newer() { # stamp first: rewriting the file after the touch would reset its time to now
  case "$2" in */report.json|*/results.json) stamp_head "$1" "$2" ;; esac
  touch -d "@$(( $(last_ct "$1") + 5 ))" "$1/$2"
}
older() { touch -d "@$(( $(last_ct "$1") - 100 ))" "$1/$2"; }
# ONLY_FORK9=1 starts with the assertions off (SKIPPING), to run the fork.9 section alone while developing.
# TEST_SHARD=<k>/<n> (k from 0) runs only the k-th of every n blocks of 20 assertions; the setup still runs, so n runs in
# parallel cover the suite on a machine where process starts are slow. A test that reads what an earlier assertion wrote
# (a bypass record, say) can fail when its block boundary falls between them: rerun that case unsharded.
SKIPPING="${ONLY_FORK9:+1}"
ASSERT_N=0
skip_case() { # succeeds (skip) when this assertion is not for this run
  [ -n "$SKIPPING" ] && return 0
  [ -n "${TEST_SHARD:-}" ] || return 1
  ASSERT_N=$((ASSERT_N + 1))
  [ $(( (ASSERT_N - 1) / 20 % ${TEST_SHARD#*/} )) -ne "${TEST_SHARD%/*}" ]
}

gates_json() { mkdir -p "$1/.scratch"; printf '{ "slug": "%s", "size": "%s", "base": "main" }\n' "$SLUG" "$2" > "$1/.scratch/gates.json"; }
put() { mkdir -p "$(dirname "$1/$3")"; cp "$fx/$2" "$1/$3"; }
put_live() { put "$1" "$2" ".scratch/live/${3:-run1}/report.json"; newer "$1" ".scratch/live/${3:-run1}/report.json"; }
put_evals() { put "$1" "$2" ".scratch/evals/$SLUG/results.json"; newer "$1" ".scratch/evals/$SLUG/results.json"; }

# Every file a normal run needs, all green.
green_normal() {
  local d="$1" size="${2:-normal}"
  gates_json "$d" "$size"
  put "$d" shape.md ".scratch/shape/$SLUG.md"
  put "$d" envelope.md ".scratch/envelope/$SLUG.md"
  put_live "$d" report-pass.json
  put "$d" review.md ".scratch/review/$SLUG.md"
  put "$d" metrics.md .scratch/loop-metrics.md
}

# Commit a source change (a new file), which makes evidence recorded on the earlier head stale.
commit_src_new() { mkdir -p "$1/src" && printf 'export const n = 1;\n' > "$1/src/new.js" && git -C "$1" add -A && git -C "$1" commit -q -m newsrc; }
# put_review_head <dir>: the review file the code-review stage leaves, naming the head it reviewed (G9 at merge, pr, close).
put_review_head() {
  mkdir -p "$1/.scratch/review"
  printf '# Review\n\n## Findings\n\nHead: %s\n\n| ID | Severity | Status | Resolution |\n|---|---|---|---|\n| F1 | LOW | PLAUSIBLE | open |\n' "$(git -C "$1" rev-parse HEAD)" > "$1/.scratch/review/$SLUG.md"
}
# Commit a file that is not source (stage-detect.mjs: .scratch/, docs/plans/, docs/agents/, docs/adr/, GLOSSARY.md).
commit_doc() { mkdir -p "$1/docs/plans" && printf '# note %s\n' "$RANDOM" > "$1/docs/plans/note.md" && git -C "$1" add -A && git -C "$1" commit -q -m doc; }

# Commit the slop sample on the feature branch.
add_slop() { mkdir -p "$1/src" && cp "$fx/src/slop.js" "$1/src/slop.js" && git -C "$1" add -A && git -C "$1" commit -q -m slop; }

# ---- assertions

# expect <name> <dir> <exit> <needle> <red lines> [gate args...]
# needle: a fixed string the output must contain ("" for none). red lines: how many "Gn red:" lines, or "-" to skip.
expect() {
  local name="$1" dir="$2" want="$3" needle="$4" reds="$5"; shift 5
  local out code got_reds bad=""
  skip_case && return 0
  out="$(cd "$dir" && "$check" "$@" 2>&1)"; code=$?
  got_reds="$(printf '%s\n' "$out" | grep -cE '^(G[0-9]+|PR-[A-Z]+) red:')"
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$out" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  if [ "$reds" != - ] && [ "$got_reds" != "$reds" ]; then bad="${bad:+$bad; }red lines $got_reds, want $reds"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   $name"; else echo "FAIL $name: $bad"; printf '%s\n' "$out" | sed 's/^/       | /'; fail=1; fi
}

# hook_case <name> <cwd> <command> <exit> <stderr needle> [VAR=value...]
hook_case() {
  local name="$1" cwd="$2" cmd="$3" want="$4" needle="$5"; shift 5
  local payload err code bad=""
  skip_case && return 0
  [ -n "${HOOK_NOREADY:-}" ] || ready_repo "$cwd"
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", transcript_path: "/dev/null", cwd: process.argv[1], hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: process.argv[2], description: "test" } }))' "$cwd" "$cmd")"
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$err" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook: $name"; else echo "FAIL hook: $name: $bad"; printf '%s\n' "$err" | sed 's/^/       | /'; fail=1; fi
}

pass_if() { # pass_if <name> <condition command...>
  local name="$1"; shift
  skip_case && return 0
  total=$((total + 1))
  if "$@"; then echo "ok   $name"; else echo "FAIL $name"; fail=1; fi
}

# ---- stage-log helpers (fork.8): the signed log, G9, and the hook tests' "finished loop" fixture

export FEATURE_LOOP_STATE_DIR="$work/state"
# shellcheck source=loop-root.sh
. "$here/loop-root.sh"
PAST=2020-01-01T00:00:00Z; FUTURE=2099-01-01T00:00:00Z
PLANNING="grilling deep-engineering behavioral-envelope to-spec to-tickets"
STAGE_EVENT=PostToolUse

# stage_hook <dir> <tool> <tool_input json> [now]: runs the PostToolUse hook; sets sh_code and sh_err.
stage_hook() {
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", cwd: process.argv[1], hook_event_name: process.argv[4], tool_name: process.argv[2], tool_input: JSON.parse(process.argv[3]) }))' "$1" "$2" "$3" "$STAGE_EVENT")"
  sh_err="$(cd "$work" && printf '%s' "$payload" | env ${4:+FEATURE_LOOP_NOW=$4} bash "$here/stage-hook.sh" post-tool 2>&1 >/dev/null)"; sh_code=$?
}
log_skill() { stage_hook "$1" Skill "{\"skill\":\"$2\"}" "${3:-$PAST}"; }
log_agent() { stage_hook "$1" Agent "{\"subagent_type\":\"general-purpose\",\"model\":\"$2\",\"description\":\"${4:-design challenge}\"}" "${3:-$PAST}"; }
log_many() { local d="$1" s; shift; for s in "$@"; do log_skill "$d" "$s"; done; }
# The SessionStart hook: records where the session began (outside the repo) and starts the loop when there is one.
session_start() {
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", cwd: process.argv[1], hook_event_name: "SessionStart" }))' "$1")"
  (cd "$work" && printf '%s' "$payload" | bash "$here/stage-hook.sh" init >/dev/null 2>&1)
}
init_loop() { stage_hook "$1" Bash '{"command":"ls"}'; }
state_file() { node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then((m) => { const r = m.readState(process.argv[2]); process.stdout.write(r ? r.path : ""); })' "$here/stage-log.mjs" "$1"; }
sign_close() { node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then((m) => { m.appendEntry(process.argv[2], { kind: "close", ts: new Date().toISOString(), slug: "x" }); })' "$here/stage-log.mjs" "$1"; }
log_of() { printf '%s' "$1/.scratch/.loop/log.jsonl"; }

# A loop with no detection: a typed /skill is logged without looking at the tree.
expand_skill() {
  local payload
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", cwd: process.argv[1], hook_event_name: "UserPromptExpansion", expansion_type: "slash_command", command_name: process.argv[2] }))' "$1" "$2")"
  (cd "$work" && printf '%s' "$payload" | env "FEATURE_LOOP_NOW=${3:-$PAST}" bash "$here/stage-hook.sh" prompt-expansion >/dev/null 2>&1)
}

# ready_repo <dir>: the signed log a finished loop leaves, for the hook tests that predate G9 (the push and merge hooks
# make G9 mandatory). Skips a repo with no active loop, a closed loop, an unreadable gates.json or a loop already started.
ready_repo() {
  local d
  d="$(loop_root "$1")" || return 0 # none, or closed; a builder worktree resolves to the main worktree
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$d/.scratch/gates.json" 2>/dev/null || return 0
  [ -f "$(log_of "$d")" ] && return 0
  local s
  session_start "$d"
  for s in $PLANNING; do expand_skill "$d" "$s"; done
  for s in code-review live-verify adversarial-review wp-loop retro; do expand_skill "$d" "$s" "$FUTURE"; done
  if grep -q '"size"[[:space:]]*:[[:space:]]*"large"' "$d/.scratch/gates.json"; then
    mkdir -p "$d/.scratch/design-challenge"; printf '## Findings\n\n- none\n' > "$d/.scratch/design-challenge/$SLUG.md"
    log_agent "$d" opus "2010-01-01T00:00:00Z"
  fi
}

# A repo on a feature branch with nothing changed yet, and a started loop of the given size on it.
loop_repo() {
  local d="$work/$1"
  mkdir -p "$d"
  (
    cd "$d" || exit 1
    git init -q -b main
    printf '.scratch/\n' > .gitignore
    printf '# demo\n' > README.md
    git add -A && git commit -q -m base
    git checkout -q -b feature
  ) || { echo "FAIL could not build repo $1"; exit 1; }
  gates_json "$d" "$2"
  init_loop "$d"
  printf '%s' "$d"
}
write_src() { mkdir -p "$1/src" && printf 'export const x = %s;\n' "${2:-1}" > "$1/src/a.js"; }
commit_src() { write_src "$1" "${2:-1}"; git -C "$1" add -A && git -C "$1" commit -q -m src; }

# ---- check-gates.sh

d=$(new_repo none)
expect "no gates.json: not running" "$d" 0 "gates: not running the feature loop (no .scratch/gates.json)" 0

d=$(new_repo small)
gates_json "$d" small
put "$d" envelope.md ".scratch/envelope/$SLUG.md"
put_live "$d" report-pass.json
expect "small: all green" "$d" 0 "gates: green for reply-options (size small): 3 green, 0 red, 5 n/a" 0
expect "small: G1 is n/a" "$d" 0 "G1 n/a: applies to normal and large only, size is small" 0

d=$(new_repo normal); green_normal "$d"
expect "normal: all green" "$d" 0 "gates: green for reply-options (size normal): 6 green, 0 red, 2 n/a" 0
expect "normal: G4 n/a without llm or retrieval" "$d" 0 "G4 n/a: envelope Packs names neither llm nor retrieval" 0
mkdir -p "$d/src/deep"
expect "normal: run from a subdirectory" "$d/src/deep" 0 "gates: green" 0

d=$(new_repo large-llm); green_normal "$d" large
put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-ok.json
expect "large with llm pack and passing evals: all green" "$d" 0 "G4 green" 0

d=$(new_repo no-llm-words); green_normal "$d"
put "$d" envelope-no-llm-words.md ".scratch/envelope/$SLUG.md"
expect "Packs saying 'no llm, no retrieval' needs no evals" "$d" 0 "G4 n/a" 0

d=$(new_repo g1-missing); green_normal "$d"; rm "$d/.scratch/shape/$SLUG.md"
expect "G1 red: shape missing (G3 cannot check coverage either)" "$d" 1 "G1 red: shape file missing (.scratch/shape/reply-options.md)" 2
expect "G1 red: shape missing, filtered to G1" "$d" 1 "G1 red: shape file missing" 1 G1

d=$(new_repo g1-no-ids); green_normal "$d"; put "$d" shape-no-ids.md ".scratch/shape/$SLUG.md"
expect "G1 red: shape without case IDs" "$d" 1 "G1 red: no journey case ID like J3.two-actors (.scratch/shape/reply-options.md)" 1

d=$(new_repo g2-missing); green_normal "$d"; rm "$d/.scratch/envelope/$SLUG.md"
expect "G2 red: envelope missing (G4 fails closed too)" "$d" 1 "G2 red: envelope file missing (.scratch/envelope/reply-options.md)" 2

d=$(new_repo g2-proof); green_normal "$d"; put "$d" envelope-empty-proof.md ".scratch/envelope/$SLUG.md"
expect "G2 red: Live row with empty Proof" "$d" 1 "G2 red: Live rows not filled: API-03 (Proof empty) (.scratch/envelope/reply-options.md)" 1

d=$(new_repo g2-tbd); green_normal "$d"; put "$d" envelope-tbd.md ".scratch/envelope/$SLUG.md"
expect "G2 red: Live row with TBD" "$d" 1 "G2 red: Live rows not filled: OUT-01 (Mechanism TBD)" 1

d=$(new_repo g2-packs); green_normal "$d"
sed 's/^\*\*Packs:\*\*.*$/**Packs:**/' "$fx/envelope.md" > "$d/.scratch/envelope/$SLUG.md"
expect "G2 red: empty Packs line" "$d" 1 "G2 red: **Packs:** line is empty" 1

# The Live table with its header and separator but no rows.
empty_live() { grep -vE '^\s*\|?\s*(OUT-01|API-03)\b' "$fx/envelope.md" > "$1/.scratch/envelope/$SLUG.md"; }

d=$(new_repo g2-empty-normal); green_normal "$d"; empty_live "$d"
expect "G2 red: empty Live table on a normal change" "$d" 1 "G2 red: Live table empty on a normal or large change (.scratch/envelope/reply-options.md)" 1

d=$(new_repo g2-empty-large); green_normal "$d" large; empty_live "$d"
expect "G2 red: empty Live table on a large change" "$d" 1 "G2 red: Live table empty on a normal or large change" 1

d=$(new_repo g2-empty-small); gates_json "$d" small; mkdir -p "$d/.scratch/envelope"; empty_live "$d"
expect "G2 green: empty Live table on a small change" "$d" 0 "G2 green" 0 G2

d=$(new_repo g3-none); green_normal "$d"; rm -r "$d/.scratch/live"
expect "G3 red: no live run" "$d" 1 "G3 red: no live run (.scratch/live/<run>/report.json)" 1

d=$(new_repo g3-fail); green_normal "$d"; put_live "$d" report-fail.json
expect "G3 red: failed scenario" "$d" 1 "G3 red: 1 scenario not passing: two reviewers race [fail] (.scratch/live/run1/report.json)" 1

d=$(new_repo g3-old); green_normal "$d"; commit_src_new "$d"
expect "G3 red: live report is for an older head and source changed since (no mtime involved)" "$d" 1 "G3 red: live run ran on" 1
expect "G3 red: the message names the changed source" "$d" 1 "source changed since (src/new.js)" 1
expect "G3 red: and says how to fix it" "$d" 1 "rerun live-verify (the runner records \"head\" in report.json)" 1
d=$(new_repo g3-nonsource); green_normal "$d"; commit_doc "$d"
expect "G3 green: HEAD moved only by a non-source file (docs/plans), the report is still fresh" "$d" 0 "G3 green" 0 G3
d=$(new_repo g3-newfile-older); green_normal "$d"; touch -d "@$(( $(last_ct "$d") - 100 ))" "$d/.scratch/live/run1/report.json"
expect "G3 green: an old file time does not matter, the head does" "$d" 0 "G3 green" 0 G3
d=$(new_repo g3-nohead); green_normal "$d"; printf '{ "runId": "r1", "scenarios": [ { "name": "a", "journey": "J1.first-run J2.two-actors", "result": "pass" } ] }\n' > "$d/.scratch/live/run1/report.json"
expect "G3 red: a report with no head is red" "$d" 1 "G3 red: live run names no commit (head is missing or not a sha)" 1
d=$(new_repo g3-badhead); green_normal "$d"; stamp_head "$d" .scratch/live/run1/report.json deadbeefdeadbeef
expect "G3 red: a head that is not a commit of the repo is red" "$d" 1 "which is not a commit of this repository" 1
d=$(new_repo g3-dirty); green_normal "$d"; printf 'export const y = 2;\n' > "$d/src/edited.js"
expect "G3 red: uncommitted source edits mean the run was on a different tree" "$d" 1 "source is edited since (uncommitted: src/edited.js)" 1
d=$(new_repo g3-other-branch); green_normal "$d"; sha0=$(git -C "$d" rev-parse HEAD); git -C "$d" checkout -q -b other main
expect "G3 red: a head that is not an ancestor of HEAD is red" "$d" 1 "which is not an ancestor of HEAD" 1

d=$(new_repo g3-case); green_normal "$d"; put_live "$d" report-missing-case.json
expect "G3 red: journey case missing from report" "$d" 1 "G3 red: journey cases in no scenario: J2.two-actors" 1

d=$(new_repo g3-newest); green_normal "$d"
put "$d" report-fail.json .scratch/live/run0/report.json; touch -d "@$(( $(last_ct "$d") + 2 ))" "$d/.scratch/live/run0/report.json"
expect "G3 green: an older failed run is ignored, the newest passes" "$d" 0 "G3 green" 0

d=$(new_repo g4-missing); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 red: llm pack without eval results" "$d" 1 "G4 red: eval results missing (.scratch/evals/reply-options/results.json)" 1

d=$(new_repo g4-bad); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-bad.json
expect "G4 red: eval gate ok:false" "$d" 1 "G4 red: eval gates not ok: pass.lo>=0.8 (.scratch/evals/reply-options/results.json)" 1

d=$(new_repo g4-old); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-ok.json
commit_src_new "$d"
expect "G4 red: eval results are for an older head and source changed since (no mtime involved)" "$d" 1 "G4 red: eval results ran on" 1 G4
d=$(new_repo g4-nohead); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put "$d" evals-ok.json ".scratch/evals/$SLUG/results.json"
expect "G4 red: results.json with no head is red" "$d" 1 "G4 red: eval results names no commit" 1
d=$(new_repo g4-nonsource); green_normal "$d"; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"; put_evals "$d" evals-ok.json; commit_doc "$d"
expect "G4 green: HEAD moved only by a non-source file" "$d" 0 "G4 green" 0 G4

d=$(new_repo g4-small); gates_json "$d" small; put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 applies to small work with the llm pack" "$d" 1 "G4 red: eval results missing" 1 G4

d=$(new_repo g5); green_normal "$d"; put "$d" review-open-high.md ".scratch/review/$SLUG.md"
expect "G5 red: open CONFIRMED HIGH finding" "$d" 1 "G5 red: open CONFIRMED finding: F1 HIGH (.scratch/review/reply-options.md)" 1

d=$(new_repo g5-missing); green_normal "$d"; rm "$d/.scratch/review/$SLUG.md"
expect "G5 red: review missing" "$d" 1 "G5 red: review file missing" 1 G5

d=$(new_repo g6-open); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
expect "G6 red: slop findings not justified" "$d" 1 "G6 red: slop findings not justified under ## Justified: CRAFT-06.todo src/slop.js:2, CRAFT-06.debug-output src/slop.js:3 (.scratch/review/reply-options.md)" 1

d=$(new_repo g6-ok); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
put "$d" review-justified.md ".scratch/review/$SLUG.md"
expect "G6 green: every finding justified with a reason" "$d" 0 "G6 green" 0

d=$(new_repo g6-noreason); green_normal "$d"; add_slop "$d"; newer "$d" .scratch/live/run1/report.json
put "$d" review-justified-no-reason.md ".scratch/review/$SLUG.md"
expect "G6 red: a justification without a reason does not count" "$d" 1 "not justified under ## Justified: CRAFT-06.todo src/slop.js:2 (" 1

d=$(new_repo g6-uncommitted); green_normal "$d"; cp "$fx/src/slop.js" "$d/src/slop.js"
expect "G6 red: uncommitted slop counts too" "$d" 1 "CRAFT-06.todo src/slop.js:2" 1 G6

d=$(new_repo g7); green_normal "$d"; printf '# Loop metrics\n\n2026-10-01 other-feature: 1 finding\n' > "$d/.scratch/loop-metrics.md"
expect "G7 red: no metrics line" "$d" 1 "G7 red: no metrics line containing reply-options (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-bypass); green_normal "$d"; put "$d" metrics-bypass-only.md .scratch/loop-metrics.md
expect "G7 red: a bypass record is not a metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1

# G7 floor: CONFIRMED findings need escapes=<n> floors=<m> on the metrics line, with m >= n.
d=$(new_repo g7-nofloor); green_normal "$d"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 red: CONFIRMED findings but no escapes/floors" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m> (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-escapes-only); green_normal "$d"; put "$d" metrics-escapes-only.md .scratch/loop-metrics.md
expect "G7 red: escapes without floors" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m>" 1

d=$(new_repo g7-low); green_normal "$d"; put "$d" metrics-floor-low.md .scratch/loop-metrics.md
expect "G7 red: floors below escapes" "$d" 1 "G7 red: floors=1 is below escapes=2, so an escape raised no floor (a check, pack item, scenario or eval case) (.scratch/loop-metrics.md)" 1

d=$(new_repo g7-floor-ok); green_normal "$d"; put "$d" metrics-floor.md .scratch/loop-metrics.md
expect "G7 green: floors above escapes" "$d" 0 "G7 green" 0

d=$(new_repo g7-nothing-confirmed); green_normal "$d"; put "$d" review-plausible.md ".scratch/review/$SLUG.md"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 green: no CONFIRMED finding needs no floor" "$d" 0 "G7 green" 0 G7

d=$(new_repo g7-no-review); green_normal "$d"; rm "$d/.scratch/review/$SLUG.md"; put "$d" metrics-no-floor.md .scratch/loop-metrics.md
expect "G7 green: no review file, today's rule only" "$d" 0 "G7 green" 0 G7

# G8 ledger: applies to every size once .scratch/loop-status.md exists.
d=$(new_repo g8-na); green_normal "$d"
expect "G8 n/a: no loop-status.md" "$d" 0 "G8 n/a: no .scratch/loop-status.md" 0 G8

d=$(new_repo g8-ok); green_normal "$d"; put "$d" loop-status.md .scratch/loop-status.md
expect "G8 green: done rows carry measured: or inferred: evidence" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-running); green_normal "$d"; put "$d" loop-status-running.md .scratch/loop-status.md
expect "G8 green: a running row is the Stop hook's business" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-columns); green_normal "$d"; put "$d" loop-status-columns.md .scratch/loop-status.md
expect "G8 green: columns found by name, any order, any case" "$d" 0 "G8 green" 0 G8

d=$(new_repo g8-noevidence); green_normal "$d"; put "$d" loop-status-no-evidence.md .scratch/loop-status.md
expect "G8 red: done without evidence or with unmarked evidence" "$d" 1 'G8 red: done stage without evidence (measured:, inferred: or assumed:): 1 shape (empty), 2 behavioral-envelope ("looks fine to me") (.scratch/loop-status.md)' 1 G8

d=$(new_repo g8-assumed); green_normal "$d"; put "$d" loop-status-assumed.md .scratch/loop-status.md
expect "G8 red: a stage cannot be done on an assumption" "$d" 1 "G8 red: a stage cannot be done on an assumption: 2 live-verify (.scratch/loop-status.md)" 1 G8

d=$(new_repo g8-small); gates_json "$d" small; put "$d" loop-status-no-evidence.md .scratch/loop-status.md
expect "G8 applies to small work too" "$d" 1 "G8 red: done stage without evidence" 1 G8

d=$(new_repo g8-notable); green_normal "$d"; printf '# Loop status\n\nnothing yet\n' > "$d/.scratch/loop-status.md"
expect "G8 red: loop-status.md without a stage table" "$d" 1 "G8 red: no stage table with Status and Evidence columns (.scratch/loop-status.md)" 1 G8

d=$(new_repo g8-all); green_normal "$d"; put "$d" loop-status.md .scratch/loop-status.md
expect "G8 counted in the summary" "$d" 0 "gates: green for reply-options (size normal): 7 green, 0 red, 1 n/a" 0

# Gate-name filtering and usage.
d=$(new_repo filter); green_normal "$d"; rm "$d/.scratch/shape/$SLUG.md"
expect "filter: G2 G6 ignore a red G1" "$d" 0 "gates: green for reply-options (size normal): 2 green, 0 red, 0 n/a" 0 G2 G6
out="$(cd "$d" && "$check" G2 G6)"
pass_if "filter: prints only the named gates" test "$(printf '%s\n' "$out" | grep -cE '^G[1-8] ')" = 2
expect "filter: lowercase g1 accepted" "$d" 1 "G1 red: shape file missing" 1 g1
expect "usage: unknown gate G13" "$d" 2 "unknown argument: G13" 0 G13
expect "usage: unknown flag" "$d" 2 "unknown argument: --bogus" 0 --bogus
expect "usage: --help" "$d" 0 "Usage (run from the target repo's root)" 0 --help

d=$(new_repo bad-size); gates_json "$d" huge
expect "invalid gates.json: bad size" "$d" 2 'size" must be small, normal or large' 0
d=$(new_repo bad-slug); mkdir -p "$d/.scratch"; printf '{ "slug": "../etc", "size": "normal", "base": "main" }\n' > "$d/.scratch/gates.json"
expect "invalid gates.json: slug with a path" "$d" 2 '"slug" must be a plain name' 0
d=$(new_repo bad-json); mkdir -p "$d/.scratch"; printf '{ nope' > "$d/.scratch/gates.json"
expect "invalid gates.json: not JSON" "$d" 2 "invalid .scratch/gates.json" 0

# ---- G3 at every size, the live waiver and the optional run-file fields (fork.6)

# gates_json_with <dir> <size> <extra JSON members, for example '"evals": "smoke"'>
gates_json_with() { mkdir -p "$1/.scratch"; printf '{ "slug": "%s", "size": "%s", "base": "main", %s }\n' "$SLUG" "$2" "$3" > "$1/.scratch/gates.json"; }

d=$(new_repo g3-small-none); gates_json "$d" small; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "G3 applies to small work: no live run is red" "$d" 1 "G3 red: no live run" 1 G3
expect "small merge phase includes G3" "$d" 1 "G3 red: no live run" 1 --phase merge
put_live "$d" report-missing-case.json
expect "G3 small: happy path only, no journey coverage needed" "$d" 0 "G3 green" 0 G3
put_live "$d" report-fail.json run2
expect "G3 small: a failing scenario is still red" "$d" 1 "1 scenario not passing" 1 G3
d=$(new_repo g3-small-stale); gates_json "$d" small; put_live "$d" report-pass.json; commit_src_new "$d"
expect "G3 small: a live run on an older head with source changed since is red" "$d" 1 "source changed since" 1 G3
d=$(new_repo g3-normal-cov); green_normal "$d"; put_live "$d" report-missing-case.json
expect "G3 normal: journey coverage still required" "$d" 1 "journey cases in no scenario" 1 G3

d=$(new_repo waiver-small); gates_json_with "$d" small '"live": "none: docs-only change, nothing runs"'
expect "live waiver on small work: G3 n/a with the reason" "$d" 0 "G3 n/a: live run waived in .scratch/gates.json: docs-only change, nothing runs" 0 G3
d=$(new_repo waiver-normal); gates_json_with "$d" normal '"live": "none: too slow"'
expect "live waiver refused on normal work" "$d" 2 '"live": "none: ..." is only allowed on small work' 0
d=$(new_repo waiver-large); gates_json_with "$d" large '"live": "none: too slow"'
expect "live waiver refused on large work" "$d" 2 'only allowed on small work' 0
d=$(new_repo waiver-noreason); gates_json_with "$d" small '"live": "none:"'
expect "live waiver needs a reason" "$d" 2 '"live" must be "none: <reason>"' 0
d=$(new_repo waiver-word); gates_json_with "$d" small '"live": "skip"'
expect "live waiver must start with none:" "$d" 2 '"live" must be "none: <reason>"' 0
d=$(new_repo waiver-type); gates_json_with "$d" small '"live": false'
expect "live waiver must be a string" "$d" 2 '"live" must be "none: <reason>"' 0

d=$(new_repo evals-smoke); gates_json_with "$d" small '"evals": "smoke", "max_builders": 3'
put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "evals smoke and max_builders 3 are valid" "$d" 0 "G2 green" 0 G2
d=$(new_repo evals-full); gates_json_with "$d" small '"evals": "full"'
put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "evals full is valid" "$d" 0 "G2 green" 0 G2
d=$(new_repo evals-bad); gates_json_with "$d" small '"evals": "some"'
expect "evals must be smoke or full" "$d" 2 '"evals" must be smoke or full' 0
for mb in 0 9 2.5 '"3"'; do
  d=$(new_repo "mb-bad-$RANDOM"); gates_json_with "$d" small "\"max_builders\": $mb"
  expect "max_builders $mb is refused" "$d" 2 '"max_builders" must be a whole number from 1 to 8' 0
done

for bad in '"tomorrow"' '"2026-10-12"' '"2026-10-12T17:00:00"' '"2026-13-12T17:00:00Z"' '"2026-02-30T10:00:00Z"' '"2026-10-12T24:00:00Z"' '"2026-10-12T17:00:00+15:00"' 5; do
  d=$(new_repo "demo-bad-$RANDOM"); gates_json_with "$d" small "\"demo_by\": $bad"
  expect "demo_by $bad is refused" "$d" 2 '"demo_by" must be an ISO 8601 time with a zone' 0
done

d=$(new_repo started-bad); gates_json_with "$d" small '"started": "2026-02-29T10:00:00Z"'
expect "started is validated like demo_by (2026 has no February 29)" "$d" 2 '"started" must be an ISO 8601 time with a zone' 0
d=$(new_repo started-ok); gates_json_with "$d" small '"started": "2028-02-29T10:00:00Z"'; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "a real leap day is accepted" "$d" 0 "G2 green" 0 G2
d=$(new_repo unknown-key); gates_json_with "$d" small '"demoBy": "2026-10-12T17:00:00Z", "Live": "none: x"'
expect "a misspelt field is refused, not ignored" "$d" 2 'unknown fields "demoBy", "Live"' 0
d=$(new_repo known-keys); gates_json_with "$d" small '"merge_check": "true", "evals": "smoke", "max_builders": 2, "started": "2026-10-12T09:00:00-04:00", "demo_by": "2026-10-12T17:00:00-04:00", "live": "none: docs"'
put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "every known field together is accepted" "$d" 0 "G3 n/a: live run waived" 0 G3

# ---- check-gates.sh --timebox

# tb_case <name> <dir> <exit> <needle> [VAR=value...]
tb_case() {
  local name="$1" dir="$2" want="$3" needle="$4"; shift 4
  skip_case && return 0
  local out code bad="" envs=() extra=()
  for a in "$@"; do case "$a" in *=*) envs+=("$a") ;; *) extra+=("$a") ;; esac; done
  out="$(cd "$dir" && env ${envs[@]+"${envs[@]}"} "$check" --timebox ${extra[@]+"${extra[@]}"} 2>&1)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  printf '%s\n' "$out" | grep -qF -- "$needle" || bad="${bad:+$bad; }missing: $needle"
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   timebox: $name"; else echo "FAIL timebox: $name: $bad"; printf '%s\n' "$out" | sed 's/^/       | /'; fail=1; fi
}
DUE='2026-10-12T17:00:00-04:00'
d=$(new_repo tb-none); gates_json "$d" small
tb_case "no demo_by: nothing to enforce" "$d" 0 'time box: none'
d=$(new_repo tb-run); gates_json_with "$d" small "\"started\": \"2020-01-01T00:00:00Z\", \"demo_by\": \"$DUE\""
tb_case "before the deadline with no live run: running, with minutes left" "$d" 0 'time box: 60 min left' FEATURE_LOOP_NOW=2026-10-12T16:00:00-04:00
tb_case "past the deadline with no live run: overdue, exit 1" "$d" 1 'time box: OVERDUE by 30 min' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
tb_case "overdue says what to do" "$d" 1 'Stop starting review, eval or hardening work' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
put_live "$d" report-fail.json
tb_case "a failing live run does not meet the time box" "$d" 1 'OVERDUE' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
put_live "$d" report-pass.json run2
tb_case "a passing live run meets the time box, even late" "$d" 0 'time box: met, a passing live run is recorded (.scratch/live/run2/report.json)' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00
printf '{ "runId": "e", "scenarios": [] }\n' > "$d/.scratch/live/run2/report.json"; touch -d "@$(( $(date +%s) + 60 ))" "$d/.scratch/live/run2/report.json"
tb_case "a newest live run with no scenarios does not meet the time box" "$d" 1 'OVERDUE' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00

d=$(new_repo tb-before-start); gates_json_with "$d" small "\"started\": \"2099-01-01T00:00:00Z\", \"demo_by\": \"$DUE\""; put_live "$d" report-pass.json
tb_case "a passing run from before the loop started does not count" "$d" 1 'OVERDUE' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00
d=$(new_repo tb-mtime); gates_json_with "$d" small "\"demo_by\": \"$DUE\""
put "$d" report-pass.json .scratch/live/old/report.json; touch -d "@$(( $(date +%s) - 3600 ))" "$d/.scratch/live/old/report.json"
tb_case "without started, a run older than gates.json does not count" "$d" 1 'OVERDUE' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00
put "$d" report-pass.json .scratch/live/new/report.json; touch -d "@$(( $(date +%s) + 60 ))" "$d/.scratch/live/new/report.json"
tb_case "without started, a run newer than gates.json counts" "$d" 0 'time box: met' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00
d=$(new_repo tb-waived); gates_json_with "$d" small "\"live\": \"none: docs only\", \"demo_by\": \"$DUE\""
tb_case "a waived live run has no time box" "$d" 0 'time box: n/a, the live run is waived in .scratch/gates.json (docs only)' FEATURE_LOOP_NOW=2026-10-12T19:00:00-04:00
tb_case "--timebox refuses gate IDs" "$d" 2 '--timebox checks only the time box' G3
tb_case "--timebox refuses a phase" "$d" 2 '--timebox checks only the time box' --phase merge

d=$(new_repo tb-zone); gates_json_with "$d" small '"demo_by": "2026-10-12T21:00:00Z"'
tb_case "zones compare as instants" "$d" 1 'OVERDUE by 30 min' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
d=$(new_repo tb-closed); mkdir -p "$d/.scratch"; printf '{ "slug": "%s", "size": "small", "base": "main", "status": "closed", "demo_by": "2020-01-01T00:00:00Z" }\n' "$SLUG" > "$d/.scratch/gates.json"
tb_case "a closed loop has no time box" "$d" 0 'loop closed'
d=$(new_repo tb-noloop)
tb_case "no loop: nothing to check" "$d" 0 'not running the feature loop'

# ---- gate-hook.sh

red_repo=$(new_repo hook-red); green_normal "$red_repo"; rm "$red_repo/.scratch/shape/$SLUG.md"
green_repo=$(new_repo hook-green); green_normal "$green_repo"
plain_repo=$(new_repo hook-plain)
outside="$work/outside"; mkdir -p "$outside"

hook_case "unrelated command passes" "$red_repo" "ls -la src" 0 ""
hook_case "commit message mentioning push passes" "$red_repo" 'git commit -m "push the fix later"' 0 ""
hook_case "git push blocked when red" "$red_repo" "git push -u origin feature" 2 "G1 red: shape file missing"
hook_case "block message says how to bypass" "$red_repo" "git push" 2 "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON="
hook_case "git -C <repo> push from elsewhere blocked" "$outside" "git -C $red_repo push" 2 "G1 red"
hook_case "cd <repo> && git push blocked" "$outside" "cd $red_repo && git push origin HEAD" 2 "G1 red"
hook_case "bash -c 'git push' blocked" "$red_repo" "bash -c 'git push origin feature'" 2 "G1 red"
hook_case "git push --dry-run passes" "$red_repo" "git push --dry-run" 0 ""
hook_case "gh pr create blocked when red" "$red_repo" 'gh pr create --title "x" --body "y"' 2 "G1 red"
hook_case "gh api POST to pulls blocked when red" "$red_repo" "gh api repos/o/r/pulls -f title=x -f head=feature -f base=main" 2 "G1 red"
hook_case "gh api -X POST /pulls blocked when red" "$red_repo" "gh api -X POST /repos/o/r/pulls --input body.json" 2 "G1 red"
hook_case "gh api GET pulls passes" "$red_repo" "gh api repos/o/r/pulls" 0 ""
hook_case "gh api POST to a PR comment passes" "$red_repo" "gh api repos/o/r/pulls/3/comments -f body=hi" 0 ""
hook_case "git push allowed when green" "$green_repo" "git push origin feature" 0 ""
hook_case "git push allowed without gates.json" "$plain_repo" "git push origin feature" 0 ""
hook_case "bypass without reason still blocked" "$red_repo" "git push" 2 "without FEATURE_LOOP_BYPASS_REASON" FEATURE_LOOP_GATES=off
hook_case "bypass with blank reason still blocked" "$red_repo" "git push" 2 "G1 red" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=   "
hook_case "bypass with reason allowed" "$red_repo" "git push" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=demo deadline"
pass_if "bypass logged in loop-metrics.md" grep -qE "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}Z reply-options gates bypassed: demo deadline$" "$red_repo/.scratch/loop-metrics.md"
hook_case "inline bypass in the command allowed" "$red_repo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='CI is down, approved by lead' git push" 0 ""
pass_if "inline bypass logged" grep -qF "reply-options gates bypassed: CI is down, approved by lead" "$red_repo/.scratch/loop-metrics.md"
hook_case "inline off without reason still blocked" "$red_repo" "FEATURE_LOOP_GATES=off git push" 2 "without FEATURE_LOOP_BYPASS_REASON"
payload='{"tool_name":"Write","cwd":"'"$red_repo"'","tool_input":{"file_path":"x","content":"git push"}}'
code=0; printf '%s' "$payload" | bash "$hook" >/dev/null 2>&1 || code=$?
pass_if "hook: a Write tool payload is never gated" test "$code" = 0

# ---- gate-hook.sh: commit gate

# A repo on the feature branch with gates.json and src/slop.js staged (not committed).
staged_repo() { local d; d=$(new_repo "$1"); gates_json "$d" normal; cp "$fx/src/slop.js" "$d/src/slop.js"; git -C "$d" add src/slop.js; printf '%s' "$d"; }
no_staged() { [ -z "$(git -C "$1" diff --cached --name-only)" ]; }

crepo=$(staged_repo commit-staged)
hook_case "commit blocked when the staged lines are slop" "$crepo" 'git commit -m "add slop"' 2 "src/slop.js:2"
hook_case "commit block names the fix and the bypass" "$crepo" 'git commit -m x' 2 'Fix: remove each finding, or list its file:line with a reason under "## Justified" in .scratch/review/reply-options.md'
hook_case "commit block says how to bypass" "$crepo" 'git commit -m x' 2 "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON="
hook_case "git -C <repo> commit from elsewhere blocked" "$outside" "git -C $crepo commit -m x" 2 "src/slop.js:2"
hook_case "cd <repo> && git commit blocked" "$outside" "cd $crepo && git commit -m x" 2 "src/slop.js:2"
hook_case "commit chained after another command blocked" "$crepo" "echo hi; git commit -m x && echo done" 2 "src/slop.js:2"
hook_case "git commit --dry-run passes" "$crepo" "git commit --dry-run" 0 ""
hook_case "git status passes" "$crepo" "git status" 0 ""
pass_if "commit hook leaves the real index alone" test "$(git -C "$crepo" diff --cached --name-only)" = "src/slop.js"

jrepo=$(staged_repo commit-justified); put "$jrepo" review-justified.md ".scratch/review/$SLUG.md"
hook_case "commit allowed when every finding is justified with a reason" "$jrepo" "git commit -m x" 0 ""
nrepo=$(staged_repo commit-noreason); put "$nrepo" review-justified-no-reason.md ".scratch/review/$SLUG.md"
hook_case "commit blocked when a justification has no reason" "$nrepo" "git commit -m x" 2 "src/slop.js"

prepo=$(new_repo commit-plain); cp "$fx/src/slop.js" "$prepo/src/slop.js"; git -C "$prepo" add src/slop.js
hook_case "commit never blocked without gates.json" "$prepo" "git commit -m x" 0 ""

urepo=$(new_repo commit-unstaged); gates_json "$urepo" normal; cp "$fx/src/slop.js" "$urepo/src/slop.js"
hook_case "untracked slop is not part of a plain commit" "$urepo" "git commit -m x" 0 ""
hook_case "git add -A && git commit sees what the add will stage" "$urepo" 'git add -A && git commit -m "x"' 2 "src/slop.js:2"
hook_case "git add <clean file> && git commit passes" "$urepo" 'git add src/clean.js && git commit -m "x"' 0 ""
hook_case "git add <slop file>; git commit blocked" "$urepo" 'git add src/slop.js; git commit -m "x"' 2 "src/slop.js:2"
pass_if "chained add leaves the real index alone" no_staged "$urepo"

arepo=$(new_repo commit-all); gates_json "$arepo" normal
printf 'export const f = () => { console.log("hi"); };\n' >> "$arepo/src/clean.js"
hook_case "commit without -a ignores unstaged edits" "$arepo" "git commit -m x" 0 ""
hook_case "git commit -am sees tracked edits" "$arepo" 'git commit -am "x"' 2 "src/clean.js"
hook_case "git commit -a -m sees tracked edits" "$arepo" 'git commit -a -m "x"' 2 "src/clean.js"
hook_case "git commit --all sees tracked edits" "$arepo" 'git commit --all -m "x"' 2 "src/clean.js"
hook_case "a -a inside the message is not the flag" "$arepo" 'git commit -m "-a"' 0 ""
pass_if "commit -a leaves the real index alone" no_staged "$arepo"

hook_case "commit bypass without reason still blocked" "$crepo" "git commit -m x" 2 "without FEATURE_LOOP_BYPASS_REASON" FEATURE_LOOP_GATES=off
hook_case "commit bypass with reason allowed" "$crepo" "git commit -m x" 0 "" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=spike branch"
pass_if "commit bypass logged" grep -qE "^[0-9T:Z-]+ reply-options gates bypassed: spike branch \(commit\)$" "$crepo/.scratch/loop-metrics.md"
hook_case "inline commit bypass allowed" "$crepo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON='wip checkpoint' git commit -m x" 0 ""
hook_case "a bypass on the commit does not cover a later push" "$red_repo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=cp git commit -m x && git push" 2 "G1 red"

# ---- gate-hook.sh: merge gate

bin="$work/bin"; mkdir -p "$bin"
cat > "$bin/gh" <<'STUB'
#!/usr/bin/env bash
# Stand-in for gh: FAKE_GH_HEAD is the PR head, FAKE_GH_REQUIRED / FAKE_GH_CHECKS the exit codes of
# `gh pr checks --required` / `gh pr checks`, FAKE_GH_VIEW_FAIL makes `gh pr view` fail, FAKE_GH_LOG records calls.
[ -n "${FAKE_GH_LOG:-}" ] && printf '%s\n' "$*" >> "$FAKE_GH_LOG"
case "$1 $2" in
  "pr view") if [ -n "${FAKE_GH_VIEW_FAIL:-}" ]; then echo "HTTP 502" >&2; exit 1; fi; echo "${FAKE_GH_HEAD:-}"; exit 0 ;;
  "pr checks")
    for a in "$@"; do if [ "$a" = --required ]; then exit "${FAKE_GH_REQUIRED:-1}"; fi; done
    echo "build	fail	1m"; exit "${FAKE_GH_CHECKS:-1}" ;;
  "workflow list")
    # fork.9.1: the CI workflows of the repository (merge_check counts only when there are none): FAKE_GH_WORKFLOWS is how many.
    if [ -n "${FAKE_GH_API_FAIL:-}" ]; then echo "HTTP 401" >&2; exit 1; fi
    if [ "${FAKE_GH_WORKFLOWS:-1}" = 0 ]; then echo '[]'; else echo '[{"id":1}]'; fi
    exit 0 ;;
  "run list")
    # fork.9 pr phase: FAKE_GH_RUNS is the JSON `gh run list --commit <sha> --json conclusion,status` prints.
    if [ -n "${FAKE_GH_RUN_FAIL:-}" ]; then echo "HTTP 502" >&2; exit 1; fi
    echo "${FAKE_GH_RUNS:-[]}"; exit 0 ;;
esac
exit 1
STUB
chmod +x "$bin/gh"
gh_env=("PATH=$bin:$PATH")

mrepo=$(new_repo merge-green); green_normal "$mrepo"
sha=$(git -C "$mrepo" rev-parse HEAD); short=${sha:0:9}
mlog="$work/gh.log"
mred=$(new_repo merge-red); green_normal "$mred"; rm "$mred/.scratch/shape/$SLUG.md"; msha=$(git -C "$mred" rev-parse HEAD)
smrepo=$(new_repo merge-small); gates_json "$smrepo" small; put "$smrepo" envelope.md ".scratch/envelope/$SLUG.md"; put_live "$smrepo" report-pass.json
ssha=$(git -C "$smrepo" rev-parse HEAD)
OWNER_MERGES="While the loop is active the owner merges: the loop never does"

# fork.9: the owner merges. Every merge is refused while a loop is active, whatever the gates, the sha or CI say.
hook_case "merge refused while a loop is active, with every gate green and CI green" "$mrepo" "gh pr merge 5 --squash --match-head-commit $sha" 2 "$OWNER_MERGES" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge refusal says the owner merges and that there is no bypass" "$mrepo" "gh pr merge 5 --match-head-commit $sha" 2 "This gate has no bypass" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "merge refused without --match-head-commit too" "$mrepo" "gh pr merge 5 --squash" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused with --match-head-commit=<sha>" "$mrepo" "gh pr merge 5 --match-head-commit=$sha --squash" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused with an abbreviated sha" "$mrepo" "gh pr merge 5 --match-head-commit $short" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused with --auto" "$mrepo" "gh pr merge 5 --auto --squash" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused with --admin" "$mrepo" "gh pr merge 5 --admin" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused when the gates are red as well" "$mred" "gh pr merge 5 --match-head-commit $msha" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge of small work with a passing live run is refused too" "$smrepo" "gh pr merge 5 --match-head-commit $ssha" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "gh api PUT .../pulls/5/merge refused" "$mrepo" "gh api -X PUT repos/o/r/pulls/5/merge -f sha=$sha" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "gh api PUT .../pulls/5/merge refused without a sha" "$mrepo" "gh api -X PUT repos/o/r/pulls/5/merge -f merge_method=squash" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused from another directory (git -C style cd)" "$outside" "cd $mrepo && gh pr merge 5 --match-head-commit $sha" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused inside bash -c" "$mrepo" "bash -c 'gh pr merge 5'" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "merge refused after a chained command" "$mrepo" "echo merging; gh pr merge 5" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "gh pr view is not a merge" "$mrepo" "gh pr view 5 --json state" 0 "" "${gh_env[@]}"
hook_case "gh pr merge in a message passes" "$mrepo" 'echo "run gh pr merge later"' 0 "" "${gh_env[@]}"
hook_case "merge never blocked without gates.json" "$plain_repo" "gh pr merge 5" 0 "" "${gh_env[@]}"
hook_case "merge bypass: FEATURE_LOOP_GATES=off does not unblock a merge" "$mrepo" "gh pr merge 5" 2 "$OWNER_MERGES" "${gh_env[@]}" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=CI outage, lead approved"
hook_case "merge bypass inline in the command does not unblock a merge" "$mrepo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x gh pr merge 5" 2 "$OWNER_MERGES" "${gh_env[@]}"
pass_if "a refused merge writes no bypass record" bash -c '! grep -qF "(merge)" "$1/.scratch/loop-metrics.md"' _ "$mrepo"

# ---- stop-hook.sh and session-start-hook.sh

stop_payload() { # <cwd or ""> <stop_hook_active true|false>
  node -e 'const o = { hook_event_name: "Stop", session_id: "s1", stop_hook_active: process.argv[2] === "true" }; if (process.argv[1]) o.cwd = process.argv[1]; process.stdout.write(JSON.stringify(o))' "$1" "$2"
}
start_payload() { node -e 'const o = { hook_event_name: "SessionStart", session_id: "s1", source: "startup" }; if (process.argv[1]) o.cwd = process.argv[1]; process.stdout.write(JSON.stringify(o))' "$1"; }

# event_case <name> <script> <payload> <exit> <out|err> <needle, or @empty for no output> [VAR=value...]
event_case() {
  local name="$1" script="$2" payload="$3" want="$4" stream="$5" needle="$6"; shift 6
  skip_case && return 0
  local so="$work/ev.out" se="$work/ev.err" code bad="" text
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$here/$script" >"$so" 2>"$se"); code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ "$stream" = out ]; then text="$(cat "$so")"; else text="$(cat "$se")"; fi
  if [ "$needle" = @empty ]; then
    [ -z "$(cat "$so" "$se")" ] || bad="${bad:+$bad; }expected no output"
  elif [ -n "$needle" ] && ! printf '%s\n' "$text" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   $script: $name"; else echo "FAIL $script: $name: $bad"; printf '%s\n' "$text" | sed 's/^/       | /'; fail=1; fi
}

srepo=$(new_repo stop-running); green_normal "$srepo"; put "$srepo" loop-status-running.md .scratch/loop-status.md
msg='feature-loop: stage 2 behavioral-envelope is running with no result; finish it and record its gate result, or mark it "blocked: <decision needed>" in .scratch/loop-status.md'
event_case "running stage blocks stopping" stop-hook.sh "$(stop_payload "$srepo" false)" 2 err "$msg"
event_case "stop_hook_active never loops" stop-hook.sh "$(stop_payload "$srepo" true)" 0 err @empty
mkdir -p "$srepo/src/deep"
event_case "subdirectory cwd finds the repo root" stop-hook.sh "$(stop_payload "$srepo/src/deep" false)" 2 err "stage 2 behavioral-envelope is running"
event_case "no cwd in the input: CLAUDE_PROJECT_DIR" stop-hook.sh "$(stop_payload "" false)" 2 err "stage 2 behavioral-envelope is running" "CLAUDE_PROJECT_DIR=$srepo"
event_case "unreadable input never blocks" stop-hook.sh "not json" 0 err @empty "CLAUDE_PROJECT_DIR=$work/outside"

put "$srepo" loop-status-columns.md .scratch/loop-status.md
event_case "columns found by name, status case-insensitive" stop-hook.sh "$(stop_payload "$srepo" false)" 2 err "stage 2 behavioral-envelope is running"
put "$srepo" loop-status-blocked.md .scratch/loop-status.md
event_case "blocked, done, pending and skipped never block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
put "$srepo" loop-status.md .scratch/loop-status.md
event_case "done, pending and skipped never block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
rm "$srepo/.scratch/loop-status.md"
event_case "no loop-status.md: nothing to block" stop-hook.sh "$(stop_payload "$srepo" false)" 0 err @empty
srepo2=$(new_repo stop-nogates); put "$srepo2" loop-status-running.md .scratch/loop-status.md
event_case "no gates.json: not running the loop" stop-hook.sh "$(stop_payload "$srepo2" false)" 0 err @empty
srepo3=$(new_repo stop-two); green_normal "$srepo3"; printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 2 | shape | running | | | | |\n| 3 | tdd | running | | | | |\n' > "$srepo3/.scratch/loop-status.md"
event_case "every running stage is named" stop-hook.sh "$(stop_payload "$srepo3" false)" 2 err "stage 3 tdd is running with no result"

trepo=$(new_repo start-summary); green_normal "$trepo"; put "$trepo" loop-status.md .scratch/loop-status.md
event_case "summary names slug and size" session-start-hook.sh "$(start_payload "$trepo")" 0 out 'feature-loop is running for "reply-options" (size normal)'
event_case "summary lists rows that are not done" session-start-hook.sh "$(start_payload "$trepo")" 0 out "- 3 tdd: pending"
event_case "summary lists skipped rows too" session-start-hook.sh "$(start_payload "$trepo")" 0 out "- 4 live-verify: skipped: no UI change"
event_case "summary says where to resume" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Resume at: stage 3 tdd (pending)"
pass_if "done rows are not listed" test -z "$(printf '%s' "$(start_payload "$trepo")" | bash "$here/session-start-hook.sh" | grep -F -- '- 1 shape')"
put "$trepo" loop-status-blocked.md .scratch/loop-status.md
event_case "a blocked stage is the resume point" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Resume at: stage 2 behavioral-envelope (blocked: which rollout order do you want)"
printf '| Stage | Skill | Status | Gate | Evidence | Output | Finished |\n|---|---|---|---|---|---|---|\n| 1 | shape | done | G1 | measured: x | | |\n| 2 | tdd | skipped: trivial | | | | |\n' > "$trepo/.scratch/loop-status.md"
event_case "all stages done or skipped" session-start-hook.sh "$(start_payload "$trepo")" 0 out "Every stage is done or skipped"
rm "$trepo/.scratch/loop-status.md"
event_case "no loop-status.md yet" session-start-hook.sh "$(start_payload "$trepo")" 0 out "no .scratch/loop-status.md yet"
event_case "no gates.json: prints nothing" session-start-hook.sh "$(start_payload "$plain_repo")" 0 out @empty
bad_repo=$(new_repo start-bad); mkdir -p "$bad_repo/.scratch"; printf '{ nope' > "$bad_repo/.scratch/gates.json"
event_case "invalid gates.json never fails the session" session-start-hook.sh "$(start_payload "$bad_repo")" 0 out @empty
tbs=$(new_repo start-timebox); gates_json_with "$tbs" small '"demo_by": "2026-10-12T17:00:00-04:00"'; put "$tbs" loop-status.md .scratch/loop-status.md
event_case "summary carries the time box when demo_by is set" session-start-hook.sh "$(start_payload "$tbs")" 0 out 'time box: OVERDUE by 30 min' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
event_case "time box before the deadline" session-start-hook.sh "$(start_payload "$tbs")" 0 out 'time box: 60 min left' FEATURE_LOOP_NOW=2026-10-12T16:00:00-04:00
rm "$tbs/.scratch/loop-status.md"
event_case "time box shows with no loop-status.md yet" session-start-hook.sh "$(start_payload "$tbs")" 0 out 'time box: OVERDUE' FEATURE_LOOP_NOW=2026-10-12T17:30:00-04:00
pass_if "no demo_by: no time box line" test -z "$(printf '%s' "$(start_payload "$trepo")" | bash "$here/session-start-hook.sh" | grep -F 'time box')"
tbb=$(new_repo start-timebox-bad); gates_json_with "$tbb" small '"demo_by": "soon"'
event_case "invalid demo_by never fails the session" session-start-hook.sh "$(start_payload "$tbb")" 0 out 'feature-loop is running for "reply-options"' 
event_case "garbage input never fails the session" session-start-hook.sh "not json" 0 out @empty "CLAUDE_PROJECT_DIR=$outside"


# ======================================================================================================
# Fix round: phases, builder worktrees, fail-closed hooks, closed loops, other merge paths, G7, parity
# ======================================================================================================

# silent_case <name> <cwd> <command> [VAR=value...]: exit 0 and nothing on stdout or stderr.
silent_case() {
  local name="$1" cwd="$2" cmd="$3"; shift 3
  skip_case && return 0
  local payload so se code bad=""
  payload="$(node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_name: "Bash", tool_input: { command: process.argv[2] } }))' "$cwd" "$cmd")"
  so="$work/sc.out"; se="$work/sc.err"
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" >"$so" 2>"$se"); code=$?
  [ "$code" = 0 ] || bad="exit $code, want 0"
  [ -z "$(cat "$so" "$se")" ] || bad="${bad:+$bad; }expected no output"
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook (silent): $name"; else echo "FAIL hook (silent): $name: $bad"; cat "$so" "$se" | sed 's/^/       | /'; fail=1; fi
}

# raw_hook_case <name> <raw stdin> <exit> <stderr needle> [VAR=value...]: a payload that is not built from JSON.
raw_hook_case() {
  local name="$1" payload="$2" want="$3" needle="$4"; shift 4
  skip_case && return 0
  local err code bad=""
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ -n "$needle" ] && ! printf '%s\n' "$err" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   hook: $name"; else echo "FAIL hook: $name: $bad"; printf '%s\n' "$err" | sed 's/^/       | /'; fail=1; fi
}

hook_code() { # <cwd> <command> [VAR=value...]: the hook's exit code
  local cwd="$1" cmd="$2"; shift 2
  local payload code
  payload="$(node -e 'process.stdout.write(JSON.stringify({ cwd: process.argv[1], tool_name: "Bash", tool_input: { command: process.argv[2] } }))' "$cwd" "$cmd")"
  (cd "$work" && printf '%s' "$payload" | env "$@" bash "$hook" >/dev/null 2>&1); code=$?
  printf '%s' "$code"
}

set_status() { # <dir> <status>: gates.json with a status field
  printf '{ "slug": "%s", "size": "normal", "base": "main", "status": "%s" }\n' "$SLUG" "$2" > "$1/.scratch/gates.json"
}

# ---- phases (check-gates.sh --phase)

d=$(new_repo ph-build); gates_json "$d" normal; put "$d" shape.md ".scratch/shape/$SLUG.md"; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
expect "phase build: green with only G1 G2 G8 in place (no live run, review or metrics)" "$d" 0 "gates: green for reply-options (size normal): 2 green, 0 red, 1 n/a" 0 --phase build
out="$(cd "$d" && "$check" --phase build)"
pass_if "phase build evaluates exactly G1 G2 G8" test "$(printf '%s\n' "$out" | grep -E '^G[1-8] ' | cut -c1-2 | tr '\n' ' ')" = "G1 G2 G8 "
expect "no phase evaluates every gate: G3 G5 G7 red here" "$d" 1 "G7 red" 3
expect "phase close evaluates every gate" "$d" 1 "G3 red" 3 --phase close
expect "explicit gates before --phase work too" "$d" 0 "gates: green" 0 G1 G2 --phase build

d=$(new_repo ph-merge); green_normal "$d"; rm "$d/.scratch/loop-metrics.md"
expect "phase merge: G1 to G6 and G8 only, so a missing metrics line (G7) is fine" "$d" 0 "gates: green for reply-options (size normal): 5 green, 0 red, 2 n/a" 0 --phase merge
expect "phase close: G7 red without the metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1 --phase close
expect "no phase: G7 red without the metrics line" "$d" 1 "G7 red: no metrics line containing reply-options" 1
out="$(cd "$d" && "$check" --phase merge)"
pass_if "phase merge prints no G7 line" test -z "$(printf '%s\n' "$out" | grep -E '^G7 ')"

d=$(new_repo ph-g5); green_normal "$d"; put "$d" review-open-high.md ".scratch/review/$SLUG.md"
expect "phase merge: G5 red blocks" "$d" 1 "G5 red: open CONFIRMED finding: F1 HIGH" 1 --phase merge
expect "phase build ignores G5" "$d" 0 "gates: green" 0 --phase build
d=$(new_repo ph-list); green_normal "$d"; rm "$d/.scratch/loop-metrics.md"
out="$(cd "$d" && "$check" --phase merge G6 G7)"
pass_if "explicit gates and a phase intersect (G7 is not a merge gate)" test "$(printf '%s\n' "$out" | grep -E '^G[1-8] ' | cut -c1-2 | tr '\n' ' ')" = "G6 "
expect "usage: unknown phase" "$d" 2 "unknown phase: soon" 0 --phase soon
expect "usage: --phase needs a value" "$d" 2 "--phase needs" 0 --phase

# The hooks use the phases: a push needs only G1 G2 G8 G9; a PR needs the whole pr phase.
bd=$(new_repo ph-hook-build); gates_json "$bd" normal; put "$bd" shape.md ".scratch/shape/$SLUG.md"; put "$bd" envelope.md ".scratch/envelope/$SLUG.md"
hook_case "push during Build passes with only G1 G2 G8 green" "$bd" "git push -u origin feature" 0 ""
hook_case "draft PR during Build is refused: a PR needs the pr phase (fork.9)" "$bd" 'gh pr create --draft --title x --body y' 2 "opening a draft PR was blocked, the pr phase is red"
hook_case "gh api POST pulls during Build is refused too" "$bd" "gh api repos/o/r/pulls -f title=x -f head=feature -f base=main" 2 "opening a PR was blocked, the pr phase is red"
bd2=$(new_repo ph-hook-build-g8); gates_json "$bd2" normal; put "$bd2" shape.md ".scratch/shape/$SLUG.md"; put "$bd2" envelope.md ".scratch/envelope/$SLUG.md"; put "$bd2" loop-status-no-evidence.md .scratch/loop-status.md
hook_case "push during Build is still blocked by a red G8" "$bd2" "git push origin feature" 2 "G8 red: done stage without evidence"
bd3=$(new_repo ph-hook-build-g2); gates_json "$bd3" normal; put "$bd3" shape.md ".scratch/shape/$SLUG.md"
hook_case "push during Build is still blocked by a red G2" "$bd3" "git push origin feature" 2 "G2 red: envelope file missing"

mg5=$(new_repo ph-pr-g5); green_normal "$mg5"; put "$mg5" review-open-high.md ".scratch/review/$SLUG.md"
hook_case "PR creation blocked when G5 is red" "$mg5" 'gh pr create --title x --body y' 2 "G5 red: open CONFIRMED finding: F1 HIGH" "${gh_env[@]}"

# ---- builder worktrees: the loop root is the main worktree

wr=$(new_repo wt-root); gates_json "$wr" normal; put "$wr" shape.md ".scratch/shape/$SLUG.md"; put "$wr" envelope.md ".scratch/envelope/$SLUG.md"
wt="$work/wt-builder"; git -C "$wr" worktree add -q -b builder "$wt" >/dev/null 2>&1 || { echo "FAIL could not add a worktree"; fail=1; }
cp "$fx/src/slop.js" "$wt/src/slop.js"; git -C "$wt" add src/slop.js
pass_if "the worktree has no .scratch of its own" test ! -e "$wt/.scratch/gates.json"
hook_case "commit in a builder worktree is slop-checked" "$wt" 'git commit -m "add slop"' 2 "src/slop.js:2"
hook_case "git -C <worktree> commit from elsewhere is slop-checked" "$outside" "git -C $wt commit -m x" 2 "src/slop.js:2"
pass_if "worktree commit hook leaves its index alone" test "$(git -C "$wt" diff --cached --name-only)" = "src/slop.js"
put "$wr" review-justified.md ".scratch/review/$SLUG.md"
hook_case "justifications are read from the loop root's review file" "$wt" "git commit -m x" 0 ""
wr2=$(new_repo wt-root-red); gates_json "$wr2" normal
wt2="$work/wt-builder-red"; git -C "$wr2" worktree add -q -b builder "$wt2" >/dev/null 2>&1
hook_case "git push in a builder worktree is gated (G1 red)" "$wt2" "git push origin builder" 2 "G1 red: shape file missing"
hook_case "draft PR from a builder worktree is gated" "$wt2" "gh pr create --draft --title x --body y" 2 "G1 red"
put "$wr" loop-status-running.md .scratch/loop-status.md
event_case "stop hook finds the loop from a builder worktree" stop-hook.sh "$(stop_payload "$wt" false)" 2 err "stage 2 behavioral-envelope is running"
event_case "session-start hook finds the loop from a builder worktree" session-start-hook.sh "$(start_payload "$wt")" 0 out 'feature-loop is running for "reply-options"'
rm "$wr/.scratch/loop-status.md"

# A PR opened from a worktree judges that worktree's code, not the main checkout's.
wm=$(new_repo wt-merge-root); green_normal "$wm"
wmt="$work/wt-merge"; git -C "$wm" worktree add -q -b builder2 "$wmt" >/dev/null 2>&1
add_slop "$wmt"; wsha=$(git -C "$wmt" rev-parse HEAD)
touch -d "@$(( $(git -C "$wmt" log -1 --format=%ct) + 5 ))" "$wm/.scratch/live/run1/report.json"
hook_case "PR creation from a worktree checks that worktree's code (G6)" "$wmt" "gh pr create --title x --body y" 2 "CRAFT-06.todo src/slop.js:2" "${gh_env[@]}"

# ---- fail closed when a loop is active

nonode="$work/nonode-bin"; mkdir -p "$nonode"
nonode_path() { # PATH without node, other tools kept
  local p f b out=""
  local -a parts
  IFS=: read -ra parts <<< "$PATH"
  for p in "${parts[@]}"; do
    if [ -x "$p/node" ] || [ -x "$p/node.exe" ]; then
      for f in "$p"/*; do
        b="${f##*/}"
        case "$b" in node|node.exe) continue ;; esac
        if [ -f "$f" ] && [ -x "$f" ] && [ ! -e "$nonode/$b" ]; then ln -s "$f" "$nonode/$b" 2>/dev/null || true; fi
      done
      p="$nonode"
    fi
    out="${out:+$out:}$p"
  done
  printf '%s' "$out"
}
np="$(nonode_path)"
pass_if "test setup: the PATH built for the node-absent cases has no node" bash -c 'PATH="$1"; ! command -v node >/dev/null 2>&1' _ "$np"
hook_case "node absent, loop active: push fails closed" "$red_repo" "git push" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: commit fails closed" "$crepo" "git commit -m x" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: merge fails closed" "$mrepo" "gh pr merge 5" 2 "node not found" "PATH=$np"
hook_case "node absent, loop active: the message says what to do" "$red_repo" "git push" 2 "Install Node" "PATH=$np"
hook_case "node absent, no loop: a warning, not a block" "$plain_repo" "git push" 1 "node not found" "PATH=$np"
hook_case "node absent, command that cannot ship: passes" "$red_repo" "ls -la" 0 "" "PATH=$np"
badbin="$work/badnode-bin"; mkdir -p "$badbin"; printf '#!/bin/sh\necho "node exploded" >&2\nexit 1\n' > "$badbin/node"; chmod +x "$badbin/node"
hook_case "node failing, loop active: push fails closed" "$red_repo" "git push" 2 "could not read the hook input" "PATH=$badbin:$PATH"
hook_case "node failing, no loop: a warning, not a block" "$plain_repo" "git push" 1 "could not read the hook input" "PATH=$badbin:$PATH"
raw_hook_case "malformed hook JSON, loop active: fails closed" '{"cwd":"'"$red_repo"'","tool_name":"Bash","tool_input":{"command":"git push origin' 2 "could not read the hook input"
raw_hook_case "malformed hook JSON without a cwd, loop active via CLAUDE_PROJECT_DIR: fails closed" 'tool_input git push {{' 2 "could not read the hook input" "CLAUDE_PROJECT_DIR=$red_repo"
raw_hook_case "malformed hook JSON, no loop: a warning, not a block" '{"cwd":"'"$plain_repo"'","tool_input":{"command":"git push' 1 "could not read the hook input"

# ---- gates.json: malformed, closed

badj=$(new_repo hook-badjson); mkdir -p "$badj/.scratch"; printf '{ nope' > "$badj/.scratch/gates.json"; cp "$fx/src/slop.js" "$badj/src/slop.js"; git -C "$badj" add src/slop.js
hook_case "malformed gates.json: push fails closed and says so" "$badj" "git push" 2 "is not valid JSON"
hook_case "malformed gates.json: commit fails closed and says so" "$badj" "git commit -m x" 2 "is not valid JSON"
hook_case "malformed gates.json: merge fails closed and says so" "$badj" "gh pr merge 5" 2 "is not valid JSON"

cl=$(new_repo closed-red); green_normal "$cl"; rm "$cl/.scratch/shape/$SLUG.md"; put "$cl" loop-status-running.md .scratch/loop-status.md
cp "$fx/src/slop.js" "$cl/src/slop.js"; git -C "$cl" add src/slop.js
hook_case "(open loop, for contrast) push blocked" "$cl" "git push origin feature" 2 "G1 red"
sign_close "$cl" # a loop that closed properly: its passing close phase signed the close
set_status "$cl" closed
silent_case "closed loop: push is not gated" "$cl" "git push origin feature"
silent_case "closed loop: PR creation is not gated" "$cl" "gh pr create --title x --body y"
silent_case "closed loop: staged slop commit is not gated" "$cl" "git commit -m x"
silent_case "closed loop: merge is not gated" "$cl" "gh pr merge 5" "${gh_env[@]}"
silent_case "closed loop: push to the base branch is not refused" "$cl" "git push origin HEAD:main"
silent_case "closed loop, node absent: silent" "$cl" "git push origin feature" "PATH=$np"
printf '{"slug":"reply-options","size":"normal","base":"main","status":"closed"}\n' > "$cl/.scratch/gates.json"
silent_case "closed loop (compact JSON): push is not gated" "$cl" "git push origin feature"
expect "closed loop: check-gates says so and exits 0" "$cl" 0 "loop closed" 0
event_case "closed loop: stop hook is silent" stop-hook.sh "$(stop_payload "$cl" false)" 0 err @empty
event_case "closed loop: session-start prints nothing" session-start-hook.sh "$(start_payload "$cl")" 0 out @empty
set_status "$cl" running
hook_case "status other than closed keeps the loop active" "$cl" "git push origin feature" 2 "G1 red"
# A2: only the top-level "status" closes a loop; the run file is parsed, not grepped
printf '{"slug":"reply-options","size":"normal","base":"main","live":{"status":"closed"}}\n' > "$cl/.scratch/gates.json"
hook_case "A2: a nested status closed does not close the loop" "$cl" "git push origin feature" 2 "so this push was blocked"
pass_if "A2: loop_root reports a nested status as an active loop" bash -c '. "$1"; loop_root "$2" >/dev/null; test $? -eq 0' _ "$here/loop-root.sh" "$cl"
cat > "$cl/.scratch/gates.json" <<'JSON'
{"slug":"reply-options","size":"normal","base":"main","merge_check":"echo \"status\": \"closed\""}
JSON
hook_case "A2: a status inside a string value does not close the loop" "$cl" "git push origin feature" 2 "G1 red"
printf '{"slug":"reply-options","status":"closed","size":"normal","base":"main", broken' > "$cl/.scratch/gates.json"
hook_case "A2: a run file that does not parse is an active loop (fails closed), whatever it says" "$cl" "git push origin feature" 2 "is not valid JSON"
pass_if "A2: stage-guard fails closed on a run file that does not parse" bash -c 'out="$(node "$1" "$2")"; test $? -eq 1 && printf "%s" "$out" | grep -q "not valid JSON"' _ "$here/stage-guard.mjs" "$cl"
set_status "$cl" running

# ---- other merge paths

gq() { printf "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"PR_kwDOabc\"%s}) { pullRequest { id } } }'" "${1:+, expectedHeadOid: \"$1\"}"; }
hook_case "graphql mergePullRequest refused when the gates are red" "$mred" "$(gq "$msha")" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "graphql mergePullRequest refused without a sha" "$mrepo" "$(gq)" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "graphql mergePullRequest refused with the head sha, green gates and CI" "$mrepo" "$(gq "$sha")" 2 "$OWNER_MERGES" "${gh_env[@]}" "FAKE_GH_HEAD=$sha" FAKE_GH_REQUIRED=0
hook_case "graphql merge with -f expectedHeadOid=<sha> refused" "$mrepo" "gh api graphql -f query='mutation(\$id: ID!, \$oid: GitObjectID) { mergePullRequest(input: {pullRequestId: \$id, expectedHeadOid: \$oid}) { clientMutationId } }' -f id=PR_x -f expectedHeadOid=$sha" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "a read-only graphql query passes" "$mred" "gh api graphql -f query='query { viewer { login } }'" 0 ""
hook_case "a graphql createPullRequest is still a PR creation" "$red_repo" "gh api graphql -f query='mutation { createPullRequest(input: {title: \"x\"}) { pullRequest { id } } }'" 2 "G1 red"
# A6: queries that cannot be read, auto-merge, and the branch-merge endpoint
hook_case "A6: graphql with -F query=@file is refused while a loop is active" "$mrepo" "gh api graphql -F query=@q.graphql" 2 "read from a file or stdin" "${gh_env[@]}"
hook_case "A6: graphql with -f query=@file is refused too" "$mrepo" "gh api graphql -f query=@q.graphql" 2 "read from a file or stdin" "${gh_env[@]}"
hook_case "A6: graphql with -F query=@- (stdin) is refused" "$mrepo" "cat q | gh api graphql -F query=@-" 2 "read from a file or stdin" "${gh_env[@]}"
hook_case "A6: graphql with --input is refused" "$mrepo" "gh api graphql --input q.json" 2 "read from a file or stdin" "${gh_env[@]}"
hook_case "A6: the opaque-query refusal has no bypass" "$mrepo" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x gh api graphql -F query=@q.graphql" 2 "no bypass" "${gh_env[@]}"
hook_case "A6: a graphql query given inline is judged as before (read-only passes)" "$mrepo" "gh api graphql -f query='query { viewer { login } }'" 0 "" "${gh_env[@]}"
hook_case "A6: enablePullRequestAutoMerge is a merge" "$mrepo" "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"PR_x\"}) { clientMutationId } }'" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "A6: POST .../merges is a merge" "$mrepo" "gh api -X POST repos/o/r/merges -f base=main -f head=feature" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "A6: a REST call with fields (an implicit POST) to .../merges is a merge" "$mrepo" "gh api repos/o/r/merges -f base=main -f head=feature" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "A6: a GET of .../merges is not a merge" "$mrepo" "gh api repos/o/r/merges" 0 "" "${gh_env[@]}"
hook_case "A6: an opaque query with no loop passes" "$plain_repo" "gh api graphql -F query=@q.graphql" 0 ""

# A push that targets the base branch skips the owner's merge; refuse it.
br=$(new_repo push-base); green_normal "$br"
hook_case "push HEAD:main refused" "$br" "git push origin HEAD:main" 2 "merge through the PR so the merge gate runs"
hook_case "push origin main refused" "$br" "git push origin main" 2 "merge through the PR so the merge gate runs"
hook_case "push feature:main with force-with-lease refused" "$br" "git push --force-with-lease origin feature:main" 2 "merge through the PR"
hook_case "push HEAD:refs/heads/main refused" "$br" "git push origin HEAD:refs/heads/main" 2 "merge through the PR"
hook_case "push --all refused" "$br" "git push --all origin" 2 "merge through the PR"
hook_case "git -C <repo> push origin main refused" "$outside" "git -C $br push origin main" 2 "merge through the PR"
hook_case "the base-branch refusal names the base" "$br" "git push origin main" 2 "base branch (main)"
hook_case "push of the feature branch is fine" "$br" "git push origin feature" 0 ""
hook_case "push of HEAD from a feature branch is fine" "$br" "git push origin HEAD" 0 ""
hook_case "push main:feature (the base as the source) is fine" "$br" "git push origin main:feature" 0 ""
bm=$(new_repo push-base-checkout); green_normal "$bm"; git -C "$bm" checkout -q main
hook_case "plain git push while the base is checked out refused" "$bm" "git push" 2 "merge through the PR so the merge gate runs"
hook_case "git push origin HEAD while the base is checked out refused" "$bm" "git push origin HEAD" 2 "merge through the PR"
hook_case "git push origin feature from the base checkout is fine" "$bm" "git push origin feature" 0 ""
hook_case "push to main without a loop is not refused" "$plain_repo" "git push origin HEAD:main" 0 ""
# A4a: a push to the base has NO bypass (fork.9.1)
hook_case "A4a: push to the base is refused even with a recorded bypass" "$br" "git push origin HEAD:main" 2 "This gate has no bypass" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=hotfix approved by lead"
hook_case "A4a: an inline bypass does not unblock a push to the base" "$br" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x git push origin main" 2 "merge through the PR"
pass_if "A4a: a refused base push writes no push-to-base bypass record" bash -c '! grep -qF "push to base" "$1/.scratch/loop-metrics.md" 2>/dev/null' _ "$br"
# A4b: the repository a push acts on, however the command names it
ready_repo "$br"; ready_repo "$red_repo"
hook_case "A4b: --git-dir and --work-tree push to the base is refused" "$outside" "git --git-dir=$br/.git --work-tree=$br push origin HEAD:main" 2 "merge through the PR"
hook_case "A4b: --git-dir <path> as two words" "$outside" "git --git-dir $br/.git push origin main" 2 "merge through the PR"
hook_case "A4b: GIT_DIR= prefix" "$outside" "GIT_DIR=$br/.git git push origin main" 2 "merge through the PR"
hook_case "A4b: GIT_DIR= and GIT_WORK_TREE= prefixes" "$outside" "GIT_DIR=$br/.git GIT_WORK_TREE=$br git push origin main" 2 "merge through the PR"
hook_case "A4b: export GIT_DIR before the push" "$outside" "export GIT_DIR=$br/.git; git push origin main" 2 "merge through the PR"
hook_case "A4b: git -C with a bypass still refused" "$outside" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x git -C $br push origin HEAD:main" 2 "no bypass"
hook_case "A4b: a --git-dir push of the feature branch runs the build gates of that repo" "$outside" "git --git-dir=$red_repo/.git --work-tree=$red_repo push origin feature" 2 "G1 red"
hook_case "A4b: GIT_DIR push of the feature branch runs the build gates of that repo" "$outside" "GIT_DIR=$red_repo/.git git push origin feature" 2 "G1 red"
hook_case "A4b: a push of the feature branch through --git-dir is fine when the gates are green" "$outside" "git --git-dir=$br/.git --work-tree=$br push origin feature" 0 ""

# ---- G7 reads the last metrics line and trusts no number it can check

d=$(new_repo g7-escapes-low); green_normal "$d"; put "$d" metrics-escapes-low.md .scratch/loop-metrics.md
expect "G7 red: escapes below the CONFIRMED findings in the review" "$d" 1 "G7 red: escapes=1 is below the 2 CONFIRMED findings in .scratch/review/reply-options.md: every CONFIRMED finding is an escape (.scratch/loop-metrics.md)" 1 G7
d=$(new_repo g7-last-bad); green_normal "$d"
printf '# Loop metrics\n\n2026-10-08 reply-options: escapes=2 floors=2\n2026-10-09 reply-options: findings 3, 1 day\n' > "$d/.scratch/loop-metrics.md"
expect "G7 red: only the last metrics line counts, an earlier good one does not" "$d" 1 "G7 red: the review has CONFIRMED findings, so a reply-options metrics line needs escapes=<n> floors=<m>" 1 G7
d=$(new_repo g7-last-good); green_normal "$d"
printf '# Loop metrics\n\n2026-10-08 reply-options: findings 3, 1 day\n2026-10-09 reply-options: escapes=2 floors=2\n2026-10-09T10:00:00Z reply-options gates bypassed: demo\n' > "$d/.scratch/loop-metrics.md"
expect "G7 green: the last metrics line is good (a later bypass record is not a metrics line)" "$d" 0 "G7 green" 0 G7
d=$(new_repo g7-more); green_normal "$d"; printf '# Loop metrics\n\n2026-10-09 reply-options: escapes=3 floors=3\n' > "$d/.scratch/loop-metrics.md"
expect "G7 green: more escapes than CONFIRMED findings is fine" "$d" 0 "G7 green" 0 G7
d=$(new_repo g7-floors-low-last); green_normal "$d"; put "$d" metrics-floor-low.md .scratch/loop-metrics.md
expect "G7 red: floors still below escapes" "$d" 1 "G7 red: floors=1 is below escapes=2" 1 G7

# ---- the justification rule is one rule: G6 (check-gates) and the commit hook agree on every review file

par=$(new_repo parity); gates_json "$par" normal; cp "$fx/src/slop.js" "$par/src/slop.js"; git -C "$par" add src/slop.js
parity_case() { # <name> <block|allow> <review file content>
  local name="$1" want="$2" content="$3" g c
  mkdir -p "$par/.scratch/review"; printf '%s' "$content" > "$par/.scratch/review/$SLUG.md"
  (cd "$par" && "$check" G6 >/dev/null 2>&1); g=$?
  c="$(hook_code "$par" "git commit -m x")"
  total=$((total + 1))
  if { [ "$want" = allow ] && [ "$g" = 0 ] && [ "$c" = 0 ]; } || { [ "$want" = block ] && [ "$g" = 1 ] && [ "$c" = 2 ]; }; then
    echo "ok   parity: $name"
  else
    echo "FAIL parity: $name: want $want, G6 exit $g, commit hook exit $c"; fail=1
  fi
}
parity_case "both findings justified with reasons" allow $'## Justified\n\n- `src/slop.js:2` CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: the CLI prints on purpose\n'
parity_case "a listing without a reason does not count" block $'## Justified\n\n- src/slop.js:2 CRAFT-06.todo\n- src/slop.js:3 CRAFT-06.debug-output\n'
parity_case "a ./ prefix on the path still counts" allow $'## Justified\n\n- ./src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- ./src/slop.js:3 CRAFT-06.debug-output: the CLI prints on purpose\n'
parity_case "line 20 does not justify line 2" block $'## Justified\n\n- src/slop.js:20 CRAFT-06.todo: another line entirely\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "only one of two findings justified" block $'## Justified\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n'
parity_case "a listing outside the Justified section does not count" block $'## Notes\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n\n## Justified\n\n- none\n'
parity_case "a listing inside a code fence does not count" block $'## Justified\n\n```\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n```\n'
parity_case "a deeper heading level is the same section" allow $'# Review\n\n### Justified\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "a heading with a colon is the same section" allow $'## Justified:\n\n- src/slop.js:2 CRAFT-06.todo: tracked as issue #42\n- src/slop.js:3 CRAFT-06.debug-output: prints on purpose\n'
parity_case "a location inside a longer path does not count" block $'## Justified\n\n- other/src/slop.js:2 CRAFT-06.todo: not this file\n- other/src/slop.js:3 CRAFT-06.debug-output: not this file\n'
parity_case "an empty review file justifies nothing" block ''
rm -f "$par/.scratch/review/$SLUG.md"
(cd "$par" && "$check" G6 >/dev/null 2>&1); g=$?; c="$(hook_code "$par" "git commit -m x")"
pass_if "parity: a missing review file blocks both" test "$g/$c" = "1/2"

# ---- the approved plan (plan-first workflow): stages it covers are done from it, not re-run

plan_repo() { # <name> <plan fixture> <ledger fixture>: a normal loop with the plan and the ledger in place
  local d; d=$(new_repo "$1"); green_normal "$d"
  put "$d" "$2" "docs/plans/$SLUG.md"; put "$d" "$3" .scratch/loop-status.md
  printf '%s' "$d"
}

d=$(plan_repo plan-ledger plan-complete.md loop-status-from-plan.md)
expect "a loop with an approved plan marks those stages done instead of re-running them" "$d" 0 "G8 green" 0 G8
sp="$(printf '%s' "$(start_payload "$d")" | bash "$here/session-start-hook.sh" 2>&1)"
pass_if "the loop resumes after the stages the plan covered, at stage 4" bash -c 'printf "%s\n" "$1" | grep -qF -- "Resume at: stage 4 tdd (pending)"' _ "$sp"
pass_if "stages done from the plan are not listed as open" test -z "$(printf '%s\n' "$sp" | grep -F -- '- 1 shape')"
ev_stop="$(printf '%s' "$(stop_payload "$d" false)" | bash "$here/stop-hook.sh" 2>&1)"; code=$?
pass_if "stages done from the plan never hold the Stop hook" test "$code" = 0 -a -z "$ev_stop"

d=$(plan_repo plan-ledger-nosection plan-complete.md loop-status-from-plan-no-section.md)
expect "G8 red: from approved plan citing a section the plan lacks" "$d" 1 '"done, from approved plan" without an existing plan section as evidence' 1 G8
d=$(plan_repo plan-ledger-nofile plan-complete.md loop-status-from-plan-no-file.md)
expect "G8 red: from approved plan citing a plan file that does not exist" "$d" 1 '3 to-tickets' 1 G8
d=$(plan_repo plan-ledger-nocite plan-complete.md loop-status-from-plan-no-cite.md)
expect "G8 red: from approved plan with evidence that names no plan section" "$d" 1 '1 shape ("inferred: the approved plan covers it")' 1 G8
d=$(plan_repo plan-ledger-assumed plan-complete.md loop-status-from-plan-assumed.md)
expect "G8 red: from approved plan on an assumption is still not done" "$d" 1 "a stage cannot be done on an assumption: 1 shape" 1 G8
d=$(plan_repo plan-ledger-empty plan-missing.md loop-status-from-plan-empty-section.md)
expect "G8 red: from approved plan citing a section that is only TBD" "$d" 1 '1 shape ("inferred: docs/plans/reply-options.md#Failure modes")' 1 G8
d=$(plan_repo plan-ledger-measured plan-complete.md loop-status-from-plan-measured.md)
expect "G8 red: from approved plan needs inferred: evidence, not measured:" "$d" 1 '1 shape ("measured: docs/plans/reply-options.md#Decisions")' 1 G8
d=$(plan_repo plan-ledger-second plan-complete.md loop-status-from-plan-second-bad.md)
expect "G8 red: every citation is checked, not only the first" "$d" 1 "without an existing plan section as evidence" 1 G8
d=$(plan_repo plan-ledger-stage plan-complete.md loop-status-from-plan-wrong-stage.md)
expect "G8 red: from approved plan on stage 2 or the build is refused" "$d" 1 "is only for stages 0, 1 and 3 (baseline, shape, to-tickets); stage 2 and every build, prove and later stage still run: 2 deep-engineering, 4 tdd" 1 G8
d=$(plan_repo plan-ledger-fenced plan-fenced.md loop-status-from-plan.md)
expect "G8 green: a plan section that is only a fenced block counts as content" "$d" 0 "G8 green" 0 G8
d=$(plan_repo plan-ledger-plain plan-complete.md loop-status.md)
expect "G8: a plain done row needs no plan" "$d" 0 "G8 green" 0 G8

# check-gates.sh --plan: names each missing section, needs no run file
d=$(new_repo plan-check); mkdir -p "$d/docs/plans"
expect "--plan: no plan file is a usage-level error" "$d" 2 "plan: no plan file" - --plan
put "$d" plan-complete.md docs/plans/reply-options.md
expect "--plan: a complete plan is green, with no run file" "$d" 0 "plan: complete (12 sections, 0 deviation lines)" - --plan
expect "--plan: an explicit file" "$d" 0 "plan: complete" - --plan docs/plans/reply-options.md
put "$d" plan-missing.md docs/plans/reply-options.md
expect "--plan: names the missing section" "$d" 1 'plan red: missing section "Time box"' - --plan
expect "--plan: names the empty section" "$d" 1 'plan red: empty section "Failure modes"' - --plan
expect "--plan: summary lists both" "$d" 1 "plan: red, 2 sections missing or empty (Failure modes, Time box)" - --plan
put "$d" plan-with-changes.md docs/plans/reply-options.md
expect "--plan: counts Changed lines" "$d" 0 "plan: complete (12 sections, 2 deviation lines)" - --plan
put "$d" plan-changed-no-reason.md docs/plans/reply-options.md
expect "--plan: a Changed line without because is red" "$d" 1 'plan red: Changed line without "because <reason>": "dropped the retry queue"' - --plan
cp "$here/../../plan-first/plan-template.md" "$d/docs/plans/reply-options.md"
expect "--plan: the unfilled template is red in every section" "$d" 1 "plan: red, 12 sections missing or empty" - --plan
put "$d" plan-fenced.md docs/plans/reply-options.md
expect "--plan: a section holding only a fenced block (with a heading-like line inside) is not empty" "$d" 0 "plan: complete (12 sections" - --plan
put "$d" plan-header-only-table.md docs/plans/reply-options.md
expect "--plan: a header-only table is an empty section" "$d" 1 'plan red: empty section "Tickets and seams"' - --plan
mkdir -p "$d/src/deep"; put "$d" plan-complete.md docs/plans/reply-options.md
expect "--plan: a relative file resolves from the repo root when run from a subdirectory" "$d/src/deep" 0 "plan: complete" - --plan docs/plans/reply-options.md
expect "--plan: a run from a subdirectory finds the newest plan" "$d/src/deep" 0 "plan: complete" - --plan
cp "$here/../../plan-first/plan-template.md" "$d/docs/plans/reply-options.md"
d2=$(new_repo plan-slug); gates_json "$d2" normal
put "$d2" plan-complete.md "docs/plans/$SLUG.md"; put "$d2" plan-missing.md docs/plans/zz-newer.md; newer "$d2" docs/plans/zz-newer.md
expect "--plan: picks the plan named for the loop's slug over a newer file" "$d2" 0 "plan: complete" - --plan
rm "$d2/.scratch/gates.json"
expect "--plan: without a loop it falls back to the newest plan" "$d2" 1 "plan red" - --plan
expect "--plan with gate IDs is a usage error" "$d" 2 "--plan checks only the approved plan" - --plan G1
expect "--plan with --phase is a usage error" "$d" 2 "--plan checks only the approved plan" - --plan --phase build

# ---- stage log and gate G9 (fork.8): the stages ran, in order, proven by the signed log

d=$(new_repo stage-noloop)
stage_hook "$d" Skill '{"skill":"deep-engineering"}'
pass_if "stage hook: no loop, nothing is logged and nothing is created" bash -c 'test "$1" = 0 && test ! -e "$2/.scratch/.loop" && test ! -e "$2/.claude"' _ "$sh_code" "$d"
d=$(loop_repo stage-closed normal); rm -rf "$d/.scratch/.loop" "$d/.claude"; printf '{ "slug": "x", "size": "normal", "base": "main", "status": "closed" }\n' > "$d/.scratch/gates.json"
write_src "$d"; stage_hook "$d" Skill '{"skill":"deep-engineering"}'
pass_if "stage hook: a closed loop is invisible, no violation and no log lines" bash -c 'test "$1" = 0 && test ! -e "$2/.scratch/.loop/log.jsonl"' _ "$sh_code" "$d"
d=$(new_repo stage-na); gates_json "$d" normal
expect "G9 asked for by name says n/a where no hook has run" "$d" 0 "G9 n/a: no stage log" - G9
expect "G9 with --require-stages (the push and merge hooks) is red where no hook has run" "$d" 1 "G9 red: no signed init entry" 1 --phase build --require-stages G9

# What is logged, signed, and where the key and the tip live.
d=$(loop_repo stage-log normal)
stage_hook "$d" Skill '{"skill":"mattpocock-skills:deep-engineering"}' "$PAST"
pass_if "init entry records the base sha, the merge-base, the start sha and the size" grep -q '"kind":"init".*"size":"normal".*"baseSha":"[0-9a-f]\{40\}".*"startSha":"[0-9a-f]\{40\}"' "$(log_of "$d")"
pass_if "Skill call is logged with its name, time and session" grep -qF '"kind":"skill","skill":"mattpocock-skills:deep-engineering","ts":"2020-01-01T00:00:00Z","session":"s1"' "$(log_of "$d")"
pass_if "every logged line carries an HMAC and the chain fields" grep -q '"seq":[0-9]*,"prev":"[0-9a-f]*","mac":"[0-9a-f]\{64\}"' "$(log_of "$d")"
pass_if "the key is under .claude/.loop and never shows in git status" bash -c 'test -s "$1/.claude/.loop/key" && ! git -C "$1" status --porcelain -uall | grep -q claude' _ "$d"
pass_if "the loop-active marker and log tip live outside the repo" bash -c 'f="$1"; test -n "$f" && test -s "$f" && grep -q "\"tip\":{\"seq\":" "$f" && case "$f" in "$2"/*) false ;; *) true ;; esac' _ "$(state_file "$d")" "$d"
log_agent "$d" opus
pass_if "Agent call is logged with its subagent type, model and description" grep -qF '"kind":"agent","subagent_type":"general-purpose","model":"opus","resolved":"","description":"design challenge"' "$(log_of "$d")"
expand_skill "$d" mattpocock-skills:grilling
pass_if "a typed /skill is logged too (it bypasses the Skill tool)" bash -c 'grep -qF "\"skill\":\"mattpocock-skills:grilling\"" "$1" && grep -qF "\"via\":\"slash\"" "$1"' _ "$(log_of "$d")"
n0=$(wc -l < "$(log_of "$d")")
STAGE_EVENT=PostToolUseFailure; log_skill "$d" code-review; STAGE_EVENT=PostToolUse
pass_if "L1: a failed Skill call is not logged" test "$(wc -l < "$(log_of "$d")")" = "$n0"
d=$(loop_repo stage-fail normal); write_src "$d"; STAGE_EVENT=PostToolUseFailure stage_hook "$d" Bash '{"command":"echo hi > src/a.js; false"}'
pass_if "L1: a failed tool call still gets the code-before-plan check" test "$sh_code" = 2

# Code before the planning skills: a violation and a red build gate; revert, run the stages, write again: cleared.
d=$(loop_repo stage-viol normal)
write_src "$d"; stage_hook "$d" Bash '{"command":"python - <<EOF ..."}'
pass_if "source edited before the planning skills: the hook reports it (exit 2)" bash -c 'test "$1" = 2 && printf "%s" "$2" | grep -qF "missing: grilling|grill-with-docs|shape, deep-engineering, behavioral-envelope, to-spec, to-tickets"' _ "$sh_code" "$sh_err"
pass_if "the violation records the paths and the blob hashes of what was written" grep -q '"kind":"violation".*"paths":\["src/a.js"\].*"blobs":{"src/a.js":"[0-9a-f]\{40\}"}' "$(log_of "$d")"
expect "build gate G9 is red while a violation is open" "$d" 1 "G9 red: open violation: source changed before" 1 --phase build G9
log_many "$d" $PLANNING
expect "running the stages but keeping the early code does not clear it" "$d" 1 "G9 red: open violation" 1 --phase build G9
rm -f "$d/src/a.js"; stage_hook "$d" Bash '{"command":"git checkout -- ."}'
pass_if "reverting the code, with the skills run, records a cleared line" grep -qF '"kind":"cleared"' "$(log_of "$d")"
expect "G9 is green after revert and run (before the code is written again)" "$d" 0 "G9 green" 0 --phase build G9
write_src "$d" 2; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "writing different code after the stages is not a violation" test "$sh_code" = 0
expect "G9 stays green with the code written after the stages" "$d" 0 "G9 green" 0 --phase build G9

d=$(loop_repo stage-revert-first normal)
write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'; rm -f "$d/src/a.js"
log_many "$d" $PLANNING
pass_if "reverting first and running the stages after clears the violation" grep -qF '"kind":"cleared"' "$(log_of "$d")"

d=$(loop_repo stage-selfcheck normal); log_skill "$d" shape; write_src "$d"
expect "G9 is red on source changed before the stages even when no hook caught it" "$d" 1 "before deep-engineering, behavioral-envelope, to-spec, to-tickets had run" 1 --phase build G9

# H3: one Bash call edits and commits; a bad base; pre-loop commits are not the loop's (M5); settings.json is allowed.
d=$(loop_repo stage-onecall normal); commit_src "$d"; stage_hook "$d" Bash '{"command":"echo x > src/a.js && git commit -am x"}'
pass_if "H3: source edited and committed in one call is a violation (diffed from the start sha)" test "$sh_code" = 2
expect "H3: G9 sees the committed source too" "$d" 1 "G9 red: open violation" 1 --phase build G9
d=$(new_repo stage-preloop); gates_json "$d" normal; session_start "$d"; init_loop "$d"
pass_if "M5: pre-loop commits from before this session are allowed" test "$sh_code" = 0
expect "M5: G9 is green for a branch whose source was committed before the session" "$d" 0 "G9 green" 0 --phase build G9
# N1, local base: the session starts on main at M, the agent commits src on main, branches, and only then writes gates.json
d="$work/stage-n1-main"; mkdir -p "$d"
(cd "$d" && git init -q -b main && printf '.scratch/\n' > .gitignore && printf '# demo\n' > README.md && git add -A && git commit -q -m base)
session_start "$d"; commit_src "$d"; git -C "$d" checkout -q -b feature; gates_json "$d" normal; init_loop "$d"
pass_if "N1: code committed on main, then a branch, then gates.json is a violation" test "$sh_code" = 2
expect "N1: G9 is red for it (the baseline is the session start, not the code commit)" "$d" 1 "G9 red: open violation" 1 --phase build G9
# N1: code committed in this session before gates.json exists is a violation (the session's start commit is recorded
# outside the repo at its first hook event, so it is the baseline, not HEAD at the time gates.json appears).
d=$(new_repo stage-n1); session_start "$d"
commit_src "$d"; gates_json "$d" normal; init_loop "$d"
pass_if "N1: source committed in this session before gates.json is a violation" test "$sh_code" = 2
expect "N1: G9 is red for it" "$d" 1 "G9 red: open violation" 1 --phase build G9
rm -rf "$d/.scratch/.loop" "$d/.claude" "$(dirname "$(state_file "$d")")"; init_loop "$d"
pass_if "N2: deleting every loop store and restarting does not launder the code" test "$sh_code" = 2
rm -rf "$d/.scratch/.loop" "$d/.claude" "$(dirname "$(state_file "$d")")" "$work/state/sessions"; init_loop "$d"
pass_if "N2: without any session record the baseline is the merge-base: pre-session commits count too" test "$sh_code" = 2
d=$(loop_repo stage-settings normal); mkdir -p "$d/.claude"; printf '{ "plansDirectory": "docs/plans" }\n' > "$d/.claude/settings.json"
stage_hook "$d" Write '{"file_path":".claude/settings.json"}'
pass_if "M5: .claude/settings.json is not source" test "$sh_code" = 0
# L1: the owner's acceptance tests (stop 1, before the loop) and tool caches are not source
d=$(loop_repo stage-l1 normal); mkdir -p "$d/docs/acceptance" "$d/.groundtruth" "$d/.pytest_cache" "$d/ignored-cache"
printf '# AT\n\n## Acceptance tests\n\n- a\n' > "$d/docs/acceptance/x.md"; printf '{}\n' > "$d/.groundtruth/index.json"; printf 'x\n' > "$d/.pytest_cache/v"
printf 'ignored-cache/\n' >> "$d/.git/info/exclude"; printf 'x\n' > "$d/ignored-cache/a.bin"
stage_hook "$d" Write '{"file_path":"docs/acceptance/x.md"}'
pass_if "L1: docs/acceptance/, .groundtruth/, .pytest_cache/ and paths in .git/info/exclude are not source (no violation)" test "$sh_code" = 0
write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "L1: real source next to them is still a violation" test "$sh_code" = 2
d=$(new_repo stage-badbase); mkdir -p "$d/.scratch"; printf '{ "slug": "%s", "size": "normal", "base": "no-such-branch" }
' "$SLUG" > "$d/.scratch/gates.json"
init_loop "$d"
expect "H3: a base that does not resolve is red" "$d" 1 "did not resolve to a commit when the loop started" 1 --phase build G9

# C1: deleting or truncating the log is red, and cannot clear a violation.
d=$(loop_repo stage-del normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
rm -f "$(log_of "$d")"
expect "C1: a deleted log is red" "$d" 1 "was deleted or truncated" 1 --phase build G9
rm -f "$d/src/a.js"; log_many "$d" $PLANNING
expect "C1: and running the stages after deleting it clears nothing" "$d" 1 "G9 red: hook log rejected" 1 --phase build G9
d=$(loop_repo stage-trunc normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
sed -i '$d' "$(log_of "$d")"
rm -f "$d/src/a.js"; log_many "$d" $PLANNING
expect "C1: a log truncated to drop the violation is red (it is shorter than its tip)" "$d" 1 "was truncated" 1 --phase build G9
d=$(loop_repo stage-gone normal); rm -rf "$d/.scratch/.loop"
expect "C1: a deleted .scratch/.loop directory is red, not a silent n/a" "$d" 1 "was deleted or truncated" 1 --phase build G9

# H1: a stash, a throwaway branch, a worktree or a copy elsewhere is not a revert.
d=$(loop_repo stage-stash normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
git -C "$d" stash -u -q; log_many "$d" $PLANNING
pass_if "H1: git stash -u does not clear the violation" bash -c '! grep -qF "\"kind\":\"cleared\"" "$1"' _ "$(log_of "$d")"
expect "H1: G9 names the stash" "$d" 1 "a git stash entry made after the loop started" 1 --phase build G9
git -C "$d" stash drop -q; stage_hook "$d" Bash '{"command":"git stash drop"}'
pass_if "H1: with the stash dropped the clean tree clears it" grep -qF '"kind":"cleared"' "$(log_of "$d")"
d=$(loop_repo stage-branch normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
git -C "$d" checkout -q -b tmp && git -C "$d" add -A && git -C "$d" commit -q -m tmp && git -C "$d" checkout -q feature
log_many "$d" $PLANNING
expect "H1: a throwaway branch holding the code is not a revert" "$d" 1 'a branch "tmp" made after the loop started holds source changes' 1 --phase build G9
d=$(loop_repo stage-worktree normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
rm -f "$d/src/a.js"; git -C "$d" worktree add -q "$work/stage-worktree-extra" -b wtbranch; log_many "$d" $PLANNING
expect "H1: a worktree added after the loop started blocks the clear" "$d" 1 "a git worktree added after the loop started" 1 --phase build G9
d=$(loop_repo stage-copy normal); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
cp "$d/src/a.js" "$work/stage-copy-hold.js"; rm -f "$d/src/a.js"; log_many "$d" $PLANNING
pass_if "H1: a copy elsewhere plus a delete does clear (nothing in the tree)" grep -qF '"kind":"cleared"' "$(log_of "$d")"
cp "$work/stage-copy-hold.js" "$d/src/a.js"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "H1: the same content coming back reopens the violation" bash -c 'test "$1" = 2 && printf "%s" "$2" | grep -qF "violation is reopened" && grep -qF "\"reopened\":true" "$3"' _ "$sh_code" "$sh_err" "$(log_of "$d")"
expect "H1: G9 is red again" "$d" 1 "G9 red: open violation" 1 --phase build G9

# H4: a size only goes up; small needs more than the envelope at merge.
d=$(loop_repo stage-size normal); gates_json "$d" small
log_skill "$d" behavioral-envelope; write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "H4: gates.json downgraded to small does not lower the planning skills" bash -c 'test "$1" = 2 && printf "%s" "$2" | grep -qF "for a normal change"' _ "$sh_code" "$sh_err"
d=$(loop_repo stage-upsize small); gates_json "$d" large; init_loop "$d"
pass_if "H4: a larger size in gates.json is recorded" grep -qF '"kind":"size"' "$(log_of "$d")"
d=$(loop_repo stage-small small)
log_skill "$d" behavioral-envelope; commit_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "small: the envelope alone is enough before a source change" test "$sh_code" = 0
expect "small: build G9 green with only the envelope run" "$d" 0 "G9 green" 0 --phase build G9
d=$(loop_repo stage-small-early small); write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "small: source before the envelope is a violation naming only the envelope" bash -c 'test "$1" = 2 && printf "%s" "$2" | grep -qF "missing: behavioral-envelope;"' _ "$sh_code" "$sh_err"
d=$(loop_repo stage-small-merge small); log_skill "$d" behavioral-envelope; commit_src "$d"
expect "H4: small merge G9 is red without wp-loop, code-review and live-verify" "$d" 1 "not run in this loop (no entry in the log): wp-loop; not run in this loop (no entry in the log): code-review; not run in this loop (no entry in the log): live-verify" 1 --phase merge G9
log_many "$d" wp-loop code-review live-verify
# fork.9: a Skill call alone no longer counts for the review and verification stages.
expect "fork.9 G9: Skill calls without a review file are red" "$d" 1 "code-review was logged but left no evidence on the head: no review file .scratch/review/reply-options.md" 1 --phase merge G9
expect "fork.9 G9: Skill calls without a live report are red" "$d" 1 "live-verify was logged but left no evidence on the head: no live run (.scratch/live/<run>/report.json)" 1 --phase merge G9
put_review_head "$d"
expect "fork.9 G9: a review file naming the head satisfies code-review, live-verify still needs its report" "$d" 1 "live-verify was logged but left no evidence" 1 --phase merge G9
out="$(cd "$d" && "$check" --phase merge G9)"
pass_if "fork.9 G9: ... and code-review is no longer a problem" test -z "$(printf '%s' "$out" | grep -F 'code-review was logged but')"
put_live "$d" report-pass.json
expect "small: merge G9 green once the Skills ran and left a review file and a live report on the head" "$d" 0 "G9 green" 0 --phase merge G9
expect "fork.9 G9: the pr phase asks the same of G9" "$d" 0 "G9 green" - --phase pr G9
commit_src_new "$d"
expect "fork.9 G9: a source commit after the review makes the review file stale" "$d" 1 "code-review was logged but left no evidence on the head: .scratch/review/reply-options.md is for" 1 --phase merge G9
expect "fork.9 G9: and the live report" "$d" 1 "live-verify was logged but left no evidence on the head: .scratch/live/run1/report.json: the live run ran on" 1 --phase merge G9
put_review_head "$d"; put_live "$d" report-pass.json
expect "fork.9 G9: green again once both are redone on the new head" "$d" 0 "G9 green" 0 --phase merge G9
commit_doc "$d"
expect "fork.9 G9: HEAD moved by a non-source file only: the evidence still holds" "$d" 0 "G9 green" 0 --phase merge G9
printf '# Review\n\n## Findings\n\n| ID | Severity | Status | Resolution |\n|---|---|---|---|\n| F1 | LOW | PLAUSIBLE | open |\n' > "$d/.scratch/review/$SLUG.md"
expect "fork.9 G9: a review file that names no head is red" "$d" 1 "names no head sha" 1 --phase merge G9
printf '# Review\n\n## Findings\n\nHead: %s\n' "$(git -C "$d" rev-parse HEAD)" > "$d/.scratch/review/$SLUG.md"
expect "fork.9 G9: a review file with no findings table is red" "$d" 1 "has no ## Findings table" 1 --phase merge G9
put_review_head "$d"
expect "small: close G9 is red without retro" "$d" 1 "retro" 1 --phase close G9
log_skill "$d" retro
expect "small: close G9 green with retro logged" "$d" 0 "G9 green" 0 --phase close G9

# fork.9: in a loop with a plan_sha the codex code attack (G11) replaces adversarial-review.
d=$(loop_repo stage-planned normal); gates_json_with "$d" normal "\"plan_sha\": \"$(printf 'p%.0s' {1..64} | tr p a)\""; init_loop "$d"
log_many "$d" $PLANNING; commit_src "$d"; log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"; put_review_head "$d"; put_live "$d" report-pass.json
expect "fork.9 G9: with a plan_sha, adversarial-review is not needed at merge" "$d" 0 "G9 green" 0 --phase merge G9
d=$(loop_repo stage-unplanned normal); log_many "$d" $PLANNING; commit_src "$d"; log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"; put_review_head "$d"; put_live "$d" report-pass.json
expect "fork.9 G9: without a plan_sha it still is" "$d" 1 "not run in this loop (no entry in the log): adversarial-review" 1 --phase merge G9

# Normal: code-review, live-verify and adversarial-review after the last source commit (L3: with a margin).
d=$(loop_repo stage-normal normal)
log_many "$d" $PLANNING; commit_src "$d"
expect "normal: merge G9 is red without code-review, live-verify and adversarial-review" "$d" 1 "not run in this loop (no entry in the log): code-review; not run in this loop (no entry in the log): live-verify; not run in this loop (no entry in the log): adversarial-review" 1 --phase merge G9
log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"; put_review_head "$d"; put_live "$d" report-pass.json
log_skill "$d" adversarial-review "$PAST"
expect "normal: adversarial-review logged before the last source commit does not count" "$d" 1 "adversarial-review was logged before the last source change" 1 --phase merge G9
ct=$(git -C "$d" log -1 --format=%ct)
log_skill "$d" adversarial-review "$(date -u -d "@$((ct - 3))" +%Y-%m-%dT%H:%M:%SZ)"
expect "L3: a review logged three seconds before the commit time does not count" "$d" 1 "adversarial-review was logged before the last source change" 1 --phase merge G9
log_skill "$d" adversarial-review "$(date -u -d "@$((ct - 1))" +%Y-%m-%dT%H:%M:%SZ)"
expect "L3: a review logged one second before the commit time counts (clock rounding only)" "$d" 0 "G9 green" 0 --phase merge G9
log_skill "$d" adversarial-review "$FUTURE"
expect "normal: merge G9 green with every stage logged after the source" "$d" 0 "G9 green" 0 --phase merge G9
expect "normal: close G9 is red without retro" "$d" 1 "retro" 1 --phase close G9
printf 'export const x = 2;%s' "" > "$d/src/a.js"; touch -d 2100-01-02 "$d/src/a.js"
expect "normal: a source edit after the reviews makes them stale" "$d" 1 "was logged before the last source change" - --phase merge G9

# M1: plan waivers only from a plan that was hashed at init.
d=$(new_repo stage-plan); session_start "$d"; gates_json "$d" normal; mkdir -p "$d/docs/plans"; put "$d" plan-complete.md "docs/plans/$SLUG.md"; put "$d" loop-status-from-plan.md .scratch/loop-status.md
init_loop "$d"; log_many "$d" deep-engineering behavioral-envelope to-spec; write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "shape and to-tickets covered by a plan that existed at init count for their slots" test "$sh_code" = 0
printf '\n## Changes\n\n- Changed: dropped the retry queue because it is out of scope\n' >> "$d/docs/plans/$SLUG.md"; stage_hook "$d" Bash '{"command":"ls"}'
pass_if "M1: a Changed line appended to the plan keeps the waiver" test "$sh_code" = 0
d=$(new_repo stage-plan-late); session_start "$d"; gates_json "$d" normal; init_loop "$d"
mkdir -p "$d/docs/plans"; put "$d" plan-complete.md "docs/plans/$SLUG.md"; put "$d" loop-status-from-plan.md .scratch/loop-status.md
log_many "$d" deep-engineering behavioral-envelope to-spec; write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "M1: a plan written after init waives nothing" test "$sh_code" = 2
d=$(new_repo stage-plan-edit); session_start "$d"; gates_json "$d" normal; mkdir -p "$d/docs/plans"; put "$d" plan-complete.md "docs/plans/$SLUG.md"; put "$d" loop-status-from-plan.md .scratch/loop-status.md
init_loop "$d"; printf 'A new decision slipped in.\n' | cat - "$d/docs/plans/$SLUG.md" > "$d/docs/plans/edited.tmp" && mv "$d/docs/plans/edited.tmp" "$d/docs/plans/$SLUG.md"
log_many "$d" deep-engineering behavioral-envelope to-spec; write_src "$d"; stage_hook "$d" Write '{"file_path":"src/a.js"}'
pass_if "M1: a plan edited after init (outside ## Changes) waives nothing" test "$sh_code" = 2

# Large: a design-challenge file written after an opus subagent that names the design challenge, logged before to-spec (M2).
d=$(loop_repo stage-large large)
log_agent "$d" sonnet "2010-01-01T00:00:00Z"
log_many "$d" $PLANNING; commit_src "$d"; log_many "$d" wp-loop; log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"; log_skill "$d" adversarial-review "$FUTURE"
put_review_head "$d"; put_live "$d" report-pass.json
expect "large: red without a design-challenge file" "$d" 1 "large work needs the design challenge written to .scratch/design-challenge/" - --phase merge G9
mkdir -p "$d/.scratch/design-challenge"; printf '## Findings\n\n- F1 CONFIRMED: retry storm\n' > "$d/.scratch/design-challenge/$SLUG.md"
expect "large: a subagent on sonnet is not enough, red without an opus one" "$d" 1 "large work needs a subagent on opus whose description names the design challenge" 1 --phase merge G9
log_agent "$d" opus "2010-02-01T00:00:00Z" "attack the design"
expect "M2: an opus subagent whose description does not name the design challenge does not count" "$d" 1 "whose description names the design challenge" 1 --phase merge G9
log_agent "$d" opus "2030-01-01T00:00:00Z"
expect "large: an opus design-challenge subagent logged after to-spec is too late" "$d" 1 "logged before to-spec" 1 --phase merge G9
log_agent "$d" opus "2010-06-01T00:00:00Z"
expect "large: green with the design challenge file and an opus subagent before to-spec" "$d" 0 "G9 green" 0 --phase merge G9
touch -d 2000-01-01 "$d/.scratch/design-challenge/$SLUG.md"
expect "M2: a design-challenge file older than the opus subagent is red" "$d" 1 "older than the opus subagent" 1 --phase merge G9

# Hand-written lines, edited lines, removed lines and a missing key are rejected.
d=$(loop_repo stage-tamper normal)
log_many "$d" $PLANNING; commit_src "$d"; log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"; log_skill "$d" adversarial-review "$FUTURE"
put_review_head "$d"; put_live "$d" report-pass.json
expect "tamper: untouched log is green" "$d" 0 "G9 green" 0 --phase merge G9
cp "$(log_of "$d")" "$work/stage-tamper.bak"
printf '{"kind":"skill","skill":"retro","ts":"2020-01-01T00:00:00Z","session":"s1"}\n' >> "$(log_of "$d")"
expect "tamper: a line written by hand (no HMAC) is rejected" "$d" 1 "fails its HMAC" 1 --phase merge G9
cp "$work/stage-tamper.bak" "$(log_of "$d")"
sed -i 's/"skill":"code-review"/"skill":"code-reviex"/' "$(log_of "$d")"
expect "tamper: an edited line is rejected" "$d" 1 "fails its HMAC" 1 --phase merge G9
cp "$work/stage-tamper.bak" "$(log_of "$d")"
sed -i '3d' "$(log_of "$d")"
expect "tamper: a removed line breaks the chain" "$d" 1 "does not follow the line before it" 1 --phase merge G9
d=$(loop_repo stage-nokey normal)
log_many "$d" $PLANNING; rm -f "$d/.claude/.loop/key"
expect "M4: a deleted key is a loud error, not a quiet regenerate" "$d" 1 "the loop key (.claude/.loop/key) is missing after init" 1 --phase build G9
log_skill "$d" code-review
pass_if "M4: the hook says so and does not regenerate the key" bash -c 'test "$1" = 2 && printf "%s" "$2" | grep -qF "never regenerated" && test ! -e "$3/.claude/.loop/key"' _ "$sh_code" "$sh_err" "$d"
d=$(loop_repo stage-nostate normal); log_many "$d" $PLANNING; rm -f "$(state_file "$d")"
expect "tamper: a deleted marker outside the repo is red" "$d" 1 "the loop state outside the repo (state.json) is missing" 1 --phase build G9

# H2 and H5: the push and merge hooks make G9 mandatory, and a vanished or hand-closed loop blocks them.
d=$(new_repo stage-h2); gates_json "$d" normal; put "$d" shape.md ".scratch/shape/$SLUG.md"; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
HOOK_NOREADY=1 hook_case "H2: a push with no stage log at all is blocked by G9" "$d" "git push -u origin feature" 2 "G9 red: no signed init entry"
hook_case "H2: the same push passes once the loop has its signed init" "$d" "git push -u origin feature" 0 ""
d=$(loop_repo stage-h5 normal); put "$d" shape.md ".scratch/shape/$SLUG.md"; put "$d" envelope.md ".scratch/envelope/$SLUG.md"
printf '{ "slug": "%s", "size": "normal", "base": "main", "status": "closed" }\n' "$SLUG" > "$d/.scratch/gates.json"
hook_case "H5: status closed without a signed close entry blocks a push" "$d" "git push -u origin feature" 2 "no signed close entry"
hook_case "H5: and a merge" "$d" "gh pr merge 5 --match-head-commit $(git -C "$d" rev-parse HEAD)" 2 "no signed close entry"
rm -f "$d/.scratch/gates.json"
hook_case "H5: a deleted gates.json blocks a push" "$d" "git push -u origin feature" 2 "gates.json is gone"
d=$(loop_repo stage-h5-close small); put "$d" envelope.md ".scratch/envelope/$SLUG.md"
log_skill "$d" behavioral-envelope; commit_src "$d"; log_many "$d" wp-loop retro; log_skill "$d" code-review "$FUTURE"; log_skill "$d" live-verify "$FUTURE"
put_live "$d" report-pass.json; put_review_head "$d"
(cd "$d" && "$check" --phase close >/dev/null 2>&1); code=$?
pass_if "H5: a passing close phase signs a close entry" bash -c 'test "$1" = 0 && grep -qF "\"kind\":\"close\"" "$2"' _ "$code" "$(log_of "$d")"
printf '{ "slug": "%s", "size": "small", "base": "main", "status": "closed" }\n' "$SLUG" > "$d/.scratch/gates.json"
hook_case "H5: a loop closed after its signed close entry is silent" "$d" "git push -u origin feature" 0 ""
rm -f "$d/.scratch/gates.json"
hook_case "H5: a deleted gates.json after a signed close is fine" "$d" "git push -u origin feature" 0 ""
# fork.9.4: wp-loop on its own. The owner's approvals create the signed store but no loop ever starts (no init entry),
# so a push or a PR is not a vanished loop. A started loop whose gates.json is deleted is still refused (H5 above).
d=$(new_repo stage-approvals-only)
node -e 'import(require("url").pathToFileURL(process.argv[1]).href).then((m) => { const why = m.recordSigned(process.argv[2], { kind: "approval", stop: "plan", plan_sha: "abc", plan_file: "docs/plans/p.md", ts: new Date().toISOString(), session: "s1" }); if (why) { console.error(why); process.exit(1); } })' "$here/approval.mjs" "$d"
pass_if "A3: approvals alone make a signed store with no init entry" bash -c 'test -s "$1" && grep -qF "\"kind\":\"approval\"" "$1" && ! grep -qF "\"kind\":\"init\"" "$1"' _ "$(log_of "$d")"
pass_if "A3: stage-guard passes a store with approvals and no init" bash -c 'node "$1" "$2"' _ "$here/stage-guard.mjs" "$d"
HOOK_NOREADY=1 hook_case "A3: a push with only approvals signed is not a vanished loop" "$d" "git push -u origin feature" 0 ""

# ---- errors are not hidden

fa=$(new_repo add-fails); gates_json "$fa" normal
hook_case "a failing chained git add fails closed with its error shown" "$fa" 'git add no-such-file && git commit -m x' 2 "git add failed"
hook_case "a failing chained git add names the path" "$fa" 'git add no-such-file && git commit -m x' 2 "no-such-file"
# ---- fork.9: G3/G4 head rule (above), the G4 Packs bypass, G10 to G12, the pr phase, PR and merge refusal
SKIPPING=""
export PATH="$bin:$PATH" # the gh stand-in answers `gh run list --commit` for the pr phase
unset FAKE_GH_RUNS FAKE_GH_RUN_FAIL FAKE_GH_LOG
PLAN_SHA=$(tr -d '\r' < "$fx/plan-acceptance.md" | sha256sum | cut -c1-64); OTHER_SHA=$(printf 'cd%.0s' {1..32})
APPR="$work/approvals.json"
# set_approvals <json list>: the owner's verified approvals, as builder B's stage-log.mjs approvals(root) returns them.
# The gates read them through gates-approvals.mjs, which takes this file in tests (FEATURE_LOOP_APPROVALS_FIXTURE).
set_approvals() { printf '%s\n' "$1" > "$APPR"; export FEATURE_LOOP_APPROVALS_FIXTURE="$APPR"; }
approve() { # <stop> <plan_sha or head>: one approval object
  case "$1" in
    pr) printf '{"stop":"pr","head":"%s","at":"2026-10-11T10:00:00Z"}' "$2" ;;
    acceptance) printf '{"stop":"acceptance","acceptance_sha":"%s","at":"2026-10-11T10:00:00Z"}' "$2" ;;
    *) printf '{"stop":"%s","plan_sha":"%s","at":"2026-10-11T10:00:00Z"}' "$1" "$2" ;;
  esac
}
# at_key <plan file>: the key of its acceptance tests (acceptance-key.mjs), the subject of "approve acceptance".
at_key() { # paths go in as arguments, which Git Bash converts for node; a path inside the -e code would not be
  node --input-type=module -e "const { pathToFileURL } = await import('node:url'); const { readFileSync } = await import('node:fs'); const { acceptanceKeyOf } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(acceptanceKeyOf(readFileSync(process.argv[2], 'utf8')));" "$here/acceptance-key.mjs" "$1"
}
AT_KEY=$(at_key "$fx/plan-acceptance.md"); AT_KEY_TWO=$(at_key "$fx/plan-acceptance-two.md")
[ ${#AT_KEY} = 64 ] && [ ${#AT_KEY_TWO} = 64 ] || { echo "FAIL at_key could not compute the acceptance keys"; exit 1; }
gates_json_f9() { mkdir -p "$1/.scratch"; printf '{ "slug": "%s", "size": "%s", "base": "main", "plan_sha": "%s" }\n' "$SLUG" "${2:-normal}" "${3:-$PLAN_SHA}" > "$1/.scratch/gates.json"; }

# codex_report <dir> <kind> <subject_sha> <findings JSON> [exit_code] [model]: the report codex-review.sh writes.
codex_report() {
  mkdir -p "$1/.scratch/review"
  node -e 'const [dir, kind, subject, findings, exit, model] = process.argv.slice(1);
    require("fs").writeFileSync(`${dir}/.scratch/review/codex-${kind}-${process.env.SLUG_X}.json`, JSON.stringify({ kind, model: model || "gpt-6-astra", codex_version: "1.0.0", subject_sha: subject, base: "main", started: "2026-10-11T10:00:00Z", finished: "2026-10-11T10:05:00Z", exit_code: Number(exit ?? 0), summary: "s", findings: JSON.parse(findings) }, null, 2));' "$1" "$2" "$3" "$4" "${5:-0}" "${6:-}"
}
export SLUG_X="$SLUG"
finding() { # <id> <severity> <status>
  printf '{"id":"%s","severity":"%s","status":"%s","title":"t","where":"src/a.js:1","evidence":"e","repro":"r"}' "$1" "$2" "$3"
}
resolutions() { # <dir> <kind> <rows: "id|resolution" ...>
  local d="$1" k="$2" r; shift 2
  mkdir -p "$d/.scratch/review"
  { printf '# Resolutions\n\n| id | resolution |\n|---|---|\n'; for r in "$@"; do printf '| %s | %s |\n' "${r%%|*}" "${r#*|}"; done; } > "$d/.scratch/review/codex-$k-$SLUG.resolutions.md"
}
head_of() { git -C "$1" rev-parse HEAD; }

# ---- G10: codex plan review (fork.9.1: the approved plan is what a signed approve plan holds, not gates.json)

plan_repo() { # <name>: a repo whose docs/plans/<slug>.md (the fixture, the version PLAN_SHA names) is committed
  local r; r=$(new_repo "$1"); put "$r" plan-acceptance.md "docs/plans/$SLUG.md"; git -C "$r" add -A; git -C "$r" commit -q -m "the plan"; printf '%s' "$r"
}
commit_plan() { # <dir> <text>: write the plan file and commit it; prints the sha256 of its LF form
  printf '%b' "$2" > "$1/docs/plans/$SLUG.md"; git -C "$1" add -A; git -C "$1" commit -q -m "plan version $RANDOM"
  tr -d '\r' < "$1/docs/plans/$SLUG.md" | sha256sum | cut -c1-64
}
sha_lf() { printf '%b' "$1" | tr -d '\r' | sha256sum | cut -c1-64; }

d=$(plan_repo g10); gates_json_f9 "$d"; set_approvals "[$(approve plan "$PLAN_SHA")]"
expect "G10 red: no codex plan report" "$d" 1 "G10 red: no codex plan report: run the codex-review skill in plan mode (.scratch/review/codex-plan-reply-options.json)" 1 G10
codex_report "$d" plan "$PLAN_SHA" '[]'
expect "G10 green: report on the approved committed plan, nothing confirmed, signed approve plan" "$d" 0 "G10 green" 0 G10
codex_report "$d" plan "$PLAN_SHA" '[]' 2
expect "G10 red: exit_code is not 0" "$d" 1 "exit_code is 2, not 0" 1 G10
codex_report "$d" plan "$PLAN_SHA" '[]' 0 some-other-model
expect "G10 red: model is not the configured one" "$d" 1 "model is \"some-other-model\", not the configured gpt-6-astra" 1 G10
d_env="$(cd "$d" && CODEX_REVIEW_MODEL=some-other-model "$check" G10 2>&1)"
pass_if "G10: CODEX_REVIEW_MODEL changes the configured model" test "$(printf '%s' "$d_env" | grep -c '^G10 green')" = 1
codex_report "$d" plan "$OTHER_SHA" '[]'
expect "G10 red: the review is of a plan that was never committed in this file" "$d" 1 "not a committed version of docs/plans/$SLUG.md" 1 G10

# L3: the plan file moves on after the approval; only a change outside ## Changes needs a new approval
d2=$(new_repo g10-version); mkdir -p "$d2/docs/plans"
draft_sha=$(commit_plan "$d2" '# Plan\n\nfirst draft\n\n## Changes\n\n')
final_sha=$(commit_plan "$d2" '# Plan\n\nfirst draft\n\nfolded: codex finding P1\n\n## Changes\n\n')
gates_json_f9 "$d2"; set_approvals "[$(approve plan "$final_sha")]"; codex_report "$d2" plan "$draft_sha" '[]'
expect "G10 green: the review is of an earlier committed version, the approval of the final one" "$d2" 0 "G10 green" 0 G10
gates_json_f9 "$d2" normal "$OTHER_SHA"
expect "G10 green: gates.json plan_sha is informational, it does not decide" "$d2" 0 "G10 green" 0 G10
gates_json_f9 "$d2"
printf '# Plan\n\nfirst draft\n\nfolded: codex finding P1\n\n## Changes\n\nChanged: the retry cap because the review said so\n' > "$d2/docs/plans/$SLUG.md"
expect "L3: after approve plan, an edit that is only inside ## Changes (uncommitted) is still green" "$d2" 0 "G10 green" 0 G10
git -C "$d2" add -A; git -C "$d2" commit -q -m "changed line"
expect "L3: ... and still green once committed" "$d2" 0 "G10 green" 0 G10
printf '# Plan\n\nfirst draft, reworded\n\nfolded: codex finding P1\n\n## Changes\n\nChanged: the retry cap because the review said so\n' > "$d2/docs/plans/$SLUG.md"
expect "L3: an edit of another section is red and says a changed plan needs approve plan again" "$d2" 1 'changed outside "## Changes" since the owner approved it' 1 G10
expect "L3: ... naming the fix" "$d2" 1 'a changed plan needs "approve plan" again' 1 G10
git -C "$d2" add -A; git -C "$d2" commit -q -m "reword"
expect "L3: ... also when the reworded plan is committed" "$d2" 1 'needs "approve plan" again' 1 G10
reworded_sha=$(tr -d '\r' < "$d2/docs/plans/$SLUG.md" | sha256sum | cut -c1-64)
set_approvals "[$(approve plan "$final_sha"),$(approve plan "$reworded_sha")]"
expect "L3: a new approve plan for the reworded version makes it green again" "$d2" 0 "G10 green" 0 G10
codex_report "$d2" plan "$reworded_sha" '[]'
expect "L3: a review of the approved version itself counts" "$d2" 0 "G10 green" 0 G10
set_approvals "[$(approve plan "$(sha_lf 'never committed\n')")]"
expect "L3: an approval of a plan that was never committed is red" "$d2" 1 'no "approve plan" for a committed version' 1 G10
# a review of a version LATER than the approved one does not count
d4=$(new_repo g10-later); mkdir -p "$d4/docs/plans"
v1_sha=$(commit_plan "$d4" '# Plan\n\none\n\n## Changes\n\n'); v2_sha=$(commit_plan "$d4" '# Plan\n\ntwo\n\n## Changes\n\n')
printf '# Plan\n\none\n\n## Changes\n\n' > "$d4/docs/plans/$SLUG.md"
gates_json_f9 "$d4"; set_approvals "[$(approve plan "$v1_sha")]"; codex_report "$d4" plan "$v2_sha" '[]'
expect "L3: a review of a version after the approved one is red" "$d4" 1 "at or before the approved one" 1 G10

# S3: a plan committed with CRLF line endings is hashed as its LF form (the sha codex-review.sh stamps)
d3=$(new_repo g10-crlf); mkdir -p "$d3/docs/plans"
crlf_sha=$(commit_plan "$d3" '# Plan\r\n\r\ncrlf draft\r\n\r\n## Changes\r\n\r\n')
crlf_final=$(commit_plan "$d3" '# Plan\r\n\r\ncrlf draft\r\n\r\nfolded\r\n\r\n## Changes\r\n\r\n')
gates_json_f9 "$d3"; set_approvals "[$(approve plan "$crlf_final")]"; codex_report "$d3" plan "$crlf_sha" '[]'
expect "G10 green: the LF sha of a CRLF plan matches its committed blobs, review and approval" "$d3" 0 "G10 green" 0 G10

d=$(plan_repo g10-res); gates_json_f9 "$d"; set_approvals "[$(approve plan "$PLAN_SHA")]"
codex_report "$d" code "$PLAN_SHA" '[]'; mv "$d/.scratch/review/codex-code-$SLUG.json" "$d/.scratch/review/codex-plan-$SLUG.json"
expect "G10 red: a code report cannot stand in for the plan review" "$d" 1 'kind is "code", not "plan"' 1 G10
codex_report "$d" plan "$PLAN_SHA" "[$(finding P1 HIGH CONFIRMED),$(finding P2 LOW PLAUSIBLE)]"
expect "G10 red: a CONFIRMED finding with no resolutions file" "$d" 1 "CONFIRMED finding with no \"fixed: <commit>\" or \"rejected: <reason>\" row in .scratch/review/codex-plan-reply-options.resolutions.md: P1 HIGH" 1 G10
resolutions "$d" plan "P1|open"
expect "G10 red: a resolution that is neither fixed nor rejected" "$d" 1 "P1 HIGH" 1 G10
resolutions "$d" plan "P1|fixed: abc1234"
expect "G10 green: CONFIRMED finding fixed, PLAUSIBLE one needs no row" "$d" 0 "G10 green" 0 G10
resolutions "$d" plan "P1|rejected: the plan already says so in Decisions"
expect "G10 green: CONFIRMED finding rejected with a reason" "$d" 0 "G10 green" 0 G10
resolutions "$d" plan "P1|rejected:"
expect "G10 red: rejected with no reason" "$d" 1 "P1 HIGH" 1 G10
codex_report "$d" plan "$PLAN_SHA" "[$(finding P3 LOW CONFIRMED)]"; resolutions "$d" plan "P9|fixed: abc1234"
expect "G10 red: every CONFIRMED finding needs a row, whatever its severity" "$d" 1 "P3 LOW" 1 G10
codex_report "$d" plan "$PLAN_SHA" '[]'
set_approvals '[]'
expect "G10 red: no signed approve plan" "$d" 1 'the signed log has no "approve plan" for a committed version of the plan' 1 G10
set_approvals "[$(approve plan "$OTHER_SHA")]"
expect "G10 red: approve plan for another plan" "$d" 1 'no "approve plan"' 1 G10
set_approvals "[$(approve acceptance "$PLAN_SHA"),$(approve pr "$(head_of "$d")")]"
expect "G10 red: approve acceptance or pr is not approve plan" "$d" 1 'no "approve plan"' 1 G10
FEATURE_LOOP_APPROVALS_FIXTURE="$work/no-such-approvals.json" expect "G10 red: approvals that cannot be read fail closed" "$d" 1 "approvals could not be read" 1 G10
set_approvals "[$(approve plan "$PLAN_SHA")]"
d=$(plan_repo g10-noplansha); gates_json "$d" normal; codex_report "$d" plan "$PLAN_SHA" '[]'
expect "G10 does not need plan_sha in gates.json (it is informational)" "$d" 0 "G10 green" 0 G10
d=$(new_repo g10-badplansha); gates_json_with "$d" normal '"plan_sha": "abc"'
expect "plan_sha must be 64 hex digits" "$d" 2 '"plan_sha" must be the sha256 (64 hex digits) of the approved plan' 0
d=$(plan_repo g10-small); gates_json_f9 "$d" small; codex_report "$d" plan "$PLAN_SHA" '[]'
expect "G10 applies to small work too" "$d" 0 "G10 green" 0 G10

# ---- G11: codex code attack

d=$(new_repo g11); gates_json_f9 "$d"; set_approvals "[]"
expect "G11 red: no codex code report" "$d" 1 "G11 red: no codex code report: run the codex-review skill in code mode" 1 G11
codex_report "$d" code "$(head_of "$d")" '[]'
expect "G11 green: report on HEAD, nothing found" "$d" 0 "G11 green" 0 G11
codex_report "$d" code "$(head_of "$d")" '[]' 3
expect "G11 red: exit_code not 0" "$d" 1 "exit_code is 3, not 0" 1 G11
codex_report "$d" code "$(head_of "$d")" '[]' 0 other-model
expect "G11 red: model not the configured one" "$d" 1 "model is \"other-model\"" 1 G11
codex_report "$d" code "$(head_of "$d")" '[]'; commit_src_new "$d"
expect "G11 red: the attack ran on an older head and source changed since" "$d" 1 "the attack ran on" 1 G11
expect "G11 red: ... and says to run it again" "$d" 1 "run the code attack again on this head" 1 G11
codex_report "$d" code "$(head_of "$d")" '[]'; commit_doc "$d"
expect "G11 green: HEAD moved only by a non-source file since the attack" "$d" 0 "G11 green" 0 G11
codex_report "$d" code "$(head_of "$d")" '[]'; printf 'x\n' > "$d/src/edit.js"
expect "G11 red: uncommitted source edits since the attack" "$d" 1 "uncommitted: src/edit.js" 1 G11
rm "$d/src/edit.js"
codex_report "$d" code "$(head_of "$d")" "[$(finding C1 CRITICAL CONFIRMED)]"
expect "G11 red: a CONFIRMED CRITICAL with no resolutions" "$d" 1 "C1 CRITICAL" 1 G11
codex_report "$d" code "$(head_of "$d")" "[$(finding C1 HIGH CONFIRMED)]"
expect "G11 red: a CONFIRMED HIGH with no resolutions" "$d" 1 "C1 HIGH" 1 G11
codex_report "$d" code "$(head_of "$d")" "[$(finding C1 HIGH PLAUSIBLE),$(finding C2 MEDIUM CONFIRMED),$(finding C3 LOW CONFIRMED)]"
expect "G11 green: PLAUSIBLE HIGH and CONFIRMED MEDIUM or LOW need no resolution" "$d" 0 "G11 green" 0 G11
codex_report "$d" code "$(head_of "$d")" "[$(finding C1 HIGH CONFIRMED)]"; resolutions "$d" code "C1|rejected: not reachable, the route is behind auth (src/auth.js:9)"
expect "G11 green: a CONFIRMED HIGH rejected with a reason" "$d" 0 "G11 green" 0 G11
resolutions "$d" code "C1|open"
expect "G11 red: open is not a resolution" "$d" 1 "C1 HIGH" 1 G11

# fixed: the repro is kept, the fix commit is on the branch, and the repo has an equivalent test.
fixed_repo() { # <name>: a repo whose fix commit adds tests/c1.test.js; prints the dir; the fix sha is in $FIX
  local r; r=$(new_repo "$1"); gates_json_f9 "$r"
  mkdir -p "$r/tests" && printf 'test("c1", () => {});\n' > "$r/tests/c1.test.js" && git -C "$r" add -A && git -C "$r" commit -q -m "fix C1"
  FIX=$(git -C "$r" rev-parse HEAD); printf '%s' "$r"
}
d=$(fixed_repo g11-fixed); FIX=$(head_of "$d"); codex_report "$d" code "$(head_of "$d")" "[$(finding C1 HIGH CONFIRMED)]"; resolutions "$d" code "C1|fixed: $FIX"
expect "G11 red: fixed but its repro is not in codex-repros/<id>/" "$d" 1 "C1 is fixed but its repro is not in .scratch/review/codex-repros/C1/" 1 G11
mkdir -p "$d/.scratch/review/codex-repros/C1"; printf 'test("c1", () => {});\n' > "$d/.scratch/review/codex-repros/C1/c1.repro.test.js"
expect "G11 green: fixed, repro kept, and the fix commit added a test" "$d" 0 "G11 green" 0 G11
resolutions "$d" code "C1|fixed: 0123456789abcdef"
expect "G11 red: fixed: names a commit that is not on this branch" "$d" 1 "is not a commit on this branch" 1 G11
d=$(new_repo g11-notest); gates_json_f9 "$d"; commit_src_new "$d"; FIX=$(head_of "$d")
codex_report "$d" code "$FIX" "[$(finding C1 HIGH CONFIRMED)]"; resolutions "$d" code "C1|fixed: $FIX"
mkdir -p "$d/.scratch/review/codex-repros/C1"; printf 'test("c1", () => {});\n' > "$d/.scratch/review/codex-repros/C1/c1.repro.test.js"
expect "G11 red: fixed, but the repo has no test equivalent to the repro" "$d" 1 "the repo has no test equivalent to its repro" 1 G11
mkdir -p "$d/tests"; printf 'test("c1", () => {});\n' > "$d/tests/c1.repro.test.js"; git -C "$d" add -A; git -C "$d" commit -q -m "add the repro as a test"
codex_report "$d" code "$(head_of "$d")" "[$(finding C1 HIGH CONFIRMED)]"
expect "G11 green: the repro file is in the tree by name" "$d" 0 "G11 green" 0 G11
d=$(new_repo g11-small); gates_json_f9 "$d" small; codex_report "$d" code "$(head_of "$d")" '[]'
expect "G11 applies to small work too" "$d" 0 "G11 green" 0 G11

# ---- G12: acceptance

at_repo() { # <name>: a repo with the plan's acceptance tests mapped and passing on HEAD; approvals set
  local r; r=$(new_repo "$1"); gates_json_f9 "$r"; put "$r" plan-acceptance.md "docs/plans/$SLUG.md"
  mkdir -p "$r/tests"; printf 't\n' > "$r/tests/at2.test.js"; printf 't\n' > "$r/tests/at3.test.js"; git -C "$r" add -A; git -C "$r" commit -q -m "acceptance tests"
  put_live "$r" report-pass.json
  sed "s/@SHA@/$(head_of "$r")/" "$fx/acceptance-ok.md" > "$r/.scratch/acceptance.md"
  set_approvals "[$(approve acceptance "$AT_KEY")]"
  printf '%s' "$r"
}
d=$(at_repo g12)
expect "G12 green: every acceptance test mapped to a test or scenario, passing on HEAD, approved" "$d" 0 "G12 green" 0 G12
d=$(at_repo g12-noplansec); put "$d" plan-complete.md "docs/plans/$SLUG.md"
expect "G12 red: the plan has no ## Acceptance tests section" "$d" 1 "the plan has no ## Acceptance tests section" 1 G12
d=$(at_repo g12-noplan); rm "$d/docs/plans/$SLUG.md"
expect "G12 red: no plan file" "$d" 1 "the plan has no ## Acceptance tests section" 1 G12
d=$(at_repo g12-nomap); rm "$d/.scratch/acceptance.md"
expect "G12 red: no .scratch/acceptance.md" "$d" 1 "no .scratch/acceptance.md mapping each acceptance test" 1 G12
d=$(at_repo g12-unmapped); grep -v '^| AT3' "$d/.scratch/acceptance.md" > "$d/.scratch/a.tmp"; mv "$d/.scratch/a.tmp" "$d/.scratch/acceptance.md"
expect "G12 red: an acceptance test with no row is unmapped" "$d" 1 "AT3 is not mapped" 1 G12
d=$(at_repo g12-empty-target); sed -i 's/^| AT2 | tests\/at2.test.js /| AT2 |  /' "$d/.scratch/acceptance.md"
expect "G12 red: a row that maps to nothing" "$d" 1 "AT2 maps to no test or scenario" 1 G12
d=$(at_repo g12-nofile); rm "$d/tests/at2.test.js"; git -C "$d" add -A; git -C "$d" commit -q -m rm; sed -i "s/pass [0-9a-f]\{40\}/pass $(head_of "$d")/" "$d/.scratch/acceptance.md"; put_live "$d" report-pass.json
expect "G12 red: the mapped test file does not exist" "$d" 1 "AT2 its test tests/at2.test.js does not exist" 1 G12
d=$(at_repo g12-noscenario); sed -i 's/first reply after install/a scenario nobody ran/' "$d/.scratch/acceptance.md"
expect "G12 red: the named scenario is in no live report" "$d" 1 'AT1 has no live-verify scenario named "a scenario nobody ran" in a report' 1 G12
d=$(at_repo g12-failscen); put_live "$d" report-fail.json; sed -i 's/first reply after install/two reviewers race/' "$d/.scratch/acceptance.md"
expect "G12 red: the named scenario failed in the live report" "$d" 1 'AT1 live-verify scenario "two reviewers race" has no passing result on HEAD' 1 G12
d=$(at_repo g12-failing); sed -i '0,/pass /s//fail /' "$d/.scratch/acceptance.md"
expect "G12 red: a failing result" "$d" 1 "AT1 is failing" 1 G12
d=$(at_repo g12-noresult); sed -i 's/pass [0-9a-f]\{40\}//' "$d/.scratch/acceptance.md"
expect "G12 red: a result with no sha" "$d" 1 'has no "pass <sha>" result' 1 G12
d=$(at_repo g12-stale); commit_src_new "$d"
expect "G12 red: results are for an older head and source changed since" "$d" 1 "AT2 result ran on" 1 G12
d=$(at_repo g12-nonsource); commit_doc "$d"
expect "G12 green: HEAD moved only by a non-source file" "$d" 0 "G12 green" 0 G12
d=$(at_repo g12-noappr); set_approvals '[]'
expect "G12 red: no signed approve acceptance" "$d" 1 'the signed log has no "approve acceptance"' 1 G12
set_approvals "[$(approve plan "$PLAN_SHA")]"
expect "G12 red: approve plan is not approve acceptance" "$d" 1 'no "approve acceptance"' 1 G12
set_approvals "[$(approve acceptance "$OTHER_SHA")]"
expect "G12 red: approve acceptance for other acceptance tests" "$d" 1 'no "approve acceptance"' 1 G12
set_approvals "[$(approve acceptance "$PLAN_SHA")]"
expect "G12 red: an acceptance approval keyed to the plan file, not the tests, does not count" "$d" 1 'no "approve acceptance"' 1 G12
d=$(at_repo g12-edited); put "$d" plan-acceptance-two.md "docs/plans/$SLUG.md"
expect "G12 red: edited acceptance tests need a fresh approval" "$d" 1 'a changed test needs a fresh approval' 1 G12
d=$(at_repo g12-two); put "$d" plan-acceptance-two.md "docs/plans/$SLUG.md"; set_approvals "[$(approve acceptance "$AT_KEY_TWO")]"
expect "G12 green: items without an AT id are numbered AT1, AT2 in order; extra rows are ignored" "$d" 0 "G12 green" 0 G12
d=$(at_repo g12-small); gates_json_f9 "$d" small
expect "G12 applies to small work too" "$d" 0 "G12 green" 0 G12
# G12: the test cell is a tracked test path, path::test name, or a live scenario name (documented in gates.md and plan-first)
at_map() { # <dir> <AT1 cell> <AT2 cell> <AT3 cell>
  local h; h=$(head_of "$1")
  printf '# Acceptance\n\n| AT id | test path or scenario name | last result on <sha> |\n|---|---|---|\n| AT1 | %s | pass %s |\n| AT2 | %s | pass %s |\n| AT3 | %s | pass %s |\n' "$2" "$h" "$3" "$h" "$4" "$h" > "$1/.scratch/acceptance.md"
}
d=$(at_repo g12-forms); at_map "$d" "first reply after install" "tests/at2.test.js" "tests/at3.test.js::never auto-sent"
expect "G12 green: a scenario name, a plain tracked path and path::test name in one table" "$d" 0 "G12 green" 0 G12
at_map "$d" "first reply after install" "tests/at2.test.js:12" "\`tests/at3.test.js::never auto-sent\`"
expect "G12 green: a path with a line number, and a path::name in backticks" "$d" 0 "G12 green" 0 G12
at_map "$d" "first reply after install" "tests/at2.test.js#case" "tests/at3.test.js never auto-sent (prose after the path)"
expect "G12 green: path#name, and a path followed by prose" "$d" 0 "G12 green" 0 G12
node -e 'const fs = require("fs"); const f = process.argv[1]; const j = JSON.parse(fs.readFileSync(f, "utf8")); j.scenarios.push({ name: "checkout/v1.2 flow", journey: "J3", result: "pass" }); fs.writeFileSync(f, JSON.stringify(j, null, 2));' "$d/.scratch/live/run1/report.json"
at_map "$d" "checkout/v1.2 flow" "tests/at2.test.js" "tests/at3.test.js"
expect "G12 green: a live scenario whose name has a dot and a slash is still a scenario" "$d" 0 "G12 green" 0 G12
at_map "$d" "first reply after install" "tests/at2.test.js" "never auto-sent"
expect "G12 red: a bare test name that is no scenario and no path says which forms are accepted" "$d" 1 'a test cell is a tracked test path, "path::test name", or a live scenario name' 1 G12
at_map "$d" "first reply after install" "tests/missing.test.js::x" "tests/at3.test.js"
expect "G12 red: path::name of a file that does not exist" "$d" 1 "AT2 its test tests/missing.test.js does not exist" 1 G12

# ---- G4: editing the envelope's Packs line after a red G4 is a bypass

set_packs() { sed -i "s/^\*\*Packs:\*\*.*/**Packs:** $2/" "$1/.scratch/envelope/$SLUG.md"; }
packs_hash8() { printf '%s' "$1" | sha256sum | cut -c1-8; }
d=$(loop_repo g4-bypass normal); put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
(cd "$d" && "$check" G4 >/dev/null 2>&1) # setup, not an assertion: the red G4 the rest builds on must exist in every shard
expect "G4 bypass: the llm pack with no eval results is red (and recorded in the signed log)" "$d" 1 "G4 red: eval results missing" 1 G4
pass_if "G4 bypass: the red G4 is signed into the stage log" grep -qF '"kind":"g4"' "$(log_of "$d")"
set_packs "$d" "core, api, data"
expect "G4 bypass: the Packs line changed after a red G4 is a bypass, red" "$d" 1 "the envelope Packs line was changed after G4 was red (a bypass)" 1 G4
H8=$(packs_hash8 "core, api, data")
expect "G4 bypass: the message says what to record" "$d" 1 "\"<date> reply-options G4 packs bypass $H8: <reason>\"" 1 G4
printf '2026-10-11T10:00:00Z reply-options G4 packs bypass %s: the diff has no llm call, see .scratch/review/reply-options.md\n' "$H8" >> "$d/.scratch/loop-metrics.md"
expect "G4 bypass: with the reason in loop-metrics.md the edit stands (n/a)" "$d" 0 "G4 n/a: envelope Packs names neither llm nor retrieval" 0 G4
set_packs "$d" "core, api, data, jobs"
expect "G4 bypass: an old reason does not cover a new edit" "$d" 1 "the envelope Packs line was changed after G4 was red" 1 G4
printf '2026-10-11T10:00:00Z reply-options G4 packs bypass %s:   \n' "$(packs_hash8 "core, api, data, jobs")" >> "$d/.scratch/loop-metrics.md"
expect "G4 bypass: a reason that is blank does not count" "$d" 1 "the envelope Packs line was changed after G4 was red" 1 G4
put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 bypass: putting the Packs line back is not a bypass (G4 is simply red again)" "$d" 1 "G4 red: eval results missing" 1 G4
d=$(loop_repo g4-nobypass normal); put "$d" envelope-no-llm-words.md ".scratch/envelope/$SLUG.md"
expect "G4 bypass: a G4 that was never red leaves the Packs line free to change (n/a)" "$d" 0 "G4 n/a" 0 G4
set_packs "$d" "core, api"
expect "G4 bypass: ... still n/a after an edit" "$d" 0 "G4 n/a" 0 G4
put "$d" envelope-llm.md ".scratch/envelope/$SLUG.md"
expect "G4 bypass: adding the llm pack is red for its own reason, not a bypass" "$d" 1 "G4 red: eval results missing" 1 G4

# ---- the pr phase: G1 to G6 and G8 to G12, CI green on the exact HEAD, the owner's approve pr for HEAD

pr_repo() { # <name>: a normal-size repo with every gate's evidence on HEAD, approvals for the three stops
  local r; r=$(new_repo "$1"); green_normal "$r"; gates_json_f9 "$r"
  put "$r" plan-acceptance.md "docs/plans/$SLUG.md"
  mkdir -p "$r/tests"; printf 't\n' > "$r/tests/at2.test.js"; printf 't\n' > "$r/tests/at3.test.js"; git -C "$r" add -A; git -C "$r" commit -q -m "acceptance tests"
  put_live "$r" report-pass.json; put_review_head "$r"
  codex_report "$r" plan "$PLAN_SHA" '[]'; codex_report "$r" code "$(head_of "$r")" '[]'
  sed "s/@SHA@/$(head_of "$r")/" "$fx/acceptance-ok.md" > "$r/.scratch/acceptance.md"
  printf '%s' "$r"
}
ALL_APPROVED="[$(approve plan "$PLAN_SHA"),$(approve acceptance "$AT_KEY")"
CI_OK='[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"success"}]'
pr_approvals() { set_approvals "$ALL_APPROVED,$(approve pr "$(head_of "$1")")]"; }
export FAKE_GH_RUNS="$CI_OK"
d=$(pr_repo pr-green); pr_approvals "$d"
expect "pr phase: every gate, CI on HEAD and approve pr green" "$d" 0 "gates: green for reply-options (size normal): 10 green, 0 red, 2 n/a" 0 --phase pr
expect "pr phase: prints PR-CI and PR-APPROVAL" "$d" 0 "PR-CI green" 0 --phase pr
expect "pr phase: ... and PR-APPROVAL" "$d" 0 "PR-APPROVAL green" 0 --phase pr
out="$(cd "$d" && "$check" --phase pr)"
pass_if "pr phase: G10 G11 G12 are evaluated, G7 is not" bash -c 'printf "%s\n" "$1" | grep -q "^G12 green" && printf "%s\n" "$1" | grep -q "^G10 green" && ! printf "%s\n" "$1" | grep -q "^G7 "' _ "$out"
out="$(cd "$d" && "$check" --phase pr G3)"
pass_if "pr phase with explicit gates does not run the CI and approval checks" test -z "$(printf '%s\n' "$out" | grep -E '^PR-')"
out="$(cd "$d" && "$check")"
pass_if "no phase does not run the CI and approval checks either" test -z "$(printf '%s\n' "$out" | grep -E '^PR-')"
: > "$work/gh-run.log"; out="$(cd "$d" && FAKE_GH_LOG="$work/gh-run.log" "$check" --phase pr)"
pass_if "pr phase asks gh for the runs of the exact HEAD sha" grep -qF "run list --commit $(head_of "$d") --json conclusion,status" "$work/gh-run.log"

FAKE_GH_RUNS='[]' expect "pr phase red: no CI run on HEAD" "$d" 1 "PR-CI red: no CI run on $(head_of "$d" | cut -c1-9): push the branch and wait for the workflow" 1 --phase pr
FAKE_GH_RUNS='[{"status":"completed","conclusion":"success"},{"status":"in_progress","conclusion":""}]' expect "pr phase red: CI still running" "$d" 1 "PR-CI red: CI is still running on" 1 --phase pr
FAKE_GH_RUNS='[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"failure"}]' expect "pr phase red: a failed run" "$d" 1 "PR-CI red: CI is not green on $(head_of "$d" | cut -c1-9): failure" 1 --phase pr
FAKE_GH_RUNS='[{"status":"completed","conclusion":"cancelled"}]' expect "pr phase red: a cancelled run" "$d" 1 "CI is not green on" 1 --phase pr
FAKE_GH_RUNS='[{"status":"completed","conclusion":"skipped"}]' expect "pr phase red: every run skipped is not a pass" "$d" 1 "no CI run succeeded" 1 --phase pr
FAKE_GH_RUNS='[{"status":"completed","conclusion":"success"},{"status":"completed","conclusion":"skipped"},{"status":"completed","conclusion":"neutral"}]' expect "pr phase green: success with skipped and neutral runs" "$d" 0 "PR-CI green" 0 --phase pr
FAKE_GH_RUN_FAIL=1 expect "pr phase red: gh fails, so CI cannot be checked (fail closed)" "$d" 1 "so CI could not be checked" 1 --phase pr
FAKE_GH_RUNS='not json' expect "pr phase red: gh output that is not JSON" "$d" 1 "gh run list did not return JSON" 1 --phase pr
set_approvals "$ALL_APPROVED]"
expect "pr phase red: no signed approve pr" "$d" 1 'PR-APPROVAL red: the signed log has no "approve pr" for HEAD' 1 --phase pr
set_approvals "$ALL_APPROVED,$(approve pr "$(git -C "$d" rev-parse HEAD~1)")]"
expect "pr phase red: approve pr for another head, source changed since" "$d" 1 "PR-APPROVAL red" 1 --phase pr
old_head=$(head_of "$d"); commit_doc "$d"
set_approvals "$ALL_APPROVED,$(approve pr "$old_head")]"
expect "S4: approve pr for an earlier head is red even when only non-source files changed since" "$d" 1 "PR-APPROVAL red" 1 --phase pr
set_approvals "$ALL_APPROVED,$(approve pr "${old_head:0:12}")]"
expect "S4: a short sha of an earlier head does not count either" "$d" 1 "PR-APPROVAL red" 1 --phase pr
set_approvals "$ALL_APPROVED,$(approve pr "$(head_of "$d")")]"
expect "S4: approve pr for the exact HEAD is green" "$d" 0 "PR-APPROVAL green" 0 --phase pr
set_approvals "$ALL_APPROVED,$(approve pr "$(head_of "$d" | cut -c1-12)")]"
expect "S4: an abbreviated sha of the exact HEAD is green" "$d" 0 "PR-APPROVAL green" 0 --phase pr
pr_approvals "$d"

d=$(pr_repo pr-g10); pr_approvals "$d"; resolutions "$d" plan "X|open"; codex_report "$d" plan "$PLAN_SHA" "[$(finding X1 HIGH CONFIRMED)]"
expect "pr phase red: an unresolved CONFIRMED plan-review finding" "$d" 1 "G10 red" 1 --phase pr
d=$(pr_repo pr-g11); pr_approvals "$d"; codex_report "$d" code "$(head_of "$d")" "[$(finding X1 CRITICAL CONFIRMED)]"
expect "pr phase red: an unresolved CONFIRMED CRITICAL code-attack finding" "$d" 1 "G11 red" 1 --phase pr
d=$(pr_repo pr-g12); pr_approvals "$d"; rm "$d/.scratch/acceptance.md"
expect "pr phase red: acceptance tests not mapped" "$d" 1 "G12 red" 1 --phase pr
d=$(pr_repo pr-g3); pr_approvals "$d"; rm -r "$d/.scratch/live"
expect "pr phase red: no live run (G3)" "$d" 1 "G3 red: no live run" - --phase pr
d=$(pr_repo pr-noplansha); pr_approvals "$d"; gates_json "$d" normal
expect "pr phase: a loop with no plan_sha still runs G10, and it is green (plan_sha is informational)" "$d" 0 "G10 green" - --phase pr
d=$(pr_repo pr-merge-check); pr_approvals "$d"; gates_json_with "$d" normal "\"plan_sha\": \"$PLAN_SHA\", \"merge_check\": \"true\""
FAKE_GH_RUNS='[]' expect "A9: with CI workflows, merge_check is ignored and gh decides (no run on HEAD is red)" "$d" 1 "PR-CI red: no CI run on" 1 --phase pr
FAKE_GH_RUNS='[]' FAKE_GH_API_FAIL=1 expect "A9: gh unable to list workflows does not open the merge_check fallback" "$d" 1 "PR-CI red: no CI run on" 1 --phase pr
FAKE_GH_RUNS='[]' FAKE_GH_WORKFLOWS=0 expect "A9: no CI workflows: merge_check is used, and the pass says so" "$d" 0 "PR-CI green (merge_check, no CI workflows)" 0 --phase pr
gates_json_with "$d" normal "\"plan_sha\": \"$PLAN_SHA\", \"merge_check\": \"false\""
FAKE_GH_WORKFLOWS=0 expect "pr phase red: a failing merge_check when the repository has no CI workflows" "$d" 1 "PR-CI red: merge_check failed on" 1 --phase pr
expect "A9: a failing merge_check is irrelevant while CI workflows exist (gh says green)" "$d" 0 "PR-CI green" 0 --phase pr
d=$(new_repo ph-pr-usage); gates_json "$d" normal
expect "usage: --phase needs build, merge, pr or close" "$d" 2 "--phase needs build, merge, pr or close" 0 --phase
expect "usage: unknown phase lists pr" "$d" 2 "expected build, merge, pr or close" 0 --phase later
d=$(new_repo ph-codex-skip); green_normal "$d"
expect "a loop without plan_sha leaves G10 to G12 out of the merge phase (they are for the fork.9 flow)" "$d" 0 "gates: green for reply-options (size normal): 5 green, 0 red, 2 n/a" 0 --phase merge
d=$(new_repo ph-codex-merge); green_normal "$d"; gates_json_f9 "$d"; set_approvals '[]'
expect "a loop with a plan_sha asks G10 to G12 at the merge phase too" "$d" 1 "G10 red" 3 --phase merge
expect "... and at close" "$d" 1 "G12 red" 3 --phase close

# ---- gate-hook.sh: PR creation needs the pr phase, merge is refused

PRMSG="the pr phase is red"
hr=$(pr_repo hook-pr-green); pr_approvals "$hr"
hook_case "gh pr create allowed when the pr phase is green" "$hr" 'gh pr create --title x --body y' 0 ""
hook_case "gh pr create --draft allowed when the pr phase is green" "$hr" 'gh pr create --draft --title x --body y' 0 ""
hook_case "gh api POST pulls allowed when the pr phase is green" "$hr" "gh api repos/o/r/pulls -f title=x -f head=feature -f base=main" 0 ""
hook_case "graphql createPullRequest allowed when the pr phase is green" "$hr" "gh api graphql -f query='mutation { createPullRequest(input: {title: \"x\"}) { pullRequest { id } } }'" 0 ""
hook_case "git push passes before CI exists (a push is the build phase)" "$hr" "git push -u origin feature" 0 "" FAKE_GH_RUNS='[]'
FAKE_GH_RUNS='[]' hook_case "gh pr create refused with no CI run on HEAD" "$hr" 'gh pr create --title x --body y' 2 "$PRMSG"
FAKE_GH_RUNS='[]' hook_case "the refusal names the CI check" "$hr" 'gh pr create --title x --body y' 2 "PR-CI red: no CI run on"
FAKE_GH_RUNS='[{"status":"completed","conclusion":"failure"}]' hook_case "gh pr create refused when CI failed on HEAD" "$hr" 'gh pr create --title x --body y' 2 "PR-CI red: CI is not green"
FAKE_GH_RUNS='[]' hook_case "a draft PR is refused before the pr phase, and says draft" "$hr" 'gh pr create --draft --title x --body y' 2 "opening a draft PR was blocked, the pr phase is red"
FAKE_GH_RUNS='[]' hook_case "gh pr create -d is a draft too" "$hr" 'gh pr create -d --title x' 2 "opening a draft PR was blocked"
FAKE_GH_RUNS='[]' hook_case "REST POST pulls with draft=true is a draft" "$hr" "gh api repos/o/r/pulls -f title=x -F draft=true" 2 "opening a draft PR was blocked"
FAKE_GH_RUNS='[]' hook_case "graphql createPullRequest refused before the pr phase" "$hr" "gh api graphql -f query='mutation { createPullRequest(input: {title: \"x\", draft: true}) { pullRequest { id } } }'" 2 "opening a draft PR was blocked"
FAKE_GH_RUNS='[]' hook_case "the refusal says how to fix and that there is no bypass" "$hr" 'gh pr create --title x' 2 "this gate has no bypass"
FAKE_GH_RUN_FAIL=1 hook_case "gh failing refuses PR creation (fail closed)" "$hr" 'gh pr create --title x' 2 "so CI could not be checked"
set_approvals "$ALL_APPROVED]"
hook_case "gh pr create refused without the owner's approve pr" "$hr" 'gh pr create --title x --body y' 2 "PR-APPROVAL red"
set_approvals '[]'
hook_case "gh pr create refused without approvals at all" "$hr" 'gh pr create --title x --body y' 2 'no "approve plan"'
pr_approvals "$hr"
hook_case "bypass does not unblock PR creation" "$hr" 'gh pr create --title x' 2 "no bypass" FAKE_GH_RUNS='[]' FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=owner is waiting"
hook_case "inline bypass does not unblock PR creation" "$hr" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x gh pr create --title x" 2 "no bypass" FAKE_GH_RUNS='[]'
pass_if "a refused PR writes no bypass record" bash -c '! grep -q "gates bypassed" "$1/.scratch/loop-metrics.md"' _ "$hr"
: > "$work/gh-hook.log"
hook_case "the hook asks gh about the runs of HEAD" "$hr" 'gh pr create --title x' 0 "" FAKE_GH_LOG="$work/gh-hook.log"
pass_if "hook: gh run list --commit <HEAD sha>" grep -qF "run list --commit $(head_of "$hr")" "$work/gh-hook.log"
hn=$(pr_repo hook-pr-noready); pr_approvals "$hn"
HOOK_NOREADY=1 hook_case "gh pr create refused when no hook ever started the loop (G9 is mandatory)" "$hn" 'gh pr create --title x' 2 "G9 red: no signed init entry"
hg=$(pr_repo hook-pr-g1); pr_approvals "$hg"; rm "$hg/.scratch/shape/$SLUG.md"
hook_case "gh pr create refused when an earlier gate is red (G1) and names it" "$hg" 'gh pr create --title x' 2 "G1 red: shape file missing"
hook_case "gh pr create --draft from another directory is gated" "$outside" "cd $hg && gh pr create --draft --title x" 2 "opening a draft PR was blocked"
hook_case "gh pr new is gated like gh pr create" "$hg" 'gh pr new --title x' 2 "$PRMSG"
hook_case "gh pr list is not a PR creation" "$hg" 'gh pr list' 0 ""
# Heredocs and ambiguous commands: a PR creation or merge after a heredoc is still classified (live run 1)
NL=$'\n'
hook_case "heredoc, newline, then gh pr create is gated (the live-run shape)" "$hg" "cd \"$hg\" && cat > /tmp/pr-body.md <<'EOF'${NL}## Summary${NL}a multi-line body${NL}EOF${NL}gh pr create --base main --head todo --title \"x\" --body-file /tmp/pr-body.md 2>&1 | tail -5" 2 "$PRMSG"
hook_case "heredoc with an unquoted delimiter, then gh pr create" "$hg" "cat > /tmp/b.md <<EOF${NL}body${NL}EOF${NL}gh pr create --title x" 2 "$PRMSG"
hook_case "heredoc <<- with tabs, then gh pr create" "$hg" "cat > /tmp/b.md <<-'EOF'${NL}	body${NL}	EOF${NL}gh pr create --title x" 2 "$PRMSG"
hook_case "heredoc opener followed by && gh pr create on the same line" "$hg" "cat > /tmp/b.md <<'EOF' && gh pr create --title x${NL}body${NL}EOF" 2 "$PRMSG"
hook_case "gh pr merge after a heredoc is refused" "$mrepo" "cat > /tmp/b.md <<'EOF'${NL}body${NL}EOF${NL}gh pr merge 5 --squash" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "gh pr merge after a heredoc and && is refused" "$mrepo" "cat > /tmp/b.md <<'EOF' && gh pr merge 5${NL}body${NL}EOF" 2 "$OWNER_MERGES" "${gh_env[@]}"
hook_case "two heredocs on one line, then gh pr create" "$hg" "cat <<A <<B > /tmp/b.md${NL}one${NL}A${NL}two${NL}B${NL}gh pr create --title x" 2 "$PRMSG"
hook_case "text of a PR inside a heredoc body is not a command" "$hg" "cat > /tmp/b.md <<'EOF'${NL}run gh pr create and gh pr merge 5 after review${NL}EOF${NL}ls" 0 ""
hook_case "a here-string is not a heredoc" "$hg" "cat <<< hello${NL}gh pr create --title x" 2 "$PRMSG"
hook_case "an unknown wrapper in front of gh pr create is refused as ambiguous" "$hg" "mywrapper gh pr create --title x" 2 "cannot classify"
hook_case "the ambiguity refusal has no bypass" "$hg" "FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x mywrapper gh pr create" 2 "no bypass"
hook_case "a PR phrase in an echo or a commit message is not ambiguous" "$hg" "echo \"then gh pr create\"" 0 ""
hook_case "gh api GET of pulls is not ambiguous" "$hg" "gh api repos/o/r/pulls" 0 ""
hook_case "an ambiguous command with no loop passes" "$plain_repo" "mywrapper gh pr create --title x" 0 ""

# ---- mcp-pr-hook.sh: the GitHub MCP tools walk around the Bash hook, so they have their own

MCP_DEFAULT_TI='{"owner":"o","repo":"r","pullNumber":5}'
mcp_case() { # <name> <cwd> <tool_name> <exit> <needle or @empty> [VAR=value...]
  local name="$1" cwd="$2" tool="$3" want="$4" needle="$5"; shift 5
  skip_case && return 0
  local payload err code bad=""
  payload="$(node -e 'process.stdout.write(JSON.stringify({ session_id: "s1", cwd: process.argv[1], hook_event_name: "PreToolUse", tool_name: process.argv[2], tool_input: JSON.parse(process.argv[3]) }))' "$cwd" "$tool" "${MCP_TI:-$MCP_DEFAULT_TI}")"
  err="$(cd "$work" && printf '%s' "$payload" | env "$@" bash "$here/mcp-pr-hook.sh" 2>&1 >/dev/null)"; code=$?
  [ "$code" = "$want" ] || bad="exit $code, want $want"
  if [ "$needle" = @empty ]; then [ -z "$err" ] || bad="${bad:+$bad; }expected no output"
  elif ! printf '%s\n' "$err" | grep -qF -- "$needle"; then bad="${bad:+$bad; }missing: $needle"; fi
  total=$((total + 1))
  if [ -z "$bad" ]; then echo "ok   mcp: $name"; else echo "FAIL mcp: $name: $bad"; printf '%s\n' "$err" | sed 's/^/       | /'; fail=1; fi
}
MERGE_TOOL=mcp__plugin_everything-claude-code_github__merge_pull_request
CREATE_TOOL=mcp__plugin_everything-claude-code_github__create_pull_request
ready_repo "$hr"; ready_repo "$hg" # the signed log a finished loop leaves (an hook_case does this too, but a sharded run may skip it)
mcp_case "merge_pull_request refused while a loop is active" "$hr" "$MERGE_TOOL" 2 "$OWNER_MERGES"
mcp_case "merge refusal has no bypass" "$hr" "$MERGE_TOOL" 2 "This gate has no bypass" FEATURE_LOOP_GATES=off "FEATURE_LOOP_BYPASS_REASON=x"
mcp_case "merge_pull_request from another MCP server name is refused too" "$hr" "mcp__github__merge_pull_request" 2 "$OWNER_MERGES"
mcp_case "merge refused even when every gate and CI are green" "$hr" "$MERGE_TOOL" 2 "owner merges"
pr_approvals "$hr" # the approvals file holds the last repo's approve pr (hg), so give hr its own
mcp_case "create_pull_request allowed when the pr phase is green" "$hr" "$CREATE_TOOL" 0 @empty
FAKE_GH_RUNS='[]' mcp_case "create_pull_request refused with no CI on HEAD" "$hr" "$CREATE_TOOL" 2 "PR-CI red: no CI run on"
mcp_case "create_pull_request refused without approve pr" "$hg" "$CREATE_TOOL" 2 "opening a PR was blocked, the pr phase is not green"
mcp_case "another MCP github tool passes" "$hr" "mcp__plugin_everything-claude-code_github__get_pull_request" 0 @empty
mcp_case "a non-MCP tool name passes" "$hr" "Bash" 0 @empty
mcp_case "merge with no loop passes" "$plain_repo" "$MERGE_TOOL" 0 @empty
mcp_case "create with no loop passes" "$plain_repo" "$CREATE_TOOL" 0 @empty
d_cl=$(loop_repo mcp-closed normal); sign_close "$d_cl"; printf '{ "slug": "%s", "size": "normal", "base": "main", "status": "closed" }
' "$SLUG" > "$d_cl/.scratch/gates.json"
mcp_case "merge on a properly closed loop passes" "$d_cl" "$MERGE_TOOL" 0 @empty
d_h5=$(loop_repo mcp-h5 normal); printf '{ "slug": "%s", "size": "normal", "base": "main", "status": "closed" }
' "$SLUG" > "$d_h5/.scratch/gates.json"
mcp_case "merge on a loop closed without a signed close entry is refused" "$d_h5" "$MERGE_TOOL" 2 "closed without a signed close"
mcp_case "node absent, loop active: create fails closed" "$hr" "$CREATE_TOOL" 2 "node not found" "PATH=$np"
mcp_case "node absent, loop active: merge is still refused" "$hr" "$MERGE_TOOL" 2 "$OWNER_MERGES" "PATH=$np"
# A7: the widened MCP hook: auto-merge, branch updates and writes to the base branch
GH_MCP=mcp__plugin_everything-claude-code_github
mcp_case "A7: enable_pull_request_auto_merge is a merge" "$hr" "mcp__github__enable_pull_request_auto_merge" 2 "$OWNER_MERGES"
mcp_case "A7: a tool with auto_merge in its name is a merge" "$hr" "mcp__github__enable_auto_merge" 2 "This gate has no bypass"
mcp_case "A7: update_pull_request_branch is refused" "$hr" "${GH_MCP}__update_pull_request_branch" 2 "update_pull_request_branch was blocked"
mcp_case "A7: update_pull_request_branch has no bypass" "$hr" "${GH_MCP}__update_pull_request_branch" 2 "This gate has no bypass" FEATURE_LOOP_GATES=off FEATURE_LOOP_BYPASS_REASON=x
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","content":"x","message":"m","branch":"main"}' mcp_case "A7: create_or_update_file on the base branch is refused" "$hr" "${GH_MCP}__create_or_update_file" 2 "the base branch (main)"
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","content":"x","message":"m","branch":"refs/heads/main"}' mcp_case "A7: ... also as refs/heads/main" "$hr" "${GH_MCP}__create_or_update_file" 2 "the base branch (main)"
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","content":"x","message":"m"}' mcp_case "A7: create_or_update_file with no branch (the default branch) is refused" "$hr" "${GH_MCP}__create_or_update_file" 2 "not named"
MCP_TI='{"owner":"o","repo":"r","branch":"main","files":[],"message":"m"}' mcp_case "A7: push_files to the base is refused" "$hr" "${GH_MCP}__push_files" 2 "the base branch (main)"
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","message":"m","branch":"main"}' mcp_case "A7: delete_file on the base is refused" "$hr" "${GH_MCP}__delete_file" 2 "the base branch (main)"
MCP_TI='{"owner":"o","repo":"r","branch":"feature","files":[],"message":"m"}' mcp_case "A7: push_files to a feature branch passes" "$hr" "${GH_MCP}__push_files" 0 @empty
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","content":"x","message":"m","branch":"feature"}' mcp_case "A7: create_or_update_file on a feature branch passes" "$hr" "${GH_MCP}__create_or_update_file" 0 @empty
MCP_TI='{"owner":"o","repo":"r","path":"a.txt","message":"m","branch":"main"}' mcp_case "A7: a base-branch write with no loop passes" "$plain_repo" "${GH_MCP}__delete_file" 0 @empty
MCP_TI='{"owner":"o","repo":"r","branch":"feature","files":[],"message":"m"}' mcp_case "A7: node absent, loop active: a file write fails closed" "$hr" "${GH_MCP}__push_files" 2 "node not found" "PATH=$np"
for t in get_file_contents list_commits search_code get_pull_request_files list_pull_requests; do
  mcp_case "A7: read tool $t passes" "$hr" "${GH_MCP}__$t" 0 @empty
done
mcp_case "A7: create_pull_request_review is not a PR creation" "$hr" "${GH_MCP}__create_pull_request_review" 0 @empty
mcp_case "A7: create_branch passes" "$hr" "${GH_MCP}__create_branch" 0 @empty
# A8: the payload is parsed as JSON, not matched with sed
unesc_payload='{"session_id":"s1","cwd":"'"$hr"'","hook_event_name":"PreToolUse","tool_name":"mcp__github__merge_pull_request","tool_input":{"owner":"o"}}'
skip_case || { err="$(cd "$work" && printf '%s' "$unesc_payload" | bash "$here/mcp-pr-hook.sh" 2>&1 >/dev/null)"; code=$?; total=$((total + 1))
  if [ "$code" = 2 ] && printf '%s' "$err" | grep -qF "$OWNER_MERGES"; then echo "ok   mcp: A8: a tool name with a JSON unicode escape is still a merge"; else echo "FAIL mcp: A8: a tool name with a JSON unicode escape is still a merge: exit $code"; fail=1; fi; }
skip_case || { err="$(cd "$work" && printf '%s' '{"cwd":"'"$hr"'","tool_input":{"body":"a \"tool_name\":\"get_issue\" b"},"tool_name":"mcp__github__merge_pull_request"}' | bash "$here/mcp-pr-hook.sh" 2>&1 >/dev/null)"; code=$?; total=$((total + 1))
  if [ "$code" = 2 ] && printf '%s' "$err" | grep -qF "$OWNER_MERGES"; then echo "ok   mcp: A8: text that looks like a tool_name inside tool_input does not hide the merge"; else echo "FAIL mcp: A8: look-alike tool_name in tool_input: exit $code"; fail=1; fi; }
skip_case || { err="$(cd "$hr" && printf '%s' '{not json' | CLAUDE_PROJECT_DIR="$hr" bash "$here/mcp-pr-hook.sh" 2>&1 >/dev/null)"; code=$?; total=$((total + 1))
  if [ "$code" = 2 ] && printf '%s' "$err" | grep -qF "could not be read"; then echo "ok   mcp: A8: an unreadable payload fails closed while a loop is active"; else echo "FAIL mcp: A8: unreadable payload: exit $code"; fail=1; fi; }
skip_case || { err="$(cd "$plain_repo" && printf '%s' '{not json' | CLAUDE_PROJECT_DIR="$plain_repo" bash "$here/mcp-pr-hook.sh" 2>&1 >/dev/null)"; code=$?; total=$((total + 1))
  if [ "$code" = 0 ]; then echo "ok   mcp: A8: an unreadable payload with no loop passes"; else echo "FAIL mcp: A8: unreadable payload, no loop: exit $code"; fail=1; fi; }
check_hooks_matcher() { node -e 'const h = require(process.argv[1]).hooks.PreToolUse.find((e) => /mcp__/.test(e.matcher)); const re = new RegExp("^(?:" + h.matcher + ")$"); const ok = ["mcp__github__push_files", "mcp__plugin_everything-claude-code_github__merge_pull_request", "mcp__plugin_github_github__enable_pull_request_auto_merge"].every((t) => re.test(t)) && !re.test("mcp__linear__save_issue"); process.exit(ok ? 0 : 1)' "$here/../../../../hooks/hooks.json"; }
pass_if "A7: hooks.json matcher covers every GitHub MCP tool (and no other server)" check_hooks_matcher

echo
if [ "$fail" -eq 0 ]; then echo "test-gates: all $total passed"; else echo "test-gates: failures above ($total cases)"; fi
exit "$fail"
