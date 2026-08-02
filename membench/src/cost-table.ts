/**
 * `membench cost` — the OpenRouter sponsor deliverable (plan Phase 7.3).
 *
 * Reads one or more COMPLETED run directories, sums the REAL reported
 * `usage.cost` per pass (observe pass per model, executor pass per lane, judge
 * pass), and extrapolates to a target matrix with the plan's cost formula:
 *
 *   N_models × (obs pass) + (N_models + 3) × k × N_executors × (executor pass)
 *
 * Both executor routes are presented side by side — `claude-cli` (the CLI's own
 * reported cost) and `openrouter-agent` (fully OpenRouter-priced) — and every
 * number is labeled **measured** or **extrapolated**.
 *
 * GUARD 1, absolutely: there is no pricing table in this file and no
 * per-token arithmetic anywhere in MemBench. Rates come only from costs a
 * provider actually reported. A run that reported nothing is REFUSED, not
 * estimated; calls whose cost was not reported are counted and shown, never
 * folded in as $0.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import {
  OPENROUTER_CITATION,
  readJudgeCosts,
  readObserveRecords,
  readResultRows,
  requireManifest,
  runIdError,
} from './scoreboard.js';
import type { RunSpec } from './spec.js';

export class CostTableError extends Error {}

/** Control variants added to every item's matrix: none, oracle, shuffled. */
export const CONTROL_VARIANT_COUNT = 3;

/** The cost-specific rider on the single shared OpenRouter citation. */
export const COST_CITATION_SUFFIX =
  'Every measured number below is a reported `usage.cost` (for the `claude-cli` lane, the cost the CLI ' +
  'itself reported). Nothing here is priced from a rate table.';

// ---------------------------------------------------------------------------
// Measured rates
// ---------------------------------------------------------------------------

/** One measurable pass: how many calls reported a cost, and their mean. */
export interface PassRate {
  label: string;
  /** Calls whose cost the provider REPORTED (the mean's sample size). */
  calls: number;
  /** Calls that returned NO cost — surfaced, never counted as $0. */
  unreported: number;
  totalUsd: number;
  meanUsd: number | null;
}

function emptyRate(label: string): PassRate {
  return { label, calls: 0, unreported: 0, totalUsd: 0, meanUsd: null };
}

function fold(rate: PassRate, costUsd: number | null | undefined): void {
  if (typeof costUsd === 'number' && Number.isFinite(costUsd)) {
    rate.totalUsd += costUsd;
    rate.calls += 1;
    rate.meanUsd = rate.totalUsd / rate.calls;
    return;
  }
  rate.unreported += 1;
}

function merge(target: PassRate, source: PassRate): void {
  target.totalUsd += source.totalUsd;
  target.calls += source.calls;
  target.unreported += source.unreported;
  target.meanUsd = target.calls > 0 ? target.totalUsd / target.calls : null;
}

/** Everything one run dir contributes to the table. */
export interface RunCostSample {
  runId: string;
  mock: boolean;
  spec: RunSpec | null;
  /** Observe pass, per observer model: one call = one (item × model) replay. */
  observeByModel: Record<string, PassRate>;
  /** Observe pass across all models (one call = one (item × model) replay). */
  observeAll: PassRate;
  /** Executor pass, per lane: one call = one fork-run. */
  executors: Record<string, PassRate>;
  /** Judge pass: one call = one judged run. */
  judge: PassRate;
  /** Distinct corpus items that produced result rows. */
  itemIds: string[];
  items: number;
  /** Populated by combineSamples when the source runs' specs disagree. */
  specConflicts?: string[];
  /** Every reported cost in the run, summed. */
  totalReportedUsd: number;
  /** Every call in the run whose cost was not reported. */
  totalUnreported: number;
}

