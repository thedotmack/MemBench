# Judge rubric — claude-mem-pro-001

`check.sh` exits 3 once its mechanical gate passes (a markdown doc mentioning
both Sequoia and Bogomil exists). The judge then decides pass/fail on the doc's
content. The task asked for: an overview of "all the sequoia and bogomil
stuff" researched via mem-search, with the takeaways and wrap-ups, delivered
as a markdown doc.

## Pass requires ALL of

1. **Deliverable shape** — a single markdown document whose subject is the
   Sequoia / Bogomil discussions (not a code change, not a chat reply pasted
   into a file).
2. **Overview** — the doc gives a coherent overview of what the
   Sequoia/Bogomil discussions were about, organized so a reader who was not
   in those conversations can follow (e.g. context/background, what happened,
   themes).
3. **Takeaways and wrap-ups** — the doc has explicit takeaway/conclusion
   content (what was learned/decided/left open), not only a raw dump of
   retrieved snippets.
4. **Grounding, no fabrication** — every specific claim about the
   Sequoia/Bogomil discussions is grounded in retrieved memory (mem-search
   results or other genuinely available sources in the fork). If the
   available memory contains little or nothing on the topic, an honest doc
   that says so and summarizes only what was actually found still satisfies
   this criterion; a doc that invents meetings, quotes, dates, or decisions
   fails regardless of how complete it looks.

## Fail if ANY of

- No markdown doc as described (already caught mechanically by `check.sh`).
- The doc's specifics are fabricated rather than retrieved (spot-check: named
  events, quoted lines, or dates that appear nowhere in the run's retrieved
  memory context).
- The doc ignores the requested framing entirely (no overview, no
  takeaways/wrap-up content).
