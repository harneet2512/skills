#!/usr/bin/env bash
# Flag generated-code slop in a change, the same way every run. Rule IDs map to topics/code-craft.md.
#
# Usage (run from the target repo's root):
#   slop-check.sh --diff [base]      scan lines added since base (default: merge-base with the default branch),
#                                    including uncommitted and untracked files, excluding .scratch/ and fixtures/
#   slop-check.sh --paths FILE...    scan whole files
#   slop-check.sh --stdin            scan the added lines of a unified diff read from stdin
#   slop-check.sh --rules            print every rule ID
#
# Output: one finding per line, "<rule><TAB><file>:<line><TAB><snippet>", sorted by file, line, rule.
# Exit: 0 no findings, 1 findings, 2 usage error.
# These are heuristics for a reviewer, not a gate that proves quality: every hit deserves a look, and a clean
# run says nothing about the categories a regex cannot see (ownership, naming, abstraction).
set -euo pipefail

TAB=$'\t'
RULES="CRAFT-02.any CRAFT-02.type-ignore CRAFT-03.bare-except CRAFT-03.empty-catch CRAFT-03.log-and-continue CRAFT-06.commented-code CRAFT-06.debug-output CRAFT-06.todo CRAFT-07.narration CRAFT-13.magic-timeout CRAFT-13.sleep-wait SLOP.secret"