/** Read one run dir into a cost sample. Never invents a number. */
export async function readRunCostSample(
  runDir: string,
  runId: string,
  warn: (message: string) => void = () => {},
): Promise<RunCostSample> {
  const problem = runIdError(runId);
  if (problem) throw new CostTableError(problem);
  if (!existsSync(runDir)) {
    throw new CostTableError(`run directory not found: ${runDir}`);
  }
  // Provenance first (guard 1): a run whose mock/live status is unknown must
  // never seed a rate — mock costs are non-zero, so nothing else would catch it.
  const manifest = await requireManifest(runDir, runId);
  const { records } = await readObserveRecords(runDir, warn);
  const { rows } = await readResultRows(join(runDir, 'results.jsonl'), warn);

  const observeByModel: Record<string, PassRate> = {};
  const observeAll = emptyRate('observe (all models)');
  for (const record of records) {
    // A failed replay bought nothing; it is not a rate sample.
    if (typeof record.error === 'string' && record.error !== '') continue;
    observeByModel[record.model] ??= emptyRate(`observe: ${record.model}`);
    fold(observeByModel[record.model], record.obs_cost_usd);
    fold(observeAll, record.obs_cost_usd);
  }

  const executors: Record<string, PassRate> = {};
  for (const row of rows) {
    executors[row.executor] ??= emptyRate(`executor: ${row.executor}`);
    // Errored runs still cost money — they are legitimate rate samples.
    fold(executors[row.executor], row.cost_usd);
  }

  const judge = emptyRate('judge');
  for (const cost of await readJudgeCosts(runDir)) fold(judge, cost);

  const rates = [observeAll, ...Object.values(executors), judge];
  const itemIds = [...new Set(rows.map((row) => row.item_id))].sort();
  return {
    runId,
    mock: manifest.mock === true,
    spec: manifest.spec ?? null,
    observeByModel,
    observeAll,
    executors,
    judge,
    itemIds,
    items: itemIds.length,
    totalReportedUsd: rates.reduce((sum, rate) => sum + rate.totalUsd, 0),
    totalUnreported: rates.reduce((sum, rate) => sum + rate.unreported, 0),
  };
}

/** Which spec fields make two runs describe a different matrix. */
const SPEC_SHAPE_KEYS = ['corpus_items', 'observer_models', 'executors', 'k'] as const;

/**
 * Combine several runs into one measured basis.
 *
 * The first run's spec supplies the extrapolation defaults, so a disagreement
 * between the source runs is RECORDED (and rendered) rather than resolved
 * silently: "measured across runs that ran different matrices" changes how the
 * total should be read.
 */
export function combineSamples(samples: RunCostSample[]): RunCostSample {
  const combined: RunCostSample = {
    runId: samples.map((sample) => sample.runId).join(' + '),
    mock: samples.some((sample) => sample.mock),
    spec: samples.find((sample) => sample.spec)?.spec ?? null,
    observeByModel: {},
    observeAll: emptyRate('observe (all models)'),
    executors: {},
    judge: emptyRate('judge'),
    itemIds: [],
    items: 0,
    totalReportedUsd: 0,
    totalUnreported: 0,
  };
  const itemIds = new Set<string>();
  const specConflicts: string[] = [];
  const reference = samples.find((sample) => sample.spec);

  for (const sample of samples) {
    for (const [model, rate] of Object.entries(sample.observeByModel)) {
      combined.observeByModel[model] ??= emptyRate(`observe: ${model}`);
      merge(combined.observeByModel[model], rate);
    }
    merge(combined.observeAll, sample.observeAll);
    for (const [lane, rate] of Object.entries(sample.executors)) {
      combined.executors[lane] ??= emptyRate(`executor: ${lane}`);
      merge(combined.executors[lane], rate);
    }
    merge(combined.judge, sample.judge);
    combined.totalReportedUsd += sample.totalReportedUsd;
    combined.totalUnreported += sample.totalUnreported;
    for (const id of sample.itemIds) itemIds.add(id);

    if (reference && sample.spec && sample !== reference) {
      for (const key of SPEC_SHAPE_KEYS) {
        const a = JSON.stringify(reference.spec?.[key]);
        const b = JSON.stringify(sample.spec[key]);
        if (a !== b) {
          specConflicts.push(`${sample.runId}: spec.${key} = ${b} but ${reference.runId} used ${a}`);
        }
      }
    } else if (reference && !sample.spec) {
      specConflicts.push(`${sample.runId}: no spec recorded in its manifest`);
    }
  }

  // Items are the UNION of what the runs measured: two runs over different
  // items measured more of the corpus, not the same item twice.
  combined.itemIds = [...itemIds].sort();
  combined.items = combined.itemIds.length;
  if (specConflicts.length > 0) combined.specConflicts = specConflicts;
  return combined;
}

