# Oracle notes — claude-mem-pro-003

Perfect-observer memory of session N (project claude-mem-pro,
2026-07-12 02:25–05:16 UTC). Everything below was established inside that
session; nothing is taken from what happened afterwards.

## Session goal and outcome

- **What happened**: implemented "the alt card as the observation card" —
  the lifecycle variant from the design source became the session card, with
  a fresh live animation cycle — shipped as PR #46 ("Alt card as the
  observation card + fresh live animation cycle"), merged to `main` as
  `b431afc`, deployed to Vercel production, cmem.ai smoke-checked healthy.

## Design source (not in git — memory is the only record)

- The mockup lives untracked at `design/timeline-cards/timeline-cards.dc.html`
  (referred to as `dc.html`; also served locally at
  `http://localhost:8899/Timeline%20Cards.dc.html` during the session), with
  a written spec at `design/timeline-cards/DESIGN-SPEC.md`. The alt card is
  the `sess-s1-alt` variant, DESIGN-SPEC §6.

## The shipped animation cycle

- Session starts → prompt and box land full-size (lilac tinted head,
  Recording pill).
- First observation arrives → prompt shrinks to a small row, the
  observation's title becomes the main card; its rail box gets a bold accent
  ring.
- Clicking any timeline item (obs card or ruler dot) swaps the main card to
  that observation; while live, landings auto-follow the newest obs; clicking
  an older one pins it, clicking the newest resumes following.
- Facts and narrative expand on the main card (new — the design had no
  facts/narrative display anywhere).
- No summary ever arrives → the card settles on the observation view with a
  time-range + count badge (the dashed "Summary distills…" placeholder is
  gone).
- Wrapped sessions get the butter summary face with per-type observation
  stacks; clicking a stack jumps to that type's earliest obs.

## Deliberate scope cuts (the mapping decisions)

- **Omitted as demo-only: the "alt layout" tag, the ↻ Replay button, and the
  ✦ magic/KINDSUM distill panel** — the distill panel's content was
  hardcoded demo text with no production data source. These are exactly the
  mockup microinteractions the production card does NOT have.
- The type stacks stayed (pure aggregation of real observations), and the
  type-stack reveal CSS was ported, so hooks for the omitted ✦ interaction
  exist in the viewer CSS without any component using them.
- Inverted the demo's `altGoToObs` (which flipped to the rail): clicking
  timeline items swaps the main card instead, per the user's description.

## File locations

- Viewer components: `src/components/timeline-viewer/` — `SessionCard.tsx`
  (the card, faces, toggle), `TimelineViewer.tsx`, `ObsCard.tsx`,
  `useRailSync.ts`, `cards.css`, `viewer.css`.
- The prompt/summary face machinery is in `SessionCard.tsx` (`canToggle`,
  `faceChoice`, `data-face`); face toggling was Playwright-verified, so the
  toggle itself exists in production.

## Gotchas

- **The "distilling…" pill exists but will not show in production yet**: the
  `isLiveSession` heuristic keeps sessions "live" for 30 minutes, which
  outlasts the 5-minute distill window; it only lights up once a real SSE
  wrap signal replaces the heuristic.
- Real-data surfaces were untested: everything was verified on the fixture
  harness; odd prompts, many observation types, and long titles remained the
  untested surface.

## Verification done

- Ran as /make-plan → /do with per-phase subagents: 5 phases, each passing
  independent Playwright verification (face toggles, full selection matrix,
  the complete 20-second live cycle with landings within ±12ms, pin/resume, a
  19ms rapid-toggle race on the stack jump, 4 themes, mobile) plus an
  anti-pattern review and a final pre-ship QA audit; lint stayed at the repo
  baseline; production smoke checks passed after deploy.
