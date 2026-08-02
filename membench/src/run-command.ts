/**
 * `membench run` / `membench observe` — the full loop plus ORSB run
 * governance (plan Phase 6.4).
 *
 * Governance behaviors ported from the OpenRouter search-benchmarks
 * conventions (§0.1) and evals/swebench:
 *   - run-id-scoped output tree with an OVERWRITE GUARD refusing to clobber a
 *     partial results.jsonl (run-batch.py:440-452) unless --resume
 *   - --resume skips (item, variant, executor, run_index) cells already
 *     present in results.jsonl (completed-rows detection, run.py:90-106) and
 *     reuses non-errored observe records
 *   - --dry-run: validate spec + corpus, print the planned call matrix and a
 *     cost estimate built ONLY from measured rates in prior runs. ZERO network
 *   - live runs REQUIRE --approve-cost-usd <ceiling>: refuse to start when a
 *     measured-rate estimate exceeds it, and stop BETWEEN ITEMS when
 *     cumulative REAL spend crosses it (the partial run stays resumable)
 *   - --mock swaps provider + executors + worker/clone seams (mocks.ts) so the
 *     whole loop runs offline
 *
 * Guard 1 discipline: the ceiling is checked against REPORTED cost only.
 * Calls whose cost the provider did not report are counted separately as
 * UNKNOWN and printed prominently — never silently treated as $0.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { defaultCorpusDir, listItems } from './corpus-item.js';
import { appendJsonl, readJsonl } from './jsonl.js';
import type { MockDepsOptions } from './mocks.js';
import { createMockDeps } from './mocks.js';
import type { QueryModelFn } from './observe-runner.js';
import { loadCorpusItem, runObserveStage, type LoadedItem } from './observe-stage.js';
import { readJudgeCosts, readObserveRecords, runIdError } from './scoreboard.js';
import {
  CONTROL_VARIANTS,
  buildVariantPlans,
  createSpendTracker,
  resolveShuffledSources,
  rowKey,
  runExecuteStage,
  type ExecuteStageDeps,
  type ShuffledSource,
  type SpendTracker,
  type VariantPlan,
  DEFAULT_FORK_CONCURRENCY,
} from './run-stage.js';
import { loadRunSpec, type RunSpec } from './spec.js';
import type { ExecutorName, ResultRow } from './types.js';

export class RunCommandError extends Error {}

/**
 * Unreported-cost circuit breaker: when this many calls have come back
 * WITHOUT a reported cost and known spend is still $0, the run's real spend
 * is unbounded-unknown and the ceiling cannot protect anything — stop.
 */
export const DEFAULT_MAX_UNREPORTED_CALLS = 50;

export const RUN_HELP = `Usage: membench run --spec <path> --run-id <id> [options]

Required:
  --spec <path>              TOML run spec (run-specs/*.toml)
  --run-id <id>              names the output tree runs/<run-id>/

Governance:
  --dry-run                  validate + print the call matrix and cost estimate; NO network
  --approve-cost-usd <n>     REQUIRED for live runs: hard ceiling on real spend
                             (the effective ceiling is min(this, spec.max_cost_usd))
  --resume                   continue a partial run (skips completed rows)
  --retry-failed             with --resume: re-run cells whose row has an error
                             (their old rows move to retried-rows.jsonl)
  --max-unreported-calls <n> stop when this many calls report no cost while
                             known spend is still $0 (default ${DEFAULT_MAX_UNREPORTED_CALLS})
  --mock                     run the whole loop offline with mocks

Paths / limits:
  --corpus-dir <path>        default: <repo-root>/corpus
  --runs-dir <path>          default: MEMBENCH_RUNS_DIR or ./runs
  --claude-mem-root <path>   default: CLAUDE_MEM_ROOT
  --fork-concurrency <n>     default: spec.fork_concurrency or ${DEFAULT_FORK_CONCURRENCY}
  --observe-concurrency <n>  default: spec.observe_concurrency or 4
  --observe-only             stage 1 only (what \`membench observe\` runs)
`;

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export interface RunFlags {
  spec?: string;
  runId?: string;
  dryRun: boolean;
  resume: boolean;
  retryFailed: boolean;
  mock: boolean;
  observeOnly: boolean;
  approveCostUsd?: number;
  maxUnreportedCalls?: number;
  corpusDir?: string;
  runsDir?: string;
  claudeMemRoot?: string;
  forkConcurrency?: number;
  observeConcurrency?: number;
}

const VALUE_FLAGS = new Set([
  '--spec',
  '--run-id',
  '--approve-cost-usd',
  '--max-unreported-calls',
  '--corpus-dir',
  '--runs-dir',
  '--claude-mem-root',
  '--fork-concurrency',
  '--observe-concurrency',
]);
const BOOLEAN_FLAGS = new Set([
  '--dry-run',
  '--resume',
  '--retry-failed',
  '--mock',
  '--observe-only',
  '--help',
  '-h',
]);

