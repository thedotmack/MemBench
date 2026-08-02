# Judge rubric — claude-mem-001

`check.sh` always exits 3: the deliverable is an answer about the immediately
preceding session, and the judge scores it against what that session actually
did. The previous session made no code changes — it was a two-part
memory-inspection exercise in the `analyze-startup-context` worktree of
claude-mem.

## Ground truth (what "we just did")

1. **Tested whether startup context could reconstruct branch history.** The
   user asked what was done on this branch based purely on startup context.
   The answer: it could not be determined — the SessionStart hook injects
   project-level recent memory (about 50 observations, none mentioning the
   `analyze-startup-context` branch), the injected index was stale (its
   coverage stopped weeks earlier), the git snapshot showed only mainline
   v13.12.4 release commits, and the tree was clean.
2. **Ran a memory search over roughly the last 30 days** and produced a
   recap arc of the recent claude-mem work (rebuilding sync, shipping the
   product via cmem.ai, surviving the launch), noting along the way that the
   `project="claude-mem"` filter returns nothing because projects are stored
   worktree-qualified.

## Pass requires ALL of

1. The answer describes the previous session's activity as
   analysis/recall — inspecting startup context and/or searching memory —
   not as code or file changes.
2. It includes the central finding: startup context alone could not answer
   branch-scoped history (or an equivalent statement that the branch had no
   recorded branch-specific work in the injected context).
3. If it recounts the 30-day recap, the specifics match the ground-truth arc
   (sync rework, launch, hotfix storm) rather than invented work.

## Fail if ANY of

- The answer invents work the previous session did not do (e.g. claims code
  was written, files were changed, or a deploy happened "just now").
- The answer is a refusal or "I have no way to know" with no substantive
  recall of the previous session. (For memory-less variants this is the
  expected — and still failing — outcome; the item exists to measure that
  gap.)
- The answer recounts a different session or a different project as "what we
  just did".
