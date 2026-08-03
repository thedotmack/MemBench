/**
 * Core MemBench types — v0.1 plan Phase 1.
 * Field lists follow plans/2026-07-31-membench-v0.1-plan.md exactly.
 */

/**
 * Executor lanes. The lanes are separate: no scoreboard cell may mix
 * claude-cli and openrouter-agent rows (plan §0.2 guard 11).
 */
export type ExecutorName = 'claude-cli' | 'openrouter-agent';

/**
 * Memory variant of a fork: a real observer model (`model:<id>`) or one of
 * the controls (none = floor, oracle = ceiling, shuffled = relevance control).
 */
export type Variant = `model:${string}` | 'none' | 'oracle' | 'shuffled';

/**
 * check.sh exit contract (tri-state) — every corpus item's check.sh follows
 * it, and Phase 6 scoring must interpret it exactly:
 *   - CHECK_EXIT_PASS (0): mechanical success — the task outcome is verified.
 *   - CHECK_EXIT_JUDGE (3): mechanical checking is impossible for this item —
 *     defer to the judge model with the success.md rubric.
 *   - any other exit code: fail.
 */
export const CHECK_EXIT_PASS = 0;
export const CHECK_EXIT_JUDGE = 3;

/**
 * One frozen corpus item (corpus/<item-id>/ — the directory format is
 * defined in plan Phase 3; Phase 1 only needs the handle).
 */
export interface CorpusItem {
  id: string;
  /** Absolute path to the frozen item directory. */
  dir: string;
}

/**
 * One row per fork-run in results.jsonl. Every fork-run writes a row, even
 * on timeout/crash (plan §0.2 guard 3 — never drop a row).
 *
 * Token counts and cost are REAL reported values only: `null` means the
 * provider did not report them. Never estimated, never split from totals
 * (plan §0.2 guards 1-2).
 */
export interface ResultRow {
  run_id: string;
  item_id: string;
  variant: Variant;
  /** The observer model id when variant is `model:<id>`. */
  observer_model?: string;
  executor: ExecutorName;
  /** Index of this repetition within the run spec's k. */
  run_index: number;
  success: boolean;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_total: number | null;
  cost_usd: number | null;
  duration_s: number;
  mem_search_calls: number;
  /**
   * Tri-state (Phase 6): true/false = the judge decided; `null` = drift is
   * UNKNOWN because the judge was unavailable or its reply was unparseable.
   * A transport failure must never read as "no drift" — pair it with `judged`.
   */
  drift_flag: boolean | null;
  /** Whether a judge model call actually completed for this run. */
  judged: boolean;
  drift_note?: string;
  error?: string;
}

/**
 * Per-fork execution context, produced by prepareFork (plan Phase 4).
 */
export interface ForkContext {
  repoDir: string;
  homeDir: string;
  workerPort: number;
  dataDir: string;
  injectionBlock: string;
  item: CorpusItem;
  variant: Variant;
  /**
   * The claude-mem project the fork's memory is filed under (the item's
   * provenance.json project_slug) — what /api/context/inject was targeted
   * at, recorded here so Phase 6 can write the run manifest without
   * re-reading provenance.
   */
  projectSlug: string;
  /**
   * The item's pinned base commit (repo.lock `commit`), i.e. the exact tree the
   * fork started from. Executor diffs are taken against THIS sha rather than
   * the worktree HEAD, so work an agent committed still shows up (see
   * captureGitDiff).
   */
  baseSha: string;
}

/**
 * Per-run budget limits an executor must enforce (stop conditions:
 * step count, cost ceiling, wall-clock timeout).
 */
export interface Budget {
  max_steps: number;
  max_cost_usd: number;
  timeout_s: number;
}

/**
 * What one executor run produced. Optional token/cost fields are real
 * reported values only — absent means not reported (never estimated).
 */
export interface ExecutionRecord {
  output: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  mem_search_calls: number;
  transcript_path: string;
  diff_path: string;
  error?: string;
}

/**
 * Interface both executor lanes (claude-cli, openrouter-agent) implement.
 */
export interface Executor {
  execute(fork: ForkContext, prompt: string, budget: Budget): Promise<ExecutionRecord>;
}
