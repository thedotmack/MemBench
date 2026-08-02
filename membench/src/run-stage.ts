/**
 * Stages 2-3 — fork + execute (plan Phase 6.2), with stage 4 measurement
 * folded in per run so the row lands immediately.
 *
 * For each item × variant × executor × run_index:
 *   prepareFork(seeded with that variant's observation set)
 *     → executor.execute(fork, injectionBlock + task.md, budget)
 *       → measureRun (check.sh + judge)
 *         → appendJsonl(results.jsonl, row)   [IMMEDIATELY, never batched]
 *           → teardownFork (mem/ pruned on success, kept on failure)
 *
 * Guard 3 (never drop a row): every path — blocked variant, fork failure,
 * executor error/timeout, measurement failure — writes a complete ResultRow
 * with `error` set. Guard 11 (lanes): the row carries its executor; nothing
 * merges lanes here.
 *
 * Hidden-field discipline: the executor prompt is exactly
 * injectionBlock + task.md. check.sh / success.md / oracle.md never enter it —
 * oracle.md is read only as the ORACLE VARIANT's seed (memory, not prompt),
 * and success.md only inside measure.ts's judge call.
 */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import { oracleObservations } from './controls.js';
import { appendJsonl } from './jsonl.js';
import { measureRun } from './measure.js';
import {
  loadCorpusItem,
  observeKey,
  type LoadedItem,
  type ObserveRecord,
} from './observe-stage.js';
import type { QueryModelFn } from './observe-runner.js';
import {
  forkDirPath,
  prepareFork,
  teardownFork,
  type CloneRepoFn,
  type PortPool,
  type PreparedFork,
  type SpawnWorkerFn,
  type WorkerHandle,
} from './fork.js';
import type { RunSpec } from './spec.js';
import type {
  Budget,
  ExecutionRecord,
  Executor,
  ExecutorName,
  ResultRow,
  Variant,
} from './types.js';
import type { ParsedObservation } from './vendor/parser.js';

export class RunStageError extends Error {}

/** The three control variants, in the order they are planned after the models. */
export const CONTROL_VARIANTS: readonly Variant[] = ['none', 'oracle', 'shuffled'];

// ---------------------------------------------------------------------------
// Spend tracking (guard 1 / plan Phase 6.4: unknowns are surfaced, never 0)
// ---------------------------------------------------------------------------

export type SpendSource = 'obs' | 'executor' | 'judge';

/**
 * Cumulative REAL spend for a run. A missing cost is NEVER counted as 0 for
 * the ceiling check: it increments `unknownCount` (and is listed by source)
 * so governance can surface "we spent at least $X, plus N calls whose cost
 * the provider did not report".
 */
export interface SpendTracker {
  add(source: SpendSource, costUsd: number | null | undefined, label: string): void;
  /** Sum of REPORTED costs only. */
  readonly knownUsd: number;
  /** Number of calls/runs whose cost was not reported. */
  readonly unknownCount: number;
  readonly unknownLabels: string[];
  readonly bySource: Record<SpendSource, { knownUsd: number; unknownCount: number }>;
}

export function createSpendTracker(initial?: {
  knownUsd?: number;
  unknownCount?: number;
  unknownLabels?: string[];
}): SpendTracker {
  const bySource: Record<SpendSource, { knownUsd: number; unknownCount: number }> = {
    obs: { knownUsd: 0, unknownCount: 0 },
    executor: { knownUsd: 0, unknownCount: 0 },
    judge: { knownUsd: 0, unknownCount: 0 },
  };
  const state = {
    knownUsd: initial?.knownUsd ?? 0,
    unknownCount: initial?.unknownCount ?? 0,
    unknownLabels: [...(initial?.unknownLabels ?? [])],
  };
  return {
    add(source, costUsd, label) {
      if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
        state.knownUsd += costUsd;
        bySource[source].knownUsd += costUsd;
        return;
      }
      state.unknownCount += 1;
      bySource[source].unknownCount += 1;
      // Cap the label list so a long run cannot balloon memory; the COUNT is
      // always exact, only the examples are capped.
      if (state.unknownLabels.length < 50) state.unknownLabels.push(`${source}: ${label}`);
    },
    get knownUsd() {
      return state.knownUsd;
    },
    get unknownCount() {
      return state.unknownCount;
    },
    get unknownLabels() {
      return state.unknownLabels;
    },
    bySource,
  };
}