export function parseRunFlags(args: string[]): RunFlags & { help: boolean } {
  const flags: RunFlags & { help: boolean } = {
    dryRun: false,
    resume: false,
    retryFailed: false,
    mock: false,
    observeOnly: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (name === '--dry-run') flags.dryRun = true;
      else if (name === '--resume') flags.resume = true;
      else if (name === '--retry-failed') flags.retryFailed = true;
      else if (name === '--mock') flags.mock = true;
      else if (name === '--observe-only') flags.observeOnly = true;
      else flags.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new RunCommandError(`unknown option: ${arg}`);
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined) throw new RunCommandError(`${name} requires a value`);
    switch (name) {
      case '--spec':
        flags.spec = value;
        break;
      case '--run-id':
        flags.runId = value;
        break;
      case '--approve-cost-usd': {
        const parsed = Number.parseFloat(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          throw new RunCommandError('--approve-cost-usd must be a positive number');
        }
        flags.approveCostUsd = parsed;
        break;
      }
      case '--max-unreported-calls': {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new RunCommandError('--max-unreported-calls must be a non-negative integer');
        }
        flags.maxUnreportedCalls = parsed;
        break;
      }
      case '--corpus-dir':
        flags.corpusDir = value;
        break;
      case '--runs-dir':
        flags.runsDir = value;
        break;
      case '--claude-mem-root':
        flags.claudeMemRoot = value;
        break;
      case '--fork-concurrency':
      case '--observe-concurrency': {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new RunCommandError(`${name} must be a positive integer`);
        }
        if (name === '--fork-concurrency') flags.forkConcurrency = parsed;
        else flags.observeConcurrency = parsed;
        break;
      }
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Measured rates (dry-run estimate)
// ---------------------------------------------------------------------------

export interface MeasuredRate {
  /** Mean of REPORTED costs. null when nothing measured. */
  meanUsd: number | null;
  /** Calls that reported a cost. */
  samples: number;
  /** Calls that reported no cost (guard 1: never counted as $0). */
  unknown: number;
}

export interface MeasuredRates {
  /**
   * Observe rate PER OBSERVER MODEL (a blended mean across models would price
   * a cheap model at an expensive model's rate). Keyed by the record's `model`
   * field, falling back to the artifact's slug for pre-Phase-6.1 records.
   */
  observeByModel: Record<string, MeasuredRate>;
  executors: Record<string, MeasuredRate>;
  judge: MeasuredRate;
  /** Run ids the rates came from. */
  sourceRuns: string[];
  /** Mock run dirs skipped (their spend is fabricated). */
  skippedMockRuns: string[];
}

function emptyRate(): MeasuredRate {
  return { meanUsd: null, samples: 0, unknown: 0 };
}

function foldRate(rate: MeasuredRate, costUsd: unknown): void {
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
    const total = (rate.meanUsd ?? 0) * rate.samples + costUsd;
    rate.samples += 1;
    rate.meanUsd = total / rate.samples;
    return;
  }
  rate.unknown += 1;
}

/**
 * Harvest measured per-call rates from prior runs under runsDir.
 *
 * Mock runs are SKIPPED (manifest.mock === true): their costs are canned
 * numbers, and letting them into an estimate would be exactly the fabricated
 * pricing guard 1 forbids. Runs without a manifest are also skipped — their
 * provenance (mock or live) is unknown.
 */
