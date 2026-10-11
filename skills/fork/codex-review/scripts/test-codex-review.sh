#!/usr/bin/env bash
# Tests for codex-review.sh. A stub `codex` on PATH records its argv, checks stdin, and writes canned output, so no
# model is called. Each case builds a throwaway git repo.
# Run: skills/fork/codex-review/scripts/test-codex-review.sh
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="$here/codex-review.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
pass=0; fail=0

ok()  { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "$2 | stderr: $(tr '\n' ' ' < "$work/stderr" 2>/dev/null | cut -c1-300)"; fi; }

# --- stub codex -------------------------------------------------------------------------------------------------
stubdir="$work/bin"; mkdir -p "$stubdir"
cat > "$stubdir/codex" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = "--version" ]; then echo "codex-cli 0.0.0-stub"; exit 0; fi
log="${STUB_LOG:?}"
stdin_bytes="$(head -c 100 | wc -c | tr -d ' ')"
out=""; cwd_flag=""; model=""; sandbox=""; schema=""; prompt=""
shift # exec
while [ $# -gt 0 ]; do
  case "$1" in
    -m) model="$2"; shift 2 ;;
    -s) sandbox="$2"; shift 2 ;;
    -C) cwd_flag="$2"; shift 2 ;;
    --output-schema) schema="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    --ephemeral|--skip-git-repo-check) shift ;;
    *) prompt="$1"; shift ;;
  esac
done
{
  echo "model=$model"; echo "sandbox=$sandbox"; echo "C=$cwd_flag"; echo "schema=$schema"
  echo "stdin_bytes=$stdin_bytes"; echo "schema_exists=$([ -f "$schema" ] && echo yes || echo no)"
  echo "prompt_has_target=$(printf '%s' "$prompt" | grep -c -- "${STUB_EXPECT_IN_PROMPT:-@@none@@}")"
} > "$log"
case "${STUB_MODE:-ok}" in
  fail) echo "boom" >&2; exit 7 ;;
  sleep) sleep 30; exit 0 ;;
  invalid) echo '{not json' > "$out"; exit 0 ;;
  badschema) echo '{"summary":"x","findings":[{"id":"F1","severity":"SEVERE"}]}' > "$out"; exit 0 ;;
esac
if [ -n "${STUB_REPRO:-}" ]; then
  d="${cwd_flag:-.}"; mkdir -p "$d/tests"; echo "// repro" > "$d/$STUB_REPRO"
  echo "stray" > "$d/stray-note.txt"
fi
cp "${STUB_CANNED:?}" "$out"
STUB
chmod +x "$stubdir/codex"
export PATH="$stubdir:$PATH"
export STUB_LOG="$work/stub.log"

canned_plan="$work/canned-plan.json"
cat > "$canned_plan" <<'J'
{"summary":"plan has gaps","findings":[
{"id":"P1","severity":"HIGH","status":"CONFIRMED","title":"missing rollback","where":"plan.md:3","evidence":"no rollback step","repro":null},
{"id":"P2","severity":"LOW","status":"PLAUSIBLE","title":"vague test","where":"plan.md:9","evidence":"unclear","repro":null}]}
J
canned_code="$work/canned-code.json"
cat > "$canned_code" <<'J'
{"summary":"race in save","findings":[
{"id":"C1","severity":"CRITICAL","status":"CONFIRMED","title":"double write","where":"src/a.js:10","evidence":"FAIL tests/repro_c1.test.js","repro":"tests/repro_c1.test.js: node --test tests/repro_c1.test.js"},
{"id":"C2","severity":"HIGH","status":"CONFIRMED","title":"leak","where":"src/b.js:4","evidence":"FAIL","repro":"tests/repro_c1.test.js"},
{"id":"C3","severity":"MEDIUM","status":"PLAUSIBLE","title":"maybe","where":"src/c.js:1","evidence":"could not run","repro":null}]}
J

