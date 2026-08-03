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
 */

import { parseAgentXml, type ParsedObservation } from './vendor/parser.js';
import { buildInitPrompt, buildObservationPrompt } from './vendor/prompts.js';
import { queryModel, type ChatMessage, type QueryModelOptions, type QueryModelResult } from './openrouter.js';
import type { ModeConfig } from './vendor/shims/types.js';

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
export type QueryModelFn = typeof queryModel;

interface ObserveRunnerOptions {
  query?: QueryModelFn;
  apiKey?: string;
  abortSignal?: AbortSignal;
}

/**
 * Per-(item, model) observe outcome. Token/cost sums are real reported usage
 * only: `null` means at least one turn did not report that field (flagged in
 * usage_notes), never a guess.
 */
interface ObserveOutcome {
  observations: ParsedObservation[];
  parse_notes: string[];
  obs_tokens_in: number | null;
  obs_tokens_out: number | null;
  obs_cost_usd: number | null;
  usage_notes: string[];
}

interface TurnUsage {
  label: string;
  result: QueryModelResult;
}

/**
 * Sum one reported-usage field across every turn. A missing field nulls the
 * whole sum and flags each missing turn in `notes` — never guessed (guard 1).
 */
function sumOrNull(
  turns: TurnUsage[],
  field: 'inputTokens' | 'outputTokens' | 'costUsd',
  describe: (label: string) => string,
  notes: string[],
): number | null {
  let total = 0;
  let missing = false;
  for (const { label, result } of turns) {
    const value = result[field];
    if (typeof value === 'number') {
      total += value;
    } else {
      missing = true;
      notes.push(describe(label));
    }
  }
  return missing ? null : total;
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
  const queryOpts: QueryModelOptions = {
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    // Billing-only prompt caching for the growing-history replay (openrouter.ts
    // header). Output-neutral: the message sequence and sampling params are
    // unchanged, so this alters what the run COSTS, never what it measures.
    cacheControl: true,
  };

  const turns: TurnUsage[] = [];
  const observations: ParsedObservation[] = [];
  const parseNotes: string[] = [];

  // Init prompt is turn 1, role user (OpenAICompatibleProvider.ts:100-105).
  const history: ChatMessage[] = [
    { role: 'user', content: buildInitPrompt(item.project, item.sessionId, item.userPrompt, item.mode) },
  ];

  const initResponse = await query(model, [...history], queryOpts);
  turns.push({ label: 'init turn', result: initResponse });
  if (initResponse.content) {
    // Assistant reply joins the history before the next turn (:172-173).
    history.push({ role: 'assistant', content: initResponse.content });
    // The init reply is normally a prose acknowledgment (not observation
    // XML) — that is expected and NOT counted as a parse failure. But if it
    // does carry parseable observations, collect them, matching the
    // production path where every reply flows through the parser.
    const parsed = parseAgentXml(initResponse.content, `${item.sessionId}:init`);
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
    turns.push({ label: turnLabel, result: response });

    if (!response.content) {
      // Empty content from an observe turn = parse note, never silent
      // success (plan Phase 2 guard). Matches :221-229: the empty reply is
      // NOT appended to the history.
      parseNotes.push(`${turnLabel}: empty response — recorded as parse failure`);
      continue;
    }

    history.push({ role: 'assistant', content: response.content });

    const parsed = parseAgentXml(response.content, `${item.sessionId}:obs${i + 1}`);
    if (!parsed.valid) {
      parseNotes.push(`${turnLabel}: reply failed to parse as observation XML`);
      continue;
    }
    observations.push(...parsed.observations);
  }

  const usageNotes: string[] = [];
  return {
    observations,
    parse_notes: parseNotes,
    obs_tokens_in: sumOrNull(
      turns,
      'inputTokens',
      (label) => `${label}: no prompt_tokens reported — obs_tokens_in is null, not estimated`,
      usageNotes,
    ),
    obs_tokens_out: sumOrNull(
      turns,
      'outputTokens',
      (label) => `${label}: no completion_tokens reported — obs_tokens_out is null, not estimated`,
      usageNotes,
    ),
    obs_cost_usd: sumOrNull(
      turns,
      'costUsd',
      (label) => `${label}: no usage.cost reported — obs_cost_usd is null, not estimated`,
      usageNotes,
    ),
    usage_notes: usageNotes,
  };
}
