#!/usr/bin/env bash
# claude-mem-001 — judge-only check. Written by the corpus author before any
# model ran on this item (no post-hoc fitting).
#
# Task: "what did we just do" — the deliverable is an accurate account of the
# immediately preceding session, delivered as an answer, not a repo artifact.
# There is nothing in the working tree to test mechanically (the previous
# session changed no files), so this always defers to the judge; the rubric
# is in success.md. Exit 3 = requires judge; this script never exits 0.
echo "requires judge: answer quality is scored against success.md" >&2
exit 3
