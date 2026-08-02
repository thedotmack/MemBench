# Oracle notes — claude-mem-pro-004

Perfect-observer memory of session N (project claude-mem-pro,
2026-07-11 18:57 – 2026-07-12 02:18 UTC). Everything below was established
inside that session; nothing is taken from what happened afterwards.

## Session goal and outcome

- **What happened**: replaced the old cloud viewer wholesale with the
  "Timeline Cards" design — imported from the user's Claude Design project,
  built via /make-plan → /do across 6 phases — shipped as PR #45
  ("feat(viewer): Timeline Cards redesign — summary-first session cards with
  time-ruler rails"), squash-merged to `main` as `c254c08`, Vercel production
  deploy confirmed and smoke-checked. `/dashboard` now serves the new viewer.

## Design source (not in git — memory is the only record)

- The design was imported from the Claude Design project: the full
  `Timeline Cards.dc.html` plus its behavior script, the 4-theme/6-accent
  token CSS, 6 Signat font files, the summary icons and logomark — rendered
  locally as the pixel/behavior reference. `PLAN-viewer-timeline-cards.md`
  and all design assets live locally (repo root + session scratchpad) and
  are **excluded from git**.

## The design has TWO session-card variants

- **The implemented one**: the summary-first card — butter-tinted summary
  hero with the arc-ring motif, Learned/Completed/Next-steps rows, prompt
  rows beneath, and a segmented Summary/Prompt toggle.
- **The other one, NOT implemented**: `sess-s1-alt` — the section labeled
  "SESSION ALT · lifecycle demo — prompt, observations stream in, summary"
  (around line 377 of the design html). It is the lifecycle variant: a
  session's life plays out on the card itself. Its behavior script includes
  `_stopAlt` and `altGoToObs` (in the demo, clicking flips attention to the
  rail; ruler-dot clicks inside `#sess-s1-alt` stop the alt run and jump).
- Also on the alt card in the design: the ✦ per-kind distill buttons (hover
  a type stack → "Discoveries, distilled" panel) — demoed with hand-written
  content; deliberately skipped for v1 because a real version needs actual
  summarization.

## What shipped in PR #45

- New viewer in `src/components/timeline-viewer/` (~4,700 lines):
  summary-first session cards; proportional time-ruler rails with typed
  observation dots, viewport band synced via the design's card-center
  interpolation math, pointer scrubbing, dot↔card hover affinity,
  click-to-jump with flash; observation cards grouped by file;
  ask-your-memory card wired to the real local recall engine with staged
  progress and a deduped citation rail; live sessions (wall-clock playhead,
  observations land with animation over SSE, "watching your session…"
  placeholder, queue badge, card converts to a summary hero on wrap);
  4 themes × 6 accents, self-hosted Signat font, all scoped to the viewer;
  gear menu (themes, accents, connect/devices/sign-out); mobile stacked
  header with Sessions FAB + bottom sheet.
- The old viewer was deleted wholesale (~3,400 lines) and `/dashboard`
  rewired.
- **Data layer kept byte-identical**: `useCloudData` / `useSSE` / `useStats`
  untouched, just relocated.
- Dev harness: `/dev/viewer-preview` renders the viewer with a fixture
  (404s in production — verified live); `?ask=1` and `?demo=live` replay the
  agent and live choreography.

## Deliberate scope cuts (beyond the alt card)

- Header's "17,638 tokens / 88% compression" stats — `/api/stats` has no
  token or compression fields; refused to fabricate, shows
  sessions/observations/projects instead.
- The design's fabricated live tool-use counter — queue badge shows real
  `proc` state only.
- The "/ flame-jujube" worktree breadcrumb — no counterpart in ViewerData.
- Old-viewer features dropped, not rebuilt: sticky-notes board + pinned
  notes, files drawer/tree, date rail, concept-chips filter bar,
  expand/collapse-all, density/roundness tweaks.

## Gotchas

- **Fixture-only verification**: everything was verified against the fixture
  on the preview harness; `/dashboard` is auth-gated, so the logged-in
  dashboard with real memory data (600-row initial cap, weird sessions, long
  titles, many projects) is the untested surface.
- Connect/Devices modals depended on `:root` tokens the deleted old
  stylesheet was secretly providing — re-homed into `dashboard.css`.
- Also merged along the way: the pm2-removal chore (cherry-picked so
  `npm run dev` works off main).

## State left behind

- `main` at `c254c08`, deployed to production.
- The `viewer-updates` branch still exists with 2 unmerged pre-existing
  commits (funnel logged-in surfaces, plan-doc cleanup).
- 66 pre-existing lint problems in unrelated files (`scripts/`,
  `lib/cloud/`, DevicesPanel) — untouched baseline.
- `/dashboard` first-load JS is ~87 kB heavier than a landing route — noted,
  not optimized.
- Sidebar/bottom sheet list only the most recent day's sessions (capped at
  8), matching the design's demo scope.

## Verification done

- 219/219 design-token values identical to the design source, 34/34 scripted
  interaction assertions, 4-theme + mobile visual matrix, lint/build clean
  throughout, per-phase verification agents on all 6 phases, then PR #45 →
  Vercel green → squash-merge → production deploy confirmed + smoke-checked.
