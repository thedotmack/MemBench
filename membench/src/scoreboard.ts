/**
 * Scoreboard — plan Phase 7.1.
 *
 * Reads one run directory DEFENSIVELY (results.jsonl + obs/<item>/<model>.json
 * + manifest.json) and emits:
 *   runs/<run_id>/summary.json    — every number, machine-readable
 *   runs/<run_id>/scoreboard.md   — the published rendering
 *
 * Renderer template: evals/swebench/summarize.py:128-215 (summary table +
 * run-vs-run diff mode, incl. its pipe-escaping of free text).
 *
 * Two structural rules hold everywhere below:
 *
 *   Guard 11 (lanes) — the markdown is SECTIONED BY EXECUTOR and no cell mixes
 *   `claude-cli` and `openrouter-agent` rows. Cross-executor deltas exist only
 *   under Diagnostics (and in the cost table, `cost-table.ts`).
 *
 *   Headline discipline — observation counts, observe tokens, parse notes and
 *   accommodations are DIAGNOSTICS. They appear under `## Diagnostics` and
 *   nowhere above it (plan Phase 7 verification, line 328).
 *
 * Guard 1 (never estimate cost): every cost here is a sum of REPORTED
 * `usage.cost` values. Rows whose provider reported no cost are counted and
 * printed as "unreported", never folded in as $0.
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import type { ObserveRecord } from './observe-stage.js';
import type { RunSpec } from './spec.js';

export class ScoreboardError extends Error {}

/** Bump when the shape of summary.json changes. */
export const SUMMARY_VERSION = 1;

/** Cited in everything published (plan §"Integrity"). */
export const OPENROUTER_CITATION =
  'All observer, executor (openrouter-agent lane) and judge models are routed through ' +
  '[OpenRouter](https://openrouter.ai). Costs are OpenRouter-reported `usage.cost` values.';

// ---------------------------------------------------------------------------
// METRIC DEFINITIONS — defined ONCE, here, with their formulas.
// Every number in summary.json and scoreboard.md comes from this block.
// ---------------------------------------------------------------------------

/**
 * success rate = successes / runs
 *   `runs`      = every results.jsonl row in the (executor, variant) cell,
 *                 INCLUDING rows that errored (a crashed run is not a success).
 *   `successes` = rows with success === true.
 * Read against the `none` control (the floor) in the same executor lane.
 */
export function successRate(successes: number, runs: number): number | null {
  if (runs <= 0) return null;
  return successes / runs;
}

/** Arithmetic mean; null for an empty sample. */
export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  return finite(total / values.length);
}

/**
 * SAMPLE standard deviation (Bessel-corrected, n-1) — the spread reported
 * beside every mean. null for fewer than 2 samples (a single run has no
 * spread; reporting 0 there would claim a precision that does not exist).
 */
export function sampleStddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values);
  if (m === null) return null;
  const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
  return finite(Math.sqrt(variance));
}

/**
 * tokens-to-done = mean ± sample stddev of `tokens_total` over SUCCESSFUL runs
 * only (a failed run's token count measures nothing), and only over successful
 * runs whose provider REPORTED usage — successful runs with null usage are
 * counted separately and surfaced, never averaged in as 0 (guard 2).
 */
export function tokensToDone(tokenTotals: number[]): { mean: number | null; stddev: number | null } {
  return { mean: mean(tokenTotals), stddev: sampleStddev(tokenTotals) };
}

/**
 * % of oracle savings = (floor_mean − model_mean) / (floor_mean − oracle_mean)
 *
 * "How much of the hand-written ceiling's token saving did this model's memory
 * capture?" Degenerate cases return null plus a reason, never NaN/Infinity:
 *   - no floor mean / no oracle mean / no model mean → "n/a (…)"
 *   - floor_mean === oracle_mean → the denominator is 0: "n/a (floor==oracle)"
 *   - oracle_mean > floor_mean → the ceiling costs MORE than the floor, so the
 *     denominator is negative and the ratio would silently flip sign. That is
 *     a broken oracle (or too few runs), not a measurement: "n/a (oracle above
 *     floor)" says so instead of publishing an inverted percentage.
 * Values outside 0-100% are REPORTED as-is (a model can be worse than the
 * floor → negative, or better than the oracle → >100%) — clamping would hide a
 * real result.
 */
export function oracleSavingsPct(
  modelMean: number | null,
  floorMean: number | null,
  oracleMean: number | null,
): { pct: number | null; note: string | null } {
  if (floorMean === null) return { pct: null, note: 'n/a (no floor tokens)' };
  if (oracleMean === null) return { pct: null, note: 'n/a (no oracle tokens)' };
  if (floorMean === oracleMean) return { pct: null, note: 'n/a (floor==oracle)' };
  if (floorMean < oracleMean) return { pct: null, note: 'n/a (oracle above floor)' };
  if (modelMean === null) return { pct: null, note: 'n/a (no successful runs)' };
  const pct = finite(((floorMean - modelMean) / (floorMean - oracleMean)) * 100);
  if (pct === null) return { pct: null, note: 'n/a' };
  return { pct, note: null };
}

/**
 * real cost — two independent sides, never added together into one headline:
 *   exec-side = Σ reported `cost_usd` over the cell's rows (+ a count of rows
 *               whose cost was NOT reported, so the sum reads as a lower bound)
 *   obs-side  = Σ reported `obs_cost_usd` over the observe records for that
 *               observer model (per RUN, shared by every executor lane).
 */
export function sumReported(values: (number | null)[]): { usd: number; unreported: number } {
  let usd = 0;
  let unreported = 0;
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) usd += value;
    else unreported += 1;
  }
  return { usd, unreported };
}

/**
 * search burden = mean `mem_search_calls` over the cell's COMPLETED runs
 * (rows without an `error`): an aborted run never had the chance to search, so
 * counting its 0 would fake a low burden.
 */
export function searchBurden(calls: number[]): number | null {
  return mean(calls);
}

/**
 * drift rate = drifted / judged, over rows with `judged === true` ONLY.
 * A row the judge never decided (transport failure, unparseable verdict) is
 * UNJUDGED — surfaced as its own count, never counted as "no drift".
 */
export function driftRate(drifted: number, judged: number): number | null {
  if (judged <= 0) return null;
  return drifted / judged;
}

/** Numeric guard: anything non-finite becomes null so no NaN/Infinity is ever rendered. */
function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Run ids (they become filesystem paths)
// ---------------------------------------------------------------------------

/**
 * A run id is joined onto runs/ and published-runs/, so it must be a single
 * path segment. Anything else — a slash, a traversal, an absolute path — could
 * make `publish` write (and, on a failed self-check, DELETE) an arbitrary
 * directory. `.` and `..` match the character class, so they are rejected by
 * name.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidRunId(runId: string): boolean {
  return RUN_ID_PATTERN.test(runId) && runId !== '.' && runId !== '..';
}

/** Throw-style guard for the CLIs; returns the message to print, or undefined. */
export function runIdError(runId: string): string | undefined {
  return isValidRunId(runId)
    ? undefined
    : `invalid --run-id "${runId}": a run id must match ${RUN_ID_PATTERN} and cannot be "." or ".." ` +
        '(it names a directory under runs/ and published-runs/)';
}

