# Oracle notes — claude-mem-pro-002

Perfect-observer memory of session N (project claude-mem-pro,
2026-07-12 05:16–17:00 UTC). Everything below was established inside that
session; nothing is taken from what happened afterwards.

## Session goal and outcome

- **What happened**: restored the two mockup microinteractions that the
  previous session's "mapping decision #5" had cut as demo-only — the
  ↻ Replay lifecycle cinematic and the ✦ distill button + panel — as PR #47
  ("Alt-card mockup parity: Replay lifecycle + ✦ distill panel"),
  squash-merged to `main` as `fec8c19` and deployed live to cmem.ai.
- **Clarified for the user**: the Summary ⇄ Prompt segmented control itself
  DID ship in PR #46 (`SessionCard.tsx`, settled head row) — what had been
  skipped was the choreography around it.

## What shipped in PR #47

- **↻ Replay**: settled sessions with a prompt + summary get a Replay button;
  clicking re-runs the card's life on real data — cross-fade to the lilac
  prompt face → "listening" placeholder + Recording pill → the session's real
  observations land one-by-one on the ruler and strip (~950ms cadence,
  dot-land/card-land animations, scroll-to-newest, flash) → "distilling N
  observations…" spinner → cross-fade settle onto the butter summary face.
  Any interaction mid-run stops it; reduced motion settles instantly.
- **✦ distill**: hovering a type stack on the summary face reveals the
  sparkle button (always visible on touch); clicking opens a panel after a
  1300ms distilling beat with per-kind text synthesized from the real
  observations' facts — a new pure `distillKind()` in
  `src/components/timeline-viewer/ask-engine.ts` (not the mockup's hardcoded
  copy) — plus cite chips (cap 4) that jump into the timeline with
  center-and-flash.

## Viewer architecture facts

- **Component layout**: the dashboard timeline viewer lives in
  `src/components/timeline-viewer/` — `SessionCard.tsx`,
  `TimelineViewer.tsx`, `ObsCard.tsx`, `ask-engine.ts`, `useRailSync.ts`,
  `cards.css`, `viewer.css`.
- **Data layer was deliberately untouched**: `useCloudData.ts` (history) +
  `useSSE()` (live rows) + `useStats` — the plan's hard constraint was that
  this layer "stays byte-identical".
- **Live wiring on the client**: `TimelineViewer.tsx:208` is the sole
  consumer of `live.lastStreamObs` and calls `rail.landObs` 80ms behind each
  landing; `isLiveSession` is used at `:274/:300/:373`; AskCard behavior
  (`TimelineViewer.tsx:89-197`) is a do-not-break zone.
- **The preview harness drives demos**: its `LANDINGS`/`WRAP_AT` constants
  are the demo driver — real state drives production. All live-cycle
  verification this session ran against the preview harness, not against
  the production SSE feed.

## Verification done

- Lint held the repo's 66-problem baseline with zero new issues; build green.
- Playwright replay suite measured landings at
  1118/2081/3038/3967/4918/5880ms with distill at 6.9s and settle at 8.7s;
  the magic suite covered reveal, cite jumps, kind switching, the 4-chip cap,
  dark theme, iPhone touch, keyboard separation, and reduced motion.

## Gotchas

- **Production live path was never exercised**: everything ran on the
  fixture/preview harness; nobody watched a real session stream into the
  production dashboard during this session.
- Infrastructure noise during verification: a usage-limit window stalled
  subagents overnight, and a network blip polluted one console-hygiene check
  (re-verified clean in isolation — the google-analytics
  ERR_INTERNET_DISCONNECTED noise was environmental, not a product bug).

## State left behind

- `main` at `fec8c19`, deployed and smoke-checked: cmem.ai 200, /dashboard
  redirects to /login unauthenticated, dev preview 404s in production.
- To see the new features: a settled session card's ↻ Replay, or hover a
  type stack on a summary face for the ✦.
