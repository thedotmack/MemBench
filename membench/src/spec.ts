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

/**
 * A corpus item id is used verbatim as a directory segment under both the
 * corpus root (reads) and runs/<run_id>/obs/ (writes), so it must be exactly
 * one safe path segment — no separators, no traversal, no leading dot. A
 * traversal id like `../../victim` would read outside --corpus-dir and land
 * observation artifacts in a sibling run's directory.
 */
const SAFE_ITEM_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `id` is a single safe directory segment (see SAFE_ITEM_ID_RE). */
export function isSafeCorpusItemId(id: string): boolean {
  return SAFE_ITEM_ID_RE.test(id);
}

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
   * Model the `claude-cli` executor lane runs, passed through as `--model`
   * (an alias like "haiku"/"sonnet"/"opus" or a full Anthropic model name —
   * NOT an OpenRouter id). Absent = whatever the CLI/account defaults to,
   * which on a Max account is the Opus tier: measured 2026-08-01, pinning
   * `haiku` cut a trivial run from $0.067 to $0.016. Because this lane's
   * reported cost counts against the run's cost ceiling, leaving it unset
   * can halt a run long before the matrix completes.
   */
  cli_model?: string;
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
  'cli_model',
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

const isNonEmptyStringArray = (value: unknown) => isStringArray(value) && value.length > 0;
const isNonEmptyString = (value: unknown) => typeof value === 'string' && value.trim() !== '';

/** Per-key [predicate, error message] — applied to every declared key. */
const RULES: Record<keyof RunSpec, [(value: unknown) => boolean, string]> = {
  corpus_items: [isNonEmptyStringArray, 'corpus_items must be a non-empty array of strings'],
  observer_models: [isStringArray, 'observer_models must be an array of strings'],
  executors: [isNonEmptyStringArray, 'executors must be a non-empty array of strings'],
  k: [isPositiveInteger, 'k must be a positive integer'],
  observe_timeout_s: [isPositiveNumber, 'observe_timeout_s must be a positive number'],
  execute_timeout_s: [isPositiveNumber, 'execute_timeout_s must be a positive number'],
  judge_model: [isNonEmptyString, 'judge_model must be a non-empty string'],
  max_cost_usd: [isPositiveNumber, 'max_cost_usd must be a positive number'],
  max_steps: [isPositiveInteger, 'max_steps must be a positive integer'],
  max_cost_per_run_usd: [isPositiveNumber, 'max_cost_per_run_usd must be a positive number'],
  executor_model: [isNonEmptyString, 'executor_model must be a non-empty string when present'],
  cli_model: [isNonEmptyString, 'cli_model must be a non-empty string when present'],
  fork_concurrency: [isPositiveInteger, 'fork_concurrency must be a positive integer when present'],
  observe_concurrency: [isPositiveInteger, 'observe_concurrency must be a positive integer when present'],
};

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

  // Type/value checks from the table; absent OPTIONAL_KEYS stay absent.
  const spec: Record<string, unknown> = {};
  for (const key of [...KNOWN_KEYS, ...OPTIONAL_KEYS]) {
    const value = table[key];
    if (value === undefined) continue;
    const [accepts, message] = RULES[key];
    if (!accepts(value)) throw new SpecError(`${source}: ${message}`);
    spec[key] = value;
  }

  // Cross-value checks the per-key predicates cannot express.
  const corpus_items = spec.corpus_items as string[];
  if (new Set(corpus_items).size !== corpus_items.length) {
    throw new SpecError(`${source}: corpus_items contains duplicate entries`);
  }
  const unsafeIds = corpus_items.filter((id) => !isSafeCorpusItemId(id));
  if (unsafeIds.length > 0) {
    throw new SpecError(
      `${source}: corpus_items entries must be single path segments ` +
        `([A-Za-z0-9._-], starting alphanumeric); got: ${unsafeIds.map((id) => JSON.stringify(id)).join(', ')}`,
    );
  }
  const executors = spec.executors as string[];
  const badExecutors = executors.filter((name) => !EXECUTOR_NAMES.includes(name));
  if (badExecutors.length > 0) {
    throw new SpecError(
      `${source}: invalid executor(s): ${badExecutors.join(', ')} (allowed: ${EXECUTOR_NAMES.join(', ')})`,
    );
  }
  if (new Set(executors).size !== executors.length) {
    throw new SpecError(`${source}: executors contains duplicate entries`);
  }

  return spec as unknown as RunSpec;
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
