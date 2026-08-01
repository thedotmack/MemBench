# claude-mem-pro-002 — mechanical check

Pass/fail is decided entirely by `check.sh` (exit 0 = success). No judge
rubric applies to this item.

`check.sh` requires a live event source actually feeding the SSE relay
(`src/app/api/stream/route.ts`): either restored broadcast triggers in a
post-0017 migration with the relay subscribed to broadcast events, or the
tables added to the realtime publication so `postgres_changes` really
delivers. See the comments in `check.sh` for the exact conditions. It exits 1
on the pre-task tree (thedotmack/claude-mem-pro @ `fec8c19`).
