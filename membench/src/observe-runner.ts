/**
 * Observe-side multi-turn conversation replay (Phase 6 stage 1 calls this).
 *
 * Replays claude-mem's production observer conversation shape against one
 * observer model: init prompt as turn 1 (role user), then one user turn per
 * tool call, appending each model reply to the running history before the
 * next observation turn. Sequence ported from claude-mem
 * src/services/worker/OpenAICompatibleProvider.ts @ 132b46343:
 *   - init turn push + query                 :99-110 (buildInitPrompt branch;
 *     MemBench items always replay prompt 1, so no continuation branch)
 *   - assistant reply appended on content    :172-173
 *   - observation prompt build (id: 0,
 *     JSON.stringify'd input/output) + push  :205-215
 *   - query full history each turn           :218
 *   - reply appended ONLY when non-empty     :221-222 (an empty observe turn
 *     is recorded as a parse note here — never a silent success)
 *
 * Replies are parsed with the VENDORED parseAgentXml. Token/cost sums use
 * only real reported usage; if any turn's usage field is missing, that sum
 * becomes null and is flagged in usage_notes — never guessed (plan §0.2
 * guards 1-2).
 *
 * JSON accommodation (plan Phase 2): when a model's XML parse-fail rate over
 * the observation turns exceeds 50%, the item is re-run with
 * response_format: {type:'json_object'} and a JSON-shaped instruction
 * appended to the init prompt; JSON replies are mapped to ParsedObservation
 * and the outcome is marked accommodation:"json" — content competes even
 * when tag discipline fails.
 */

import { parseAgentXml, type ParsedObservation } from './vendor/parser.js';
import { buildInitPrompt, buildObservationPrompt } from './vendor/prompts.js';
import type { ModeConfig } from './vendor/shims/types.js';
import { queryModel, type ChatMessage, type QueryModelOptions, type QueryModelResult } from './openrouter.js';

/** One replayed tool call from a frozen corpus item. */
export interface ObserveToolCall {
  tool_name: string;
  tool_input: unknown;
  tool_output: unknown;
  created_at_epoch: number;
  cwd?: string;
}

export interface ObserveItemInput {
  project: string;
  sessionId: string;
  userPrompt: string;
  mode: ModeConfig;
  toolCalls: ObserveToolCall[];
}

/** Injectable transport (offline tests mock this; defaults to queryModel). */
export type QueryModelFn = (
  model: string,
  messages: ChatMessage[],
  opts?: QueryModelOptions,
) => Promise<QueryModelResult>;

export interface ObserveRunnerOptions {
  query?: QueryModelFn;
  apiKey?: string;
  abortSignal?: AbortSignal;
}

/**
 * Per-(item, model) observe outcome. Token/cost sums are real reported usage
 * only: `null` means at least one turn did not report that field (flagged in
 * usage_notes), never a guess.
 */
export interface ObserveOutcome {
  observations: ParsedObservation[];
  parse_notes: string[];
  obs_tokens_in: number | null;
  obs_tokens_out: number | null;
  obs_cost_usd: number | null;
  usage_notes: string[];
  accommodation?: 'json';
}

/** XML parse-fail rate (over observation turns) above which the JSON accommodation re-run triggers. */
const JSON_PARSE_FAIL_THRESHOLD = 0.5;

/** Appended to the init prompt on the JSON accommodation pass. */
export const JSON_ACCOMMODATION_INSTRUCTION = `FORMAT OVERRIDE — JSON MODE:
Respond with a single JSON object instead of XML, using this exact shape:
{"observations": [{"type": "...", "title": "...", "subtitle": "...", "facts": ["..."], "narrative": "...", "concepts": ["..."], "files_read": ["..."], "files_modified": ["..."]}]}
Apply the same observation types, field meanings, and content rules described above.
To skip a tool use that produced nothing worth recording, respond with {"observations": []}.
Do not emit XML tags, markdown fences, or any text outside the JSON object.`;

interface UsageAccumulator {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  tokensInMissing: boolean;
  tokensOutMissing: boolean;
  costMissing: boolean;
  notes: string[];
}

function createUsageAccumulator(): UsageAccumulator {
  return {
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    tokensInMissing: false,
    tokensOutMissing: false,
    costMissing: false,
    notes: [],
  };
}

/**
 * Fold one turn's reported usage into the accumulator. A missing field nulls
 * the corresponding sum for the whole item and is flagged — never guessed.
 */
