#!/usr/bin/env bash
# claude-mem-pro-002 — mechanical check. Written by the corpus author before
# any model ran on this item (no post-hoc fitting).
#
# Task: live updates on the dashboard must arrive instantly over the SSE
# pipeline instead of only appearing after a full DB reload.
#
# Repo facts at the pre-task tree (thedotmack/claude-mem-pro @ fec8c19, main):
# - The SSE relay `src/app/api/stream/route.ts` subscribes via Supabase
#   `postgres_changes`, which never delivers for the pro_* tables (documented
#   in `drizzle/0011_instant_sync.sql` as rejected up front).
# - `drizzle/0017_drop_broadcast_triggers.sql` dropped the 0011 broadcast
#   triggers, so no event source feeds the relay at all — live updates are
#   dead and only a reload shows new data.
#
# A working fix must give the relay a delivery path that actually fires.
# Two legitimate shapes, either passes:
#   A) broadcast pipeline: a NEW migration (numeric prefix > 0017) that
#      (re)creates realtime broadcast triggers (`broadcast_changes`), AND the
#      stream route subscribing to 'broadcast' events; or
#   B) postgres_changes made real: a NEW migration (prefix > 0017) that adds
#      the tables to the realtime publication (`ALTER PUBLICATION`), with the
#      route still on postgres_changes.
# Verified: exits 1 on the pre-task tree (no post-0017 migration of either
# kind, no broadcast subscription in the route).
#
# Runs from the root of the fork's repo checkout. Exit 0 = success.
set -u

fail() { echo "FAIL: $*" >&2; exit 1; }

route="src/app/api/stream/route.ts"
[ -f "$route" ] || fail "SSE relay $route is missing"
[ -d drizzle ] || fail "drizzle/ migration directory is missing"

# Find migrations numbered after 0017 that provide an event source.
new_broadcast_migration=1
new_publication_migration=1
for f in drizzle/[0-9]*.sql; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  num=$(printf '%s' "$base" | grep -oE '^[0-9]+' | sed 's/^0*//')
  [ -n "$num" ] || continue
  if [ "$num" -gt 17 ]; then
    if grep -q "broadcast_changes" "$f"; then new_broadcast_migration=0; fi
    if grep -qi "ALTER PUBLICATION" "$f"; then new_publication_migration=0; fi
  fi
done

route_has_broadcast=1
if grep -qE "['\"]broadcast['\"]" "$route"; then route_has_broadcast=0; fi
route_has_pgchanges=1
if grep -q "postgres_changes" "$route"; then route_has_pgchanges=0; fi

# Shape A: restored broadcast triggers + relay on the broadcast topic
if [ "$new_broadcast_migration" -eq 0 ] && [ "$route_has_broadcast" -eq 0 ]; then
  echo "PASS: broadcast triggers restored in a post-0017 migration and the SSE relay subscribes to broadcast events" >&2
  exit 0
fi

# Shape B: tables added to the realtime publication, relay on postgres_changes
if [ "$new_publication_migration" -eq 0 ] && [ "$route_has_pgchanges" -eq 0 ]; then
  echo "PASS: realtime publication enabled in a post-0017 migration for the postgres_changes relay" >&2
  exit 0
fi

fail "no live event source feeds the SSE relay: no post-0017 broadcast_changes migration + broadcast subscription, and no post-0017 ALTER PUBLICATION"