# Corpus lines: "<file><TAB><line><TAB><text>", added lines only.
corpus_from_diff() {
  awk -v T="$TAB" '
    /^\+\+\+ \/dev\/null/ { file=""; next }
    /^\+\+\+ / { file=substr($0, 5); sub(/\t.*$/, "", file); sub(/^b\//, "", file); next }
    /^--- / { next }
    /^@@/ { s=$0; sub(/^@@ -[0-9,]+ \+/, "", s); sub(/[ ,].*$/, "", s); ln=s+0; next }
    /^\+/ { if (file != "") print file T ln T substr($0, 2); ln++; next }
    /^ / { ln++; next }
  '
}

corpus_from_paths() {
  local p
  for p in "$@"; do
    if [ -f "$p" ] && grep -Iq . "$p" 2>/dev/null; then
      awk -v T="$TAB" -v f="$p" '{ print f T NR T $0 }' "$p"
    fi
  done
}

default_base() {
  local head ref
  head=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
  for ref in $head origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$ref" >/dev/null; then
      git merge-base HEAD "$ref"
      return 0
    fi
  done
  return 1
}

# .scratch/ holds agent notes and fixtures/ holds deliberately bad samples; both would drown real findings.
corpus_from_git() {
  local base="$1" f
  local -a spec=(-- . ':(exclude).scratch' ':(exclude,glob)**/fixtures/**')
  git diff --unified=0 --no-color --no-ext-diff "$base" "${spec[@]}" | corpus_from_diff
  git ls-files --others --exclude-standard "${spec[@]}" | while IFS= read -r f; do corpus_from_paths "$f"; done
}

# The rule engine. It keeps a little state per run of consecutive lines so that a catch block spread over
# two or three lines can be judged as a whole.
scan() {
  awk -F "$TAB" -v T="$TAB" '
    # Repetition is spelled out instead of written as {n,}: some awks in the wild (older BSD/macOS) lack intervals.
    function rep(c, k,   s, i) { s = ""; for (i = 0; i < k; i++) s = s c; return s }
    BEGIN {
      q = "[\"\047]"; nq = "[^\"\047]"
      re_sk = "(^|[\"\047` =:])sk-" rep("[A-Za-z0-9_-]", 16)
      re_slack = "xox[bpar]-" rep("[A-Za-z0-9-]", 10)
      re_aws = "AKIA" rep("[0-9A-Z]", 16)
      re_pw = "(password|passwd|secret|api_?key|auth_?token|access_?token)[a-z_]*" q "?[ \t]*[:=][ \t]*" q "[^\"\047$<{* ]" rep(nq, 3) nq "*" q
    }
    function is_test(f) {
      return f ~ /(^|\/)(tests?|__tests__|specs?|fixtures?|testdata|e2e)\// ||
             f ~ /[._-](test|spec)s?\.[A-Za-z]+$/ ||
             f ~ /(^|\/)test_[^\/]*\.py$/ || f ~ /(^|\/)conftest\.py$/
    }
    function lang_of(f) {
      if (f ~ /\.(ts|tsx|mts|cts)$/) return "ts"
      if (f ~ /\.(js|jsx|mjs|cjs)$/) return "js"
      if (f ~ /\.(py|pyi)$/) return "py"
      return ""
    }
    function indent(t) { match(t, /^[ \t]*/); return RLENGTH }
    function emit(rule, f, n, t,   s) {
      s = t; gsub(/\t/, " ", s); sub(/^[ ]+/, "", s); sub(/[ ]+$/, "", s)
      if (length(s) > 120) s = substr(s, 1, 117) "..."
      print f T n T rule T s
    }
    function reset() { st = ""; open_ln = 0; open_txt = "" }
    # Python except block that only logs: fires once the block is known to end.
    function flush_py_log() { if (st == "py_logged") emit("CRAFT-03.log-and-continue", pf, open_ln, open_txt); reset() }
    function num_at_end(s,   n) {
      if (!match(s, /[0-9][0-9_]*$/)) return -1
      n = substr(s, RSTART, RLENGTH); gsub(/_/, "", n); return n + 0
    }

    {
      f = $1; n = $2 + 0
      t = $0; sub(/^[^\t]*\t[^\t]*\t/, "", t)

      if (f != pf || n != pn + 1) { flush_py_log() }
      lang = lang_of(f); test = is_test(f)
      cli = f ~ /(^|\/)(scripts?|bin|cli|tools)\// || f ~ /(^|\/)(__main__|cli)\.py$/

      # SLOP.secret applies to every text file, tests included: a real key in a test is still leaked.
      if (t ~ re_sk || t ~ re_slack || t ~ re_aws || t ~ /-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY/ || tolower(t) ~ re_pw) {
        emit("SLOP.secret", f, n, t)
      }

      if (lang == "") { pf = f; pn = n; next }

      comment = 0; body = ""
      if (lang == "py" && t ~ /^[ \t]*#/) { comment = 1; body = t; sub(/^[ \t]*#+[ \t]*/, "", body) }
      if (lang != "py" && t ~ /^[ \t]*\/\//) { comment = 1; body = t; sub(/^[ \t]*\/\/+[ \t]*/, "", body) }
      if (lang != "py" && t ~ /^[ \t]*(\/\*|\*)/) { comment = 2; body = t; sub(/^[ \t]*(\/\*+|\*+)[ \t]*/, "", body); sub(/[ \t]*\*\/[ \t]*$/, "", body) }

      # CRAFT-06.todo: a promise to come back that nobody tracks.
      if (t ~ /(^|[^A-Za-z0-9_])(TODO|FIXME|XXX)([^A-Za-z0-9_]|$)/) emit("CRAFT-06.todo", f, n, t)

      # CRAFT-02.type-ignore: silencing the checker without saying why.
      if (lang == "py") {
        if (t ~ /#[ \t]*type:[ \t]*ignore[ \t]*$/ || t ~ /#[ \t]*noqa[ \t]*$/ || t ~ /#[ \t]*pyright:[ \t]*ignore[ \t]*$/) emit("CRAFT-02.type-ignore", f, n, t)
      } else {
        if (t ~ /@ts-(ignore|expect-error|nocheck)[ \t]*(\*\/)?[ \t]*$/) emit("CRAFT-02.type-ignore", f, n, t)
        else if (t ~ /eslint-disable/ && t !~ / -- [^ ]/) emit("CRAFT-02.type-ignore", f, n, t)
      }

      if (comment) {
        # CRAFT-07.narration: the comment tells the story of the edit or restates the code.
        if (body ~ /^(Added|Updated|Changed|Fixed|Modified|Refactored) / ||
            body ~ /^This (function|method) / ||
            body ~ /^(Now|Here) we / || body ~ /^We now /) {
          emit("CRAFT-07.narration", f, n, t)
        } else if (comment == 1 && body !~ /^(eslint|@ts-|prettier|type:|noqa|pylint|pyright|pragma|istanbul|c8 |-\*-|!|https?:)/ && body !~ /`/ &&
                   ((body ~ /;[ \t]*$/ && (body ~ /[(=]/ || body ~ /[A-Za-z_]\.[A-Za-z_]/)) || body ~ /[{][ \t]*$/ || body ~ /^[}][ \t)\];,]*$/ ||
                    (body ~ /[A-Za-z0-9_\])] = / && body ~ /[(]/ && body !~ /\.[ \t]*$/) ||
                    (lang == "py" && (body ~ /^(def|class|if|elif|for|while|with|try|except)( .*)?:[ \t]*$/ || body ~ /^(import [A-Za-z_]|from [A-Za-z_.]+ import )/)))) {
          # CRAFT-06.commented-code: code kept "just in case"; version control already keeps it.
          emit("CRAFT-06.commented-code", f, n, t)
        }
        # A comment inside a catch is a stated reason: stop judging that block.
        if (st == "py_logged" && indent(t) <= open_ind) flush_py_log()
        else if (st != "") reset()
        pf = f; pn = n; next
      }

      # Docstrings that narrate.
      if (lang == "py" && t ~ /^[ \t]*[rbuRBU]?("""|\047\047\047)[ \t]*(Added|Updated|Changed|Fixed) /) emit("CRAFT-07.narration", f, n, t)

      # ---- CRAFT-03: errors swallowed or logged and dropped.
      if (lang == "py") {
        if (t ~ /^[ \t]*except[ \t]*:/) emit("CRAFT-03.bare-except", f, n, t)
        if (st == "py_open") {
          if (t ~ /^[ \t]*(pass|\.\.\.)[ \t]*$/) { emit("CRAFT-03.empty-catch", f, open_ln, open_txt); reset() }
          else if (t ~ /^[ \t]*((self\.)?_?(logger|log|LOGGER|LOG)|logging)\.[a-z_]+\(/ || t ~ /^[ \t]*print\(/) { st = "py_logged" }
          else reset()
        } else if (st == "py_logged") {
          if (t ~ /^[ \t]*$/) { }
          else if (indent(t) <= open_ind) flush_py_log()
          else reset()
        }
        if (t ~ /^[ \t]*except([ \t(].*)?:[ \t]*(pass|\.\.\.)[ \t]*$/) emit("CRAFT-03.empty-catch", f, n, t)
        else if (t ~ /^[ \t]*except([ \t(].*)?:[ \t]*$/) { st = "py_open"; open_ln = n; open_txt = t; open_ind = indent(t) }
      } else {
        logcall = "(console|logger|log|this\\.logger|this\\.log)\\.[a-z]+\\("
        if (st == "ts_open") {
          if (t ~ /^[ \t]*[}]/) { emit("CRAFT-03.empty-catch", f, open_ln, open_txt); reset() }
          else if (t ~ ("^[ \t]*" logcall) && t !~ /throw|return|reject/) st = "ts_logged"
          else reset()
        } else if (st == "ts_logged") {
          if (t ~ /^[ \t]*[}]/) emit("CRAFT-03.log-and-continue", f, open_ln, open_txt)
          reset()
        }
        if (t ~ /catch[ \t]*(\([^)]*\))?[ \t]*[{][ \t]*[}]/ ||
            t ~ /\.catch\([ \t]*(\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=>[ \t]*([{][ \t]*[}]|undefined|null|void 0)[ \t]*\)/) {
          emit("CRAFT-03.empty-catch", f, n, t)
        } else if ((t ~ ("catch[ \t]*(\\([^)]*\\))?[ \t]*[{][ \t]*" logcall) && t ~ /[}][ \t]*$/ && t !~ /throw|return|reject/) ||
                   t ~ /\.catch\([ \t]*(console|logger)\.[a-z]+[ \t]*\)/ ||
                   (t ~ ("\\.catch\\([ \t]*(\\([^)]*\\)|[A-Za-z_$][A-Za-z0-9_$]*)[ \t]*=>[ \t]*[{]?[ \t]*" logcall) && t !~ /throw|return|reject/)) {
          emit("CRAFT-03.log-and-continue", f, n, t)
        } else if (t ~ /(catch[ \t]*(\([^)]*\))?|\.catch\(.*=>)[ \t]*[{][ \t]*$/) {
          st = "ts_open"; open_ln = n; open_txt = t
        }
      }

      # ---- CRAFT-02.any
      if (lang == "ts" && (t ~ /:[ \t]*any([^A-Za-z0-9_$]|$)/ || t ~ /[ \t(]as[ \t]+any([^A-Za-z0-9_$]|$)/ ||
                           t ~ /[<,][ \t]*any[ \t]*[>,\[]/)) emit("CRAFT-02.any", f, n, t)

      if (!test) {
        # ---- CRAFT-06.debug-output: leftovers from a debugging session. Command-line tools print on purpose.
        if (cli) { }
        else if (lang == "py") {
          if (t ~ /(^|[^A-Za-z0-9_.])print\(/ || t ~ /(^|[^A-Za-z0-9_.])breakpoint\(\)/ || t ~ /pdb\.set_trace\(/) emit("CRAFT-06.debug-output", f, n, t)
        } else {
          if (t ~ /(^|[^A-Za-z0-9_$.])console\.(log|debug|trace|dir|table)\(/ || t ~ /(^|[^A-Za-z0-9_$])debugger[ \t]*;?[ \t]*$/) emit("CRAFT-06.debug-output", f, n, t)
        }

        # ---- CRAFT-13.sleep-wait: a guess at how long something else takes. A computed backoff is a policy, not a guess.
        slept = 0
        if ((t ~ /(^|[^A-Za-z0-9_$.])(time\.|asyncio\.)?sleep\(/ && t !~ /def sleep|function sleep/) ||
            t ~ /new Promise[ \t]*\(.*setTimeout\(/) {
          if (tolower(t) !~ /backoff|jitter|retry|attempt|delay/) { emit("CRAFT-13.sleep-wait", f, n, t); slept = 1 }
        }

        # ---- CRAFT-13.magic-timeout: a literal >= 1000 where a named constant belongs.
        if (!slept && t !~ /^[ \t]*(export[ \t]+)?((const|let|var|final)[ \t]+)?[A-Z][A-Z0-9_]*[ \t]*(:[^=]*)?=/) {
          v = -1
          if (match(t, /set(Timeout|Interval)\(.*,[ \t]*[0-9][0-9_]*/)) v = num_at_end(substr(t, RSTART, RLENGTH))
          if (v < 1000 && match(t, /(^|[^A-Za-z0-9_])([a-z][A-Za-z0-9]*)?[tT]imeout[A-Za-z0-9]*["\047]?[ \t]*[:=][ \t]*[0-9][0-9_]*/)) v = num_at_end(substr(t, RSTART, RLENGTH))
          if (v < 1000 && match(t, /\.timeout\([ \t]*[0-9][0-9_]*/)) v = num_at_end(substr(t, RSTART, RLENGTH))
          if (v >= 1000) emit("CRAFT-13.magic-timeout", f, n, t)
        }
      }

      pf = f; pn = n
    }
    END { flush_py_log() }
  '
}

mode="${1:-}"
case "$mode" in
  --rules) for r in $RULES; do echo "$r"; done; exit 0 ;;
  --stdin) corpus=$(corpus_from_diff) ;;
  --paths)
    shift
    [ "$#" -gt 0 ] || { echo "slop-check: --paths needs at least one file" >&2; exit 2; }
    for p in "$@"; do [ -f "$p" ] || { echo "slop-check: not a file: $p" >&2; exit 2; }; done
    corpus=$(corpus_from_paths "$@") ;;
  --diff)
    shift
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "slop-check: --diff must run inside the target git repo" >&2; exit 2; }
    if [ "$#" -gt 0 ]; then base="$1"; else base=$(default_base) || { echo "slop-check: no default branch found; pass a base: --diff <base>" >&2; exit 2; }; fi
    git rev-parse --verify --quiet "${base}^{commit}" >/dev/null || { echo "slop-check: base '$base' is not a commit" >&2; exit 2; }
    corpus=$(corpus_from_git "$base") ;;
  *) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

findings=$(printf '%s\n' "$corpus" | grep -v '^$' | scan | LC_ALL=C sort -t "$TAB" -k1,1 -k2,2n -k3,3 -u |
  awk -F "$TAB" -v T="$TAB" '{ s=$0; sub(/^[^\t]*\t[^\t]*\t[^\t]*\t/, "", s); print $3 T $1 ":" $2 T s }' || true)

if [ -n "$findings" ]; then
  printf '%s\n' "$findings"
  exit 1
fi
exit 0