function recordUsage(acc: UsageAccumulator, turnLabel: string, result: QueryModelResult): void {
  if (typeof result.inputTokens === 'number') {
    acc.tokensIn += result.inputTokens;
  } else {
    acc.tokensInMissing = true;
    acc.notes.push(`${turnLabel}: no prompt_tokens reported — obs_tokens_in is null, not estimated`);
  }
  if (typeof result.outputTokens === 'number') {
    acc.tokensOut += result.outputTokens;
  } else {
    acc.tokensOutMissing = true;
    acc.notes.push(`${turnLabel}: no completion_tokens reported — obs_tokens_out is null, not estimated`);
  }
  if (typeof result.costUsd === 'number') {
    acc.costUsd += result.costUsd;
  } else {
    acc.costMissing = true;
    acc.notes.push(`${turnLabel}: no usage.cost reported — obs_cost_usd is null, not estimated`);
  }
}

/**
 * Map a JSON-mode reply to ParsedObservation[], mirroring the vendored
 * parser's semantics (parser.ts @ 132b46343):
 *   - missing/unknown type: unknown preserved, missing falls back to the
 *     mode's first observation type (parser.ts:108-119)
 *   - concept cleanup: truncate at the first ':', trim, drop empties and the
 *     observation type (parser.ts:121-129 — exact-string concept matching
 *     downstream makes this load-bearing)
 *   - observations with no content fields are dropped (parser.ts:140-146)
 *   - `{"observations": []}` is the JSON analog of a skip → valid, zero obs
 * Returns {valid:false} for non-JSON or a shape without an observations array.
 */
export function mapJsonToObservations(
  raw: string,
  mode: ModeConfig,
): { valid: true; observations: ParsedObservation[] } | { valid: false } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { valid: false };
  }

  let list: unknown[];
  if (Array.isArray(data)) {
    list = data;
  } else if (data !== null && typeof data === 'object' && Array.isArray((data as { observations?: unknown }).observations)) {
    list = (data as { observations: unknown[] }).observations;
  } else {
    return { valid: false };
  }

  const validTypes = mode.observation_types.map((t) => t.id);
  const fallbackType = validTypes[0];
  const observations: ParsedObservation[] = [];

  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;

    const type = asString(obj.type) ?? fallbackType;
    const title = asString(obj.title);
    const subtitle = asString(obj.subtitle);
    const narrative = asString(obj.narrative);
    const facts = asStringArray(obj.facts);
    const concepts = asStringArray(obj.concepts);
    const files_read = asStringArray(obj.files_read);
    const files_modified = asStringArray(obj.files_modified);

    const cleanedConcepts = concepts
      .map((c) => {
        const colonIndex = c.indexOf(':');
        return (colonIndex === -1 ? c : c.slice(0, colonIndex)).trim();
      })
      .filter((c) => c !== '' && c !== type);

    if (!title && !narrative && facts.length === 0 && cleanedConcepts.length === 0) {
      continue;
    }

    observations.push({
      type,
      title,
      subtitle,
      facts,
      narrative,
      concepts: cleanedConcepts,
      files_read,
      files_modified,
    });
  }

  // Deliberate asymmetry with the XML parser: when every entry is dropped,
  // parseAgentXml returns {valid:false} (zero observations = malformed), but
  // JSON mode returns valid-with-zero — the instruction defines
  // {"observations": []} as the explicit skip shape, so an all-dropped list
  // is treated as a deliberate skip, not a parse failure.
  return { valid: true, observations };
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

interface ConversationPass {
  observations: ParsedObservation[];
  parseNotes: string[];
  usage: UsageAccumulator;
  obsParseFailures: number;
}

