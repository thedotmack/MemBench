# Oracle notes — mini-002 (TEST FIXTURE)

MINI002-ORACLE-MARKER — seeded as MEMORY only, never as prompt text. This item
is also the shuffled control's donor for mini-001: these notes are the
"another session's notes" the shuffled fork is seeded with.

## Release script layout

- **Entry point**: `scripts/release.sh` bumps the version then tags.
- **Ordering**: the tag must be created after the version bump commit.

## Known gotcha

- **Dirty tree**: the script silently no-ops when the tree is dirty.
