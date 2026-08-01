/**
 * OpenRouter chat client — the observe-side transport.
 *
 * Ported (not imported) from claude-mem src/services/worker/OpenRouterProvider.ts
 * @ 132b46343 — this is the production request shape being benchmarked, so the
 * observe side reproduces it exactly (plan §0.1). Section provenance:
 *   - classifyOpenRouterError            OpenRouterProvider.ts:30-94 (verbatim)
 *   - OpenRouterResponse shape           :104-129
 *   - request build (headers + body)     :204-224 (fetchChatCompletion)
 *   - fetch/retry loop, request-id dedup :245-287 (queryOpenRouterMultiTurn)
 *   - 200-with-`error` re-throw          :276-284
 *   - empty-choices → { content: '' }    :289-292 (caller records the parse note)
 *   - usage extraction (number-guards)   :295-308
 * URL from claude-mem src/shared/openrouter-base-url.ts:35.
 *
 * Deviations from the source (all reported in the Phase 2 notes):
 *   - HTTP-Referer / X-Title identify MemBench, per the plan.
 *   - `usage: { include: true }` is sent unconditionally — the URL is fixed to
 *     openrouter.ai, so the source's `apiUrl.includes('openrouter.ai')` guard
 *     (:221) is always true here.
 *   - Retry-dedup header renamed x-claude-mem-prior-request-id →
 *     x-membench-prior-request-id.
 *   - opts adds `response_format` (JSON accommodation, plan Phase 2) and an
 *     external AbortSignal / retry-timing knobs (offline tests).
 *
 * Cost is REAL reported usage only: usage.cost (+ cost_details.
 * upstream_inference_cost with BYOK), else `undefined`. NEVER estimated
 * (plan §0.2 guard 1). Tokens come from usage.prompt_tokens /
 * completion_tokens or stay undefined (guard 2 — no split fallback).
 */

import { OBSERVE_MAX_TOKENS, OBSERVE_TEMPERATURE } from './config.js';
import { ClassifiedProviderError } from './provider-errors.js';
import { parseRetryAfterMs, withRetry } from './retry.js';

/** claude-mem src/shared/openrouter-base-url.ts:35 (DEFAULT_OPENROUTER_API_URL). */
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** OpenAIMessage from OpenRouterProvider.ts:99-102. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Classify an OpenRouter fetch failure into ClassifiedProviderError. Called
 * at the boundary right after `fetch()` returns or throws.
 * (OpenRouterProvider.ts:30-94, verbatim.)
 */
