/**
 * Offline tests for the ported retry helper (claude-mem retry.ts:76-125
 * @ 132b46343): backoff shape, classified-kind gating, Retry-After parsing,
 * and the withRetry loop. No network, no OPENROUTER_API_KEY.
 */
import { describe, expect, test } from 'bun:test';
import { ClassifiedProviderError } from '../src/provider-errors.ts';
import { computeBackoffMs, isRetryableKind, parseRetryAfterMs, withRetry } from '../src/retry.ts';

describe('parseRetryAfterMs', () => {
  test('parses seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });

  test('parses an HTTP-date in the future (and clamps past dates to 0)', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms!).toBeLessThanOrEqual(5000);
    expect(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBe(0);
  });

  test('returns undefined for null and garbage', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('not-a-value')).toBeUndefined();
    // '-3' fails the seconds branch (negative) but Date.parse('-3') parses it
    // as a past date, so the ported behavior clamps it to 0 — asserted here so
    // a future "fix" that diverges from the CM source gets noticed.
    expect(parseRetryAfterMs('-3')).toBe(0);
  });
});

describe('isRetryableKind — class gating', () => {
  test('retries only transient and rate_limit', () => {
    const mk = (kind: string) => new ClassifiedProviderError('x', { kind, cause: null });
    expect(isRetryableKind(mk('transient'))).toBe(true);
    expect(isRetryableKind(mk('rate_limit'))).toBe(true);
    expect(isRetryableKind(mk('auth_invalid'))).toBe(false);
    expect(isRetryableKind(mk('unrecoverable'))).toBe(false);
    expect(isRetryableKind(mk('quota_exhausted'))).toBe(false);
  });

  test('unclassified errors are treated as transient (retryable)', () => {
    expect(isRetryableKind(new Error('plain'))).toBe(true);
  });
});

describe('computeBackoffMs', () => {
  test('is 100 * 2^attempt + jitter(0..50), capped at maxDelayMs', () => {
    for (const attempt of [0, 1, 2]) {
      const ms = computeBackoffMs(attempt, { baseDelayMs: 100, maxDelayMs: 30_000 });
      const exponential = 100 * Math.pow(2, attempt);
      expect(ms).toBeGreaterThanOrEqual(exponential);
      expect(ms).toBeLessThanOrEqual(exponential + 50);
    }
    expect(computeBackoffMs(20, { baseDelayMs: 100, maxDelayMs: 30_000 })).toBe(30_000);
  });
});

describe('withRetry', () => {
  test('retries a transient error, then succeeds (maxRetries 2 default)', async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) {
        throw new ClassifiedProviderError('upstream', { kind: 'transient', cause: null });
      }
      return 'ok';
    }, { baseDelayMs: 1 });
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  test('does NOT retry a non-retryable kind', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new ClassifiedProviderError('bad key', { kind: 'auth_invalid', cause: null });
    }, { baseDelayMs: 1 })).rejects.toThrow('bad key');
    expect(attempts).toBe(1);
  });

  test('throws the last error after exhausting maxRetries', async () => {
    let attempts = 0;
    await expect(withRetry(async () => {
      attempts++;
      throw new ClassifiedProviderError(`fail ${attempts}`, { kind: 'transient', cause: null });
    }, { maxRetries: 2, baseDelayMs: 1 })).rejects.toThrow('fail 3');
    expect(attempts).toBe(3);
  });

  test('honors retryAfterMs from a rate_limit error over exponential backoff', async () => {
    let attempts = 0;
    const started = Date.now();
    // baseDelayMs 5000 would make the backoff path take >= 5s; retryAfterMs 0
    // completing quickly proves Retry-After took precedence.
    const result = await withRetry(async () => {
      attempts++;
      if (attempts === 1) {
        throw new ClassifiedProviderError('429', { kind: 'rate_limit', cause: null, retryAfterMs: 0 });
      }
      return 'ok';
    }, { baseDelayMs: 5000 });
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('per-attempt timeout aborts the attempt signal', async () => {
    let sawAbort = false;
    await expect(withRetry(async (signal) => {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => {
          sawAbort = true;
          reject(new ClassifiedProviderError('aborted attempt', { kind: 'unrecoverable', cause: null }));
        }, { once: true });
      });
    }, { perAttemptTimeoutMs: 20, maxRetries: 0 })).rejects.toThrow('aborted attempt');
    expect(sawAbort).toBe(true);
  });
});
