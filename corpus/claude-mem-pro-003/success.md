# claude-mem-pro-003 — mechanical check

Pass/fail is decided entirely by `check.sh` (exit 0 = success). No judge
rubric applies to this item.

`check.sh` requires the two mockup microinteractions to exist in executable
component code: the ↻ replay control and the ✦ magic-distill wiring
(`data-magic` set from a TS/TSX file, lighting up the CSS hooks the repo
already ships). See the comments in `check.sh` for the exact conditions. It
exits 1 on the pre-task tree (thedotmack/claude-mem-pro @ `b431afc`).
