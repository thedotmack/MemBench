#!/usr/bin/env bash
# mini-002 (TEST FIXTURE) — judge-gated check.
# Mechanical gate: the run must have left the marker file. Content quality is
# not mechanically decidable, so a passing gate exits 3 (CHECK_EXIT_JUDGE) and
# the judge decides against success.md. Exercises the judge-success path in
# the offline e2e.
set -u

if [ ! -f "membench-mock-marker.md" ]; then
  echo "FAIL: membench-mock-marker.md missing" >&2
  exit 1
fi

echo "GATE PASSED: marker present — content requires judge (see success.md)" >&2
exit 3