// ---------------------------------------------------------------------------
// Variant planning
// ---------------------------------------------------------------------------

/** Where the shuffled control's notes come from for one item. */
export interface ShuffledSource {
  donor_item: string;
  /** An observer model id, or 'oracle' when the donor's oracle.md is used. */
  donor_source: string;
}

/**
 * The shuffled control's FIXED donor mapping, recorded verbatim in the run
 * manifest.
 *
 *  - ≥2 items in the run: controls.ts shuffledSourceMap (sorted ids rotated
 *    by 1) and the donor's FIRST observer model — a genuine "another
 *    session's model notes" control.
 *  - 1 item in the run: no in-run donor exists, so the donor is the next
 *    frozen corpus item (sorted, wrapping) and its oracle.md supplies the
 *    notes. Still another session's notes; deterministic; declared in the
 *    manifest. Fails loudly when the corpus has no other item.
 */
export function resolveShuffledSources(
  runItemIds: string[],
  models: string[],
  corpusItemIds: string[],
): Record<string, ShuffledSource> {
  const sources: Record<string, ShuffledSource> = {};
  if (runItemIds.length >= 2) {
    const sorted = [...runItemIds].sort();
    const donorSource = models[0] ?? 'oracle';
    for (let i = 0; i < sorted.length; i++) {
      sources[sorted[i]] = { donor_item: sorted[(i + 1) % sorted.length], donor_source: donorSource };
    }
    return sources;
  }

  const only = runItemIds[0];
  const candidates = [...corpusItemIds].sort();
  const index = candidates.indexOf(only);
  const donor = candidates.find((id, i) => id !== only && i > index) ?? candidates.find((id) => id !== only);
  if (!donor) {
    throw new RunStageError(
      `the shuffled control needs another corpus item's notes, but ${only} is the only item in the corpus`,
    );
  }
  sources[only] = { donor_item: donor, donor_source: 'oracle' };
  return sources;
}

/** One planned variant of one item: what to seed, or why it cannot run. */
export interface VariantPlan {
  variant: Variant;
  observer_model?: string;
  /** Seed set; undefined for `none` (which seeds nothing by definition). */
  observations?: ParsedObservation[];
  /** Set when the variant cannot be forked — its cells become error rows. */
  blocked?: string;
  /** accommodation recorded by the observe stage for this model, if any. */
  accommodation?: string;
}

export interface BuildVariantPlansOptions {
  item: LoadedItem;
  models: string[];
  /** Stage-1 records, keyed by observeKey(itemId, model). */
  obsRecords: Map<string, ObserveRecord>;
  shuffled: ShuffledSource;
  corpusDir: string;
}

/**
 * Plan every variant of one item: one per observer model, plus none / oracle
 * / shuffled. A variant whose seed set cannot be produced is planned as
 * BLOCKED rather than dropped — its cells still get rows (guard 3).
 */
