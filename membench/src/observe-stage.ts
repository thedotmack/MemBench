/**
 * Stage 1 — observe (plan Phase 6.1).
 *
 * For each corpus item × observer model, replay the item's frozen tool calls
 * through claude-mem's production observer conversation (observe-runner.ts,
 * Phase 2) and emit
 *   runs/<run_id>/obs/<item>/<model-slug>.json
 *     = {observations, parse_notes, usage_notes,
 *        obs_tokens_in, obs_tokens_out, obs_cost_usd, error?}
 *
 * `error` is written ONLY when the replay itself failed (transport error,
 * timeout). It is an addition to the plan's field list, not a substitution:
 * a failed observe must not be indistinguishable from "the model produced no
 * observations" — Phase 6.2 turns an errored observe into error rows for that
 * variant instead of silently seeding an empty fork.
 *
 * Items are processed one at a time with the item's models concurrent (cap
 * from the spec, default 4) so cost governance can stop BETWEEN items
 * (plan Phase 6.4) while the partial run stays resumable.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mapWithConcurrency } from './concurrency.js';
import {
  REQUIRED_FILES,
  computeContentHash,
  firstHumanPrompt,
  type ToolCallRecord,
  type TranscriptRow,
} from './corpus-item.js';
import { readJsonl } from './jsonl.js';
import { runObserveItem, type ObserveToolCall, type QueryModelFn } from './observe-runner.js';
import { isSafeCorpusItemId } from './spec.js';
import type { CorpusItem } from './types.js';
import codeMode from './vendor/modes/code.json';
import type { ParsedObservation } from './vendor/parser.js';
import type { ModeConfig } from './vendor/shims/types.js';

export class ObserveStageError extends Error {}

/** The frozen-item metadata stage 1 needs (project + session identity). */
export interface ItemProvenance {
  content_session_id?: string;
  project_slug?: string;
  dates?: { session_n_ended?: string | null };
  content_hash?: string;
}

/**
 * Per-(item, model) observe artifact. Token/cost fields are real reported
 * usage only — `null` means "not reported", never an estimate (guard 1).
 */
export interface ObserveRecord {
  /** Self-identifying artifact: the model slug in the filename is a one-way hash. */
  item_id: string;
  model: string;
  observations: ParsedObservation[];
  parse_notes: string[];
  usage_notes: string[];
  obs_tokens_in: number | null;
  obs_tokens_out: number | null;
  obs_cost_usd: number | null;
  /** Present only when the replay failed; observations is then empty. */
  error?: string;
}

/**
 * Filesystem-safe slug for a model id or variant name (fork.ts uses it for
 * fork dir names too): lossless names stay bare, any LOSSY cleaning appends
 * the first 8 hex of sha256(raw id) so `a/b` and `a-b` can never collide on
 * disk.
 */
export function modelSlug(model: string): string {
  const cleaned = model.replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (cleaned === model) return cleaned;
  const hash = new Bun.CryptoHasher('sha256').update(model).digest('hex').slice(0, 8);
  return `${cleaned}-${hash}`;
}

/** runs/<run_id>/obs/<item>/<model-slug>.json */
export function observeRecordPath(runDir: string, itemId: string, model: string): string {
  return join(runDir, 'obs', itemId, `${modelSlug(model)}.json`);
}

/**
 * Map key for a per-(item, model) observe record. JSON-encoded array: an
 * unambiguous separator that (unlike a control character) keeps this file
 * plain text, so the plan's audit greps never treat it as binary.
 */
export function observeKey(itemId: string, model: string): string {
  return JSON.stringify([itemId, model]);
}


// ---------------------------------------------------------------------------
// Corpus item loading
// ---------------------------------------------------------------------------

/** A corpus item plus the frozen metadata the orchestrator reads repeatedly. */
export interface LoadedItem extends CorpusItem {
  provenance: ItemProvenance;
  /** provenance.content_hash — null when the item was never frozen. */
  contentHash: string | null;
}

/**
 * Resolve one frozen corpus item, verifying every required file exists.
 *
 * `requireFrozen` (dry-run + live runs) additionally demands a content hash
 * AND RECOMPUTES it: a recorded hash only proves the item was frozen once,
 * while a recomputed match proves the bytes the run is about to measure are
 * the frozen bytes. An item mutated after freezing refuses to run — otherwise
 * published numbers would silently describe a different corpus.
 */
