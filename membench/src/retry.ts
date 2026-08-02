/**
 * Retry helper — ported from claude-mem src/services/worker/retry.ts
 * @ 132b46343 (core: lines 76-125). Behavior preserved:
 *   - maxRetries 2 default (POSTs aren't strictly idempotent)
 *   - per-attempt timeout 30s (AbortSignal.timeout, external aborts fanned in)
 *   - backoff 100 * 2^attempt + random(50), capped at 30s
 *   - retries ONLY kinds 'transient' | 'rate_limit'
 *   - honors retryAfterMs (Retry-After header) for rate_limit errors
 * Only deviation: claude-mem's logger.warn is replaced by console.warn
 * (MemBench has no structured logger; message content preserved).
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { isClassified } from './provider-errors.js';

/**
 * Parse Retry-After header (seconds or HTTP-date).
 * Returns ms or undefined.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

export interface RetryOptions {
  /** Maximum retry attempts (in addition to the initial attempt). Cap=2 by default for non-idempotent POSTs. */
  maxRetries?: number;
  /** Per-attempt timeout in ms. Default 30s. */
  perAttemptTimeoutMs?: number;
  /** Base delay used for exponential backoff. Default 100ms. */
  baseDelayMs?: number;
  /** Tag for logging. */
  label?: string;
  /** External abort signal. */
  abortSignal?: AbortSignal;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'label' | 'abortSignal'>> = {
  maxRetries: 2,
  perAttemptTimeoutMs: 30_000,
  baseDelayMs: 100,
};

/** Returns true if a classified error is worth retrying. */
export function isRetryableKind(err: unknown): boolean {
  if (!isClassified(err)) {
    // Unclassified errors are treated as transient (preserve old default).
    return true;
  }
  return err.kind === 'transient' || err.kind === 'rate_limit';
}

/** Compute backoff delay: 100 * 2^attempt + random(50). Capped at maxDelayMs. */
export function computeBackoffMs(attempt: number, opts: { baseDelayMs: number; maxDelayMs: number }): number {
  const exponential = opts.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 50;
  return Math.min(exponential + jitter, opts.maxDelayMs);
}

/**
 * Run `fn` with retry. `fn` receives an AbortSignal scoped to the current
 * attempt's timeout. The classified error from `fn` (if any) drives the
 * retry/no-retry decision. Honors `retryAfterMs` for rate_limit kind.
 */
export async function withRetry<T>(
  fn: (attemptSignal: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  for (let attempt = 0; ; attempt++) {
    if (options.abortSignal?.aborted) {
      throw new Error('Aborted');
    }

    // Per-attempt timeout; an external abort aborts the attempt too.
    const timeoutSignal = AbortSignal.timeout(opts.perAttemptTimeoutMs);
    const attemptSignal = options.abortSignal
      ? AbortSignal.any([options.abortSignal, timeoutSignal])
      : timeoutSignal;

    try {
      return await fn(attemptSignal);
    } catch (err: unknown) {
      if (!isRetryableKind(err) || attempt >= opts.maxRetries) {
        throw err;
      }

      // Honor retryAfterMs from rate_limit errors; otherwise exponential backoff.
      let delayMs: number;
      if (isClassified(err) && err.kind === 'rate_limit' && err.retryAfterMs !== undefined) {
        delayMs = err.retryAfterMs;
      } else {
        delayMs = computeBackoffMs(attempt, { baseDelayMs: opts.baseDelayMs, maxDelayMs: 30_000 });
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`Retrying ${opts.label ?? 'fetch'} after ${delayMs}ms (attempt ${attempt + 1}/${opts.maxRetries})`, {
        kind: isClassified(err) ? err.kind : 'unclassified',
        message: errMsg.substring(0, 200),
      });
      // Abort-aware sleep: an external abort during backoff exits immediately
      // instead of waiting out the full delay.
      try {
        await sleep(delayMs, undefined, { signal: options.abortSignal });
      } catch {
        throw new Error('Aborted');
      }
    }
  }
}
