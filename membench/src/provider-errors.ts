/**
 * Classified provider errors — ported from claude-mem
 * src/services/worker/provider-errors.ts @ 132b46343 (body trimmed to the
 * kinds MemBench actually constructs; the native Error `cause` option
 * replaces the hand-declared field). The `kind` field drives retry gating
 * in retry.ts.
 */

export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid';

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
  }) {
    super(message, { cause: opts.cause });
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}