// ---------------------------------------------------------------------------
// Defensive loading
// ---------------------------------------------------------------------------

/** A results.jsonl line that could not be used, with its 1-based line number. */
export interface SkippedRow {
  line: number;
  reason: string;
}

/** A results.jsonl row after validation + numeric normalization. */
export interface NormalizedRow {
  run_id: string;
  item_id: string;
  variant: string;
  observer_model: string | null;
  executor: string;
  run_index: number;
  success: boolean;
  tokens_total: number | null;
  cost_usd: number | null;
  duration_s: number | null;
  mem_search_calls: number | null;
  drift_flag: boolean | null;
  judged: boolean;
  accommodation: string | null;
  error: string | null;
}

function normalizeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Validate + normalize one parsed results.jsonl row. Returns a reason string
 * when the row cannot be used: the identity fields (item/variant/executor/
 * run_index/success) must be present and well-typed, because every metric is
 * grouped by them. Everything else degrades to null and is surfaced as such.
 */
export function normalizeRow(value: unknown): NormalizedRow | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'not a JSON object';
  }
  const row = value as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof row.item_id !== 'string' || row.item_id === '') missing.push('item_id');
  if (typeof row.variant !== 'string' || row.variant === '') missing.push('variant');
  if (typeof row.executor !== 'string' || row.executor === '') missing.push('executor');
  if (typeof row.run_index !== 'number' || !Number.isFinite(row.run_index)) missing.push('run_index');
  if (typeof row.success !== 'boolean') missing.push('success');
  if (missing.length > 0) return `missing/invalid field(s): ${missing.join(', ')}`;

  const tokensTotal = normalizeNumber(row.tokens_total);
  const tokensIn = normalizeNumber(row.tokens_in);
  const tokensOut = normalizeNumber(row.tokens_out);
  return {
    run_id: typeof row.run_id === 'string' ? row.run_id : '',
    item_id: row.item_id as string,
    variant: row.variant as string,
    observer_model:
      typeof row.observer_model === 'string'
        ? row.observer_model
        : (row.variant as string).startsWith('model:')
          ? (row.variant as string).slice('model:'.length)
          : null,
    executor: row.executor as string,
    run_index: row.run_index as number,
    success: row.success as boolean,
    // Prefer the reported total; fall back to the reported halves only when at
    // least one of them exists (never a 70/30 split — guard 2).
    tokens_total:
      tokensTotal ?? (tokensIn !== null || tokensOut !== null ? (tokensIn ?? 0) + (tokensOut ?? 0) : null),
    cost_usd: normalizeNumber(row.cost_usd),
    duration_s: normalizeNumber(row.duration_s),
    mem_search_calls: normalizeNumber(row.mem_search_calls),
    drift_flag: typeof row.drift_flag === 'boolean' ? row.drift_flag : null,
    judged: row.judged === true,
    accommodation: typeof row.accommodation === 'string' && row.accommodation !== '' ? row.accommodation : null,
    error: typeof row.error === 'string' && row.error !== '' ? row.error : null,
  };
}

export interface LoadedRows {
  rows: NormalizedRow[];
  skipped: SkippedRow[];
}

/**
 * Read results.jsonl with per-line tolerance: blank lines are ignored, and any
 * line that fails to parse or fails validation is SKIPPED with a warning and
 * recorded (with its line number) in the summary — never silently dropped.
 * Port of the tolerant reader in summarize.py:14-39.
 */
export async function readResultRows(
  path: string,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<LoadedRows> {
  const rows: NormalizedRow[] = [];
  const skipped: SkippedRow[] = [];
  if (!existsSync(path)) {
    warn(`warning: results.jsonl not found: ${path}`);
    return { rows, skipped };
  }
  const text = await Bun.file(path).text();
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const lineNumber = index + 1;
    const stripped = lines[index].trim();
    if (!stripped) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripped);
    } catch (error: unknown) {
      const reason = `unparseable JSON: ${error instanceof Error ? error.message : String(error)}`;
      warn(`warning: skipping results.jsonl line ${lineNumber}: ${reason}`);
      skipped.push({ line: lineNumber, reason });
      continue;
    }
    const normalized = normalizeRow(parsed);
    if (typeof normalized === 'string') {
      warn(`warning: skipping results.jsonl line ${lineNumber}: ${normalized}`);
      skipped.push({ line: lineNumber, reason: normalized });
      continue;
    }
    rows.push(normalized);
  }
  return { rows, skipped };
}

/** The manifest fields the scoreboard reads (all optional — a run may predate any of them). */
export interface RunManifest {
  run_id?: string;
  created_at?: string;
  mock?: boolean;
  spec?: RunSpec;
  spec_path?: string;
  corpus_dir?: string;
  runs_dir?: string;
  items?: { id: string; content_hash: string | null }[];
  variants?: string[];
  shuffled_source_map?: Record<string, { donor_item: string; donor_source: string }>;
  approve_cost_usd?: number | null;
}

export async function readManifest(runDir: string): Promise<RunManifest | null> {
  const path = join(runDir, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await Bun.file(path).text()) as RunManifest;
  } catch {
    return null;
  }
}

/**
 * The manifest is the ONLY record of whether a run's numbers are real or
 * fabricated by `--mock`. Missing or unparseable, the safe default is not
 * "live" — a mock run whose manifest was lost would otherwise render as a
 * result, with no MOCK banner and (since mock costs are non-zero) no
 * zero-cost refusal to catch it either.
 *
 * So score / publish / cost REFUSE a run dir without a readable manifest,
 * matching readMeasuredRates' conservative default (runs without a manifest
 * never contribute rates).
 */
export async function requireManifest(runDir: string, runId: string): Promise<RunManifest> {
  const path = join(runDir, 'manifest.json');
  const manifest = await readManifest(runDir);
  if (manifest === null) {
    throw new ScoreboardError(
      `run "${runId}" has no readable manifest.json (${path}) — provenance unknown, so this run's ` +
        'mock/live status cannot be determined. Refusing to score, publish or cost it. ' +
        '(manifest.json is written by `membench run`/`observe`; restore it from the run tree.)',
    );
  }
  return manifest;
}

/**
 * Judge-side costs for a run, as raw reported values (`null` = the provider
 * reported none). One reader shared by the scoreboard, the cost table and the
 * runner's measured-rate harvest — each folds them into its own accumulator.
 */
export async function readJudgeCosts(runDir: string): Promise<(number | null)[]> {
  const path = join(runDir, 'judge.jsonl');
  if (!existsSync(path)) return [];
  const values: (number | null)[] = [];
  const text = await Bun.file(path).text();
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (!stripped) continue;
    try {
      const row = JSON.parse(stripped) as { cost_usd?: unknown };
      values.push(normalizeNumber(row.cost_usd));
    } catch {
      // An unreadable judge line contributes no cost — and no guessed cost.
    }
  }
  return values;
}

