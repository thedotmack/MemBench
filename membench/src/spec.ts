/**
 * TOML run-spec loader (Bun's native TOML parser) + strict validation.
 *
 * A run spec (committed under run-specs/) declares the reviewable parameters
 * of a run — ORSB governance convention: specs are reviewed in the repo, raw
 * run artifacts are gitignored, redacted result bundles go to published-runs/.
 *
 * Secrets and machine-local paths (OPENROUTER_API_KEY, CLAUDE_MEM_ROOT,
 * MEMBENCH_RUNS_DIR) are env-only and MUST NOT appear in a spec — unknown
 * keys are rejected, so putting them here fails loudly.
 */

import type { ExecutorName } from './types.js';

export class SpecError extends Error {}

/** The reviewable parameters of a benchmark run. Flat table, snake_case keys. */
export interface RunSpec {
  /** Frozen corpus item ids to run. */
  corpus_items: string[];
  /** Observer models for `model:<id>` variants (may be empty for a controls-only run). */
  observer_models: string[];
  /** Executor lanes to run; subset of ["claude-cli", "openrouter-agent"]. */
  executors: ExecutorName[];
  /** Repetitions per (item, variant, executor) cell. */
  k: number;
  /** Timeout for one observe-replay conversation, in seconds. */
  observe_timeout_s: number;
  /** Wall-clock timeout for one executor fork-run, in seconds. */
  execute_timeout_s: number;
  /** Judge model id (used only where check.sh cannot decide mechanically). */
  judge_model: string;
  /** Ceiling for the whole run, USD; the runner refuses/halts past this. */
  max_cost_usd: number;
  /** Executor stop condition: max agent steps per fork-run. */
  max_steps: number;
  /** Executor stop condition: max spend per fork-run, USD. */
  max_cost_per_run_usd: number;

  // --- Optional keys (Phase 6 orchestration) -------------------------------
  // Optional so every spec written against the Phase 1 schema still loads.
  /**
   * Model the `openrouter-agent` executor lane runs (plan Phase 5.2: "model
   * from the run spec"). Required — and checked by the Phase 6 runner — only
   * when that lane is selected for a live run.
   */
  executor_model?: string;
  /**
   * How many forks may be live at once. Each fork spawns its own claude-mem
   * worker, so this is a machine-load knob; it lives in the spec because it
   * is part of what a published run declares. Default 2 (Phase 6).
   */
  fork_concurrency?: number;
  /** How many (item, observer model) observe replays run at once. Default 4. */
  observe_concurrency?: number;
}

const EXECUTOR_NAMES: readonly string[] = ['claude-cli', 'openrouter-agent'];

const KNOWN_KEYS: readonly (keyof RunSpec)[] = [
  'corpus_items',
  'observer_models',
  'executors',
  'k',
  'observe_timeout_s',
  'execute_timeout_s',
  'judge_model',
  'max_cost_usd',
  'max_steps',
  'max_cost_per_run_usd',
];

/** Keys a spec MAY declare (absent = the Phase 6 default documented above). */
const OPTIONAL_KEYS: readonly (keyof RunSpec)[] = [
  'executor_model',
  'fork_concurrency',
  'observe_concurrency',
];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Validate a parsed TOML table as a RunSpec. Rejects unknown keys, missing
 * keys, and type/value violations. `source` names the spec in error messages.
 */
