/**
 * Flat MemBench config. Precedence: CLI flag > env > default, via the
 * `flag ?? Bun.env.X ?? DEFAULT` idiom (layered-precedence reference:
 * claude-mem src/shared/SettingsDefaultsManager.ts:204,212-263 @ 132b46343,
 * where env overrides are applied last over file values over defaults).
 *
 * These keys live OUTSIDE run specs (secrets / machine-local):
 *   OPENROUTER_API_KEY  — secret; env-only, no flag, no default
 *   CLAUDE_MEM_ROOT     — claude-mem checkout the workers spawn from
 *   MEMBENCH_RUNS_DIR   — where raw (gitignored) run artifacts go
 */

export const DEFAULT_CLAUDE_MEM_ROOT = '/Users/alexnewman/Scripts/claude-mem';
export const DEFAULT_RUNS_DIR = 'runs';

/** CLI flags that may override env/default config values. */
export interface ConfigFlags {
  /** --claude-mem-root */
  claudeMemRoot?: string;
  /** --runs-dir */
  runsDir?: string;
}

export interface Config {
  /** undefined when unset (offline mode / tests — no network calls possible). */
  openrouterApiKey: string | undefined;
  claudeMemRoot: string;
  runsDir: string;
}

/**
 * Resolve the flat config. `env` is injectable for tests; it defaults to the
 * process environment.
 */
export function loadConfig(
  flags: ConfigFlags = {},
  env: Record<string, string | undefined> = Bun.env,
): Config {
  return {
    openrouterApiKey: env.OPENROUTER_API_KEY,
    claudeMemRoot: flags.claudeMemRoot ?? env.CLAUDE_MEM_ROOT ?? DEFAULT_CLAUDE_MEM_ROOT,
    runsDir: flags.runsDir ?? env.MEMBENCH_RUNS_DIR ?? DEFAULT_RUNS_DIR,
  };
}