export function classifyOpenRouterError(input: {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
  requestId?: string;
}): ClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();
  const headers = input.headers;
  const retryAfterMs = headers ? parseRetryAfterMs(headers.get('retry-after')) : undefined;

  // Quota / insufficient credits — body marker takes precedence over status.
  if (
    lower.includes('quota exceeded') ||
    lower.includes('insufficient credits') ||
    lower.includes('insufficient_quota')
  ) {
    return new ClassifiedProviderError(
      `OpenRouter quota exhausted${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'quota_exhausted', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ClassifiedProviderError(
      'OpenRouter rate limit (429)',
      { kind: 'rate_limit', cause: input.cause, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
    );
  }

  if (status === 401 || status === 403) {
    return new ClassifiedProviderError(
      `OpenRouter auth error (status ${status})`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 400 || status === 404) {
    return new ClassifiedProviderError(
      `OpenRouter bad request (status ${status})`,
      { kind: 'unrecoverable', cause: input.cause },
    );
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ClassifiedProviderError(
      `OpenRouter upstream error (status ${status})`,
      { kind: 'transient', cause: input.cause },
    );
  }

  // Network errors (no status) — treat as transient.
  if (status === undefined) {
    return new ClassifiedProviderError(
      `OpenRouter network error: ${input.cause instanceof Error ? input.cause.message : String(input.cause)}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  return new ClassifiedProviderError(
    `OpenRouter API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

/** OpenRouterResponse from OpenRouterProvider.ts:104-129. */
interface OpenRouterResponse {
  /** The model that actually served the request — not the configured string. */
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Credits charged by openrouter.ai (~USD). With BYOK this is only the fee. */
    cost?: number;
    cost_details?: {
      /** What the upstream provider charged when using BYOK. */
      upstream_inference_cost?: number;
    };
  };
  error?: {
    message?: string;
    code?: string | number;
  };
}

export interface QueryModelOptions {
  /** Defaults to OPENROUTER_API_KEY from the environment. */
  apiKey?: string;
  /** JSON accommodation (plan Phase 2): forwarded verbatim in the body. */
  response_format?: { type: 'json_object' };
  /**
   * Request-shape overrides for non-observe callers (e.g. Phase 6's judge).
   * Defaults are the production observe shape (OBSERVE_TEMPERATURE /
   * OBSERVE_MAX_TOKENS from config.ts = OpenRouterProvider.ts:216-217).
   */
  temperature?: number;
  maxTokens?: number;
  /** External abort — forwarded to the retry loop and each fetch attempt. */
  abortSignal?: AbortSignal;
  /** Retry knobs (offline tests); defaults come from retry.ts (2 / 30s / 100ms). */
  maxRetries?: number;
  perAttemptTimeoutMs?: number;
  baseDelayMs?: number;
}

/**
 * Real reported usage only. Absent fields mean the provider did not report
 * them — never estimated, never split from totals.
 */
export interface QueryModelResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  servedModel?: string;
}

/**
 * POST one chat-completions request (with retry) and normalize the response.
 * The fetch/classify/retry sequence mirrors OpenRouterProvider.ts
 * queryOpenRouterMultiTurn (:245-329) minus session bookkeeping.
 */
export async function queryModel(
  model: string,
  messages: ChatMessage[],
  opts: QueryModelOptions = {},
): Promise<QueryModelResult> {
  const apiKey = opts.apiKey ?? Bun.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set — cannot query OpenRouter');
  }

  let priorRequestId: string | null = null;

  const data = await withRetry<OpenRouterResponse>(async (attemptSignal) => {
    let response: Response;
    try {
      // Request build from OpenRouterProvider.ts:204-224.
      response = await fetch(OPENROUTER_API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/thedotmack/MemBench',
          'X-Title': 'MemBench',
          'Content-Type': 'application/json',
          ...(priorRequestId ? { 'x-membench-prior-request-id': priorRequestId } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? OBSERVE_TEMPERATURE,  // Lower temperature for structured extraction
          max_tokens: opts.maxTokens ?? OBSERVE_MAX_TOKENS,
          // Ask openrouter.ai for usage accounting (token counts + cost).
          usage: { include: true },
          ...(opts.response_format ? { response_format: opts.response_format } : {}),
        }),
        signal: attemptSignal,
      });
    } catch (networkError: unknown) {
      const err = networkError instanceof Error ? networkError : new Error(String(networkError));
      throw classifyOpenRouterError({ cause: err });
    }

    const requestId = response.headers.get('x-request-id') ?? response.headers.get('x-openrouter-request-id');
    if (requestId) {
      priorRequestId = requestId;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw classifyOpenRouterError({
        status: response.status,
        bodyText: errorText,
        headers: response.headers,
        cause: new Error(`OpenRouter API error: ${response.status} - ${errorText}`),
        ...(requestId ? { requestId } : {}),
      });
    }

    const responseData = await response.json() as OpenRouterResponse;

    if (responseData.error) {
      // Per OpenRouter spec, errors can come in 200 responses too. (:276-284)
      throw classifyOpenRouterError({
        status: response.status,
        bodyText: `${responseData.error.code} ${responseData.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`OpenRouter API error: ${responseData.error.code} - ${responseData.error.message}`),
      });
    }

    return responseData;
  }, {
    label: `OpenRouter ${model}`,
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.perAttemptTimeoutMs !== undefined ? { perAttemptTimeoutMs: opts.perAttemptTimeoutMs } : {}),
    ...(opts.baseDelayMs !== undefined ? { baseDelayMs: opts.baseDelayMs } : {}),
  });

  // Usage extraction with number-guards, verbatim from :295-308. usage.cost is
  // what openrouter.ai charged in credits (~USD); with BYOK the model spend is
  // reported separately as upstream_inference_cost. When absent, costUsd stays
  // undefined (never estimated). Extracted BEFORE the empty-choices check:
  // this is a cost benchmark, and an empty reply that still reports usage was
  // real spend — discarding it would falsely null the whole item's sums.
  const realInputTokens = data.usage?.prompt_tokens;
  const realOutputTokens = data.usage?.completion_tokens;
  const orCost = typeof data.usage?.cost === 'number' ? data.usage.cost : undefined;
  const upstreamCost = typeof data.usage?.cost_details?.upstream_inference_cost === 'number'
    ? data.usage.cost_details.upstream_inference_cost
    : undefined;
  const costUsd = orCost !== undefined || upstreamCost !== undefined
    ? (orCost ?? 0) + (upstreamCost ?? 0)
    : undefined;
  const servedModel = typeof data.model === 'string' && data.model ? data.model : undefined;

  const usageFields = {
    ...(realInputTokens !== undefined ? { inputTokens: realInputTokens } : {}),
    ...(realOutputTokens !== undefined ? { outputTokens: realOutputTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(servedModel !== undefined ? { servedModel } : {}),
  };

  // Empty choices → empty content (:289-292), with any reported usage kept.
  // The caller records the empty content as a parse note — never a silent
  // success (plan §0.2 / Phase 2 guard).
  if (!data.choices?.[0]?.message?.content) {
    return { content: '', ...usageFields };
  }

  return { content: data.choices[0].message.content, ...usageFields };
}