export function validateRunSpec(raw: unknown, source: string): RunSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SpecError(`${source}: run spec must be a TOML table`);
  }
  const table = raw as Record<string, unknown>;

  const known = new Set<string>([...KNOWN_KEYS, ...OPTIONAL_KEYS]);
  const unknownKeys = Object.keys(table).filter((key) => !known.has(key));
  if (unknownKeys.length > 0) {
    throw new SpecError(`${source}: unknown key(s): ${unknownKeys.join(', ')}`);
  }

  const missingKeys = KNOWN_KEYS.filter((key) => table[key] === undefined);
  if (missingKeys.length > 0) {
    throw new SpecError(`${source}: missing required key(s): ${missingKeys.join(', ')}`);
  }

  const {
    corpus_items,
    observer_models,
    executors,
    k,
    observe_timeout_s,
    execute_timeout_s,
    judge_model,
    max_cost_usd,
    max_steps,
    max_cost_per_run_usd,
    executor_model,
    fork_concurrency,
    observe_concurrency,
  } = table;

  if (!isStringArray(corpus_items) || corpus_items.length === 0) {
    throw new SpecError(`${source}: corpus_items must be a non-empty array of strings`);
  }
  if (new Set(corpus_items).size !== corpus_items.length) {
    throw new SpecError(`${source}: corpus_items contains duplicate entries`);
  }
  if (!isStringArray(observer_models)) {
    throw new SpecError(`${source}: observer_models must be an array of strings`);
  }
  if (!isStringArray(executors) || executors.length === 0) {
    throw new SpecError(`${source}: executors must be a non-empty array of strings`);
  }
  const badExecutors = executors.filter((name) => !EXECUTOR_NAMES.includes(name));
  if (badExecutors.length > 0) {
    throw new SpecError(
      `${source}: invalid executor(s): ${badExecutors.join(', ')} (allowed: ${EXECUTOR_NAMES.join(', ')})`,
    );
  }
  if (new Set(executors).size !== executors.length) {
    throw new SpecError(`${source}: executors contains duplicate entries`);
  }
  if (!isPositiveInteger(k)) {
    throw new SpecError(`${source}: k must be a positive integer`);
  }
  if (!isPositiveNumber(observe_timeout_s)) {
    throw new SpecError(`${source}: observe_timeout_s must be a positive number`);
  }
  if (!isPositiveNumber(execute_timeout_s)) {
    throw new SpecError(`${source}: execute_timeout_s must be a positive number`);
  }
  if (typeof judge_model !== 'string' || judge_model.trim() === '') {
    throw new SpecError(`${source}: judge_model must be a non-empty string`);
  }
  if (!isPositiveNumber(max_cost_usd)) {
    throw new SpecError(`${source}: max_cost_usd must be a positive number`);
  }
  if (!isPositiveInteger(max_steps)) {
    throw new SpecError(`${source}: max_steps must be a positive integer`);
  }
  if (!isPositiveNumber(max_cost_per_run_usd)) {
    throw new SpecError(`${source}: max_cost_per_run_usd must be a positive number`);
  }
  if (executor_model !== undefined && (typeof executor_model !== 'string' || executor_model.trim() === '')) {
    throw new SpecError(`${source}: executor_model must be a non-empty string when present`);
  }
  if (fork_concurrency !== undefined && !isPositiveInteger(fork_concurrency)) {
    throw new SpecError(`${source}: fork_concurrency must be a positive integer when present`);
  }
  if (observe_concurrency !== undefined && !isPositiveInteger(observe_concurrency)) {
    throw new SpecError(`${source}: observe_concurrency must be a positive integer when present`);
  }

  return {
    corpus_items,
    observer_models,
    executors: executors as ExecutorName[],
    k,
    observe_timeout_s,
    execute_timeout_s,
    judge_model,
    max_cost_usd,
    max_steps,
    max_cost_per_run_usd,
    // Spread-when-present: an absent optional key stays absent on the object.
    ...(executor_model !== undefined ? { executor_model } : {}),
    ...(fork_concurrency !== undefined ? { fork_concurrency } : {}),
    ...(observe_concurrency !== undefined ? { observe_concurrency } : {}),
  };
}

/**
 * Load and validate a TOML run spec via Bun's native TOML parser.
 */
export async function loadRunSpec(path: string): Promise<RunSpec> {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(await Bun.file(path).text());
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpecError(`${path}: failed to load TOML: ${message}`);
  }
  return validateRunSpec(parsed, path);
}
