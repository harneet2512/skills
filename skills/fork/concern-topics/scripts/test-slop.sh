#!/usr/bin/env bash
# Regression tests for slop-check.sh. Each case names the exact set of rules a fixture must raise and how many
# findings it must produce; the clean fixtures must raise nothing.
# Run: skills/fork/concern-topics/scripts/test-slop.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
slop="$here/slop-check.sh"
fail=0

run() { "$slop" "$@" || true; }

check() {
  local fixture="$1" want_rules="$2" want_count="$3" out got_rules got_count code
  set +e; out=$("$slop" --stdin < "$here/fixtures/$fixture"); code=$?; set -e
  got_rules=$(printf '%s\n' "$out" | grep -v '^$' | cut -f1 | LC_ALL=C sort -u | tr '\n' ' ' | sed 's/ $//' || true)
  got_count=$(printf '%s\n' "$out" | grep -c . || true)
  local want_code=1; [ "$want_count" -eq 0 ] && want_code=0
  if [ "$got_rules" = "$want_rules" ] && [ "$got_count" -eq "$want_count" ] && [ "$code" -eq "$want_code" ]; then
    echo "ok   $fixture: ${got_rules:-no findings} ($got_count)"
  else
    echo "FAIL $fixture: want [$want_rules] x$want_count exit $want_code, got [$got_rules] x$got_count exit $code"
    printf '%s\n' "$out" | sed 's/^/       /'
    fail=1
  fi
}

#     fixture                  exact rule set                                  findings
check empty-catch-ts.diff      "CRAFT-03.empty-catch"                          3
check empty-catch-py.diff      "CRAFT-03.empty-catch"                          2
check bare-except.diff         "CRAFT-03.bare-except"                          1
check log-continue-ts.diff     "CRAFT-03.log-and-continue"                     3
check log-continue-py.diff     "CRAFT-03.log-and-continue"                     1
check debug-output.diff        "CRAFT-06.debug-output"                         3
check todo.diff                "CRAFT-06.todo"                                 3
check ts-any.diff              "CRAFT-02.any"                                  4
check type-ignore.diff         "CRAFT-02.type-ignore"                          4
check commented-code.diff      "CRAFT-06.commented-code"                       4
check narration.diff           "CRAFT-07.narration"                            5
check sleep-wait.diff          "CRAFT-13.sleep-wait"                           3
check secrets.diff             "SLOP.secret"                                   5
check magic-timeout.diff       "CRAFT-13.magic-timeout"                        3
# Must not fire: idiomatic modules, a test that prints and sleeps on purpose, and comments that explain why.
check clean-ts.diff            ""                                              0
check clean-py.diff            ""                                              0
check clean-test.diff          ""                                              0
check clean-why-comment.diff   ""                                              0