export async function loadCorpusItem(
  corpusDir: string,
  itemId: string,
  options: { requireFrozen?: boolean } = {},
): Promise<LoadedItem> {
  // Defense in depth behind validateRunSpec: the id becomes a directory
  // segment here (reads) and in observeRecordPath (writes), so every load
  // path — spec items and shuffled donors alike — re-checks it.
  if (!isSafeCorpusItemId(itemId)) {
    throw new ObserveStageError(
      `corpus item id ${JSON.stringify(itemId)} is not a single safe path segment`,
    );
  }
  const dir = resolve(corpusDir, itemId);
  if (!existsSync(dir)) {
    throw new ObserveStageError(`corpus item not found: ${itemId} (${dir})`);
  }
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    throw new ObserveStageError(`corpus item ${itemId} is missing: ${missing.join(', ')}`);
  }
  const provenancePath = join(dir, 'provenance.json');
  if (!existsSync(provenancePath)) {
    throw new ObserveStageError(`corpus item ${itemId} has no provenance.json`);
  }
  let provenance: ItemProvenance;
  try {
    provenance = JSON.parse(await Bun.file(provenancePath).text()) as ItemProvenance;
  } catch (error: unknown) {
    throw new ObserveStageError(
      `corpus item ${itemId}: could not parse provenance.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const contentHash = typeof provenance.content_hash === 'string' ? provenance.content_hash : null;
  if (options.requireFrozen) {
    if (contentHash === null) {
      throw new ObserveStageError(
        `corpus item ${itemId} is not frozen (no content_hash) — freeze it before running the benchmark`,
      );
    }
    const actual = await computeContentHash(dir);
    if (actual !== contentHash) {
      throw new ObserveStageError(
        `corpus item ${itemId} changed since it was frozen (provenance ${contentHash}, on disk ${actual}) — ` +
          'the corpus is append-only; restore the frozen content or build a new item',
      );
    }
  }
  if (!provenance.project_slug) {
    throw new ObserveStageError(`corpus item ${itemId}: provenance.json has no project_slug`);
  }
  return { id: itemId, dir, provenance, contentHash };
}

// ---------------------------------------------------------------------------
// Observe input assembly
// ---------------------------------------------------------------------------

/**
 * Build the observe-runner input for one item: the init prompt's identity
 * (project slug + session id + session N's opening HUMAN prompt) plus the
 * frozen tool calls. `toolcalls.jsonl` records carry nullable epoch/cwd
 * (interrupted or untimestamped calls); the runner's prompt shape wants a
 * number and an optional string, so nulls collapse here — 0 for the epoch
 * (the observation prompt renders it as a timestamp only) and absent cwd.
 */
async function buildObserveInput(item: LoadedItem) {
  const toolCalls = await readJsonl<ToolCallRecord>(join(item.dir, 'toolcalls.jsonl'));
  const transcript = await readJsonl<TranscriptRow>(join(item.dir, 'transcript.jsonl'));
  const userPrompt = firstHumanPrompt(transcript) ?? 'Work session';
  const observeCalls: ObserveToolCall[] = toolCalls.map((call) => ({
    tool_name: call.tool_name,
    tool_input: call.tool_input,
    tool_output: call.tool_output,
    created_at_epoch: call.created_at_epoch ?? 0,
    ...(call.cwd ? { cwd: call.cwd } : {}),
  }));
  return {
    project: item.provenance.project_slug!,
    sessionId: item.provenance.content_session_id ?? item.id,
    userPrompt,
    mode: codeMode as ModeConfig,
    toolCalls: observeCalls,
  };
}

// ---------------------------------------------------------------------------
// Stage driver
// ---------------------------------------------------------------------------

/**
 * The single cost-governance hook's events:
 *   - 'record' — a record landed (fresh or reused); fold its REAL reported
 *     obs_cost_usd into the run's spend.
 *   - 'call'   — pre-flight BEFORE a paid replay. 'stop' abandons the
 *     remaining replays without spending; nothing is written for them, so
 *     they are simply re-attempted on the next invocation.
 *   - 'item'   — one item's models all completed. 'stop' halts the stage
 *     between items; the partial run stays resumable.
 */
type ObserveGovernanceEvent =
  | { type: 'record'; itemId: string; model: string; record: ObserveRecord; reused: boolean }
  | { type: 'call' }
  | { type: 'item'; itemId: string };

interface ObserveStageOptions {
  items: LoadedItem[];
  models: string[];
  /** runs/<run_id>/ */
  runDir: string;
  /** Injected transport (mock in offline runs); defaults to the real client. */
  query?: QueryModelFn;
  apiKey?: string;
  /** Per-(item, model) replay timeout, seconds (spec.observe_timeout_s). */
  timeoutS: number;
  /** Max concurrent (item, model) replays within one item. Default 4. */
  concurrency?: number;
  /** Cost governance (see ObserveGovernanceEvent). */
  governance?: (event: ObserveGovernanceEvent) => 'continue' | 'stop';
  log?: (message: string) => void;
}

interface ObserveStageResult {
  /** key = observeKey(itemId, model) */
  records: Map<string, ObserveRecord>;
  /** Items whose models were all attempted (or reused) before the stage ended. */
  itemsObserved: string[];
  /** True when the governance hook stopped the stage early. */
  stopped: boolean;
}

const DEFAULT_OBSERVE_CONCURRENCY = 4;

/**
 * Run stage 1 over (items × models). One item at a time; that item's models
 * run concurrently up to `concurrency`. Every attempted (item, model) pair
 * gets a record file — a failed replay writes `error` rather than vanishing.
 *
 * An existing non-errored record is ALWAYS reused, resume flag or not: an
 * observe record is an idempotent artifact of (frozen item × model), so
 * `observe` followed by `run` on the same run id must never re-spend it.
 * Errored records are re-attempted.
 */
export async function runObserveStage(options: ObserveStageOptions): Promise<ObserveStageResult> {
  const {
    items,
    models,
    runDir,
    query,
    apiKey,
    timeoutS,
    concurrency = DEFAULT_OBSERVE_CONCURRENCY,
    governance,
    log = () => {},
  } = options;

  const records = new Map<string, ObserveRecord>();
  const itemsObserved: string[] = [];
  let stoppedEarly = false;

  for (const item of items) {
    const input = await buildObserveInput(item);
    await mapWithConcurrency(models, concurrency, async (model) => {
      const path = observeRecordPath(runDir, item.id, model);
      let existing: ObserveRecord | undefined;
      if (existsSync(path)) {
        try {
          existing = JSON.parse(await Bun.file(path).text()) as ObserveRecord;
        } catch {
          // Unreadable artifact — re-attempt the replay below.
        }
      }
      if (existing && !existing.error) {
        records.set(observeKey(item.id, model), existing);
        governance?.({ type: 'record', itemId: item.id, model, record: existing, reused: true });
        log(`observe: reusing ${item.id} × ${model} (${existing.observations.length} observations)`);
        return;
      }
      if (stoppedEarly) return;
      if (governance?.({ type: 'call' }) === 'stop') {
        stoppedEarly = true;
        return;
      }
      let record: ObserveRecord;
      try {
        const outcome = await runObserveItem(input, model, {
          ...(query ? { query } : {}),
          ...(apiKey ? { apiKey } : {}),
          abortSignal: AbortSignal.timeout(timeoutS * 1000),
        });
        record = {
          item_id: item.id,
          model,
          observations: outcome.observations,
          parse_notes: outcome.parse_notes,
          usage_notes: outcome.usage_notes,
          obs_tokens_in: outcome.obs_tokens_in,
          obs_tokens_out: outcome.obs_tokens_out,
          obs_cost_usd: outcome.obs_cost_usd,
        };
        log(
          `observe: ${item.id} × ${model} → ${record.observations.length} observations` +
            `${record.parse_notes.length > 0 ? `, ${record.parse_notes.length} parse note(s)` : ''}`,
        );
      } catch (error: unknown) {
        record = {
          item_id: item.id,
          model,
          observations: [],
          parse_notes: [],
          usage_notes: [],
          obs_tokens_in: null,
          obs_tokens_out: null,
          obs_cost_usd: null,
          error: error instanceof Error ? error.message : String(error),
        };
        log(`observe: ${item.id} × ${model} FAILED: ${record.error}`);
      }
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, JSON.stringify(record, null, 2) + '\n');
      records.set(observeKey(item.id, model), record);
      governance?.({ type: 'record', itemId: item.id, model, record, reused: false });
    });

    if (stoppedEarly) {
      return { records, itemsObserved, stopped: true };
    }
    itemsObserved.push(item.id);
    if (governance?.({ type: 'item', itemId: item.id }) === 'stop') {
      return { records, itemsObserved, stopped: true };
    }
  }

  return { records, itemsObserved, stopped: false };
}