/** Read every runs/<id>/obs/<item>/<model>.json, skipping unreadable artifacts. */
export async function readObserveRecords(
  runDir: string,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<{ records: ObserveRecord[]; skipped: string[] }> {
  const records: ObserveRecord[] = [];
  const skipped: string[] = [];
  const obsDir = join(runDir, 'obs');
  if (!existsSync(obsDir)) return { records, skipped };
  for (const itemEntry of readdirSync(obsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!itemEntry.isDirectory()) continue;
    const itemDir = join(obsDir, itemEntry.name);
    for (const file of readdirSync(itemDir).sort()) {
      if (!file.endsWith('.json')) continue;
      const path = join(itemDir, file);
      try {
        const record = JSON.parse(await Bun.file(path).text()) as ObserveRecord;
        if (typeof record !== 'object' || record === null) throw new Error('not an object');
        // Pre-Phase-6.1 artifacts carried no self-identifying fields; fall back
        // to the on-disk location rather than dropping the record.
        if (typeof record.item_id !== 'string') record.item_id = itemEntry.name;
        if (typeof record.model !== 'string') record.model = file.replace(/\.json$/, '');
        records.push(record);
      } catch (error: unknown) {
        const reason = `${itemEntry.name}/${file}: ${error instanceof Error ? error.message : String(error)}`;
        warn(`warning: skipping unreadable observe record ${reason}`);
        skipped.push(reason);
      }
    }
  }
  return { records, skipped };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export interface TokenStats {
  /** Successful rows in the cell. */
  successful_runs: number;
  /** Successful rows whose provider reported usage (the mean's sample size). */
  counted: number;
  /** Successful rows with NO reported usage — excluded from the mean, surfaced. */
  missing_usage: number;
  mean: number | null;
  stddev: number | null;
  /**
   * Corpus items the mean actually pools. Two variants whose sets differ are
   * not comparing like with like (one may have failed the expensive item) —
   * the renderer footnotes that instead of pretending the means align.
   */
  item_ids: string[];
}

export interface VariantStats {
  variant: string;
  observer_model: string | null;
  /** none / oracle / shuffled are reference rows, not competitors. */
  is_control: boolean;
  runs: number;
  errored: number;
  successes: number;
  success_rate: number | null;
  tokens: TokenStats;
  oracle_savings_pct: number | null;
  oracle_savings_note: string | null;
  exec_cost_usd: number;
  exec_cost_unreported_rows: number;
  /** Observe-side spend for this observer model across the whole run (null for controls). */
  obs_cost_usd: number | null;
  obs_cost_unreported: number;
  search_burden_mean: number | null;
  /** Rows the burden mean was computed over (completed runs). */
  search_burden_runs: number;
  drift_judged: number;
  drift_flagged: number;
  drift_rate: number | null;
  drift_unjudged: number;
  /** Rows carrying an accommodation (surfaced, never silently averaged in). */
  accommodation_rows: number;
  accommodations: string[];
}

export interface ExecutorSection {
  executor: string;
  runs: number;
  models: VariantStats[];
  controls: VariantStats[];
  floor_tokens_mean: number | null;
  oracle_tokens_mean: number | null;
}

export interface PerItemStat {
  executor: string;
  item_id: string;
  variant: string;
  runs: number;
  successes: number;
  tokens_mean: number | null;
}

export interface CrossExecutorDelta {
  variant: string;
  a: string;
  b: string;
  success_rate_a: number | null;
  success_rate_b: number | null;
  success_rate_delta: number | null;
  tokens_mean_a: number | null;
  tokens_mean_b: number | null;
  tokens_mean_delta: number | null;
}

export interface Diagnostics {
  /** Observation counts live HERE and nowhere else (plan line 328). */
  observations: {
    item_id: string;
    model: string;
    observation_count: number;
    parse_notes: number;
    usage_notes: number;
    obs_tokens_in: number | null;
    obs_tokens_out: number | null;
    obs_cost_usd: number | null;
    accommodation: string | null;
    error: string | null;
  }[];
  parse_note_samples: string[];
  accommodations: { model: string; accommodation: string; items: string[] }[];
  per_item: PerItemStat[];
  cross_executor: CrossExecutorDelta[];
  skipped_result_rows: SkippedRow[];
  skipped_observe_records: string[];
  /** Rows with an `error` — grouped by message, so failure modes are visible. */
  error_rows: { executor: string; variant: string; item_id: string; error: string }[];
}

export interface RunSummary {
  summary_version: number;
  run_id: string;
  generated_at: string;
  mock: boolean;
  created_at: string | null;
  spec: RunSpec | null;
  corpus_items: { id: string; content_hash: string | null }[];
  totals: {
    rows: number;
    successes: number;
    errored: number;
    exec_cost_usd: number;
    exec_cost_unreported_rows: number;
    obs_cost_usd: number;
    obs_cost_unreported: number;
    judge_cost_usd: number;
    judge_cost_unreported: number;
  };
  executors: ExecutorSection[];
  diagnostics: Diagnostics;
}

/** Judge-side spend for the run, summed from the shared reader. */
async function readJudgeCost(runDir: string): Promise<{ usd: number; unreported: number }> {
  return sumReported(await readJudgeCosts(runDir));
}

const CONTROL_ORDER = ['none', 'oracle', 'shuffled'];

function isControl(variant: string): boolean {
  return CONTROL_ORDER.includes(variant);
}

/** Model variants sorted by id, then the controls in floor → ceiling → shuffled order. */
function sortVariants(variants: string[]): string[] {
  const models = variants.filter((variant) => !isControl(variant)).sort();
  const controls = CONTROL_ORDER.filter((control) => variants.includes(control));
  const others = variants.filter((variant) => !models.includes(variant) && !controls.includes(variant));
  return [...models, ...controls, ...others.sort()];
}

interface ObsAggregate {
  usd: number | null;
  unreported: number;
  accommodations: Set<string>;
}

function aggregateObsByModel(records: ObserveRecord[]): Map<string, ObsAggregate> {
  const byModel = new Map<string, ObsAggregate>();
  for (const record of records) {
    const model = record.model;
    const entry = byModel.get(model) ?? { usd: null, unreported: 0, accommodations: new Set<string>() };
    const cost = normalizeNumber(record.obs_cost_usd);
    if (cost !== null) entry.usd = (entry.usd ?? 0) + cost;
    else entry.unreported += 1;
    if (typeof record.accommodation === 'string' && record.accommodation !== '') {
      entry.accommodations.add(record.accommodation);
    }
    byModel.set(model, entry);
  }
  return byModel;
}

function statsForCell(
  variant: string,
  rows: NormalizedRow[],
  obs: ObsAggregate | undefined,
): VariantStats {
  const successful = rows.filter((row) => row.success);
  const tokenRows = successful.filter((row) => row.tokens_total !== null);
  const tokenSamples = tokenRows.map((row) => row.tokens_total as number);
  const { mean: tokensMean, stddev } = tokensToDone(tokenSamples);
  const exec = sumReported(rows.map((row) => row.cost_usd));
  const completed = rows.filter((row) => row.error === null);
  const burdenSamples = completed
    .map((row) => row.mem_search_calls)
    .filter((value): value is number => value !== null);
  const judgedRows = rows.filter((row) => row.judged);
  const drifted = judgedRows.filter((row) => row.drift_flag === true).length;
  const accommodationRows = rows.filter((row) => row.accommodation !== null);
  const accommodations = new Set<string>(
    accommodationRows.map((row) => row.accommodation).filter((value): value is string => value !== null),
  );
  for (const value of obs?.accommodations ?? []) accommodations.add(value);

  return {
    variant,
    observer_model: rows[0]?.observer_model ?? null,
    is_control: isControl(variant),
    runs: rows.length,
    errored: rows.filter((row) => row.error !== null).length,
    successes: successful.length,
    success_rate: successRate(successful.length, rows.length),
    tokens: {
      successful_runs: successful.length,
      counted: tokenSamples.length,
      missing_usage: successful.length - tokenSamples.length,
      mean: tokensMean,
      stddev,
      item_ids: [...new Set(tokenRows.map((row) => row.item_id))].sort(),
    },
    // Filled in by the caller once the lane's floor + oracle means are known.
    oracle_savings_pct: null,
    oracle_savings_note: null,
    exec_cost_usd: exec.usd,
    exec_cost_unreported_rows: exec.unreported,
    obs_cost_usd: obs ? obs.usd : null,
    obs_cost_unreported: obs?.unreported ?? 0,
    search_burden_mean: searchBurden(burdenSamples),
    search_burden_runs: burdenSamples.length,
    drift_judged: judgedRows.length,
    drift_flagged: drifted,
    drift_rate: driftRate(drifted, judgedRows.length),
    drift_unjudged: rows.length - judgedRows.length,
    accommodation_rows: accommodationRows.length,
    accommodations: [...accommodations].sort(),
  };
}

export interface BuildSummaryInput {
  runId: string;
  rows: NormalizedRow[];
  skippedRows: SkippedRow[];
  observeRecords: ObserveRecord[];
  skippedObserveRecords: string[];
  manifest: RunManifest | null;
  judgeCost: { usd: number; unreported: number };
  now?: Date;
}

/** Build the full summary. Pure over its inputs — the renderers only format it. */
export function buildSummary(input: BuildSummaryInput): RunSummary {
  const { runId, rows, skippedRows, observeRecords, skippedObserveRecords, manifest, judgeCost } = input;
  const obsByModel = aggregateObsByModel(observeRecords);

  const lanes = [...new Set(rows.map((row) => row.executor))].sort();
  const executors: ExecutorSection[] = [];
  for (const lane of lanes) {
    // GUARD 11: every row feeding this section is filtered to ONE executor
    // here, and nothing below ever re-merges lanes.
    const laneRows = rows.filter((row) => row.executor === lane);
    const variants = sortVariants([...new Set(laneRows.map((row) => row.variant))]);
    const stats = variants.map((variant) => {
      const cellRows = laneRows.filter((row) => row.variant === variant);
      const model = cellRows[0]?.observer_model ?? null;
      return statsForCell(variant, cellRows, model ? obsByModel.get(model) : undefined);
    });
    const floorMean = stats.find((entry) => entry.variant === 'none')?.tokens.mean ?? null;
    const oracleMean = stats.find((entry) => entry.variant === 'oracle')?.tokens.mean ?? null;
    for (const entry of stats) {
      if (entry.variant === 'none') {
        entry.oracle_savings_note = 'floor';
        continue;
      }
      const savings = oracleSavingsPct(entry.tokens.mean, floorMean, oracleMean);
      entry.oracle_savings_pct = savings.pct;
      entry.oracle_savings_note = savings.note;
    }
    executors.push({
      executor: lane,
      runs: laneRows.length,
      models: stats.filter((entry) => !entry.is_control),
      controls: stats.filter((entry) => entry.is_control),
      floor_tokens_mean: floorMean,
      oracle_tokens_mean: oracleMean,
    });
  }

  // --- diagnostics ---------------------------------------------------------
  const perItem: PerItemStat[] = [];
  for (const lane of lanes) {
    const laneRows = rows.filter((row) => row.executor === lane);
    for (const itemId of [...new Set(laneRows.map((row) => row.item_id))].sort()) {
      const itemRows = laneRows.filter((row) => row.item_id === itemId);
      for (const variant of sortVariants([...new Set(itemRows.map((row) => row.variant))])) {
        const cellRows = itemRows.filter((row) => row.variant === variant);
        const tokenSamples = cellRows
          .filter((row) => row.success)
          .map((row) => row.tokens_total)
          .filter((value): value is number => value !== null);
        perItem.push({
          executor: lane,
          item_id: itemId,
          variant,
          runs: cellRows.length,
          successes: cellRows.filter((row) => row.success).length,
          tokens_mean: mean(tokenSamples),
        });
      }
    }
  }

  // Cross-executor deltas: the ONLY place two lanes meet in the scoreboard,
  // and it lives under Diagnostics (guard 11).
  const crossExecutor: CrossExecutorDelta[] = [];
  if (lanes.length >= 2) {
    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const laneA = lanes[i];
        const laneB = lanes[j];
        const sectionA = executors.find((section) => section.executor === laneA);
        const sectionB = executors.find((section) => section.executor === laneB);
        const allVariants = sortVariants([
          ...new Set([
            ...(sectionA ? [...sectionA.models, ...sectionA.controls] : []).map((entry) => entry.variant),
            ...(sectionB ? [...sectionB.models, ...sectionB.controls] : []).map((entry) => entry.variant),
          ]),
        ]);
        for (const variant of allVariants) {
          const pick = (section: ExecutorSection | undefined) =>
            section ? [...section.models, ...section.controls].find((entry) => entry.variant === variant) : undefined;
          const a = pick(sectionA);
          const b = pick(sectionB);
          const successA = a?.success_rate ?? null;
          const successB = b?.success_rate ?? null;
          const tokensA = a?.tokens.mean ?? null;
          const tokensB = b?.tokens.mean ?? null;
          crossExecutor.push({
            variant,
            a: laneA,
            b: laneB,
            success_rate_a: successA,
            success_rate_b: successB,
            success_rate_delta: delta(successA, successB),
            tokens_mean_a: tokensA,
            tokens_mean_b: tokensB,
            tokens_mean_delta: delta(tokensA, tokensB),
          });
        }
      }
    }
  }

  const accommodationIndex = new Map<string, { model: string; accommodation: string; items: Set<string> }>();
  for (const record of observeRecords) {
    if (typeof record.accommodation !== 'string' || record.accommodation === '') continue;
    const key = `${record.model} ${record.accommodation}`;
    const entry = accommodationIndex.get(key) ?? {
      model: record.model,
      accommodation: record.accommodation,
      items: new Set<string>(),
    };
    entry.items.add(record.item_id);
    accommodationIndex.set(key, entry);
  }

  const parseNoteSamples: string[] = [];
  for (const record of observeRecords) {
    for (const note of Array.isArray(record.parse_notes) ? record.parse_notes : []) {
      if (parseNoteSamples.length >= 20) break;
      parseNoteSamples.push(`${record.item_id} × ${record.model}: ${note}`);
    }
  }

  const execTotals = sumReported(rows.map((row) => row.cost_usd));
  const obsTotals = sumReported(observeRecords.map((record) => normalizeNumber(record.obs_cost_usd)));

  return {
    summary_version: SUMMARY_VERSION,
    run_id: runId,
    generated_at: (input.now ?? new Date()).toISOString(),
    mock: manifest?.mock === true,
    created_at: manifest?.created_at ?? null,
    spec: manifest?.spec ?? null,
    corpus_items: manifest?.items ?? [],
    totals: {
      rows: rows.length,
      successes: rows.filter((row) => row.success).length,
      errored: rows.filter((row) => row.error !== null).length,
      exec_cost_usd: execTotals.usd,
      exec_cost_unreported_rows: execTotals.unreported,
      obs_cost_usd: obsTotals.usd,
      obs_cost_unreported: obsTotals.unreported,
      judge_cost_usd: judgeCost.usd,
      judge_cost_unreported: judgeCost.unreported,
    },
    executors,
    diagnostics: {
      observations: observeRecords.map((record) => ({
        item_id: record.item_id,
        model: record.model,
        observation_count: Array.isArray(record.observations) ? record.observations.length : 0,
        parse_notes: Array.isArray(record.parse_notes) ? record.parse_notes.length : 0,
        usage_notes: Array.isArray(record.usage_notes) ? record.usage_notes.length : 0,
        obs_tokens_in: normalizeNumber(record.obs_tokens_in),
        obs_tokens_out: normalizeNumber(record.obs_tokens_out),
        obs_cost_usd: normalizeNumber(record.obs_cost_usd),
        accommodation: typeof record.accommodation === 'string' ? record.accommodation : null,
        error: typeof record.error === 'string' ? record.error : null,
      })),
      parse_note_samples: parseNoteSamples,
      accommodations: [...accommodationIndex.values()].map((entry) => ({
        model: entry.model,
        accommodation: entry.accommodation,
        items: [...entry.items].sort(),
      })),
      per_item: perItem,
      cross_executor: crossExecutor,
      skipped_result_rows: skippedRows,
      skipped_observe_records: skippedObserveRecords,
      error_rows: rows
        .filter((row) => row.error !== null)
        .map((row) => ({
          executor: row.executor,
          variant: row.variant,
          item_id: row.item_id,
          error: row.error as string,
        })),
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering (template: summarize.py:128-215)
// ---------------------------------------------------------------------------

/** Escape pipes so free text can never break a markdown table (summarize.py:151). */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function fmtInt(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return Math.round(value).toLocaleString('en-US');
}

function fmtPct(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(digits)}%`;
}

/** A percentage that is ALREADY in percent units (oracle savings). */
function fmtPctUnits(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `${value.toFixed(digits)}%`;
}

function fmtUsd(value: number | null, digits = 4): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return `$${value.toFixed(digits)}`;
}

function fmtMean(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

/**
 * "12,345 ± 678 (n=6)" — never NaN: an absent mean renders as n/a with why.
 * Successful runs whose usage was NOT reported are appended to the cell, so a
 * mean can never quietly stand for fewer runs than it appears to.
 */
function fmtTokens(tokens: TokenStats): string {
  if (tokens.mean === null) {
    return tokens.successful_runs === 0 ? 'n/a (0 successful runs)' : 'n/a (no reported usage)';
  }
  const spread = tokens.stddev === null ? '± n/a' : `± ${fmtInt(tokens.stddev)}`;
  const missing = tokens.missing_usage > 0 ? ` + ${tokens.missing_usage} without usage` : '';
  return `${fmtInt(tokens.mean)} ${spread} (n=${tokens.counted})${missing}`;
}

function fmtSuccess(stats: VariantStats): string {
  return `${fmtPct(stats.success_rate)} (${stats.successes}/${stats.runs})`;
}

function fmtDrift(stats: VariantStats): string {
  const base = `${fmtPct(stats.drift_rate)} (${stats.drift_flagged}/${stats.drift_judged} judged)`;
  return stats.drift_unjudged > 0 ? `${base}, ${stats.drift_unjudged} unjudged` : base;
}

function fmtExecCost(stats: VariantStats): string {
  return stats.exec_cost_unreported_rows > 0
    ? `${fmtUsd(stats.exec_cost_usd)} + ${stats.exec_cost_unreported_rows} unreported`
    : fmtUsd(stats.exec_cost_usd);
}

function fmtObsCost(stats: VariantStats): string {
  if (stats.obs_cost_usd === null) {
    // No reported observe cost. If replays happened but reported nothing, say
    // so — "—" would read as "this variant has no observe side" (the controls).
    return stats.obs_cost_unreported > 0 ? `n/a + ${stats.obs_cost_unreported} unreported` : '—';
  }
  return stats.obs_cost_unreported > 0
    ? `${fmtUsd(stats.obs_cost_usd)} + ${stats.obs_cost_unreported} unreported`
    : fmtUsd(stats.obs_cost_usd);
}

function fmtBurden(stats: VariantStats): string {
  return `${fmtMean(stats.search_burden_mean)} (n=${stats.search_burden_runs})`;
}

function variantLabel(stats: VariantStats): string {
  if (stats.variant === 'none') return '`none` — floor';
  if (stats.variant === 'oracle') return '`oracle` — ceiling';
  if (stats.variant === 'shuffled') return '`shuffled` — relevance control';
  return `\`${stats.observer_model ?? stats.variant}\``;
}

/** Per-lane footnotes: everything that must never be silently averaged in. */
function laneFootnotes(section: ExecutorSection): string[] {
  const notes: string[] = [];
  const all = [...section.models, ...section.controls];
  const floorItems = section.controls.find((entry) => entry.variant === 'none')?.tokens.item_ids ?? [];
  for (const stats of all) {
    // Pooled-items caveat: a mean over a different item mix than the floor's
    // is not directly comparable, and neither is the savings % built from it.
    if (
      stats.variant !== 'none' &&
      stats.tokens.item_ids.length > 0 &&
      floorItems.length > 0 &&
      stats.tokens.item_ids.join(' ') !== floorItems.join(' ')
    ) {
      notes.push(
        `**pooled items** — ${cell(variantLabel(stats))}: tokens-to-done pools ${cell(stats.tokens.item_ids.join(', '))} ` +
          `while the floor pools ${cell(floorItems.join(', '))}. The means (and the % of oracle savings built from ` +
          'them) cover different item mixes — read the per-item split under Diagnostics.',
      );
    }
  }
  for (const stats of all) {
    if (stats.accommodation_rows > 0 || stats.accommodations.length > 0) {
      notes.push(
        `**accommodation** — ${cell(variantLabel(stats))}: ${stats.accommodation_rows} row(s) ran with ` +
          `\`${cell(stats.accommodations.join(', ') || 'unknown')}\`. Its content competes, but its tag discipline failed.`,
      );
    }
    if (stats.tokens.missing_usage > 0) {
      notes.push(
        `**missing usage** — ${cell(variantLabel(stats))}: ${stats.tokens.missing_usage} successful run(s) reported ` +
          'no token usage and are EXCLUDED from tokens-to-done (never counted as 0).',
      );
    }
    if (stats.exec_cost_unreported_rows > 0) {
      notes.push(
        `**unreported cost** — ${cell(variantLabel(stats))}: ${stats.exec_cost_unreported_rows} row(s) reported no ` +
          'cost; the cost column is a LOWER BOUND.',
      );
    }
    if (stats.drift_unjudged > 0) {
      notes.push(
        `**unjudged** — ${cell(variantLabel(stats))}: ${stats.drift_unjudged} row(s) were never judged; they are ` +
          'excluded from the drift rate (never counted as "no drift").',
      );
    }
    if (stats.errored > 0) {
      notes.push(
        `**errors** — ${cell(variantLabel(stats))}: ${stats.errored} row(s) carry an \`error\`; they count as ` +
          'failures in the success rate. See Diagnostics.',
      );
    }
  }
  return notes;
}

function renderExecutorSection(section: ExecutorSection): string[] {
  const lines: string[] = [];
  lines.push(`## Executor lane: \`${section.executor}\``);
  lines.push('');
  lines.push(
    `Every number in this section comes from \`${section.executor}\` runs only — lanes are never compared ` +
      'in the same cell (see Diagnostics for cross-lane deltas).',
  );
  lines.push('');
  lines.push('### Observer models');
  lines.push('');
  lines.push(
    '| Observer model | runs | success rate | tokens-to-done (successful) | % of oracle savings | exec cost | obs cost (run) | search burden | drift rate |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|');
  if (section.models.length === 0) {
    lines.push('| (no observer-model variants in this lane) | | | | | | | | |');
  }
  for (const stats of section.models) {
    // The accommodation marker rides on the model name: a row that only
    // competed because its tag discipline was accommodated says so in place.
    const marker = stats.accommodations.length > 0 ? ` ⚠︎ ${cell(stats.accommodations.join(', '))}` : '';
    lines.push(
      `| ${cell(variantLabel(stats))}${marker} | ${stats.runs} | ${fmtSuccess(stats)} | ${fmtTokens(stats.tokens)} | ` +
        `${stats.oracle_savings_pct === null ? cell(stats.oracle_savings_note ?? 'n/a') : fmtPctUnits(stats.oracle_savings_pct)} | ` +
        `${fmtExecCost(stats)} | ${fmtObsCost(stats)} | ${fmtBurden(stats)} | ${fmtDrift(stats)} |`,
    );
  }
  lines.push('');
  lines.push('### Controls (reference rows)');
  lines.push('');
  lines.push('| Control | runs | success rate | tokens-to-done (successful) | exec cost | search burden | drift rate |');
  lines.push('|---|---|---|---|---|---|---|');
  if (section.controls.length === 0) {
    lines.push('| (no control variants in this lane) | | | | | | |');
  }
  for (const stats of section.controls) {
    lines.push(
      `| ${cell(variantLabel(stats))} | ${stats.runs} | ${fmtSuccess(stats)} | ${fmtTokens(stats.tokens)} | ` +
        `${fmtExecCost(stats)} | ${fmtBurden(stats)} | ${fmtDrift(stats)} |`,
    );
  }
  lines.push('');
  const notes = laneFootnotes(section);
  if (notes.length > 0) {
    lines.push('Footnotes:');
    lines.push('');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines;
}

function renderDiagnostics(summary: RunSummary): string[] {
  const lines: string[] = [];
  const diagnostics = summary.diagnostics;
  lines.push('## Diagnostics');
  lines.push('');
  lines.push(
    'Never headline numbers. Counts, parse behavior, per-item splits and cross-lane deltas live here so the ' +
      'headline stays "did the memory help?".',
  );
  lines.push('');

  lines.push('### Observation counts and observe-side usage');
  lines.push('');
  lines.push('| item | observer model | observations | parse notes | obs tokens in | obs tokens out | obs cost | accommodation | error |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  if (diagnostics.observations.length === 0) {
    lines.push('| (no observe records) | | | | | | | | |');
  }
  for (const record of diagnostics.observations) {
    lines.push(
      `| ${cell(record.item_id)} | \`${cell(record.model)}\` | ${record.observation_count} | ${record.parse_notes} | ` +
        `${fmtInt(record.obs_tokens_in)} | ${fmtInt(record.obs_tokens_out)} | ${fmtUsd(record.obs_cost_usd, 6)} | ` +
        `${record.accommodation ? cell(record.accommodation) : '—'} | ${record.error ? cell(record.error) : '—'} |`,
    );
  }
  lines.push('');

  if (diagnostics.accommodations.length > 0) {
    lines.push('### Accommodations');
    lines.push('');
    for (const entry of diagnostics.accommodations) {
      lines.push(
        `- \`${cell(entry.model)}\` → \`${cell(entry.accommodation)}\` on: ${entry.items.map(cell).join(', ')}`,
      );
    }
    lines.push('');
  }

  lines.push('### Parse notes');
  lines.push('');
  if (diagnostics.parse_note_samples.length === 0) {
    lines.push('None.');
  } else {
    for (const note of diagnostics.parse_note_samples) lines.push(`- ${cell(note)}`);
  }
  lines.push('');

  lines.push('### Per-item splits');
  lines.push('');
  lines.push('| executor | item | variant | runs | successes | mean tokens (successful) |');
  lines.push('|---|---|---|---|---|---|');
  if (diagnostics.per_item.length === 0) {
    lines.push('| (no rows) | | | | | |');
  }
  for (const entry of diagnostics.per_item) {
    lines.push(
      `| \`${cell(entry.executor)}\` | ${cell(entry.item_id)} | ${cell(entry.variant)} | ${entry.runs} | ` +
        `${entry.successes} | ${fmtInt(entry.tokens_mean)} |`,
    );
  }
  lines.push('');

  lines.push('### Cross-executor deltas');
  lines.push('');
  lines.push(
    'The only place the two lanes meet. Executors differ in tooling and pricing, so these are context, ' +
      'not a ranking. **Deltas are lane A − lane B.**',
  );
  lines.push('');
  if (diagnostics.cross_executor.length === 0) {
    lines.push('Only one executor lane in this run — no deltas.');
  } else {
    lines.push('| variant | lane A | lane B | success A | success B | Δ success | tokens A | tokens B | Δ tokens |');
    lines.push('|---|---|---|---|---|---|---|---|---|');
    for (const entry of diagnostics.cross_executor) {
      lines.push(
        `| ${cell(entry.variant)} | \`${cell(entry.a)}\` | \`${cell(entry.b)}\` | ${fmtPct(entry.success_rate_a)} | ` +
          `${fmtPct(entry.success_rate_b)} | ${entry.success_rate_delta === null ? 'n/a' : fmtPct(entry.success_rate_delta)} | ` +
          `${fmtInt(entry.tokens_mean_a)} | ${fmtInt(entry.tokens_mean_b)} | ${fmtInt(entry.tokens_mean_delta)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### Skipped / errored rows');
  lines.push('');
  lines.push(
    `- results.jsonl lines skipped as malformed: **${diagnostics.skipped_result_rows.length}**` +
      (diagnostics.skipped_result_rows.length > 0
        ? ` (${diagnostics.skipped_result_rows.map((entry) => `line ${entry.line}: ${cell(entry.reason)}`).join('; ')})`
        : ''),
  );
  lines.push(
    `- observe records skipped as unreadable: **${diagnostics.skipped_observe_records.length}**` +
      (diagnostics.skipped_observe_records.length > 0
        ? ` (${diagnostics.skipped_observe_records.map(cell).join('; ')})`
        : ''),
  );
  lines.push(`- rows carrying an \`error\`: **${diagnostics.error_rows.length}**`);
  for (const entry of diagnostics.error_rows.slice(0, 20)) {
    lines.push(`  - \`${cell(entry.executor)}\` ${cell(entry.item_id)} ${cell(entry.variant)}: ${cell(entry.error)}`);
  }
  lines.push('');
  return lines;
}

/**
 * Render the published scoreboard. Sectioned by executor (guard 11); every
 * count of what the observers WROTE is deferred to Diagnostics.
 */
export function renderScoreboard(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# MemBench scoreboard — run \`${summary.run_id}\``);
  lines.push('');
  if (summary.mock) {
    lines.push(
      '> **MOCK RUN — every token and cost number below is fabricated by the offline mocks.** ' +
        'Nothing here describes a real model. Do not publish or cite these numbers.',
    );
    lines.push('');
  }
  const spec = summary.spec;
  lines.push(`- generated: ${summary.generated_at}${summary.created_at ? ` · run started: ${summary.created_at}` : ''}`);
  lines.push(
    `- corpus items: ${summary.corpus_items.length > 0 ? summary.corpus_items.map((item) => `\`${cell(item.id)}\``).join(', ') : '(not recorded)'}`,
  );
  if (spec) {
    lines.push(`- k (runs per cell): ${spec.k} · executors: ${spec.executors.map((lane) => `\`${lane}\``).join(', ')}`);
    lines.push(`- judge model: \`${cell(spec.judge_model)}\`${spec.executor_model ? ` · openrouter-agent executor model: \`${cell(spec.executor_model)}\`` : ''}`);
  }
  lines.push(
    `- result rows: ${summary.totals.rows} (successes ${summary.totals.successes}, errored ${summary.totals.errored}` +
      `${summary.diagnostics.skipped_result_rows.length > 0 ? `, ${summary.diagnostics.skipped_result_rows.length} malformed line(s) SKIPPED — see Diagnostics` : ''})`,
  );
  lines.push(
    `- real spend, reported only: executor ${fmtUsd(summary.totals.exec_cost_usd)}` +
      `${summary.totals.exec_cost_unreported_rows > 0 ? ` + ${summary.totals.exec_cost_unreported_rows} unreported row(s)` : ''}` +
      ` · observe ${fmtUsd(summary.totals.obs_cost_usd)}` +
      `${summary.totals.obs_cost_unreported > 0 ? ` + ${summary.totals.obs_cost_unreported} unreported` : ''}` +
      ` · judge ${fmtUsd(summary.totals.judge_cost_usd)}` +
      `${summary.totals.judge_cost_unreported > 0 ? ` + ${summary.totals.judge_cost_unreported} unreported` : ''}`,
  );
  lines.push('');
  lines.push(OPENROUTER_CITATION);
  lines.push('');
  lines.push('## How to read this');
  lines.push('');
  lines.push('- **success rate** = successes / runs in the cell (errored runs count as failures). Compare against the `none` floor.');
  lines.push('- **tokens-to-done** = mean ± sample stddev (n−1) of `tokens_total`, over SUCCESSFUL runs with reported usage only.');
  lines.push('- **% of oracle savings** = (floor_mean − model_mean) / (floor_mean − oracle_mean), in percent. `n/a` where the formula is undefined.');
  lines.push('  A negative % means the model did WORSE than the no-memory floor; above 100% means it beat the hand-written oracle. Both are reported as measured, never clamped.');
  lines.push('- **exec cost** = Σ reported `cost_usd` for the cell (a lower bound whenever rows reported no cost). **obs cost** = the observer model\'s write-side spend for the WHOLE run, shared across lanes — do not add the lanes together.');
  lines.push('- **search burden** = mean `mem_search_calls` over completed runs.');
  lines.push('- **drift rate** = drifted / judged, over judged rows only; unjudged rows are shown separately.');
  lines.push('');

  if (summary.executors.length === 0) {
    lines.push('_No usable result rows in this run._');
    lines.push('');
  }
  for (const section of summary.executors) {
    lines.push(...renderExecutorSection(section));
  }
  lines.push(...renderDiagnostics(summary));
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Run-vs-run diff (template: summarize.py:157-215)
// ---------------------------------------------------------------------------

function findStats(summary: RunSummary, executor: string, variant: string): VariantStats | undefined {
  const section = summary.executors.find((entry) => entry.executor === executor);
  if (!section) return undefined;
  return [...section.models, ...section.controls].find((entry) => entry.variant === variant);
}

function delta(current: number | null, other: number | null): number | null {
  if (current === null || other === null) return null;
  return finite(current - other);
}

function fmtDeltaPct(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${(value * 100).toFixed(1)}pp`;
}

function fmtDeltaInt(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${fmtInt(value)}`;
}

function fmtDeltaMean(value: number | null): string {
  if (value === null) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`;
}

/**
 * Render metric deltas per (executor, model): `current` against `other`.
 * One table per executor lane — a diff row never spans lanes (guard 11).
 */
export function renderDiff(current: RunSummary, other: RunSummary): string {
  const lines: string[] = [];
  lines.push(`# Diff — run \`${current.run_id}\` vs \`${other.run_id}\``);
  lines.push('');
  if (current.mock || other.mock) {
    lines.push(
      `> **MOCK DATA INVOLVED** (${[current.mock ? current.run_id : null, other.mock ? other.run_id : null]
        .filter(Boolean)
        .join(', ')}) — these deltas are between fabricated numbers.`,
    );
    lines.push('');
  }
  lines.push(
    `- \`${current.run_id}\`: ${current.totals.rows} row(s), ${current.totals.successes} success(es), ` +
      `executor spend ${fmtUsd(current.totals.exec_cost_usd)}`,
  );
  lines.push(
    `- \`${other.run_id}\`: ${other.totals.rows} row(s), ${other.totals.successes} success(es), ` +
      `executor spend ${fmtUsd(other.totals.exec_cost_usd)}`,
  );
  lines.push('');
  lines.push('Deltas are `current − other`. `absent` means the cell exists in only one of the two runs.');
  lines.push('');

  const lanes = [
    ...new Set([
      ...current.executors.map((section) => section.executor),
      ...other.executors.map((section) => section.executor),
    ]),
  ].sort();

  const variantsOf = (summary: RunSummary, lane: string): string[] => {
    const section = summary.executors.find((entry) => entry.executor === lane);
    return section ? [...section.models, ...section.controls].map((entry) => entry.variant) : [];
  };

  for (const lane of lanes) {
    lines.push(`## Executor lane: \`${lane}\``);
    lines.push('');
    const variants = sortVariants([
      ...new Set([...variantsOf(current, lane), ...variantsOf(other, lane)]),
    ]);
    lines.push(
      '| variant | success (other → current) | Δ | tokens-to-done (other → current) | Δ | drift (other → current) | search burden Δ |',
    );
    lines.push('|---|---|---|---|---|---|---|');
    if (variants.length === 0) {
      lines.push('| (lane absent from both runs) | | | | | | |');
    }
    for (const variant of variants) {
      const a = findStats(current, lane, variant);
      const b = findStats(other, lane, variant);
      const successCell = `${b ? fmtPct(b.success_rate) : 'absent'} → ${a ? fmtPct(a.success_rate) : 'absent'}`;
      const tokensCell = `${b ? fmtInt(b.tokens.mean) : 'absent'} → ${a ? fmtInt(a.tokens.mean) : 'absent'}`;
      const driftCell = `${b ? fmtPct(b.drift_rate) : 'absent'} → ${a ? fmtPct(a.drift_rate) : 'absent'}`;
      lines.push(
        `| ${cell(variant)} | ${successCell} | ${fmtDeltaPct(delta(a?.success_rate ?? null, b?.success_rate ?? null))} | ` +
          `${tokensCell} | ${fmtDeltaInt(delta(a?.tokens.mean ?? null, b?.tokens.mean ?? null))} | ${driftCell} | ` +
          `${fmtDeltaMean(delta(a?.search_burden_mean ?? null, b?.search_burden_mean ?? null))} |`,
      );
    }
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Driver + CLI
// ---------------------------------------------------------------------------

export interface ScoreRunOptions {
  runDir: string;
  runId: string;
  warn?: (message: string) => void;
  now?: Date;
}

/** Load one run directory and build its summary (no files written). */
export async function summarizeRun(options: ScoreRunOptions): Promise<RunSummary> {
  const { runDir, runId, warn } = options;
  if (!existsSync(runDir)) {
    throw new ScoreboardError(`run directory not found: ${runDir}`);
  }
  // Provenance first: a run whose mock/live status is unknown is never scored.
  const manifest = await requireManifest(runDir, runId);
  const { rows, skipped } = await readResultRows(join(runDir, 'results.jsonl'), warn);
  const { records, skipped: skippedObserve } = await readObserveRecords(runDir, warn);
  const judgeCost = await readJudgeCost(runDir);
  return buildSummary({
    runId,
    rows,
    skippedRows: skipped,
    observeRecords: records,
    skippedObserveRecords: skippedObserve,
    manifest,
    judgeCost,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** Build the summary AND write summary.json + scoreboard.md into the run dir. */
export async function scoreRun(options: ScoreRunOptions): Promise<{ summary: RunSummary; markdown: string }> {
  const summary = await summarizeRun(options);
  const markdown = renderScoreboard(summary);
  mkdirSync(options.runDir, { recursive: true });
  await Bun.write(join(options.runDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  await Bun.write(join(options.runDir, 'scoreboard.md'), markdown);
  return { summary, markdown };
}

export const SCORE_HELP = `Usage: membench score --run-id <id> [options]

Reads runs/<run-id>/{results.jsonl,obs/,judge.jsonl,manifest.json} and writes
runs/<run-id>/summary.json + runs/<run-id>/scoreboard.md.

Required:
  --run-id <id>          the run to score

Options:
  --runs-dir <path>      default: MEMBENCH_RUNS_DIR or ./runs
  --diff <other-run-id>  also render metric deltas vs another run into
                         runs/<run-id>/diff-vs-<other>.md
  --print                print the scoreboard markdown to stdout
  -h, --help             show this help
`;

interface ScoreFlags {
  runId?: string;
  runsDir?: string;
  diff?: string;
  print: boolean;
  help: boolean;
}

export function parseScoreFlags(args: string[]): ScoreFlags {
  const flags: ScoreFlags = { print: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
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
    if (name === '--print') {
      flags.print = true;
      continue;
    }
    if (name !== '--run-id' && name !== '--runs-dir' && name !== '--diff') {
      throw new ScoreboardError(`unknown option: ${arg}`);
    }
    const value = inlineValue ?? args[++i];
    if (value === undefined) throw new ScoreboardError(`${name} requires a value`);
    if (name === '--run-id') flags.runId = value;
    else if (name === '--runs-dir') flags.runsDir = value;
    else flags.diff = value;
  }
  return flags;
}

/** `membench score`. Returns a process exit code; never throws for user errors. */
export async function scoreMain(
  args: string[],
  overrides: { log?: (message: string) => void } = {},
): Promise<number> {
  const log = overrides.log ?? ((message: string) => console.log(message));
  let flags: ScoreFlags;
  try {
    flags = parseScoreFlags(args);
  } catch (error: unknown) {
    console.error(`membench score: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(SCORE_HELP);
    return 1;
  }
  if (flags.help) {
    log(SCORE_HELP);
    return 0;
  }
  if (!flags.runId) {
    console.error('membench score: --run-id is required\n');
    console.error(SCORE_HELP);
    return 1;
  }
  for (const runId of [flags.runId, ...(flags.diff ? [flags.diff] : [])]) {
    const problem = runIdError(runId);
    if (problem) {
      console.error(`membench score: ${problem}`);
      return 1;
    }
  }

  const config = loadConfig({ ...(flags.runsDir ? { runsDir: flags.runsDir } : {}) });
  const runsDir = resolve(config.runsDir);
  const runDir = join(runsDir, flags.runId);

  try {
    const { summary, markdown } = await scoreRun({ runDir, runId: flags.runId });
    log(`wrote ${join(runDir, 'summary.json')}`);
    log(`wrote ${join(runDir, 'scoreboard.md')}`);
    if (summary.diagnostics.skipped_result_rows.length > 0) {
      log(`!! ${summary.diagnostics.skipped_result_rows.length} malformed results.jsonl line(s) were skipped (see Diagnostics)`);
    }
    if (flags.diff) {
      const otherDir = join(runsDir, flags.diff);
      const other = await summarizeRun({ runDir: otherDir, runId: flags.diff });
      const diffMarkdown = renderDiff(summary, other);
      const diffPath = join(runDir, `diff-vs-${flags.diff}.md`);
      await Bun.write(diffPath, diffMarkdown);
      log(`wrote ${diffPath}`);
      if (flags.print) log(diffMarkdown);
    }
    if (flags.print) log(markdown);
    return 0;
  } catch (error: unknown) {
    console.error(`membench score: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