// ---------------------------------------------------------------------------
// Extrapolation
// ---------------------------------------------------------------------------

/** What the table extrapolates TO. Defaults come from the run's own spec. */
export interface CostTarget {
  models: number;
  items: number;
  k: number;
  /** Human-readable provenance of each default ("--models flag" / "run spec"). */
  sources: { models: string; items: string; k: string };
}

/**
 * Resolve the target matrix: explicit flags win, otherwise the run's own spec,
 * otherwise what the run itself measured.
 */
export function resolveTarget(
  sample: RunCostSample,
  flags: { models?: number; items?: number; k?: number },
): CostTarget {
  const specModels = sample.spec?.observer_models.length;
  const specItems = sample.spec?.corpus_items.length;
  const specK = sample.spec?.k;
  const measuredModels = Object.keys(sample.observeByModel).length;
  return {
    models: flags.models ?? specModels ?? measuredModels,
    items: flags.items ?? specItems ?? sample.items,
    k: flags.k ?? specK ?? 1,
    sources: {
      models: flags.models !== undefined ? '--models' : specModels !== undefined ? 'run spec' : 'measured runs',
      items: flags.items !== undefined ? '--items' : specItems !== undefined ? 'run spec' : 'measured runs',
      k: flags.k !== undefined ? '--k' : specK !== undefined ? 'run spec' : 'default 1',
    },
  };
}

export interface RouteEstimate {
  lane: string;
  /** items × Σ per-model observe means — shared with every other route. */
  observeUsd: number | null;
  /** items × (models + 3) × k × mean(executor pass for THIS lane). */
  executorUsd: number | null;
  /** items × (models + 3) × k × mean(judge pass) — an UPPER BOUND (see below). */
  judgeUsd: number | null;
  totalUsd: number | null;
  /** Components with no measured rate; excluded from the total. */
  missing: string[];
  /** Fork-runs this route implies, for the reader's sanity check. */
  executorRuns: number;
  observeCalls: number;
  /** Models priced at their OWN measured rate. */
  observeMeasuredModels: number;
  /** Models priced at the blended mean because they were never measured. */
  observeBlendedModels: number;
}

/**
 * Observe-pass cost for the whole target matrix.
 *
 * Observe cost is MODEL-SPECIFIC (a cheap model priced at an expensive model's
 * rate is a fabricated number), so each model is priced at its own measured
 * mean — mirroring run-command.ts's per-model MeasuredRates. Only models the
 * source runs never measured fall back to the blended mean across all measured
 * observe calls, and that fallback is counted so the render can say so.
 */
export function estimateObservePass(
  sample: RunCostSample,
  target: CostTarget,
): { usd: number | null; measuredModels: number; blendedModels: number } {
  const measuredMeans = Object.keys(sample.observeByModel)
    .sort()
    .map((model) => sample.observeByModel[model].meanUsd)
    .filter((value): value is number => value !== null);

  const priced = measuredMeans.slice(0, target.models);
  const blendedCount = Math.max(0, target.models - priced.length);
  const blend = sample.observeAll.meanUsd;
  if (priced.length === 0 && blendedCount > 0 && blend === null) {
    return { usd: null, measuredModels: 0, blendedModels: blendedCount };
  }
  if (blendedCount > 0 && blend === null) {
    // Some models measured, some not, and no blend to price the rest with.
    return { usd: null, measuredModels: priced.length, blendedModels: blendedCount };
  }
  const perItem = priced.reduce((sum, value) => sum + value, 0) + blendedCount * (blend ?? 0);
  return { usd: target.items * perItem, measuredModels: priced.length, blendedModels: blendedCount };
}