export async function buildVariantPlans(options: BuildVariantPlansOptions): Promise<VariantPlan[]> {
  const { item, models, obsRecords, shuffled, corpusDir } = options;
  const plans: VariantPlan[] = [];

  for (const model of models) {
    const record = obsRecords.get(observeKey(item.id, model));
    const plan: VariantPlan = { variant: `model:${model}`, observer_model: model };
    if (!record) {
      plan.blocked = `no observe record for ${item.id} × ${model}`;
    } else if (record.error) {
      plan.blocked = `observe failed for ${item.id} × ${model}: ${record.error}`;
    } else {
      plan.observations = record.observations;
      if (record.accommodation) plan.accommodation = record.accommodation;
    }
    plans.push(plan);
  }

  // `none` — the floor: no seed, no injection block.
  plans.push({ variant: 'none' });

  // `oracle` — the ceiling: the item's hand-written notes.
  const oraclePlan: VariantPlan = { variant: 'oracle' };
  try {
    oraclePlan.observations = await oracleObservations(item);
  } catch (error: unknown) {
    oraclePlan.blocked = `oracle synthesis failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  plans.push(oraclePlan);

  // `shuffled` — another item's notes under the manifest-recorded mapping.
  const shuffledPlan: VariantPlan = { variant: 'shuffled' };
  try {
    if (shuffled.donor_source === 'oracle') {
      const donor = await loadCorpusItem(corpusDir, shuffled.donor_item);
      shuffledPlan.observations = await oracleObservations(donor);
    } else {
      const donorRecord = obsRecords.get(observeKey(shuffled.donor_item, shuffled.donor_source));
      if (!donorRecord || donorRecord.error) {
        throw new RunStageError(
          `donor observations unavailable (${shuffled.donor_item} × ${shuffled.donor_source}${
            donorRecord?.error ? `: ${donorRecord.error}` : ''
          })`,
        );
      }
      shuffledPlan.observations = donorRecord.observations;
    }
  } catch (error: unknown) {
    shuffledPlan.blocked = `shuffled synthesis failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  plans.push(shuffledPlan);

  return plans;
}

// ---------------------------------------------------------------------------
// Cell execution
// ---------------------------------------------------------------------------

/** One planned fork-run. */
export interface RunCell {
  item: LoadedItem;
  plan: VariantPlan;
  executor: ExecutorName;
  run_index: number;
}

/**
 * Identity of a fork-run in results.jsonl — the resume key (plan Phase 6.4).
 * JSON-encoded array: unambiguous (no separator can occur inside a component)
 * and plain text, so the plan's audit greps never treat this file as binary.
 */
export function cellKey(itemId: string, variant: string, executor: string, runIndex: number): string {
  return JSON.stringify([itemId, variant, executor, runIndex]);
}

export function rowKey(row: {
  item_id?: unknown;
  variant?: unknown;
  executor?: unknown;
  run_index?: unknown;
}): string | undefined {
  if (
    typeof row.item_id !== 'string' ||
    typeof row.variant !== 'string' ||
    typeof row.executor !== 'string' ||
    typeof row.run_index !== 'number'
  ) {
    return undefined;
  }
  return cellKey(row.item_id, row.variant, row.executor, row.run_index);
}

export interface ExecuteStageDeps {
  /** One Executor per lane in the spec. */
  executors: Partial<Record<ExecutorName, Executor>>;
  portPool: PortPool;
  /** prepareFork seams — mocked offline. */
  spawnWorker?: SpawnWorkerFn;
  cloneRepo?: CloneRepoFn;
  killTree?: (worker: WorkerHandle) => Promise<void>;
  /** Judge transport (mocked offline); defaults to the real client. */
  query?: QueryModelFn;
  apiKey?: string;
  claudeMemRoot?: string;
  readinessTimeoutMs?: number;
}

/**
 * What the cost gate needs to reserve headroom for cells that are already
 * running. The ceiling can only be checked against REPORTED spend, and an
 * in-flight cell has reported nothing yet, so without this a run overshoots by
 * up to (concurrency x cost of one run) — measured on live-smoke-2: $6.74
 * against a $5.00 ceiling.
 */
export interface CellGateContext {
  /** Lane of the cell about to be scheduled. */
  lane: ExecutorName;
  /** Cells already executing, excluding the one being scheduled. */
  inFlight: number;
  /** Highest reported cost seen so far in each lane THIS run. */
  maxObservedByLane: Partial<Record<ExecutorName, number>>;
}

export interface ExecuteStageOptions {
  runId: string;
  runsDir: string;
  /** runs/<run_id>/ */
  runDir: string;
  spec: RunSpec;
  items: LoadedItem[];
  /** itemId → planned variants (from buildVariantPlans). */
  plansByItem: Map<string, VariantPlan[]>;
  deps: ExecuteStageDeps;
  /** Resume: (item, variant, executor, run_index) keys already in results.jsonl. */
  completed?: Set<string>;
  /** Forks live at once. Default spec.fork_concurrency ?? 2. */
  concurrency?: number;
  tracker?: SpendTracker;
  /**
   * Cost-governance pre-flight consulted BEFORE each cell. 'stop' abandons
   * every remaining cell WITHOUT writing rows for them: an unrun cell must
   * stay retryable on --resume, and a synthetic "skipped" row would instead
   * mark it permanently done.
   */
  beforeCell?: (context: CellGateContext) => 'continue' | 'stop';
  /** Cost governance hook, called after each item. 'stop' halts the stage. */
  betweenItems?: (itemId: string) => Promise<'continue' | 'stop'> | 'continue' | 'stop';
  log?: (message: string) => void;
}

export interface ExecuteStageResult {
  rowsWritten: number;
  rowsSkipped: number;
  /** Cells abandoned by the beforeCell pre-flight (no rows written). */
  cellsAbandoned: number;
  itemsRun: string[];
  stopped: boolean;
}

export const DEFAULT_FORK_CONCURRENCY = 2;

/**
 * Run every planned cell of every item. One item at a time (so cost
 * governance can stop between items); the item's cells run concurrently up
 * to `concurrency`, each holding its own port + worker + repo checkout.
 */
export async function runExecuteStage(options: ExecuteStageOptions): Promise<ExecuteStageResult> {
  const {
    runId,
    runsDir,
    runDir,
    spec,
    items,
    plansByItem,
    deps,
    completed = new Set<string>(),
    concurrency = spec.fork_concurrency ?? DEFAULT_FORK_CONCURRENCY,
    tracker,
    beforeCell,
    betweenItems,
    log = () => {},
  } = options;

  const resultsPath = join(runDir, 'results.jsonl');
  const judgePath = join(runDir, 'judge.jsonl');
  const budget: Budget = {
    max_steps: spec.max_steps,
    max_cost_usd: spec.max_cost_per_run_usd,
    timeout_s: spec.execute_timeout_s,
  };

  let rowsWritten = 0;
  let rowsSkipped = 0;
  let cellsAbandoned = 0;
  let abandonRemaining = false;
  const itemsRun: string[] = [];

  for (const item of items) {
    const plans = plansByItem.get(item.id) ?? [];
    const taskPath = join(item.dir, 'task.md');
    if (!existsSync(taskPath)) {
      throw new RunStageError(`corpus item ${item.id} has no task.md`);
    }
    const taskMd = await Bun.file(taskPath).text();

    const cells: RunCell[] = [];
    for (const plan of plans) {
      for (const executor of spec.executors) {
        for (let runIndex = 0; runIndex < spec.k; runIndex++) {
          cells.push({ item, plan, executor, run_index: runIndex });
        }
      }
    }

    let inFlight = 0;
    const maxObservedByLane: Partial<Record<ExecutorName, number>> = {};

    await mapWithConcurrency(cells, concurrency, async (cell) => {
      const key = cellKey(cell.item.id, cell.plan.variant, cell.executor, cell.run_index);
      if (completed.has(key)) {
        rowsSkipped += 1;
        log(`skip (resume): ${cell.item.id} ${cell.plan.variant} ${cell.executor} #${cell.run_index}`);
        return;
      }
      if (abandonRemaining) {
        cellsAbandoned += 1;
        return;
      }
      if (beforeCell?.({ lane: cell.executor, inFlight, maxObservedByLane }) === 'stop') {
        abandonRemaining = true;
        cellsAbandoned += 1;
        return;
      }
      inFlight += 1;
      let row: ResultRow;
      try {
        row = await runCell(cell, {
        runId,
        runsDir,
        taskMd,
        budget,
        judgeModel: spec.judge_model,
        deps,
        judgePath,
        tracker,
        log,
        });
      } finally {
        inFlight -= 1;
      }
      if (typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd)) {
        const seen = maxObservedByLane[cell.executor];
        if (seen === undefined || row.cost_usd > seen) maxObservedByLane[cell.executor] = row.cost_usd;
      }
      // Immediately per run, never batched (plan Phase 6.3) — the jsonl mutex
      // serializes concurrent cells.
      await appendJsonl(resultsPath, row);
      rowsWritten += 1;
      log(
        `row: ${row.item_id} ${row.variant} ${row.executor} #${row.run_index} ` +
          `success=${row.success} drift=${row.drift_flag} cost=${row.cost_usd ?? 'unreported'}` +
          `${row.error ? ` error=${row.error}` : ''}`,
      );
    });

    if (abandonRemaining) {
      log(`!! ${cellsAbandoned} cell(s) abandoned unrun — they stay retryable with --resume`);
      return { rowsWritten, rowsSkipped, cellsAbandoned, itemsRun, stopped: true };
    }
    itemsRun.push(item.id);
    if (betweenItems) {
      const decision = await betweenItems(item.id);
      if (decision === 'stop') {
        return { rowsWritten, rowsSkipped, cellsAbandoned, itemsRun, stopped: true };
      }
    }
  }

  return { rowsWritten, rowsSkipped, cellsAbandoned, itemsRun, stopped: false };
}

