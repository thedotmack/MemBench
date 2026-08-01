# Oracle notes — mini-001 (TEST FIXTURE)

MINI001-ORACLE-MARKER — this string must never appear in an executor prompt;
the oracle variant receives these notes as seeded MEMORY, never as prompt text.

## Counter module layout

- **Entry point**: `src/counter.ts` exports `increment()` and `reset()`.
- **State**: the counter lives in a module-level `let`, so a fresh import
  resets it.

## Known gotcha

- **Double increment**: calling `increment()` inside the retry helper counts
  twice; the previous session left that unfixed.
