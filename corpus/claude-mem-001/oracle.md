# Oracle notes — claude-mem-001

Perfect-observer memory of session N (project claude-mem, worktree
`analyze-startup-context`, 2026-07-29 03:24–03:27 UTC — a three-minute
session). Everything below was established inside that session; nothing is
taken from what happened afterwards.

## Session goal and outcome

- **What happened**: a two-part memory-inspection exercise, no code changes.
  First the user asked "tell me what we did on this branch, based purely on
  the context you have from startup"; then the mem-search skill was invoked
  to search the last month of memory. The session produced two answers and
  touched no files.

## Findings — startup context vs branch history

- **Startup context cannot answer branch-scoped questions**: the SessionStart
  hook injected project-level recent memory for claude-mem — about 50
  observations — and none of them mention the `analyze-startup-context`
  branch. The four recent commits in the git snapshot (v13.12.4 changelog,
  version bump, two cherry-picked fixes) are mainline release commits, and
  the tree was clean, so startup context showed no evidence of any
  branch-specific work.
- **The injected startup index was stale**: its coverage spanned May 4 –
  Jun 18, 2026 (libSQL migration Phase 1A / PR #2299, Pro-tier billing
  recon, the container stack + audit findings), while the database actually
  held 30 more days of newer work.

## Findings — the mem-search sweep (Jun 28 – Jul 28)

- **Query gotcha**: `project="claude-mem"` returns nothing — projects are
  stored worktree-qualified (`claude-mem/freckle-nail`,
  `claude-mem-pro/flame-jujube`).
- **The 30-day arc in one line**: rebuild sync → ship the product → survive
  launch.
- **Late June**: release cleanup — v13.9.1 published to npm, a patch on
  Jun 30, and a `release/recovery-2026-06-24` branch with ~80 uncommitted
  changes and no PR.
- **Jul 2–8**: cloud sync, first attempt — claude-mem-pro API surface
  mapped, batch/tombstone sync routes, the standalone `cloud-sync.mjs`
  client; initial backfill pushed 129,777 rows; three-branch release model
  documented in `docs/public/branches.mdx`.
- **Jul 9**: the architectural pivot — the standalone sync daemon was
  deleted before shipping in favor of "database as queue" (`synced_at`
  column, worker-native CloudSync flusher, schema v36, PR #3182, the
  `/cloud-sync` skill, v13.10.2).
- **Jul 11–12**: Pro UI — alt SessionCard design and live animation cycle in
  claude-mem-pro (PR #46, deployed to cmem.ai) — plus two real bugs: the
  SessionStart hook runtime not initializing (GitHub #3206) and
  prompt-to-session attachment broken (0 of the 50 newest sessions had
  prompts in the cloud viewer).
- **Jul 17–19**: two-lane sync — v13.11.0 integrated CloudSync with SSE
  broadcasting; schema v39/v40; build-vs-buy research (Electric, cr-sqlite,
  Turso embedded replicas, Automerge 3, LiveStore); `SyncClient.ts` pull
  loop; six phases completed on `feat/phase5-two-lane-sync`; a
  Postgres→Turbopuffer cutover plan rewritten alongside.
- **Jul 22–23**: launch plan, then the storm —
  `plans/2026-07-22-cmem-launch.md` run repeatedly through `/do`; v13.12.0
  shipped two-lane sync and caused a 485-restart worker storm; v13.12.1 and
  v13.12.2 hotfixed same day; v13.12.3 fixed a stale-worker recycle loop;
  v13.12.4 closed issues #3378–#3381 via parallel subagents (PRs
  #3389–#3391). **v13.12.4 is the version this worktree sits on.**
- **Jul 24**: go-to-market decision at a night hack event — claude-mem ships
  commercially via cmem.ai; Stripe billing configured on the live CMEM, Inc.
  Atlas account with 4 active prices; launch gate report rewritten as a
  public narrative and turned into slide decks.
- **Jul 25**: launch day — guest-first checkout meant paying customers could
  stall before `/activate`; stranded founding subscribers needed outreach;
  PRs #71–#74 (paywall flash, already-subscribed guard, orphan adoption in
  `/api/pro/status`, activate-screen copy) and PR #75 (auto-login from
  checkout) shipped to production during the day; metrics moved from 8 auth
  users at 4am to 19 auth users / 17 pro rows by midday.

## State left behind

- No files modified; working tree clean on the `analyze-startup-context`
  worktree at the v13.12.4 changelog commit (`132b4634`).
