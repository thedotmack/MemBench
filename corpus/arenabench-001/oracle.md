# Oracle notes — arenabench-001

Perfect-observer memory of session N (project arenabench,
2026-07-03 19:20–22:30 UTC). Everything below was established inside that
session; nothing is taken from what happened afterwards.

## Session goal and outcome

- **What happened**: babysat PR #1 ("ArenaBench goes OpenRouter-only") to a
  clean merge into `main` (merge commit `ca0189b`), then ran the first real
  head-to-head benchmark test (Sonnet 5 as the coding model, Haiku as the
  claude-mem model) and spent most of the session untangling cost-reporting
  mistakes and verifying claude-mem behavior inside the arena.
- **Ending state**: `main` at `ca0189b`; one real test completed for prompt
  `09-url-shortener` across both arms; user closed with "It should really be
  multi session tests and also what's the eval metric that we can report?"

## How the tool is run today (all manual)

- **Run a benchmark**: `bun run src/orchestrator.ts` (also `bun run start`)
  with hand-assembled flags — `--prompts-dir` (default `./prompts`),
  `--keys-env` (default `./keys.env`), `--results-dir` (default
  `./results`), `--replicas` (default 1), `--dry-run`. No interactive mode;
  a real test in this session required building a scratch prompts dir, a
  test `keys.env`, and a scratch results dir by hand.
- **Score/report**: `bun run report` (`src/report.ts`) — cross-vendor judge
  panel via OpenRouter (strict `json_schema`, median across judges per
  rubric dimension: functionality, code_quality, ux, completeness).
- **Unit tests**: `bun test` — suite was green at 75/75 during the session.
- **Prompts**: `prompts/` holds 10 numbered app prompts
  (`01-twosidednews.md` … `10-recipe-api.md`).
- **Arms**: every prompt×replica runs both arms, `claude-mem` and `vanilla`,
  in Docker images `benchmark-agent:claude-mem` / `benchmark-agent:vanilla`.

## Decisions and fixes that landed in PR #1

- **`entrypoint.sh` copies the agent's built project into `results/project/`**
  so judges can actually see the produced app.
- **`entrypoint.sh` writes `DONE.md` / `CRASHED.md` based on exit code**, so
  `src/analysis/aggregator.ts`'s completion-status logic works.
- **Per-agent results subdirectory is mounted**, not the shared results root.
- Both were verified with a mocked `claude` binary in Docker (success and
  crash paths).

## Gotchas discovered

- **Never quote Claude Code's self-reported `total_cost_usd`**: this repo's
  own Phase 4 finding is that it overstates real OpenRouter billed cost by
  ~3x (it prices tokens at Anthropic-direct rates). The correct path is the
  ledger in `aggregator.ts` (`computeAgentCost`,
  `cost_source: 'openrouter_ledger'`) which sums real `total_cost` per
  gen-id from `GET /api/v1/generation`; `report.json`'s
  `openrouter_billed_usd` is an independent reconciliation via the key's
  `usage_daily` delta. In this session the real cost of the one-prompt test
  was ~$0.93 billed (cmem $0.478, vanilla $0.450) vs $1.41 self-reported.
- **Vanilla arm legitimately shows a tiny Haiku charge (~$0.007)**:
  `src/container-manager.ts` sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` for every
  container regardless of arm because Claude Code itself makes an internal
  haiku-tier call. This is expected, not claude-mem leaking into vanilla —
  misreporting it as an anomaly caused a serious user blow-up mid-session.
- **The background haiku call has no `gen-` id** in the transcript, so it is
  outside the ledger total (small, self-reported ~$0.007).
- **Stale Docker images mask entrypoint fixes**: `benchmark-agent:*` images
  had to be removed so the orchestrator would rebuild with the latest
  `entrypoint.sh`.
- **claude-mem observation context is confirmed working** in this
  environment: a `PreToolUse` Read hook (worker-service daemon) injects
  prior observations on file reads — but only for files that already have
  observations recorded.

## User friction to remember (why "easy to run tests" matters)

- The user was repeatedly furious this session about: a mocked "bullshit
  test" being run when a real test was expected, Docker containers left
  running and wasting money, and cost numbers quoted from the wrong data
  source. Any change to how tests are launched should make real-vs-dry-run
  explicit, make small cheap tests trivial to start, and keep cost reporting
  on the ledger numbers.
