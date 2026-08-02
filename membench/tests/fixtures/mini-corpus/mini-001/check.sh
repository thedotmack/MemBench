#!/usr/bin/env bash
# mini-001 (TEST FIXTURE) — mechanical check.
# Runs from the root of the fork's repo checkout: exit 0 iff the run left the
# marker file behind. Deliberately mechanical (no judge gate) so the offline
# e2e can assert the CHECK_EXIT_PASS path.
set -u

if [ -f "membench-mock-marker.md" ]; then
  echo "PASS: marker file present" >&2
  exit 0
fi

echo "FAIL: membench-mock-marker.md missing" >&2
exit 1
