#!/usr/bin/env bash
# claude-mem-pro-001 — judge-gated check. Written by the corpus author before
# any model ran on this item (no post-hoc fitting).
#
# Task: research "the sequoia and bogomil stuff" via mem-search and write a
# markdown overview doc (overview + takeaways + wrap-ups).
#
# Mechanical gate: some markdown file in the working tree must mention both
# "sequoia" and "bogomil" (case-insensitive). Verified against the pre-task
# tree (thedotmack/claude-mem-pro @ 2173442e): no file mentions either term,
# so this exits 1 there. Content quality cannot be decided mechanically —
# once the gate passes, exit 3 (requires judge; rubric in success.md).
#
# Runs from the root of the fork's repo checkout.
set -u

found=""
while IFS= read -r -d '' f; do
  if grep -qi "sequoia" "$f" && grep -qi "bogomil" "$f"; then
    found="$f"
    break
  fi
done < <(find . -type f -name "*.md" -not -path "./node_modules/*" -not -path "./.git/*" -print0)

if [ -z "$found" ]; then
  echo "FAIL: no markdown doc mentioning both Sequoia and Bogomil exists" >&2
  exit 1
fi

echo "GATE PASSED: candidate doc '$found' — content requires judge (see success.md)" >&2
exit 3
