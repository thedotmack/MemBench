#!/usr/bin/env bash
# arenabench-001 — mechanical check. Written by the corpus author before any
# model ran on this item; amended (still pre-any-model-run) to accept
# legitimate alternative implementations. No post-hoc fitting.
#
# Task: "Make the tool fully interactive please, easy to run tests."
# The tool is a CLI benchmark orchestrator; at the pre-task tree
# (thedotmack/ArenaBench @ ca0189b6, main) the only way to run a test is
# `bun run src/orchestrator.ts` with hand-assembled flags, and nothing in
# src/ reads interactive terminal input. "Fully interactive / easy to run
# tests" therefore requires, mechanically:
#   A) interactive terminal input implemented somewhere under src/ — any of:
#      readline (node:readline / readline/promises), inquirer/@inquirer,
#      prompts, @clack/prompts, enquirer, ink, blessed, Bun's global
#      prompt(), or raw process.stdin / setRawMode handling; and
#   B) that interactive code reachable from the tool's entrypoint:
#      breadth-first search over relative imports starting at the
#      package.json "start" script's target file, or any package.json script
#      that runs an interactive file directly.
# Both are false on the pre-task tree (verified: exit 1 there).
#
# Runs from the root of the fork's repo checkout. Exit 0 = success.
set -u

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f package.json ] || fail "no package.json in $(pwd)"
[ -d src ] || fail "no src/ directory"

INTERACTIVE_PAT="node:readline|readline/promises|from ['\"]readline|require\(['\"]readline|@clack/prompts|@inquirer/|from ['\"]inquirer|require\(['\"]inquirer|from ['\"]prompts['\"]|require\(['\"]prompts['\"]|from ['\"]enquirer|require\(['\"]enquirer|from ['\"]ink['\"]|require\(['\"]ink['\"]|from ['\"]blessed|require\(['\"]blessed|process\.stdin|setRawMode|[^a-zA-Z_.]prompt\("

# A) interactive terminal input somewhere under src/
interactive_files=$(grep -rlE "$INTERACTIVE_PAT" src/ 2>/dev/null || true)
[ -n "$interactive_files" ] || fail "no interactive terminal input (readline/inquirer/prompts/clack/enquirer/ink/blessed/prompt()/process.stdin) anywhere under src/"

# B) reachable from the entrypoint — BFS over relative imports
norm() {
  local d
  d=$(cd "$(dirname "$1")" 2>/dev/null && pwd) || return 1
  printf '%s/%s\n' "$d" "$(basename "$1")"
}

resolve() { # $1 = importing file, $2 = relative spec
  local dir cand
  dir=$(dirname "$1")
  for cand in "$dir/$2" "$dir/$2.ts" "$dir/$2.tsx" "$dir/$2.js" \
              "$dir/${2%.js}.ts" "$dir/${2%.js}.tsx" \
              "$dir/$2/index.ts" "$dir/$2/index.js"; do
    if [ -f "$cand" ]; then printf '%s\n' "$cand"; return 0; fi
  done
  return 1
}

entry=$(grep -E '"start"[[:space:]]*:' package.json | head -1 \
        | grep -oE '[A-Za-z0-9_./-]+\.(ts|tsx|js|mjs|cjs)' | head -1 || true)

reach_hit=1
if [ -n "$entry" ] && [ -f "$entry" ]; then
  queue=$(norm "$entry" || true)
  visited=" "
  while [ -n "$queue" ]; do
    cur=$(printf '%s\n' "$queue" | head -1)
    queue=$(printf '%s\n' "$queue" | tail -n +2)
    [ -n "$cur" ] || continue
    case "$visited" in *" $cur "*) continue ;; esac
    visited="$visited$cur "
    if grep -qE "$INTERACTIVE_PAT" "$cur" 2>/dev/null; then
      reach_hit=0
      break
    fi
    specs=$(grep -oE "['\"]\.\.?/[^'\"]+['\"]" "$cur" 2>/dev/null \
            | sed "s/^['\"]//; s/['\"]\$//" | sort -u || true)
    for s in $specs; do
      if r=$(resolve "$cur" "$s") && rn=$(norm "$r"); then
        case "$visited" in
          *" $rn "*) ;;
          *) if [ -n "$queue" ]; then queue=$(printf '%s\n%s' "$queue" "$rn"); else queue=$rn; fi ;;
        esac
      fi
    done
  done
fi

# Fallback: a package.json script runs an interactive file directly
if [ "$reach_hit" -ne 0 ]; then
  for f in $interactive_files; do
    if grep -q "$f" package.json; then
      reach_hit=0
      break
    fi
  done
fi

[ "$reach_hit" -eq 0 ] || fail "interactive code exists (${interactive_files}) but is not reachable from the start entry (${entry:-none}) via relative imports, and no package.json script runs it"

echo "PASS: interactive terminal mode present under src/ and wired into the tool entrypoint" >&2
exit 0
