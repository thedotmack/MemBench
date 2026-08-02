/**
 * Classified provider errors — ported from claude-mem
 * src/services/worker/provider-errors.ts @ 132b46343 (verbatim body; only
 * this header differs). The `kind` field drives retry gating in retry.ts.
 */

// F4 foundation: classified provider errors with extensible kind field.
export type ProviderErrorClass =
  | 'transient'
  | 'unrecoverable'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'auth_invalid'
  | 'setup_required'
  | (string & {}); // open union: providers may emit custom kinds

export class ClassifiedProviderError extends Error {
  readonly kind: ProviderErrorClass;
  readonly retryAfterMs?: number;
  readonly cause: unknown;

  constructor(message: string, opts: {
    kind: ProviderErrorClass;
    cause: unknown;
    retryAfterMs?: number;
  }) {
    super(message);
    this.name = 'ClassifiedProviderError';
    this.kind = opts.kind;
    this.cause = opts.cause;
    if (opts.retryAfterMs !== undefined) {
      this.retryAfterMs = opts.retryAfterMs;
    }
  }
}

export function isClassified(err: unknown): err is ClassifiedProviderError {
  return err instanceof ClassifiedProviderError;
}