new_repo() { # prints repo path
  local r="$work/repo$RANDOM$RANDOM"; mkdir -p "$r"
  git -C "$r" init -q -b main
  git -C "$r" config core.autocrlf false
  git -C "$r" config user.email t@t; git -C "$r" config user.name t
  printf 'a\n' > "$r/a.txt"; printf '# Plan\nstep\n' > "$r/plan.md"
  printf '.scratch/\n' > "$r/.gitignore"
  git -C "$r" add -A; git -C "$r" commit -q -m init
  printf 'b\n' > "$r/b.txt"; git -C "$r" add -A; git -C "$r" commit -q -m second
  printf '%s' "$r"
}
# run <repo> args...: stdin is a pipe with data, to prove the script detaches codex from it
run() {
  local r="$1"; shift
  ( cd "$r" && echo "inherited stdin" | "$script" "$@" ) > "$work/stdout" 2> "$work/stderr"
  echo $? > "$work/rc"
}
rc() { cat "$work/rc"; }
stub_c() { awk -F= '$1=="C"{print $2}' "$STUB_LOG"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
native_() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
jq_() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(eval("j."+process.argv[2]))' "$(native_ "$1")" "$2"; }
lines() { wc -l < "$1" | tr -d ' '; }

# --- plan mode --------------------------------------------------------------------------------------------------
repo="$(new_repo)"
before="$(git -C "$repo" status --porcelain)"
STUB_MODE=ok STUB_CANNED="$canned_plan" STUB_EXPECT_IN_PROMPT="plan.md" run "$repo" plan plan.md --slug demo
check "plan: exit 0" '[ "$(rc)" = 0 ]'
j="$repo/.scratch/review/codex-plan-demo.json"
check "plan: json written" '[ -f "$j" ]'
check "plan: kind=plan" '[ "$(jq_ "$j" kind)" = plan ]'
check "plan: subject_sha is sha256 of the plan file" '[ "$(jq_ "$j" subject_sha)" = "$(sha256 "$repo/plan.md")" ]'
check "plan: model default gpt-6-astra" '[ "$(jq_ "$j" model)" = gpt-6-astra ] && grep -qx "model=gpt-6-astra" "$STUB_LOG"'
check "plan: sandbox read-only" 'grep -qx "sandbox=read-only" "$STUB_LOG"'
check "plan: stdin detached" 'grep -qx "stdin_bytes=0" "$STUB_LOG"'
check "plan: schema file passed and exists" 'grep -qx "schema_exists=yes" "$STUB_LOG"'
check "plan: prompt names the plan file" 'grep -qx "prompt_has_target=1" "$STUB_LOG"'
check "plan: codex_version stamped" '[ "$(jq_ "$j" codex_version)" = "codex-cli 0.0.0-stub" ]'
check "plan: exit_code stamped 0" '[ "$(jq_ "$j" exit_code)" = 0 ]'
check "plan: findings preserved, no resolution key" '[ "$(jq_ "$j" findings.length)" = 2 ] && ! grep -q resolution "$j"'
check "plan: markdown rendered" 'grep -q "missing rollback" "$repo/.scratch/review/codex-plan-demo.md"'
check "plan: one-line summary" '[ "$(lines "$work/stdout")" = 1 ] && grep -q "1 CONFIRMED (1 HIGH), 1 PLAUSIBLE" "$work/stdout"'
check "plan: timeline line appended" 'grep -q "codex plan review" "$repo/.scratch/timeline.md" && [ "$(lines "$repo/.scratch/timeline.md")" = 1 ]'
check "plan: no resolutions file written" '! ls "$repo/.scratch/review/"*resolutions* >/dev/null 2>&1'
check "plan: working tree untouched" '[ "$(git -C "$repo" status --porcelain)" = "$before" ]'
STUB_MODE=ok STUB_CANNED="$canned_plan" run "$repo" plan plan.md --slug demo
check "plan: second run appends a second timeline line" '[ "$(lines "$repo/.scratch/timeline.md")" = 2 ]'
STUB_MODE=ok STUB_CANNED="$canned_plan" CODEX_REVIEW_MODEL=other-model run "$repo" plan plan.md
check "plan: CODEX_REVIEW_MODEL overrides, slug defaults to file stem" 'grep -qx "model=other-model" "$STUB_LOG" && [ -f "$repo/.scratch/review/codex-plan-plan.json" ]'

# --- code mode --------------------------------------------------------------------------------------------------
repo="$(new_repo)"
head="$(git -C "$repo" rev-parse HEAD)"
before="$(git -C "$repo" status --porcelain)"; wt_before="$(git -C "$repo" worktree list | wc -l | tr -d ' ')"
STUB_MODE=ok STUB_CANNED="$canned_code" STUB_REPRO="tests/repro_c1.test.js" STUB_EXPECT_IN_PROMPT="HEAD~1" run "$repo" code HEAD~1 --slug feat
check "code: exit 0" '[ "$(rc)" = 0 ]'
j="$repo/.scratch/review/codex-code-feat.json"
check "code: subject_sha is HEAD, base stamped" '[ "$(jq_ "$j" subject_sha)" = "$head" ] && [ "$(jq_ "$j" base)" = "HEAD~1" ]'
check "code: sandbox workspace-write" 'grep -qx "sandbox=workspace-write" "$STUB_LOG"'
check "code: ran in a worktree, not the repo" 'c="$(stub_c)"; [ -n "$c" ] && [ "$c" != "$repo" ]'
check "code: worktree removed" '[ "$(git -C "$repo" worktree list | wc -l | tr -d " ")" = "$wt_before" ] && ! [ -d "$(stub_c)" ]'
check "code: prompt carries the base" 'grep -qx "prompt_has_target=[1-9]" "$STUB_LOG"'
check "code: repro copied for each finding that names it" '[ -f "$repo/.scratch/review/codex-repros/C1/tests/repro_c1.test.js" ] && [ -f "$repo/.scratch/review/codex-repros/C2/tests/repro_c1.test.js" ]'
check "code: unmatched worktree files kept apart" '[ -f "$repo/.scratch/review/codex-repros/_unassigned/stray-note.txt" ]'
check "code: no repro dir for PLAUSIBLE" '[ ! -d "$repo/.scratch/review/codex-repros/C3" ]'
check "code: summary line" 'grep -q "codex code attack on ${head:0:7} by gpt-6-astra: 2 CONFIRMED (1 CRITICAL, 1 HIGH), 1 PLAUSIBLE" "$work/stdout"'
check "code: target working tree untouched" '[ "$(git -C "$repo" status --porcelain)" = "$before" ]'
check "code: target has no repro file in tests/" '[ ! -e "$repo/tests/repro_c1.test.js" ]'
check "code: timeline line" 'grep -q "codex code attack" "$repo/.scratch/timeline.md"'

# --- failures: never fake a report ------------------------------------------------------------------------------
repo="$(new_repo)"
STUB_MODE=fail STUB_CANNED="$canned_plan" run "$repo" plan plan.md --slug f
check "fail: codex non-zero gives exit 2, no report" '[ "$(rc)" = 2 ] && [ ! -e "$repo/.scratch/review/codex-plan-f.json" ] && [ ! -e "$repo/.scratch/review/codex-plan-f.md" ]'
check "fail: stdout has no success summary" '! grep -q CONFIRMED "$work/stdout"'
check "fail: timeline records the failure" 'grep -qi "failed" "$repo/.scratch/timeline.md"'
STUB_MODE=invalid STUB_CANNED="$canned_plan" run "$repo" plan plan.md --slug f
check "invalid JSON gives exit 2, no report" '[ "$(rc)" = 2 ] && [ ! -e "$repo/.scratch/review/codex-plan-f.json" ]'
STUB_MODE=badschema STUB_CANNED="$canned_plan" run "$repo" plan plan.md --slug f
check "schema violation gives exit 2, no report" '[ "$(rc)" = 2 ] && [ ! -e "$repo/.scratch/review/codex-plan-f.json" ] && grep -q severity "$work/stderr"'
STUB_MODE=sleep STUB_CANNED="$canned_plan" CODEX_REVIEW_TIMEOUT=1 run "$repo" plan plan.md --slug f
check "timeout gives exit 3, no report" '[ "$(rc)" = 3 ] && [ ! -e "$repo/.scratch/review/codex-plan-f.json" ]'
repo2="$(new_repo)"; wt_before="$(git -C "$repo2" worktree list | wc -l | tr -d ' ')"
STUB_MODE=fail STUB_CANNED="$canned_code" run "$repo2" code HEAD~1 --slug f
check "fail in code mode still removes the worktree" '[ "$(rc)" = 2 ] && [ "$(git -C "$repo2" worktree list | wc -l | tr -d " ")" = "$wt_before" ]'
STUB_MODE=ok STUB_CANNED="$canned_plan" CODEX_REVIEW_CODEX_BIN=definitely-not-codex run "$repo" plan plan.md --slug f
check "codex missing gives exit 2" '[ "$(rc)" = 2 ] && grep -qi "codex" "$work/stderr"'
STUB_MODE=ok STUB_CANNED="$canned_plan" run "$repo" plan nope.md
check "missing plan file gives exit 2" '[ "$(rc)" = 2 ]'
STUB_MODE=ok STUB_CANNED="$canned_plan" run "$repo" bogus x
check "bad usage gives exit 2" '[ "$(rc)" = 2 ]'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" = 0 ]