/**
 * Apply the formula to one executor route.
 * A component with no measured rate stays null and is listed in `missing` —
 * it is never filled in from a price list (guard 1).
 *
 * The judge term is an UPPER BOUND: measure.ts skips the judge entirely when
 * check.sh decided mechanically AND the run produced an empty diff, so a real
 * run makes at most one judge call per fork-run, often fewer.
 */
export function estimateRoute(sample: RunCostSample, lane: string, target: CostTarget): RouteEstimate {
  const variantsPerItem = target.models + CONTROL_VARIANT_COUNT;
  const observeCalls = target.items * target.models;
  const executorRuns = target.items * variantsPerItem * target.k;
  const missing: string[] = [];

  const observe = estimateObservePass(sample, target);
  const executorMean = sample.executors[lane]?.meanUsd ?? null;
  const judgeMean = sample.judge.meanUsd;

  const observeUsd = observe.usd;
  const executorUsd = executorMean === null ? null : executorRuns * executorMean;
  const judgeUsd = judgeMean === null ? null : executorRuns * judgeMean;

  if (observeUsd === null) missing.push('observe pass');
  if (executorUsd === null) missing.push(`executor pass (${lane})`);
  if (judgeUsd === null) missing.push('judge pass');

  const parts = [observeUsd, executorUsd, judgeUsd].filter((value): value is number => value !== null);
  return {
    lane,
    observeUsd,
    executorUsd,
    judgeUsd,
    totalUsd: parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null,
    missing,
    executorRuns,
    observeCalls,
    observeMeasuredModels: observe.measuredModels,
    observeBlendedModels: observe.blendedModels,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Both v0.1 routes, always rendered side by side even when one has no rate. */
export const ROUTES = ['claude-cli', 'openrouter-agent'] as const;

function usd(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(digits)}`;
}

function measured(value: number | null, digits = 4): string {
  return value === null ? 'n/a (nothing reported)' : `${usd(value, digits)} **measured**`;
}

function extrapolated(value: number | null, digits = 4): string {
  return value === null ? 'n/a (no measured rate)' : `${usd(value, digits)} **extrapolated**`;
}

function rateRow(rate: PassRate): string {
  return (
    `| ${rate.label} | ${rate.calls} | ${usd(rate.totalUsd, 6)} **measured** | ${usd(rate.meanUsd, 6)} **measured** | ` +
    `${rate.unreported} |`
  );
}

export interface CostTableInput {
  samples: RunCostSample[];
  combined: RunCostSample;
  target: CostTarget;
  generatedAt?: Date;
}

/** Render the sponsor-facing markdown cost table. */
export function renderCostTable(input: CostTableInput): string {
  const { samples, combined, target } = input;
  const lines: string[] = [];
  const routes = ROUTES.map((lane) => estimateRoute(combined, lane, target));

  lines.push('# MemBench cost estimate');
  lines.push('');
  lines.push(
    `Source run(s): ${samples.map((sample) => `\`${sample.runId}\``).join(', ')} · generated ${(input.generatedAt ?? new Date()).toISOString()}`,
  );
  lines.push('');
  if (combined.mock) {
    lines.push(
      '> **MOCK DATA — at least one source run is a `--mock` run whose costs are fabricated by the offline ' +
        'mocks.** This table is structurally valid but its numbers describe nothing real. Do not send it to a sponsor.',
    );
    lines.push('');
  }
  lines.push(`${OPENROUTER_CITATION} ${COST_CITATION_SUFFIX}`);
  lines.push('');
  if (combined.specConflicts && combined.specConflicts.length > 0) {
    lines.push(
      '> **The source runs did not run the same matrix.** The extrapolation defaults come from the first ' +
        "run's spec; the measured means pool runs that differ:",
    );
    for (const conflict of combined.specConflicts) lines.push(`> - ${conflict}`);
    lines.push('');
  }

  // --- measured ------------------------------------------------------------
  lines.push('## 1. Measured — what the source run(s) actually cost');
  lines.push('');
  lines.push('| Pass | calls with reported cost | Σ reported | mean per call | calls with NO reported cost |');
  lines.push('|---|---|---|---|---|');
  for (const model of Object.keys(combined.observeByModel).sort()) {
    lines.push(rateRow(combined.observeByModel[model]));
  }
  lines.push(rateRow(combined.observeAll));
  for (const lane of ROUTES) {
    lines.push(rateRow(combined.executors[lane] ?? emptyRate(`executor: ${lane}`)));
  }
  for (const lane of Object.keys(combined.executors).sort()) {
    if ((ROUTES as readonly string[]).includes(lane)) continue;
    lines.push(rateRow(combined.executors[lane]));
  }
  lines.push(rateRow(combined.judge));
  lines.push('');
  lines.push(
    `Total reported spend across the source run(s): ${usd(combined.totalReportedUsd, 4)} **measured**` +
      (combined.totalUnreported > 0
        ? ` — plus **${combined.totalUnreported} call(s) whose cost the provider did not report**. ` +
          'Those are NOT counted as $0: real spend is at least the number above, possibly more.'
        : ' — every call reported a cost.'),
  );
  lines.push('');
  if (samples.length > 1) {
    lines.push('Per source run:');
    lines.push('');
    lines.push('| run | reported spend | calls with no reported cost | mock |');
    lines.push('|---|---|---|---|');
    for (const sample of samples) {
      lines.push(
        `| \`${sample.runId}\` | ${usd(sample.totalReportedUsd, 4)} **measured** | ${sample.totalUnreported} | ` +
          `${sample.mock ? '**yes — fabricated**' : 'no'} |`,
      );
    }
    lines.push('');
  }

  // --- extrapolated --------------------------------------------------------
  lines.push('## 2. Extrapolated — a full run of the benchmark');
  lines.push('');
  lines.push('What is actually computed below, per executor route:');
  lines.push('');
  lines.push('```');
  lines.push('observe  = items × Σ(per-model measured observe mean)      [shared by both routes]');
  lines.push('executor = items × (models + 3 controls) × k × mean cost per fork-run in that lane');
  lines.push('judge    = items × (models + 3 controls) × k × mean judge cost      [UPPER BOUND]');
  lines.push('route    = observe + executor + judge');
  lines.push('```');
  lines.push('');
  lines.push(
    'This is the plan\'s cost formula — `N_models × (obs pass) + (N_models + 3) × k × N_executors × ' +
      '(executor pass)` — written out per item and per route, with the judge pass (which the plan folds into ' +
      'the executor pass) priced separately from its own measured rate.',
  );
  lines.push('');
  lines.push(
    '**The judge term is an upper bound**: the judge is skipped entirely when `check.sh` decided ' +
      'mechanically and the run produced an empty diff, so a real run makes at most one judge call per ' +
      'fork-run and usually fewer.',
  );
  lines.push('');
  lines.push(
    `Target: **${target.models} observer model(s)** (${target.sources.models}) × ` +
      `**${target.items} corpus item(s)** (${target.sources.items}) × ` +
      `**k=${target.k}** (${target.sources.k}), plus the ${CONTROL_VARIANT_COUNT} controls ` +
      '(`none`, `oracle`, `shuffled`) per item.',
  );
  lines.push('');
  lines.push(
    `Call counts per route: ${routes[0].observeCalls} observe replay(s) (shared by both routes) and ` +
      `${routes[0].executorRuns} fork-run(s) **per lane**, each with at most one judge call.`,
  );
  lines.push('');
  lines.push('| Component | Route `claude-cli` | Route `openrouter-agent` | basis |');
  lines.push('|---|---|---|---|');
  const observeBasis =
    `items × Σ per-model measured observe means — ${routes[0].observeMeasuredModels} model(s) at their own rate` +
    (routes[0].observeBlendedModels > 0
      ? `, ${routes[0].observeBlendedModels} unmeasured model(s) at the blended mean ${usd(combined.observeAll.meanUsd, 6)} **measured**`
      : '');
  lines.push(
    `| observe pass (shared) | ${extrapolated(routes[0].observeUsd)} | ${extrapolated(routes[1].observeUsd)} | ${observeBasis} |`,
  );
  lines.push(
    `| executor pass | ${extrapolated(routes[0].executorUsd)} | ${extrapolated(routes[1].executorUsd)} | ` +
      `items × (models+${CONTROL_VARIANT_COUNT}) × k × mean lane cost ` +
      `(${usd(combined.executors['claude-cli']?.meanUsd ?? null, 6)} / ${usd(combined.executors['openrouter-agent']?.meanUsd ?? null, 6)} **measured**) |`,
  );
  lines.push(
    `| judge pass (upper bound) | ${extrapolated(routes[0].judgeUsd)} | ${extrapolated(routes[1].judgeUsd)} | ` +
      `at most one call per fork-run × mean judge cost (${usd(combined.judge.meanUsd, 6)} **measured**) |`,
  );
  lines.push(
    `| **route total** | ${extrapolated(routes[0].totalUsd)} | ${extrapolated(routes[1].totalUsd)} | ` +
      'observe + executor + judge |',
  );
  lines.push('');
  const bothRoutes =
    routes[0].totalUsd !== null && routes[1].totalUsd !== null && routes[0].observeUsd !== null
      ? routes[0].totalUsd + routes[1].totalUsd - routes[0].observeUsd
      : null;
  lines.push(
    `Running **both** lanes in one run costs ${extrapolated(bothRoutes)} — the observe pass is paid once and shared, ` +
      'so it is not double counted.',
  );
  lines.push('');
  const missing = [...new Set(routes.flatMap((route) => route.missing))];
  if (missing.length > 0) {
    lines.push(
      `> **Excluded from the totals (no measured rate yet): ${missing.join(', ')}.** ` +
        'MemBench refuses to price a pass it has not measured — run that pass live first.',
    );
    lines.push('');
  }
  if (combined.totalUnreported > 0) {
    lines.push(
      `> **${combined.totalUnreported} measured call(s) returned no cost.** The means above are computed only over ` +
        'calls that DID report one, so the extrapolation is a lower bound.',
    );
    lines.push('');
  }
  lines.push(
    '_Caveat: extrapolation assumes the measured items are representative. Token-heavy corpus items cost more; ' +
      'a model that fails and retries costs more. Treat the totals as an order of magnitude, not a quote._',
  );
  lines.push('');
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const COST_HELP = `Usage: membench cost <run-id> [<run-id>...] [options]

Sums the REAL reported usage cost of completed run(s) per pass and extrapolates
to a target matrix with the plan's cost formula. Both executor routes are shown
side by side; every number is labeled measured or extrapolated.

Options:
  --models <n>       observer models to extrapolate to (default: the run's spec)
  --items <n>        corpus items to extrapolate to   (default: the run's spec)
  --k <n>            runs per cell to extrapolate to  (default: the run's spec)
  --runs-dir <path>  default: MEMBENCH_RUNS_DIR or ./runs
  --out <path>       also write the markdown table to this file
  -h, --help         show this help

There is no pricing table in MemBench: a run that reported no cost at all is
refused, never estimated.
`;

