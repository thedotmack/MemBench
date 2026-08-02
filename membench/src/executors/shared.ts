/**
 * Shared executor plumbing — plan Phase 5 (§0.2 guards 3-4).
 *
 * Both executor lanes need the same four things:
 *   - a minimal allowlisted spawn env (mirrors fork.ts's WORKER_ENV_ALLOWLIST
 *     approach: an ALLOWLIST, not a strip-list — a strip-list leaks every
 *     secret it didn't anticipate into the spawned process; no inherited
 *     ANTHROPIC_* / CLAUDE_* / OPENROUTER_* survives) with HOME pointed at
 *     the fork's isolated home (guard 4)
 *   - a timeout-killable subprocess runner: detached process group + group
 *     signal, with fork.ts's killWorkerTree (SIGTERM the whole tree, grace
 *     window, SIGKILL survivors) reused as the tree-walk fallback
 *   - `git -C <repoDir> diff` capture to the fork's diff_path
 *   - defensive number/output-cap helpers (guard 1: usage numbers are taken
 *     as reported or not at all — never derived)
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { killWorkerTree } from '../fork.js';
import type { ForkContext } from '../types.js';

/**
 * The ONLY parent-env keys a spawned benchmark child (executor CLI, bash
 * tool, claude-mem worker) inherits. An ALLOWLIST, not a strip-list: a
 * strip-list leaks every secret it didn't anticipate. LC_* passes as a
 * prefix (locale vars). fork.ts's buildWorkerEnv builds on the same baseline
 * via allowlistedParentEnv().
 */
const PARENT_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'SHELL',
  'USER',
  'LOGNAME',
  'TZ',
  'TERM',
]);

/** The allowlisted baseline copied from the parent environment. */
export function allowlistedParentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (PARENT_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) env[key] = value;
  }
  return env;
}

/**
 * Build the spawn env for an executor child process: allowlisted baseline +
 * HOME=<fork home> (guard 4: never the user's real HOME) + any deliberate
 * extras the orchestrator injects (e.g. CLI auth). Extras are explicit
 * arguments, never inherited — "NO inherited ANTHROPIC_* / CLAUDE_MEM_* except
 * what you set". Extras may NOT set HOME: that would defeat guard 4.
 */
export function buildExecEnv(homeDir: string, extraEnv?: Record<string, string>): Record<string, string> {
  if (extraEnv && 'HOME' in extraEnv) {
    throw new Error('extraEnv must not set HOME — the fork home is mandatory (guard 4)');
  }
  const env = allowlistedParentEnv();
  env.HOME = homeDir;
  return { ...env, ...extraEnv };
}

/**
 * The fork's root directory (<runs>/<run_id>/forks/<item>/<variant>/) —
 * prepareFork lays out homeDir as <forkDir>/home, so the parent of homeDir
 * is where executor artifacts (mcp config, transcript, diff) belong.
 */
export function forkRootDir(fork: ForkContext): string {
  return dirname(resolve(fork.homeDir));
}

// ---------------------------------------------------------------------------
// Timeout-killable subprocess runner
// ---------------------------------------------------------------------------

export interface RunWithTimeoutOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** SIGTERM → SIGKILL grace window. Default 3000ms. */
  gracefulKillMs?: number;
}

export interface RunWithTimeoutResult {
  outcome: 'exit' | 'timeout' | 'spawn-error';
  /** Set when outcome is "spawn-error". */
  spawnError?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone — exactly what a kill wants.
  }
}

/**
 * Run argv to completion or timeout, then kill the WHOLE process tree.
 *
 * The child is spawned detached (its own process group) so the timeout kill
 * can signal the group — a plain tree walk (pgrep of descendants) provably
 * races: a grandchild spawned between the walk and signal delivery is
 * reparented to PID 1 when its parent dies and survives holding the stdio
 * pipes (observed in tests as an execute() that blocked for the full length
 * of the orphan's sleep). Group-signal first, then fork.ts's killWorkerTree
 * tree walk as a fallback for members that moved themselves to a new group,
 * then a group SIGKILL for stragglers.
 *
 * Output is accumulated from data events and the post-exit pipe wait is
 * BOUNDED (2s), so even a survivor holding a pipe open can never wedge the
 * caller (row invariant, guard 3).
 */
