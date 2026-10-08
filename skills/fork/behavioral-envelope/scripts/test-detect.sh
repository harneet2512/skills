#!/usr/bin/env bash
# Regression tests for detect-packs.sh. Each case names packs that must be selected and packs that must not be.
# Run: skills/fork/behavioral-envelope/scripts/test-detect.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
detect="$here/detect-packs.sh"
fail=0

check() {
  local fixture="$1" must="$2" must_not="$3" got pack bad=0
  got=$("$detect" --stdin < "$here/fixtures/$fixture" | cut -f1 | tr '\n' ' ')
  for pack in $must; do
    case " $got" in *" $pack "*) ;; *) echo "FAIL $fixture: expected $pack, got: $got"; bad=1 ;; esac
  done
  for pack in $must_not; do
    case " $got" in *" $pack "*) echo "FAIL $fixture: did not expect $pack, got: $got"; bad=1 ;; esac
  done
  if [ "$bad" -eq 0 ]; then echo "ok   $fixture: $got"; else fail=1; fi
}

#     fixture               must select                                             must not select
check color-token.diff      "core ui-visual"                                        "outbound money llm data api"
check copy-edit.diff        "core"                                                  "ui-visual outbound money llm data api jobs-time"
check comment-only.diff     "core"                                                  "money identity-access personal-data"
check space-path.diff       "core"                                                  "outbound money"
check resend-button.diff    "core ui-behavior api data outbound personal-data"      "llm money"
check webhook-handler.diff  "core api data inbound-events integrations-auth"        "llm ui-visual"
check llm-reply.diff        "core llm"                                              "outbound ui-visual money"
check migration.diff        "core data"                                             "outbound llm ui-visual"
check scheduled-send.diff   "core jobs-time"                                        "llm ui-visual money"
check celery-task.diff      "core jobs-time data"                                   "ui-visual llm"
check stripe-charge.diff    "core money data"                                       "ui-visual llm"
check go-handler.diff       "core api"                                              "ui-visual llm money"
check deps.diff             "core dependencies"                                     "ui-visual llm money"

# --plan mode: plain-language requests, including packs implied by others.
check_plan() {
  local fixture="$1" must="$2" must_not="$3" got pack bad=0
  got=$("$detect" --plan "$here/fixtures/plans/$fixture" | cut -f1 | tr '\n' ' ')
  for pack in $must; do
    case " $got" in *" $pack "*) ;; *) echo "FAIL plan $fixture: expected $pack, got: $got"; bad=1 ;; esac
  done
  for pack in $must_not; do
    case " $got" in *" $pack "*) echo "FAIL plan $fixture: did not expect $pack, got: $got"; bad=1 ;; esac
  done
  if [ "$bad" -eq 0 ]; then echo "ok   plan $fixture: $got"; else fail=1; fi
}
check_plan readme-typo.txt      "core"                                          "ui-visual outbound money llm data api"
check_plan button-color.txt     "core ui-visual"                                "outbound money llm data api"
check_plan ghost-sequences.txt  "core outbound jobs-time llm data inbound-events" "money ui-visual"
check_plan seat-billing.txt     "core money data api inbound-events"            "ui-visual llm"
check_plan quant-orders.txt     "core money data api jobs-time"                 "ui-visual outbound"
check_plan password-reset.txt   "core identity-access outbound api data"        "money llm"

# Evidence keeps paths with spaces whole.
"$detect" --stdin < "$here/fixtures/space-path.diff" >/dev/null
sp=$(printf '%s\n' 'diff --git a/my dir/x.css b/my dir/x.css' '+++ b/my dir/x.css' '@@ -0,0 +1 @@' '+a { color: red; }' | "$detect" --stdin | grep '^ui-visual' || true)
case "$sp" in *"my dir/x.css"*) echo "ok   path with spaces kept whole" ;; *) echo "FAIL path with spaces: $sp"; fail=1 ;; esac

# Same input, same output: run every fixture twice and compare.
for f in "$here"/fixtures/*.diff; do
  a=$("$detect" --stdin < "$f"); b=$("$detect" --stdin < "$f")
  [ "$a" = "$b" ] || { echo "FAIL $(basename "$f"): output differs between runs"; fail=1; }
done
echo "ok   identical output on repeat runs"

# --paths mode scans whole files.
paths_got=$("$detect" --paths "$here/fixtures/llm-reply.diff" | cut -f1 | tr '\n' ' ')
case " $paths_got" in *" llm "*) echo "ok   --paths: $paths_got" ;; *) echo "FAIL --paths: expected llm, got: $paths_got"; fail=1 ;; esac

# --diff mode in a throwaway repo: bad base fails, untracked files count, .scratch/ is ignored.
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(
  cd "$tmp"
  git init -q
  git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
  base=$(git rev-parse HEAD)
  if "$detect" --diff nosuchref >/dev/null 2>&1; then echo "FAIL --diff with a bad base exited 0"; exit 1; fi
  echo "ok   --diff rejects a bad base"
  mkdir -p .scratch/envelope src
  printf 'OUT-01 sent once; LLM-02; tenant session; price refund\n' > .scratch/envelope/x.md
  printf 'await mailer.sendEmail({ to })\n' > src/send.ts
  got=$("$detect" --diff "$base" | cut -f1 | tr '\n' ' ')
  case " $got" in *" outbound "*) ;; *) echo "FAIL --diff: untracked src/send.ts not scanned, got: $got"; exit 1 ;; esac
  case " $got" in *" money "*|*" llm "*) echo "FAIL --diff: .scratch/ was scanned, got: $got"; exit 1 ;; esac
  echo "ok   --diff: $got(.scratch ignored)"
) || fail=1

if [ "$fail" -ne 0 ]; then echo "detect-packs tests failed"; exit 1; fi
echo "all detect-packs tests passed"
