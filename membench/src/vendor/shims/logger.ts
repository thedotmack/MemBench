// Shim for MemBench vendored files: no-op logger.
// Replaces claude-mem src/utils/logger.ts @ commit 132b46343 — the vendored
// prompts.ts/parser.ts call logger.debug/warn/error for diagnostics only.
export const logger = {
  debug(..._args: unknown[]): void {},
  info(..._args: unknown[]): void {},
  warn(..._args: unknown[]): void {},
  error(..._args: unknown[]): void {},
};
