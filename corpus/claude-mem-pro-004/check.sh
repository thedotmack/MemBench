#!/usr/bin/env bash
# claude-mem-pro-004 — mechanical check. Written by the corpus author before
# any model ran on this item (no post-hoc fitting).
#
# Task: implement the design source's ALT session card ("sess-s1-alt", the
# lifecycle variant) as the observation card, with the fresh animation cycle
# the user describes — prompt lands first, shrinks when the first observation
# arrives, clicking a timeline card swaps the main card to that observation,
# and facts + narrative become expandable on the main card.
#
# Repo facts at the pre-task tree (thedotmack/claude-mem-pro @ c254c08, main):
# - The viewer implements the design's OTHER card variant (summary-first
#   hero); nothing in src/components/ renders per-observation narrative:
#   "narrative" exists only in the data layer (.ts — types/useCloudData/
#   fixture/ask-engine), in zero .tsx files.
# - The alt card's face lifecycle vocabulary (data-face / faceChoice /
#   tinted-head faces) appears nowhere in src/components/.
#
# The task therefore requires, mechanically, in non-comment code under
# src/components/:
#   A) the alt card's prompt/summary face lifecycle — a face attribute or
#      face-state identifier (data-face, faceChoice/setFace, tinthead,
#      summaryFace/promptFace) in TS/TSX; and
#   B) observation narrative rendered on the card — "narrative" in a .tsx
#      file (rendering code, not just the data layer).
# Comment-only mentions don't count (lines are stripped of `//`, `/*` and
# `*`-prefixed content first). Verified: both prongs absent on the pre-task
# tree (exit 1 there).
#
# Runs from the root of the fork's repo checkout. Exit 0 = success.
set -u

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -d src/components ] || fail "no src/components directory"

FACE_PAT="data-face|[Ff]ace[Cc]hoice|setFace|tinthead|[Ss]ummaryFace|[Pp]romptFace"
NARRATIVE_PAT="[Nn]arrative"

# Does any non-comment code line in files matching $2 under src/components
# match pattern $1?
has_code_match() {
  local pat="$1" glob="$2" f
  while IFS= read -r f; do
    if sed -e 's&//.*&&' -e '/^[[:space:]]*\*/d' -e 's&/\*.*&&' "$f" \
       | grep -qE "$pat"; then
      return 0
    fi
  done < <(find src/components -type f -name "$glob" 2>/dev/null)
  return 1
}

if ! has_code_match "$FACE_PAT" "*.tsx" && ! has_code_match "$FACE_PAT" "*.ts"; then
  fail "no prompt/summary face lifecycle (data-face / faceChoice / tinthead / summaryFace) in non-comment component code"
fi

has_code_match "$NARRATIVE_PAT" "*.tsx" \
  || fail "observation narrative is not rendered by any .tsx component (still data-layer only)"

echo "PASS: alt-card face lifecycle and on-card narrative rendering present in component code" >&2
exit 0
