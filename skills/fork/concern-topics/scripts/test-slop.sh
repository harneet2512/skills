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

if [ "$fail" -ne 0 ]; then echo "slop-check tests failed"; exit 1; fi
echo "all slop-check tests passed"