async function runConversation(
  item: ObserveItemInput,
  model: string,
  query: QueryModelFn,
  opts: ObserveRunnerOptions,
  jsonMode: boolean,
): Promise<ConversationPass> {
  const usage = createUsageAccumulator();
  const observations: ParsedObservation[] = [];
  const parseNotes: string[] = [];
  let obsParseFailures = 0;

  const queryOpts: QueryModelOptions = {
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    // Billing-only prompt caching for the growing-history replay (openrouter.ts
    // header). Output-neutral: the message sequence and sampling params are
    // unchanged, so this alters what the run COSTS, never what it measures.
    cacheControl: true,
  };

  // Init prompt is turn 1, role user (OpenAICompatibleProvider.ts:100-105).
  const initPromptBase = buildInitPrompt(item.project, item.sessionId, item.userPrompt, item.mode);
  const initPrompt = jsonMode ? `${initPromptBase}\n\n${JSON_ACCOMMODATION_INSTRUCTION}` : initPromptBase;
  const history: ChatMessage[] = [{ role: 'user', content: initPrompt }];

  const initResponse = await query(model, [...history], queryOpts);
  recordUsage(usage, 'init turn', initResponse);
  if (initResponse.content) {
    // Assistant reply joins the history before the next turn (:172-173).
    history.push({ role: 'assistant', content: initResponse.content });
    // The init reply is normally a prose acknowledgment (not observation
    // XML/JSON) — that is expected and NOT counted as a parse failure. But if
    // it does carry parseable observations, collect them, matching the
    // production path where every reply flows through the parser.
    const parsed = jsonMode
      ? mapJsonToObservations(initResponse.content, item.mode)
      : parseAgentXml(initResponse.content, `${item.sessionId}:init`);
    if (parsed.valid) {
      observations.push(...parsed.observations);
    }
  } else {
    parseNotes.push('init turn: empty response');
  }

  for (let i = 0; i < item.toolCalls.length; i++) {
    const call = item.toolCalls[i];
    const turnLabel = `observation turn ${i + 1} (${call.tool_name})`;

    // Observation prompt build from :205-212 — call sites pass id: 0 and
    // JSON.stringify the tool input/output.
    const obsPrompt = buildObservationPrompt({
      id: 0,
      tool_name: call.tool_name,
      tool_input: JSON.stringify(call.tool_input),
      tool_output: JSON.stringify(call.tool_output),
      created_at_epoch: call.created_at_epoch,
      cwd: call.cwd,
    });
    history.push({ role: 'user', content: obsPrompt });

    const response = await query(model, [...history], queryOpts);
    recordUsage(usage, turnLabel, response);

    if (!response.content) {
      // Empty content from an observe turn = parse note, never silent
      // success (plan Phase 2 guard). Matches :221-229: the empty reply is
      // NOT appended to the history.
      obsParseFailures++;
      parseNotes.push(`${turnLabel}: empty response — recorded as parse failure`);
      continue;
    }

    history.push({ role: 'assistant', content: response.content });

    const parsed = jsonMode
      ? mapJsonToObservations(response.content, item.mode)
      : parseAgentXml(response.content, `${item.sessionId}:obs${i + 1}`);
    if (!parsed.valid) {
      obsParseFailures++;
      parseNotes.push(`${turnLabel}: reply failed to parse as ${jsonMode ? 'JSON observations' : 'observation XML'}`);
      continue;
    }
    observations.push(...parsed.observations);
  }

  return { observations, parseNotes, usage, obsParseFailures };
}

/** null-propagating sum for combining the two passes' real-usage totals. */
function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

function finalizeUsage(acc: UsageAccumulator): { tokensIn: number | null; tokensOut: number | null; costUsd: number | null } {
  return {
    tokensIn: acc.tokensInMissing ? null : acc.tokensIn,
    tokensOut: acc.tokensOutMissing ? null : acc.tokensOut,
    costUsd: acc.costMissing ? null : acc.costUsd,
  };
}

/**
 * Replay one corpus item's conversation against one observer model and
 * return the per-(item, model) observe outcome.
 */
export async function runObserveItem(
  item: ObserveItemInput,
  model: string,
  opts: ObserveRunnerOptions = {},
): Promise<ObserveOutcome> {
  const query = opts.query ?? queryModel;

  const xmlPass = await runConversation(item, model, query, opts, false);
  const xmlUsage = finalizeUsage(xmlPass.usage);
  const obsTurns = item.toolCalls.length;

  const failRate = obsTurns > 0 ? xmlPass.obsParseFailures / obsTurns : 0;
  if (failRate <= JSON_PARSE_FAIL_THRESHOLD) {
    return {
      observations: xmlPass.observations,
      parse_notes: xmlPass.parseNotes,
      obs_tokens_in: xmlUsage.tokensIn,
      obs_tokens_out: xmlUsage.tokensOut,
      obs_cost_usd: xmlUsage.costUsd,
      usage_notes: xmlPass.usage.notes,
    };
  }

  // JSON accommodation re-run: same item, response_format json_object, JSON
  // instruction appended to the init prompt. The re-run's observations
  // REPLACE the XML pass's (re-collecting both would double-count tool calls
  // that parsed in both passes), but token/cost sums cover BOTH passes —
  // that is the real spend for this (item, model).
  const jsonPass = await runConversation(item, model, query, opts, true);
  const jsonUsage = finalizeUsage(jsonPass.usage);

  return {
    observations: jsonPass.observations,
    parse_notes: [
      `xml pass: ${xmlPass.obsParseFailures}/${obsTurns} observation turns failed to parse (> ${JSON_PARSE_FAIL_THRESHOLD * 100}%) — re-ran with JSON accommodation`,
      ...xmlPass.parseNotes.map((n) => `xml pass: ${n}`),
      ...jsonPass.parseNotes.map((n) => `json pass: ${n}`),
    ],
    obs_tokens_in: sumOrNull(xmlUsage.tokensIn, jsonUsage.tokensIn),
    obs_tokens_out: sumOrNull(xmlUsage.tokensOut, jsonUsage.tokensOut),
    obs_cost_usd: sumOrNull(xmlUsage.costUsd, jsonUsage.costUsd),
    usage_notes: [
      ...xmlPass.usage.notes.map((n) => `xml pass: ${n}`),
      ...jsonPass.usage.notes.map((n) => `json pass: ${n}`),
    ],
    accommodation: 'json',
  };
}