interface CostFlags {
  runIds: string[];
  models?: number;
  items?: number;
  k?: number;
  runsDir?: string;
  out?: string;
  help: boolean;
}

export function parseCostFlags(args: string[]): CostFlags {
  const flags: CostFlags = { runIds: [], help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) {
      flags.runIds.push(arg);
      continue;
    }
    let name = arg;
    let inlineValue: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      name = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }
    if (name === '--help' || name === '-h') {
      flags.help = true;
      continue;
    }
    if (!['--models', '--items', '--k', '--runs-dir', '--out'].includes(name)) {
      throw new CostTableError(`unknown option: ${arg}`);
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined) throw new CostTableError(`${name} requires a value`);
    if (name === '--runs-dir') {
      flags.runsDir = value;
      continue;
    }
    if (name === '--out') {
      flags.out = value;
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new CostTableError(`${name} must be a positive integer`);
    }
    if (name === '--models') flags.models = parsed;
    else if (name === '--items') flags.items = parsed;
    else flags.k = parsed;
  }
  return flags;
}

/** `membench cost`. Returns a process exit code; never throws for user errors. */
export async function costMain(
  args: string[],
  overrides: { log?: (message: string) => void } = {},
): Promise<number> {
  const log = overrides.log ?? ((message: string) => console.log(message));
  let flags: CostFlags;
  try {
    flags = parseCostFlags(args);
  } catch (error: unknown) {
    console.error(`membench cost: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(COST_HELP);
    return 1;
  }
  if (flags.help) {
    log(COST_HELP);
    return 0;
  }
  if (flags.runIds.length === 0) {
    console.error('membench cost: at least one <run-id> is required\n');
    console.error(COST_HELP);
    return 1;
  }
  // A repeated run id would double-weight that run's rates.
  const runIds = [...new Set(flags.runIds)];
  if (runIds.length !== flags.runIds.length) {
    log(`note: ignoring duplicate run id(s); using ${runIds.join(', ')}`);
  }
  for (const runId of runIds) {
    const problem = runIdError(runId);
    if (problem) {
      console.error(`membench cost: ${problem}`);
      return 1;
    }
  }

  const config = loadConfig({ ...(flags.runsDir ? { runsDir: flags.runsDir } : {}) });
  const runsDir = resolve(config.runsDir);

  try {
    const samples: RunCostSample[] = [];
    for (const runId of runIds) {
      const sample = await readRunCostSample(join(runsDir, runId), runId);
      // Guard 1: a run with nothing reported cannot seed a rate, and guessing
      // one is exactly the failure this benchmark exists to avoid.
      if (sample.totalReportedUsd === 0 && sample.observeAll.calls === 0 && sample.judge.calls === 0 &&
        Object.values(sample.executors).every((rate) => rate.calls === 0)) {
        console.error(
          `membench cost: run "${runId}" reports no usage cost anywhere (observe, executor or judge) — ` +
            'refusing to build a cost table from it. MemBench never estimates cost from a pricing table; ' +
            'run the passes live (with --approve-cost-usd) so real usage.cost values exist.',
        );
        if (sample.totalUnreported > 0) {
          console.error(`  (${sample.totalUnreported} call(s) in that run returned no cost at all)`);
        }
        return 1;
      }
      samples.push(sample);
    }

    const combined = combineSamples(samples);
    for (const conflict of combined.specConflicts ?? []) {
      log(`!! source runs disagree: ${conflict}`);
    }
    const target = resolveTarget(combined, {
      ...(flags.models !== undefined ? { models: flags.models } : {}),
      ...(flags.items !== undefined ? { items: flags.items } : {}),
      ...(flags.k !== undefined ? { k: flags.k } : {}),
    });
    const markdown = renderCostTable({ samples, combined, target });
    if (flags.out) {
      await Bun.write(flags.out, markdown);
      log(`wrote ${resolve(flags.out)}`);
    }
    log(markdown);
    return 0;
  } catch (error: unknown) {
    console.error(`membench cost: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