interface RunCellContext {
  runId: string;
  runsDir: string;
  taskMd: string;
  budget: Budget;
  judgeModel: string;
  deps: ExecuteStageDeps;
  judgePath: string;
  tracker?: SpendTracker;
  log: (message: string) => void;
}

/**
 * One fork-run, from fork prep to measured row. Never throws: every failure
 * path returns a complete ResultRow with `error` set (guard 3).
 */
export async function runCell(cell: RunCell, context: RunCellContext): Promise<ResultRow> {
  const { runId, runsDir, taskMd, budget, judgeModel, deps, judgePath, tracker, log } = context;
  const { item, plan, executor: executorName, run_index } = cell;

  const row: ResultRow = {
    run_id: runId,
    item_id: item.id,
    variant: plan.variant,
    ...(plan.observer_model ? { observer_model: plan.observer_model } : {}),
    executor: executorName,
    run_index,
    success: false,
    tokens_in: null,
    tokens_out: null,
    tokens_total: null,
    cost_usd: null,
    duration_s: 0,
    mem_search_calls: 0,
    // Unknown until a judge answers: a row that never reached the judge must
    // not read as "no drift" (tri-state, Phase 6 review).
    drift_flag: null,
    judged: false,
    ...(plan.accommodation ? { accommodation: plan.accommodation } : {}),
  };

  if (plan.blocked) {
    row.error = plan.blocked;
    row.drift_note = 'variant not run';
    return row;
  }

  const executor = deps.executors[executorName];
  if (!executor) {
    row.error = `no executor implementation for lane ${executorName}`;
    return row;
  }

  let fork: PreparedFork | undefined;
  const started = Date.now();
  const cellLabel = `${executorName}-${run_index}`;
  try {
    // Quarantine a fork dir left behind by a crashed attempt: prepareFork
    // refuses to reuse a populated data dir (and a half-cloned repo would
    // poison the retry), so the leftover is moved aside for audit instead.
    const existingForkDir = forkDirPath(runsDir, runId, item.id, plan.variant, cellLabel);
    if (existsSync(existingForkDir)) {
      const quarantined = `${existingForkDir}.stale-${Date.now()}`;
      renameSync(existingForkDir, quarantined);
      log(`quarantined leftover fork dir → ${quarantined}`);
    }
    fork = await prepareFork(item, plan.variant, runsDir, {
      runId,
      portPool: deps.portPool,
      // Every fork-run gets its own directory: k repetitions × executor lanes
      // all share (item, variant) and would otherwise collide.
      cellLabel,
      ...(plan.variant === 'none' ? {} : { observations: plan.observations ?? [] }),
      ...(deps.claudeMemRoot ? { claudeMemRoot: deps.claudeMemRoot } : {}),
      ...(deps.spawnWorker ? { spawnWorker: deps.spawnWorker } : {}),
      ...(deps.cloneRepo ? { cloneRepo: deps.cloneRepo } : {}),
      ...(deps.killTree ? { killTree: deps.killTree } : {}),
      ...(deps.readinessTimeoutMs !== undefined ? { readinessTimeoutMs: deps.readinessTimeoutMs } : {}),
    });
  } catch (error: unknown) {
    row.error = `fork preparation failed: ${error instanceof Error ? error.message : String(error)}`;
    row.duration_s = (Date.now() - started) / 1000;
    return row;
  }

  // Hidden-field discipline: injection block + task.md, nothing else.
  const injection = fork.injectionBlock.trim();
  const prompt = injection ? `${injection}\n\n${taskMd.trim()}` : taskMd.trim();

  let record: ExecutionRecord = {
    output: '',
    mem_search_calls: 0,
    transcript_path: '',
    diff_path: '',
  };
  const executeStarted = Date.now();
  try {
    record = await executor.execute(fork, prompt, budget);
  } catch (error: unknown) {
    // The Executor contract says execute() never throws; if a lane ever
    // breaks that contract the row still lands (guard 3).
    record.error = `executor threw: ${error instanceof Error ? error.message : String(error)}`;
  }
  row.duration_s = (Date.now() - executeStarted) / 1000;

  if (typeof record.tokens_in === 'number') row.tokens_in = record.tokens_in;
  if (typeof record.tokens_out === 'number') row.tokens_out = record.tokens_out;
  if (row.tokens_in !== null || row.tokens_out !== null) {
    row.tokens_total = (row.tokens_in ?? 0) + (row.tokens_out ?? 0);
  }
  if (typeof record.cost_usd === 'number') row.cost_usd = record.cost_usd;
  row.mem_search_calls = record.mem_search_calls;
  if (record.error) row.error = record.error;
  tracker?.add(
    'executor',
    record.cost_usd,
    `${item.id} ${plan.variant} ${executorName} #${run_index}`,
  );

  try {
    const measured = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd,
      executorOutput: record.output,
      diffPath: record.diff_path,
      judgeModel,
      ...(deps.query ? { query: deps.query } : {}),
      ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
    });
    row.success = measured.success;
    row.drift_flag = measured.drift_flag;
    row.judged = measured.judged;
    if (measured.drift_note) row.drift_note = measured.drift_note;
    if (measured.judged) {
      tracker?.add(
        'judge',
        measured.judge_cost_usd,
        `${item.id} ${plan.variant} ${executorName} #${run_index}`,
      );
      await appendJsonl(judgePath, {
        run_id: runId,
        item_id: item.id,
        variant: plan.variant,
        executor: executorName,
        run_index,
        check_exit: measured.check_exit,
        drift: measured.drift_flag,
        success: measured.success,
        cost_usd: measured.judge_cost_usd,
        tokens_in: measured.judge_tokens_in,
        tokens_out: measured.judge_tokens_out,
        error: measured.judge_error ?? null,
        raw: measured.judge_raw ?? null,
      });
    }
  } catch (error: unknown) {
    const message = `measurement failed: ${error instanceof Error ? error.message : String(error)}`;
    row.error = row.error ? `${row.error}; ${message}` : message;
  } finally {
    try {
      // Failure keeps mem/ for audit; a clean run prunes it (plan Phase 4).
      await teardownFork(fork, { keepData: row.error !== undefined });
    } catch (error: unknown) {
      log(
        `teardown failed for ${item.id} ${plan.variant} ${executorName} #${run_index}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return row;
}