export async function runWithTimeout(argv: string[], options: RunWithTimeoutOptions): Promise<RunWithTimeoutResult> {
  const { cwd, env, timeoutMs, gracefulKillMs = 3_000 } = options;
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<void>((resolveExited) => child.once('exit', () => resolveExited()));
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()));

  const outcome = await new Promise<'exit' | 'timeout' | Error>((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome('timeout'), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveOutcome('exit');
    });
    child.once('error', (error: Error) => {
      clearTimeout(timer);
      resolveOutcome(error);
    });
  });

  if (outcome instanceof Error) {
    return { outcome: 'spawn-error', spawnError: outcome.message, exitCode: null, stdout, stderr };
  }

  if (outcome === 'timeout') {
    const pid = child.pid;
    if (pid !== undefined) {
      signalGroup(pid, 'SIGTERM');
      await killWorkerTree(
        { pid, kill: (signal) => void child.kill(signal as NodeJS.Signals | undefined), exited },
        gracefulKillMs,
      );
      signalGroup(pid, 'SIGKILL');
    }
  }

  // Bounded pipe drain: normally 'close' follows 'exit' immediately; an
  // orphaned survivor holding the pipes must not block the row.
  let drainTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    closed,
    new Promise<void>((resolveDrain) => {
      drainTimer = setTimeout(resolveDrain, 2_000);
    }),
  ]);
  clearTimeout(drainTimer);

  // Group cleanup on EVERY path: a child the process left behind (e.g. a
  // backgrounded daemon) belongs to no one once the run is over — reap it so
  // it cannot write into the fork after teardown.
  if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');

  return { outcome, exitCode: child.exitCode, stdout, stderr };
}

/** A finite number exactly as reported, else undefined. Never coerced from strings. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Cap a text blob for tool output / transcript rows (~50KB default). */
export function capText(text: string, capBytes = 50_000): string {
  if (text.length <= capBytes) return text;
  return `${text.slice(0, capBytes)}\n[...truncated ${text.length - capBytes} of ${text.length} chars]`;
}

/** JSON-encode a value for a transcript row, capped so audit logs stay bounded. */
export function capJson(value: unknown, capBytes = 50_000): string {
  try {
    return capText(JSON.stringify(value) ?? String(value), capBytes);
  } catch {
    return capText(String(value), capBytes);
  }
}

export interface DiffCaptureResult {
  ok: boolean;
  error?: string;
}

/**
 * Capture the run's repo changes to diffPath. `git add -N -A` (intent-to-add)
 * runs first so NEW untracked files appear in `git diff` — a run whose whole
 * solution is a new file must not yield an empty diff. Always writes the file
 * (empty on failure) so every row has a diff artifact; reports failure
 * instead of throwing (row invariant, guard 3).
 */
export function captureGitDiff(repoDir: string, diffPath: string, baseSha?: string): DiffCaptureResult {
  try {
    // Best-effort: a failed intent-to-add still leaves the tracked-file diff.
    Bun.spawnSync(['git', '-C', repoDir, 'add', '-N', '-A'], { stdout: 'ignore', stderr: 'ignore' });
    // Diff the WORKTREE against the pinned base commit. A bare `git diff`
    // compares against HEAD, which silently returns EMPTY as soon as the agent
    // commits its work — measured on live-smoke-2, where a claude-cli run made
    // 13 edits + 2 writes (592 insertions), committed them, and produced a
    // 0-byte executor.diff that also suppressed the drift judge. Diffing
    // against the base sha captures committed, uncommitted and (via -N) new
    // files alike.
    const args = ['git', '-C', repoDir, 'diff'];
    if (baseSha) args.push(baseSha);
    const proc = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
    writeFileSync(diffPath, proc.exitCode === 0 ? proc.stdout : new Uint8Array());
    if (proc.exitCode !== 0) {
      return {
        ok: false,
        error: `git diff${baseSha ? ` ${baseSha}` : ''} exited ${proc.exitCode}: ${proc.stderr.toString().trim()}`,
      };
    }
    return { ok: true };
  } catch (error: unknown) {
    try {
      writeFileSync(diffPath, '');
    } catch {
      // The diff file itself could not be written; the returned error covers it.
    }
    return { ok: false, error: `git diff capture failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Uniform error → message helper for record.error fields. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Set record.error only when unset — the FIRST failure wins (guard 3). */
export function fail(record: { error?: string }, message: string): void {
  if (!record.error) record.error = message;
}

/**
 * Shared executor epilogue: capture the fork's git diff to
 * <forkDir>/executor.diff and note failure on the record without ever
 * throwing (row invariant, guard 3).
 */
export function captureDiffInto(
  record: { diff_path: string; error?: string },
  repoDir: string,
  forkDir: string,
  baseSha?: string,
): void {
  try {
    const diffPath = join(forkDir, 'executor.diff');
    const diff = captureGitDiff(repoDir, diffPath, baseSha);
    record.diff_path = diffPath;
    if (!diff.ok) fail(record, diff.error ?? 'diff capture failed');
  } catch (error: unknown) {
    fail(record, `diff capture failed: ${errorMessage(error)}`);
  }
}
