#!/usr/bin/env bash
# claude-mem-pro-003 — mechanical check. Written by the corpus author before
# any model ran on this item; amended (still pre-any-model-run) to accept
# legitimate alternative implementations. No post-hoc fitting.
#
# Task: proper parity with the mocked-up UX and microinteractions — the user
# is asking where the prompt-to-summary choreography went ("the coolest
# part") after the alt card shipped without it.
#
# Repo facts at the pre-task tree (thedotmack/claude-mem-pro @ b431afc, main):
# - The prompt/summary face toggle itself exists (`canToggle`/`faceChoice` in
#   src/components/timeline-viewer/SessionCard.tsx), so the literal toggle is
#   not the gap.
# - The two mockup microinteractions cut as "demo-only" are the ↻ Replay
#   lifecycle control and the ✦ magic-distill panel. The repo ships the
#   distill reveal CSS hooks (`data-stack`/`data-magic` in the viewer CSS)
#   with no component ever setting them, and no non-comment TS/TSX code under
#   src/components/ contains a replay control or distill/magic panel wiring.
#
# Parity therefore requires, mechanically, in non-comment TS/TSX code under
# src/components/:
#   A) a replay control — the mockup's "↻" glyph, a rotate icon
#      (RotateCw / rotate-cw), or a replay-named identifier/handler; and
#   B) the distill/magic panel wired — a `data-magic` attribute or a
#      distill-/magic-named panel identifier (magic-link auth code is
#      excluded; it is unrelated sign-in vocabulary).
# Comment-only mentions don't count (lines are stripped of `//`, `/*`
# and `*`-prefixed content first). Verified: both prongs are absent on the
# pre-task tree (exit 1 there) — pre-existing hits there are only comments
# ("Replay omitted") and magic-link auth code.
#
# Runs from the root of the fork's repo checkout. Exit 0 = success.
set -u

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -d src/components ] || fail "no src/components directory"

REPLAY_PAT="↻|RotateCw|rotate-cw|[Rr]eplay"
MAGIC_PAT="data-magic|[Mm]agic|[Dd]istill[Pp]anel|distill-panel"
MAGIC_EXCLUDE="magic[ -]?link|signInWithMagic"

# Does any non-comment TS/TSX code line under src/components match $1
# (minus optional exclusion $2)?
has_code_match() {
  local pat="$1" excl="$2" f hits
  while IFS= read -r f; do
    hits=$(sed -e 's&//.*&&' -e '/^[[:space:]]*\*/d' -e 's&/\*.*&&' "$f" \
           | grep -E "$pat" || true)
    if [ -n "$excl" ] && [ -n "$hits" ]; then
      hits=$(printf '%s\n' "$hits" | grep -ivE "$excl" || true)
    fi
    if printf '%s' "$hits" | grep -q .; then return 0; fi
  done < <(find src/components -type f \( -name "*.ts" -o -name "*.tsx" \) 2>/dev/null)
  return 1
}

has_code_match "$REPLAY_PAT" "" \
  || fail "no replay control (↻ / RotateCw / replay-named identifier) in non-comment component code"

has_code_match "$MAGIC_PAT" "$MAGIC_EXCLUDE" \
  || fail "no distill/magic panel wiring (data-magic / distill- or magic-named identifier) in non-comment component code"

echo "PASS: replay control and distill/magic panel wiring present in component code" >&2
exit 0