export async function readMeasuredRates(runsDir: string): Promise<MeasuredRates> {
  const rates: MeasuredRates = {
    observeByModel: {},
    executors: {},
    judge: emptyRate(),
    sourceRuns: [],
    skippedMockRuns: [],
  };
  if (!existsSync(runsDir)) return rates;

  for (const entry of readdirSync(runsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const runDir = join(runsDir, entry.name);
    const manifestPath = join(runDir, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    let manifest: { mock?: unknown };
    try {
      manifest = JSON.parse(await Bun.file(manifestPath).text()) as { mock?: unknown };
    } catch {
      continue;
    }
    if (manifest.mock === true) {
      rates.skippedMockRuns.push(entry.name);
      continue;
    }
    rates.sourceRuns.push(entry.name);

    // Shared readers (scoreboard.ts) — one implementation of "walk obs/ and
    // judge.jsonl", three accumulators. An unreadable artifact contributes
    // nothing here; it never becomes a guessed rate.
    const { records } = await readObserveRecords(runDir, () => {});
    for (const record of records) {
      if (record.error) continue;
      rates.observeByModel[record.model] ??= emptyRate();
      foldRate(rates.observeByModel[record.model], record.obs_cost_usd);
    }

    const resultsPath = join(runDir, 'results.jsonl');
    if (existsSync(resultsPath)) {
      for (const row of await readJsonl<ResultRow>(resultsPath)) {
        if (typeof row.executor !== 'string') continue;
        // Errored runs still cost money; they are legitimate rate samples.
        rates.executors[row.executor] ??= emptyRate();
        foldRate(rates.executors[row.executor], row.cost_usd);
      }
    }

    for (const cost of await readJudgeCosts(runDir)) foldRate(rates.judge, cost);
  }
  return rates;
}

export interface CallMatrix {
  items: number;
  models: number;
  variantsPerItem: number;
  executors: number;
  k: number;
  observeCalls: number;
  executorRunsPerLane: number;
  executorRuns: number;
  /** Upper bound: one judge call per executor run. */
  judgeCallsMax: number;
}

/** The plan's cost formula (top of the plan file), as counts. */
export function computeCallMatrix(spec: RunSpec): CallMatrix {
  const items = spec.corpus_items.length;
  const models = spec.observer_models.length;
  const variantsPerItem = models + CONTROL_VARIANTS.length;
  const executors = spec.executors.length;
  const observeCalls = items * models;
  const executorRunsPerLane = items * variantsPerItem * spec.k;
  const executorRuns = executorRunsPerLane * executors;
  return {
    items,
    models,
    variantsPerItem,
    executors,
    k: spec.k,
    observeCalls,
    executorRunsPerLane,
    executorRuns,
    judgeCallsMax: executorRuns,
  };
}

export interface CostEstimate {
  /** Sum over the components that HAVE a measured rate. */
  totalUsd: number | null;
  lines: string[];
  /** Components with no measured rate — the estimate excludes them. */
  missing: string[];
}

export function estimateCost(matrix: CallMatrix, spec: RunSpec, rates: MeasuredRates): CostEstimate {
  const lines: string[] = [];
  const missing: string[] = [];
  let total: number | null = null;

  const addComponent = (label: string, calls: number, rate: MeasuredRate) => {
    if (rate.meanUsd === null) {
      missing.push(label);
      lines.push(`  ${label.padEnd(22)} ${String(calls).padStart(5)} calls × (no measured rate yet)`);
      return;
    }
    const component = calls * rate.meanUsd;
    total = (total ?? 0) + component;
    lines.push(
      `  ${label.padEnd(22)} ${String(calls).padStart(5)} calls × $${rate.meanUsd.toFixed(6)} = $${component.toFixed(4)}` +
        `   [${rate.samples} measured${rate.unknown > 0 ? `, ${rate.unknown} without reported cost` : ''}]`,
    );
  };

  // One component per observer model: observe cost is model-specific.
  for (const model of spec.observer_models) {
    addComponent(`observe:${model}`, matrix.items, rates.observeByModel[model] ?? emptyRate());
  }
  for (const lane of spec.executors) {
    addComponent(lane, matrix.executorRunsPerLane, rates.executors[lane] ?? emptyRate());
  }
  addComponent('judge', matrix.judgeCallsMax, rates.judge);

  return { totalUsd: total, lines, missing };
}

// ---------------------------------------------------------------------------
// Spend reporting
// ---------------------------------------------------------------------------

/**
 * Human-readable spend line. The unknown count is ALWAYS printed when
 * non-zero: a run whose provider reported no usage must never look free.
 */
export function formatSpend(tracker: SpendTracker): string {
  const lines = [`REAL SPEND: $${tracker.knownUsd.toFixed(4)} (reported costs only)`];
  if (tracker.unknownCount > 0) {
    const bySource = (Object.keys(tracker.bySource) as (keyof typeof tracker.bySource)[])
      .map((source) => `${source}: ${tracker.bySource[source].unknownCount}`)
      .join(', ');
    lines.push(
      `  !! UNKNOWN COST: ${tracker.unknownCount} call(s) reported no cost (${bySource}).`,
      '     These are NOT counted as $0 — real spend is at least the number above, possibly more.',
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export interface RunOverrides {
  /** Options for the mock bundle when --mock is set. */
  mock?: MockDepsOptions;
  /** Direct dependency overrides (tests / live wiring). */
  deps?: Partial<ExecuteStageDeps>;
  /** Observe + judge transport override (wins over --mock's provider). */
  query?: QueryModelFn;
  log?: (message: string) => void;
}

interface ManifestShape {
  run_id: string;
  created_at: string;
  mock: boolean;
  spec_path: string;
  spec: RunSpec;
  corpus_dir: string;
  runs_dir: string;
  items: { id: string; content_hash: string | null }[];
  variants: string[];
  shuffled_source_map: Record<string, ShuffledSource>;
  fork_concurrency: number;
  observe_concurrency: number;
  approve_cost_usd: number | null;
  resumes: string[];
}

async function loadPriorManifest(path: string): Promise<Partial<ManifestShape> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(await Bun.file(path).text()) as Partial<ManifestShape>;
  } catch {
    return undefined;
  }
}

/**
 * Seed the spend tracker from artifacts already in the run dir, so a resumed
 * run's ceiling accounts for what the earlier attempt already spent.
 */
async function seedTrackerFromRunDir(runDir: string, tracker: SpendTracker): Promise<void> {
  // Unreadable artifacts are skipped by the shared reader; the count of
  // knowns stays honest.
  const { records } = await readObserveRecords(runDir, () => {});
  for (const record of records) {
    if (record.error) continue;
    tracker.add('obs', record.obs_cost_usd, `${record.item_id} × ${record.model} (prior attempt)`);
  }
  const resultsPath = join(runDir, 'results.jsonl');
  if (existsSync(resultsPath)) {
    for (const row of await readJsonl<ResultRow>(resultsPath)) {
      tracker.add('executor', row.cost_usd, `${row.item_id} ${row.variant} ${row.executor} (prior attempt)`);
    }
  }
  for (const cost of await readJudgeCosts(runDir)) {
    tracker.add('judge', cost, 'judge call (prior attempt)');
  }
}

/** Completed (item, variant, executor, run_index) keys from results.jsonl. */
export async function readCompletedCells(resultsPath: string): Promise<Set<string>> {
  const completed = new Set<string>();
  if (!existsSync(resultsPath)) return completed;
  for (const row of await readJsonl<ResultRow>(resultsPath)) {
    const key = rowKey(row);
    if (key) completed.add(key);
  }
  return completed;
}

/**
 * --retry-failed: drop rows carrying an `error` from results.jsonl so their
 * cells run again. The removed rows are MOVED to retried-rows.jsonl (never
 * discarded — the failed attempt stays auditable), and results.jsonl keeps
 * exactly one row per cell.
 */
export async function applyRetryFailed(
  runDir: string,
  log: (message: string) => void,
): Promise<Set<string>> {
  const resultsPath = join(runDir, 'results.jsonl');
  if (!existsSync(resultsPath)) return new Set<string>();
  const rows = await readJsonl<ResultRow>(resultsPath);
  const failed = rows.filter((row) => row.error !== undefined && row.error !== null);
  if (failed.length === 0) return readCompletedCells(resultsPath);

  const kept = rows.filter((row) => row.error === undefined || row.error === null);
  for (const row of failed) {
    await appendJsonl(join(runDir, 'retried-rows.jsonl'), { retried_at: new Date().toISOString(), row });
  }
  await Bun.write(resultsPath, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : ''));
  log(`--retry-failed: ${failed.length} errored row(s) moved to retried-rows.jsonl and re-queued`);

  const completed = new Set<string>();
  for (const row of kept) {
    const key = rowKey(row);
    if (key) completed.add(key);
  }
  return completed;
}

/**
 * Refuse to resume into a DIFFERENT run: a resumed run appends to the same
 * results.jsonl and rewrites the manifest, so a changed mock flag, spec or
 * corpus hash would silently mix incomparable rows — and resuming a mock run
 * "live" would relabel canned costs as measured rates (guard 1).
 */
export function checkResumeCompatibility(
  prior: Partial<ManifestShape> | undefined,
  current: { mock: boolean; spec: RunSpec; items: LoadedItem[] },
): string | undefined {
  if (!prior) return undefined;
  if (typeof prior.mock === 'boolean' && prior.mock !== current.mock) {
    return `this run was created with mock=${prior.mock}; refusing to continue it with mock=${current.mock}`;
  }
  if (prior.spec && JSON.stringify(prior.spec) !== JSON.stringify(current.spec)) {
    return 'the run spec differs from the one this run was created with (compare manifest.json → spec)';
  }
  if (prior.items) {
    const priorHashes = new Map(prior.items.map((item) => [item.id, item.content_hash]));
    for (const item of current.items) {
      if (!priorHashes.has(item.id)) {
        return `corpus item ${item.id} was not part of this run (manifest.json → items)`;
      }
      const before = priorHashes.get(item.id);
      if (before !== item.contentHash) {
        return `corpus item ${item.id} changed since this run started (${before} → ${item.contentHash})`;
      }
    }
  }
  return undefined;
}

/**
 * `membench run` (and, with --observe-only, `membench observe`).
 * Returns a process exit code; never throws for user-facing errors.
 */
export async function runMain(args: string[], overrides: RunOverrides = {}): Promise<number> {
  const log = overrides.log ?? ((message: string) => console.log(message));

  let flags: RunFlags & { help: boolean };
  try {
    flags = parseRunFlags(args);
  } catch (error: unknown) {
    console.error(`membench run: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(RUN_HELP);
    return 1;
  }
  if (flags.help) {
    log(RUN_HELP);
    return 0;
  }
  if (!flags.spec || !flags.runId) {
    console.error('membench run: --spec and --run-id are required\n');
    console.error(RUN_HELP);
    return 1;
  }
  // The run id names a directory under runs/ (and later under published-runs/).
  const invalidRunId = runIdError(flags.runId);
  if (invalidRunId) {
    console.error(`membench run: ${invalidRunId}`);
    return 1;
  }

  const config = loadConfig({
    ...(flags.claudeMemRoot ? { claudeMemRoot: flags.claudeMemRoot } : {}),
    ...(flags.runsDir ? { runsDir: flags.runsDir } : {}),
  });
  const runsDir = resolve(config.runsDir);
  const runDir = join(runsDir, flags.runId);
  const resultsPath = join(runDir, 'results.jsonl');
  const corpusDir = resolve(flags.corpusDir ?? defaultCorpusDir());

  let spec: RunSpec;
  let items: LoadedItem[];
  try {
    spec = await loadRunSpec(flags.spec);
    items = [];
    for (const id of spec.corpus_items) {
      items.push(await loadCorpusItem(corpusDir, id, { requireFrozen: true }));
    }
  } catch (error: unknown) {
    console.error(`membench run: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const matrix = computeCallMatrix(spec);
  const forkConcurrency = flags.forkConcurrency ?? spec.fork_concurrency ?? DEFAULT_FORK_CONCURRENCY;
  const observeConcurrency = flags.observeConcurrency ?? spec.observe_concurrency ?? 4;

  // Spec-level wiring check both paths need: the openrouter-agent lane has no
  // model unless the spec names one, so a dry run must catch it too.
  const missingExecutorModel =
    spec.executors.includes('openrouter-agent') && !spec.executor_model
      ? 'the openrouter-agent lane needs `executor_model = "<model id>"` in the run spec'
      : undefined;

  // --- dry run: zero network, zero disk mutation ---------------------------
  if (flags.dryRun) {
    if (missingExecutorModel && !flags.mock) {
      console.error(`membench run: ${missingExecutorModel}`);
      return 1;
    }
    const rates = await readMeasuredRates(runsDir);
    const estimate = estimateCost(matrix, spec, rates);
    log(`DRY RUN — spec ${flags.spec}, run-id ${flags.runId} (no network, nothing written)`);
    log('');
    log('Corpus items (frozen):');
    for (const item of items) log(`  ${item.id}  ${item.contentHash}`);
    log('');
    log('Planned call matrix:');
    log(`  items                 ${matrix.items}`);
    log(`  observer models       ${matrix.models}`);
    log(`  variants per item     ${matrix.variantsPerItem} (${matrix.models} model(s) + ${CONTROL_VARIANTS.join('/')})`);
    log(`  executors             ${matrix.executors} (${spec.executors.join(', ')})`);
    log(`  k                     ${matrix.k}`);
    log(`  observe calls         items × models = ${matrix.observeCalls}`);
    log(
      `  executor runs         items × (models+${CONTROL_VARIANTS.length}) × executors × k = ${matrix.executorRuns}` +
        ` (${matrix.executorRunsPerLane} per lane)`,
    );
    log(`  judge calls (max)     ${matrix.judgeCallsMax}`);
    log('');
    log('Cost estimate (measured rates from prior runs only — never priced from a table):');
    if (rates.sourceRuns.length === 0) {
      log('  no measured rates yet — no prior non-mock run under ' + runsDir);
    } else {
      log(`  rate sources: ${rates.sourceRuns.join(', ')}`);
    }
    if (rates.skippedMockRuns.length > 0) {
      log(`  skipped mock runs (fabricated spend): ${rates.skippedMockRuns.join(', ')}`);
    }
    for (const line of estimate.lines) log(line);
    if (estimate.totalUsd === null) {
      log('  TOTAL: no measured rates yet — run a live item first to produce rates');
    } else {
      log(`  TOTAL (measured components only): $${estimate.totalUsd.toFixed(4)}`);
    }
    if (estimate.missing.length > 0) {
      log(`  !! excluded from the total (no measured rate): ${estimate.missing.join(', ')}`);
    }
    log('');
    log(`Live runs require --approve-cost-usd; the ceiling is enforced on REAL reported spend between items.`);
    return 0;
  }

  // --- governance gates ----------------------------------------------------
  const manifestPath = join(runDir, 'manifest.json');
  const prior = await loadPriorManifest(manifestPath);
  // A run dir with a manifest is an EXISTING run even before its first row:
  // `observe` writes the manifest + obs artifacts, and a later `run` on the
  // same id must continue it (reusing that spend), not restart it.
  const runExists = existsSync(resultsPath) || existsSync(manifestPath);
  if (runExists && !flags.resume) {
    console.error(
      `membench run: run "${flags.runId}" already exists at ${runDir} ` +
        `(${existsSync(resultsPath) ? 'results.jsonl' : 'manifest.json'} present) — refusing to clobber it.\n` +
        '  Pass --resume to continue it, or pick a different --run-id.',
    );
    return 1;
  }
  if (flags.resume) {
    const incompatible = checkResumeCompatibility(prior, { mock: flags.mock, spec, items });
    if (incompatible) {
      console.error(`membench run: cannot resume run "${flags.runId}": ${incompatible}`);
      return 1;
    }
  }
  if (flags.retryFailed && !flags.resume) {
    console.error('membench run: --retry-failed only applies together with --resume');
    return 1;
  }

  if (!flags.mock && flags.approveCostUsd === undefined) {
    console.error(
      'membench run: live runs require --approve-cost-usd <ceiling>.\n' +
        '  Run --dry-run first to see the planned call matrix and the measured-rate estimate.',
    );
    return 1;
  }
  if (!flags.mock && missingExecutorModel) {
    console.error(`membench run: ${missingExecutorModel}`);
    return 1;
  }

  // The spec's own declared budget is a hard co-limit: whichever is smaller
  // wins, so an over-generous --approve-cost-usd can never exceed what the
  // reviewed, committed spec authorized.
  const approved = flags.approveCostUsd ?? Number.POSITIVE_INFINITY;
  const ceiling = Math.min(approved, spec.max_cost_usd);
  const maxUnreportedCalls = flags.maxUnreportedCalls ?? DEFAULT_MAX_UNREPORTED_CALLS;
  if (Number.isFinite(ceiling)) {
    log(
      `Effective cost ceiling: $${ceiling.toFixed(4)} ` +
        `(min of --approve-cost-usd ${Number.isFinite(approved) ? `$${approved.toFixed(4)}` : 'unset'} ` +
        `and spec.max_cost_usd $${spec.max_cost_usd.toFixed(4)}).`,
    );
    if (spec.executors.includes('claude-cli')) {
      log(
        '   Ceiling softness: fork-runs reserve headroom for in-flight cells, but the ' +
          'claude-cli lane has NO mid-run cost stop (wall-clock timeout only), so its first ' +
          'run is unbounded and can overshoot on its own.',
      );
    }
  }
  if (!flags.mock) {
    const rates = await readMeasuredRates(runsDir);
    const estimate = estimateCost(matrix, spec, rates);
    if (estimate.totalUsd !== null && estimate.totalUsd > ceiling) {
      console.error(
        `membench run: measured-rate estimate $${estimate.totalUsd.toFixed(4)} exceeds ` +
          `--approve-cost-usd $${ceiling.toFixed(4)} — refusing to start.`,
      );
      for (const line of estimate.lines) console.error(line);
      return 1;
    }
    if (estimate.totalUsd === null) {
      log('!! no measured rates yet — starting without a pre-flight estimate.');
      log('   The ceiling will be enforced on REAL reported spend between items.');
    } else {
      log(`Pre-flight estimate $${estimate.totalUsd.toFixed(4)} <= ceiling $${ceiling.toFixed(4)} — starting.`);
      if (estimate.missing.length > 0) {
        log(`!! estimate EXCLUDES (no measured rate): ${estimate.missing.join(', ')} — real spend may be higher.`);
      }
    }
  }

  // --- dependencies --------------------------------------------------------
  mkdirSync(runDir, { recursive: true });

  let deps: ExecuteStageDeps;
  let query: QueryModelFn | undefined;
  let mockFarmStop: (() => void) | undefined;

  if (flags.mock) {
    const mocks = createMockDeps({ lanes: spec.executors, ...(overrides.mock ?? {}) });
    mockFarmStop = () => mocks.farm.stopAll();
    query = overrides.query ?? mocks.query;
    deps = {
      executors: mocks.executors,
      spawnWorker: mocks.spawnWorker,
      cloneRepo: mocks.cloneRepo,
      killTree: mocks.killTree,
      query,
      ...(overrides.deps ?? {}),
    };
  } else {
    if (!config.openrouterApiKey) {
      console.error('membench run: OPENROUTER_API_KEY is not set — a live run cannot query models.');
      return 1;
    }
    try {
      const executors = await buildLiveExecutors(spec, config.claudeMemRoot, config.openrouterApiKey);
      query = overrides.query;
      deps = {
        executors,
        claudeMemRoot: config.claudeMemRoot,
        apiKey: config.openrouterApiKey,
        ...(query ? { query } : {}),
        ...(overrides.deps ?? {}),
      };
    } catch (error: unknown) {
      console.error(`membench run: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  // --- manifest ------------------------------------------------------------
  let shuffled: Record<string, ShuffledSource>;
  try {
    // Donor candidates are COMPLETE, FROZEN corpus items only — a stray or
    // half-built directory must never become the shuffled control's source.
    const corpusItemIds = (await listItems(corpusDir))
      .filter((status) => status.complete && status.frozen)
      .map((status) => status.id);
    shuffled = resolveShuffledSources(spec.corpus_items, spec.observer_models, corpusItemIds);
  } catch (error: unknown) {
    console.error(`membench run: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const manifest: ManifestShape = {
    run_id: flags.runId,
    created_at: prior?.created_at ?? new Date().toISOString(),
    mock: flags.mock,
    spec_path: resolve(flags.spec),
    spec,
    corpus_dir: corpusDir,
    runs_dir: runsDir,
    items: items.map((item) => ({ id: item.id, content_hash: item.contentHash })),
    variants: [...spec.observer_models.map((model) => `model:${model}`), ...CONTROL_VARIANTS],
    shuffled_source_map: shuffled,
    fork_concurrency: forkConcurrency,
    observe_concurrency: observeConcurrency,
    approve_cost_usd: flags.approveCostUsd ?? null,
    resumes: [...(prior?.resumes ?? []), ...(flags.resume ? [new Date().toISOString()] : [])],
  };
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  // --- spend governance ----------------------------------------------------
  const tracker = createSpendTracker();
  if (flags.resume) await seedTrackerFromRunDir(runDir, tracker);

  let stoppedByCeiling = false;
  let stopReported = false;

  /**
   * The single spend gate, consulted both BEFORE each unit of work (so a
   * crossed ceiling stops the very next call, not the next item) and after
   * each item. Two independent stop conditions:
   *   - known spend reached the effective ceiling
   *   - spend is unbounded-unknown: nothing reported a cost yet, but enough
   *     calls came back without one that the ceiling protects nothing
   */
  const stopReason = (reserveUsd = 0, reserveNote = ''): string | undefined => {
    if (reserveUsd > 0 && tracker.knownUsd + reserveUsd >= ceiling) {
      return (
        `COST CEILING would be crossed: real reported spend $${tracker.knownUsd.toFixed(4)} + ` +
        `$${reserveUsd.toFixed(4)} reserved${reserveNote} >= effective ceiling $${ceiling.toFixed(4)}.`
      );
    }
    return plainStopReason();
  };

  const plainStopReason = (): string | undefined => {
    if (tracker.knownUsd >= ceiling) {
      return (
        `COST CEILING REACHED: real reported spend $${tracker.knownUsd.toFixed(4)} >= ` +
        `effective ceiling $${ceiling.toFixed(4)}.`
      );
    }
    if (tracker.knownUsd === 0 && tracker.unknownCount > maxUnreportedCalls) {
      return (
        `UNREPORTED-COST LIMIT REACHED: ${tracker.unknownCount} call(s) returned no cost and ` +
        'NOTHING has reported a cost yet — real spend is unbounded-unknown, so the ceiling cannot ' +
        'protect anything (raise --max-unreported-calls only if you accept that).'
      );
    }
    return undefined;
  };

  const reportStop = (reason: string): void => {
    stoppedByCeiling = true;
    if (stopReported) return;
    stopReported = true;
    log('');
    log(`!! ${reason} Stopping.`);
    if (tracker.unknownCount > 0) {
      log(`!! plus ${tracker.unknownCount} call(s) with UNREPORTED cost — actual spend is higher.`);
    }
    log(
      `   The partial run is resumable: membench run --spec ${flags.spec} --run-id ${flags.runId} --resume`,
    );
  };

  const preflight = (reserveUsd = 0, reserveNote = ''): 'continue' | 'stop' => {
    const reason = stopReason(reserveUsd, reserveNote);
    if (!reason) return 'continue';
    reportStop(reason);
    return 'stop';
  };

  /**
   * Headroom-aware gate for a fork-run. The plain ceiling check only sees
   * REPORTED spend, and a cell that is still running has reported nothing, so
   * concurrent cells are invisible to it: live-smoke-2 finished at $6.7356
   * against a $5.0000 ceiling because a $1.59 claude-cli cell was already in
   * flight when the ceiling tripped.
   *
   * So before scheduling, reserve budget for the cells ALREADY IN FLIGHT,
   * priced at the worst per-run cost seen so far in any lane this run.
   * spec.max_cost_per_run_usd seeds the estimate for the openrouter-agent
   * lane, where it is a genuinely enforced per-run cap. Nothing is reserved
   * for the cell being scheduled — the ceiling is a spend limit, not a
   * pre-authorization, and reserving for it would abandon affordable work.
   *
   * RESIDUAL SOFTNESS (documented, not fixable here): the claude-cli lane has
   * no mid-run cost stop by design — only a wall-clock timeout — so until its
   * first row lands there is no measured worst case to price it at, and that
   * first run can still overshoot on its own.
   */
  const cellPreflight = (context: {
    lane: ExecutorName;
    inFlight: number;
    maxObservedByLane: Partial<Record<ExecutorName, number>>;
  }): 'continue' | 'stop' => {
    if (context.inFlight <= 0) return preflight();
    const estimateFor = (lane: ExecutorName): number =>
      context.maxObservedByLane[lane] ??
      // Only the SDK lane has an enforced per-run cap to fall back on.
      (lane === 'openrouter-agent' ? spec.max_cost_per_run_usd : 0);
    const perRun = Math.max(0, ...spec.executors.map(estimateFor));
    if (perRun <= 0) return preflight();
    const note = ` for ${context.inFlight} in-flight run(s) at $${perRun.toFixed(4)}/run`;
    return preflight(perRun * context.inFlight, note);
  };

  try {
    // --- stage 1: observe --------------------------------------------------
    const observeResult = await runObserveStage({
      items,
      models: spec.observer_models,
      runDir,
      ...(query ? { query } : {}),
      ...(config.openrouterApiKey && !flags.mock ? { apiKey: config.openrouterApiKey } : {}),
      timeoutS: spec.observe_timeout_s,
      concurrency: observeConcurrency,
      governance: (event) => {
        if (event.type === 'record') {
          // Reused records were already counted when the tracker was seeded
          // from the run dir (--resume); counting them again would
          // double-charge. A failed replay is an error record, not spend.
          if (!(event.reused && flags.resume) && !event.record.error) {
            tracker.add('obs', event.record.obs_cost_usd, `${event.itemId} × ${event.model}`);
          }
          return 'continue';
        }
        if (event.type === 'item') {
          log(`observe complete for ${event.itemId}. ${formatSpend(tracker)}`);
        }
        return preflight();
      },
      log,
    });

    if (observeResult.stopped) {
      log(finalReport(tracker, { rowsWritten: 0, rowsSkipped: 0, cellsAbandoned: 0, stopped: true }));
      return 2;
    }
    if (flags.observeOnly) {
      log('');
      log(`observe stage complete: ${observeResult.records.size} (item × model) record(s) under ${join(runDir, 'obs')}`);
      log(formatSpend(tracker));
      return 0;
    }

    // --- variant planning --------------------------------------------------
    const plansByItem = new Map<string, VariantPlan[]>();
    for (const item of items) {
      const plans = await buildVariantPlans({
        item,
        models: spec.observer_models,
        obsRecords: observeResult.records,
        shuffled: shuffled[item.id],
        corpusDir,
      });
      plansByItem.set(item.id, plans);
      for (const plan of plans) {
        if (plan.blocked) log(`!! variant blocked: ${item.id} ${plan.variant} — ${plan.blocked}`);
      }
    }

    // --- stages 2-4: fork, execute, measure --------------------------------
    const completed = flags.retryFailed
      ? await applyRetryFailed(runDir, log)
      : flags.resume
        ? await readCompletedCells(resultsPath)
        : new Set<string>();
    if (completed.size > 0) log(`resume: ${completed.size} completed row(s) will be skipped`);

    const executeResult = await runExecuteStage({
      runId: flags.runId,
      runsDir,
      runDir,
      spec,
      items,
      plansByItem,
      deps,
      completed,
      concurrency: forkConcurrency,
      tracker,
      beforeCell: cellPreflight,
      betweenItems: (itemId) => {
        log(`execute complete for ${itemId}. ${formatSpend(tracker)}`);
        return preflight();
      },
      log,
    });

    log(finalReport(tracker, executeResult));
    return executeResult.stopped || stoppedByCeiling ? 2 : 0;
  } catch (error: unknown) {
    console.error(`membench run: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    log(formatSpend(tracker));
    return 1;
  } finally {
    mockFarmStop?.();
  }
}

function finalReport(
  tracker: SpendTracker,
  result: { rowsWritten: number; rowsSkipped: number; cellsAbandoned: number; stopped: boolean },
): string {
  return [
    '',
    result.stopped ? 'RUN STOPPED EARLY (resumable).' : 'RUN COMPLETE.',
    `rows written: ${result.rowsWritten}` +
      `${result.rowsSkipped > 0 ? `, skipped (already complete): ${result.rowsSkipped}` : ''}` +
      `${result.cellsAbandoned > 0 ? `, abandoned unrun (retry with --resume): ${result.cellsAbandoned}` : ''}`,
    formatSpend(tracker),
  ].join('\n');
}

/**
 * Construct the live executor for each selected lane. The openrouter-agent
 * module (and its SDK dependency) is imported LAZILY so mock runs, dry runs
 * and CLI-only runs never load it.
 */
async function buildLiveExecutors(
  spec: RunSpec,
  claudeMemRoot: string,
  apiKey: string,
): Promise<Partial<Record<ExecutorName, import('./types.js').Executor>>> {
  const executors: Partial<Record<ExecutorName, import('./types.js').Executor>> = {};
  for (const lane of spec.executors) {
    if (lane === 'claude-cli') {
      const { createClaudeCliExecutor, resolveClaudeCredentials } = await import(
        './executors/claude-cli.js'
      );
      // The fork HOME is isolated (guard 4), so the CLI has no credentials
      // unless we seed them. Resolved once per run and reused for every fork.
      const credentialsJson = resolveClaudeCredentials();
      if (!credentialsJson) {
        throw new RunCommandError(
          'the claude-cli lane found no Claude Code credentials to seed into the isolated fork HOME.\n' +
            '  Run `claude login` on this host, or point MEMBENCH_CLAUDE_CREDENTIALS_FILE at a\n' +
            '  .credentials.json. Without it every fork-run fails "Not logged in".',
        );
      }
      executors[lane] = createClaudeCliExecutor({
        claudeMemRoot,
        credentialsJson,
        ...(spec.cli_model ? { model: spec.cli_model } : {}),
      });
    } else {
      if (!spec.executor_model) {
        throw new RunCommandError(
          'the openrouter-agent lane needs `executor_model = "<model id>"` in the run spec',
        );
      }
      const { createOpenRouterAgentExecutor } = await import('./executors/openrouter-agent.js');
      executors[lane] = createOpenRouterAgentExecutor({ model: spec.executor_model, apiKey });
    }
  }
  return executors;
}

/** `membench observe` — stage 1 only, same governance. */
export async function observeMain(args: string[], overrides: RunOverrides = {}): Promise<number> {
  return runMain([...args, '--observe-only'], overrides);
}
