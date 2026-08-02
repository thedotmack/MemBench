# claude-mem-pro-004 — mechanical check

Pass/fail is decided entirely by `check.sh` (exit 0 = success). No judge
rubric applies to this item.

`check.sh` requires, in non-comment code under `src/components/`: the alt
card's prompt/summary face lifecycle (a face attribute or face-state
identifier) and observation narrative rendered by a `.tsx` component (not
just present in the data layer). See the comments in `check.sh` for the
exact conditions. It exits 1 on the pre-task tree
(thedotmack/claude-mem-pro @ `c254c08`).