# Every rule the script advertises is exercised by some fixture.
covered=$(cat "$here"/fixtures/*.diff | "$slop" --stdin | cut -f1 | LC_ALL=C sort -u || true)
missing=$("$slop" --rules | LC_ALL=C sort | comm -23 - <(printf '%s\n' "$covered"))
if [ -z "$missing" ]; then echo "ok   every rule has a firing fixture"; else echo "FAIL rules with no fixture: $missing"; fail=1; fi

# Same input, same output: run every fixture twice and compare.
same=1
for f in "$here"/fixtures/*.diff; do
  a=$(run --stdin < "$f"); b=$(run --stdin < "$f")
  [ "$a" = "$b" ] || { echo "FAIL $(basename "$f"): output differs between runs"; same=0; fail=1; }
done
[ "$same" -eq 1 ] && echo "ok   identical output on repeat runs"

# Output is sorted by file, then line number, then rule.
sorted=$(cat "$here"/fixtures/*.diff | run --stdin | awk -F '\t' '{ split($2, a, ":"); print a[1] "\t" a[2] "\t" $1 }')
resorted=$(printf '%s\n' "$sorted" | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -k2,2n -k3,3)
if [ "$sorted" = "$resorted" ]; then echo "ok   output sorted by file, line, rule"; else echo "FAIL output not sorted"; fail=1; fi

# Usage errors exit 2.
for args in "" "--bogus" "--paths" "--paths /nonexistent/file.ts"; do
  set +e; "$slop" $args >/dev/null 2>&1; code=$?; set -e
  if [ "$code" -eq 2 ]; then echo "ok   usage error exits 2: '${args}'"; else echo "FAIL usage '${args}' exited $code"; fail=1; fi
done

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# --paths scans whole files, with real line numbers.
mkdir -p "$tmp/p"
printf 'def f():\n    try:\n        g()\n    except:\n        raise\n' > "$tmp/p/mod.py"
got=$("$slop" --paths "$tmp/p/mod.py" || true)
case "$got" in *"CRAFT-03.bare-except	$tmp/p/mod.py:4	"*) echo "ok   --paths: bare except found at line 4" ;; *) echo "FAIL --paths: got: $got"; fail=1 ;; esac

# --diff in a throwaway repo: bad base fails, tracked edits and untracked files count, .scratch/ and fixtures/ do not.
(
  cd "$tmp"
  git init -q repo && cd repo
  git config core.autocrlf false
  mkdir -p src
  printf 'export function a(): number {\n  return 1;\n}\n' > src/a.ts
  git add . && git -c user.email=t@t -c user.name=t commit -q -m base
  base=$(git rev-parse HEAD)

  set +e; "$slop" --diff nosuchref >/dev/null 2>&1; code=$?; set -e
  if [ "$code" -eq 0 ]; then echo "FAIL --diff with a bad base exited 0"; exit 1; fi
  echo "ok   --diff rejects a bad base (exit $code)"

  set +e; out=$("$slop" --diff "$base"); code=$?; set -e
  [ "$code" -eq 0 ] && [ -z "$out" ] || { echo "FAIL --diff on a clean tree: exit $code, out: $out"; exit 1; }
  echo "ok   --diff on an unchanged tree exits 0"

  printf 'export function a(): number {\n  console.log("a");\n  return 1;\n}\n' > src/a.ts
  printf 'def b():\n    try:\n        c()\n    except Exception:\n        pass\n' > src/b.py
  mkdir -p .scratch fixtures
  printf 'console.log("note")\n' > .scratch/notes.ts
  printf 'const x: any = 1;\n' > fixtures/bad.ts
  out=$("$slop" --diff "$base" || true)
  case "$out" in *"CRAFT-06.debug-output	src/a.ts:2	"*) ;; *) echo "FAIL --diff: tracked edit not found at src/a.ts:2, got: $out"; exit 1 ;; esac
  case "$out" in *"CRAFT-03.empty-catch	src/b.py:4	"*) ;; *) echo "FAIL --diff: untracked src/b.py not scanned, got: $out"; exit 1 ;; esac
  case "$out" in *".scratch"*|*"fixtures/"*) echo "FAIL --diff: .scratch/ or fixtures/ was scanned, got: $out"; exit 1 ;; esac
  echo "ok   --diff: tracked edit and untracked file scanned, .scratch/ and fixtures/ ignored"
) || fail=1

# --staged: only lines added in the index count. Unstaged edits and untracked files are ignored; --justified skips
# findings whose file:line is listed with a reason under "## Justified".
(
  cd "$tmp"
  git init -q staged && cd staged
  git config core.autocrlf false
  mkdir -p src .scratch fixtures
  printf 'export function a(): number {\n  return 1;\n}\n' > src/a.ts
  git add . && git -c user.email=t@t -c user.name=t commit -q -m base
  code_of() { set +e; "$@" >/dev/null 2>&1; code=$?; set -e; }

  out=$("$slop" --staged)
  [ -z "$out" ] || { echo "FAIL --staged on an empty index: out: $out"; exit 1; }
  echo "ok   --staged: empty index exits 0"

  printf 'export function a(): number {\n  console.log("a");\n  return 1;\n}\n' > src/a.ts
  printf 'def b():\n    try:\n        c()\n    except Exception:\n        pass\n' > src/b.py
  printf 'const x: any = 1;\n' > src/c.ts
  printf 'const y: any = 1;\n' > fixtures/bad.ts
  printf 'console.log("note")\n' > .scratch/notes.ts
  git add src/a.ts src/c.ts fixtures/bad.ts
  git add -f .scratch/notes.ts
  set +e; out=$("$slop" --staged); code=$?; set -e
  [ "$code" -eq 1 ] || { echo "FAIL --staged with staged slop: exit $code, want 1"; exit 1; }
  case "$out" in *"CRAFT-06.debug-output	src/a.ts:2	"*) ;; *) echo "FAIL --staged: staged edit not found, got: $out"; exit 1 ;; esac
  case "$out" in *"CRAFT-02.any	src/c.ts:1	"*) ;; *) echo "FAIL --staged: staged new file not found, got: $out"; exit 1 ;; esac
  case "$out" in *"src/b.py"*) echo "FAIL --staged: untracked src/b.py was scanned, got: $out"; exit 1 ;; esac
  case "$out" in *".scratch"*|*"fixtures/"*) echo "FAIL --staged: .scratch/ or fixtures/ was scanned, got: $out"; exit 1 ;; esac
  echo "ok   --staged: staged lines only, same output format, untracked files ignored"

  # An unstaged edit on top of a staged file is not part of the commit.
  printf 'export function a(): number {\n  console.log("a");\n  console.debug("b");\n  return 1;\n}\n' > src/a.ts
  out=$("$slop" --staged || true)
  case "$out" in *"src/a.ts:3"*) echo "FAIL --staged: unstaged edit scanned, got: $out"; exit 1 ;; esac
  echo "ok   --staged: unstaged edits on a staged file ignored"

  printf '# Review\n\n## Findings\n\n## Justified\n\n- `src/a.ts:2` CRAFT-06.debug-output: startup banner the operator reads\n- src/c.ts:1 CRAFT-02.any\n\n## Other\n\n- src/zzz.ts:1 nope here\n' > .scratch/review.md
  set +e; out=$("$slop" --staged --justified .scratch/review.md); code=$?; set -e
  [ "$code" -eq 1 ] || { echo "FAIL --justified: exit $code, want 1 (src/c.ts:1 has no reason)"; exit 1; }
  case "$out" in *"src/a.ts:2"*) echo "FAIL --justified: justified finding still reported, got: $out"; exit 1 ;; esac
  case "$out" in *"src/c.ts:1"*) ;; *) echo "FAIL --justified: a listing without a reason must not count, got: $out"; exit 1 ;; esac
  echo "ok   --staged --justified: finding with a reason skipped, listing without a reason kept"

  printf '## Justified\n\n- src/c.ts:1 CRAFT-02.any: legacy payload shape owned by the vendor SDK\n- src/a.ts:2 CRAFT-06.debug-output: banner\n' > .scratch/review.md
  code_of "$slop" --justified .scratch/review.md --staged
  [ "$code" -eq 0 ] || { echo "FAIL --justified before --staged: exit $code, want 0"; exit 1; }
  echo "ok   --staged --justified: every finding justified exits 0, either argument order"

  code_of "$slop" --staged --justified .scratch/missing.md
  [ "$code" -eq 1 ] || { echo "FAIL --justified with a missing file: exit $code, want 1"; exit 1; }
  echo "ok   --staged --justified: a missing file justifies nothing"

  code_of "$slop" --staged --justified
  [ "$code" -eq 2 ] || { echo "FAIL --justified without a file: exit $code, want 2"; exit 1; }
  code_of "$slop" --stdin --justified x.md
  [ "$code" -eq 2 ] || { echo "FAIL --justified with --stdin: exit $code, want 2"; exit 1; }
  code_of "$slop" --paths --justified x.md src/a.ts
  [ "$code" -eq 2 ] || { echo "FAIL --justified with --paths: exit $code, want 2"; exit 1; }
  echo "ok   --justified usage errors exit 2"

  # --diff takes --justified too: the one justification rule serves the commit hook and the push and merge gates.
  printf '## Justified

- ./src/a.ts:2 CRAFT-06.debug-output: banner
- src/a.ts:3 CRAFT-06.debug-output: banner too
- src/c.ts:1 CRAFT-02.any: vendor sdk shape
' > .scratch/review.md
  set +e; out=$("$slop" --diff HEAD --justified .scratch/review.md); code=$?; set -e
  [ "$code" -eq 1 ] || { echo "FAIL --diff --justified: exit $code, want 1 (src/b.py:4 is not justified)"; exit 1; }
  case "$out" in *"src/b.py:4"*) ;; *) echo "FAIL --diff --justified: the unjustified finding must remain, got: $out"; exit 1 ;; esac
  case "$out" in *"src/a.ts"*|*"src/c.ts"*) echo "FAIL --diff --justified: justified findings still reported, got: $out"; exit 1 ;; esac
  printf -- '- src/b.py:4 CRAFT-03.empty-catch: shutdown path, the error is logged upstream
' >> .scratch/review.md
  code_of "$slop" --diff HEAD --justified .scratch/review.md
  [ "$code" -eq 0 ] || { echo "FAIL --diff --justified: every finding justified, exit $code, want 0"; exit 1; }
  echo "ok   --diff --justified: findings with a reason skipped (./ prefix too), the rest kept"
) || fail=1
(
  cd "$tmp" && mkdir -p nogit && cd nogit
  set +e; GIT_CEILING_DIRECTORIES="$tmp" "$slop" --staged >/dev/null 2>&1; code=$?; set -e
  [ "$code" -eq 2 ] || { echo "FAIL --staged outside a repo: exit $code, want 2"; exit 1; }
  echo "ok   --staged outside a git repo exits 2"
) || fail=1

if [ "$fail" -ne 0 ]; then echo "slop-check tests failed"; exit 1; fi
echo "all slop-check tests passed"
