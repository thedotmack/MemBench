/**
 * Executor lane A — Claude Code CLI (plan Phase 5.1; §0.2 guards 3-5, 11).
 *
 * One fork-run = one headless `claude --print` invocation inside the fork's
 * pinned repo checkout, with:
 *   - HOME=<fork>/home (guard 4 — isolated-HOME pattern from
 *     evals/swebench/run-instance.sh:117,147 @ vancouver) and a minimal
 *     allowlisted env (shared.ts): no inherited ANTHROPIC_* / CLAUDE_* keys
 *   - flags verified against scripts/swebench/run.py:180-200 @ cancun-v1
 *     (`--print`, `--permission-mode bypassPermissions`, prompt positional,
 *     cwd = repo dir; guard 5: plugin/skill discovery stays enabled) plus
 *     `--output-format json` and `--session-id <uuid>` from
 *     run-instance.sh:110-158
 *   - mem-search via a per-fork MCP config registering server `mcp-search`
 *     (the production server name, CM plugin/.mcp.json @ 132b46343) pointed
 *     at THIS fork's worker: CLAUDE_MEM_WORKER_PORT/CLAUDE_MEM_DATA_DIR from
 *     the ForkContext and CLAUDE_MEM_RUNTIME=worker (guard 8)
 *   - a wall-clock timeout enforced by a process-group + tree kill
 *     (shared.ts runWithTimeout), yielding error:"timeout"
 *   - usage/cost taken ONLY from the CLI's JSON result (guard 1: missing →
 *     absent, never estimated), the session transcript retained from the
 *     isolated HOME, and `git -C <repo> diff` saved
 *
 * Row invariant (guard 3): execute() never throws — every path returns a
 * complete ExecutionRecord with error set on failure.
 *
 * Budget enforcement in THIS lane is wall-clock timeout only (plan-conformant:
 * the plan's CLI surface has no step/cost stop). max_steps and max_cost_usd
 * are enforced only in the openrouter-agent lane — Phase 6 must not assume
 * symmetric budget stops across lanes.
 *
 * The prompt is passed positionally after a `--` separator (verified against
 * the installed CLI: without `--` a prompt starting with `-` parses as an
 * unknown option; with `--` it is accepted as the prompt).
 */

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { loadConfig } from '../config.js';
import { readJsonl } from '../jsonl.js';
import type { Budget, ExecutionRecord, Executor, ForkContext } from '../types.js';
import {
  asFiniteNumber,
  buildExecEnv,
  captureGitDiff,
  errorMessage,
  forkRootDir,
  runWithTimeout,
} from './shared.js';

/** The three mem-search tools as the CLI sees them via the MCP server. */
const MEM_SEARCH_TOOL_USE_RE = /^mcp__mcp-search__(search|timeline|get_observations)$/;

export interface ClaudeCliExecutorOptions {
  /** Path to the claude binary (tests point this at a stub). Default: "claude". */
  claudeBin?: string;
  /** Claude-mem checkout root for the MCP server script. Default: config resolution. */
  claudeMemRoot?: string;
  /** Optional --model override (verified flag, run.py:189-190). */
  model?: string;
  /**
   * Deliberate env injections for the spawned CLI (e.g. auth for live runs).
   * Nothing is inherited from the parent env beyond the shared allowlist —
   * anything the CLI needs must be set explicitly here.
   */
  extraEnv?: Record<string, string>;
  /** SIGTERM→SIGKILL grace window for the timeout tree-kill. Default 3000ms. */
  gracefulKillMs?: number;
}

/**
 * Per-fork MCP config: production server name `mcp-search`, direct node
 * launch of the claude-mem MCP server script, env pinned to THIS fork's
 * worker (guard 8: CLAUDE_MEM_RUNTIME=worker so search cannot silently
 * reroute to another backend — CM mcp-server.ts:506-513).
 */
export function buildMcpConfig(fork: ForkContext, claudeMemRoot: string): Record<string, unknown> {
  return {
    mcpServers: {
      'mcp-search': {
        type: 'stdio',
        command: 'node',
        args: [join(claudeMemRoot, 'plugin', 'scripts', 'mcp-server.cjs')],
        env: {
          CLAUDE_MEM_WORKER_PORT: String(fork.workerPort),
          CLAUDE_MEM_DATA_DIR: fork.dataDir,
          CLAUDE_MEM_RUNTIME: 'worker',
        },
      },
    },
  };
}

/**
 * Count mem-search tool_use blocks in a retained session transcript:
 * assistant rows' message.content[] blocks of type "tool_use" whose name is
 * one of the three mcp__mcp-search__* tools.
 */
export function countMemSearchCalls(rows: unknown[]): number {
  let count = 0;
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const message = (row as { message?: unknown }).message;
    if (typeof message !== 'object' || message === null) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const { type, name } = block as { type?: unknown; name?: unknown };
      if (type === 'tool_use' && typeof name === 'string' && MEM_SEARCH_TOOL_USE_RE.test(name)) {
        count++;
      }
    }
  }
  return count;
}

/**
 * Locate the session transcript the CLI wrote under the isolated HOME:
 * <home>/.claude/projects/<path-encoded-cwd>/<sessionId>.jsonl. The project
 * dir encoding is lossy (plan §0.1), so search by filename instead of
 * re-deriving the encoded path.
 */
export function findSessionTranscript(homeDir: string, sessionId: string): string | undefined {
  const projectsDir = join(homeDir, '.claude', 'projects');
  if (!existsSync(projectsDir)) return undefined;
  const needle = `${sessionId}.jsonl`;
  let entries: string[];
  try {
    entries = (readdirSync(projectsDir, { recursive: true }) as unknown[]).map(String);
  } catch {
    return undefined;
  }
  const hit = entries.find((entry) => entry === needle || entry.endsWith(sep + needle));
  return hit ? join(projectsDir, hit) : undefined;
}

interface CliJsonResult {
  output?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  isError: boolean;
  subtype?: string;
}

/**
 * Defensive parse of the CLI's `--output-format json` stdout. Fields are read
 * as reported (result, usage.input_tokens/output_tokens, total_cost_usd) —
 * anything missing or non-numeric stays absent (guard 1: never fabricate).
 * Falls back to parsing the last non-empty stdout line in case the CLI ever
 * mixes log lines into stdout.
 */
export function parseCliJsonOutput(stdout: string): CliJsonResult | undefined {
  const candidates = [stdout.trim()];
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1];
  if (lastLine !== undefined && lastLine !== candidates[0]) candidates.push(lastLine);

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const usage =
      typeof record.usage === 'object' && record.usage !== null
        ? (record.usage as Record<string, unknown>)
        : undefined;
    const result: CliJsonResult = { isError: record.is_error === true };
    if (typeof record.result === 'string') result.output = record.result;
    if (typeof record.subtype === 'string') result.subtype = record.subtype;
    const tokensIn = asFiniteNumber(usage?.input_tokens);
    const tokensOut = asFiniteNumber(usage?.output_tokens);
    const costUsd = asFiniteNumber(record.total_cost_usd);
    if (tokensIn !== undefined) result.tokensIn = tokensIn;
    if (tokensOut !== undefined) result.tokensOut = tokensOut;
    if (costUsd !== undefined) result.costUsd = costUsd;
    return result;
  }
  return undefined;
}

/** Executor lane A: one headless claude CLI run per fork. */
export function createClaudeCliExecutor(options: ClaudeCliExecutorOptions = {}): Executor {
  const {
    claudeBin = 'claude',
    claudeMemRoot = loadConfig().claudeMemRoot,
    model,
    extraEnv,
    gracefulKillMs = 3_000,
  } = options;

  return {
    async execute(fork: ForkContext, prompt: string, budget: Budget): Promise<ExecutionRecord> {
      const forkDir = forkRootDir(fork);
      const record: ExecutionRecord = {
        output: '',
        mem_search_calls: 0,
        transcript_path: '',
        diff_path: '',
      };
      const sessionId = randomUUID();

      try {
        // Per-fork MCP config (written before spawn so --mcp-config can load it).
        const mcpConfigPath = join(forkDir, 'mcp-config.json');
        writeFileSync(mcpConfigPath, JSON.stringify(buildMcpConfig(fork, claudeMemRoot), null, 2));

        const argv = [
          claudeBin,
          '--print',
          '--output-format',
          'json',
          '--permission-mode',
          'bypassPermissions',
          '--session-id',
          sessionId,
          '--mcp-config',
          mcpConfigPath,
          ...(model ? ['--model', model] : []),
          '--',
          prompt,
        ];

        const run = await runWithTimeout(argv, {
          cwd: fork.repoDir,
          env: buildExecEnv(fork.homeDir, extraEnv),
          timeoutMs: budget.timeout_s * 1000,
          gracefulKillMs,
        });

        if (run.outcome === 'timeout') {
          record.error = 'timeout';
        } else if (run.outcome === 'spawn-error') {
          record.error = `claude spawn failed: ${run.spawnError ?? 'unknown'}`;
        } else {
          const parsed = parseCliJsonOutput(run.stdout);
          record.output = parsed?.output ?? run.stdout;
          if (parsed?.tokensIn !== undefined) record.tokens_in = parsed.tokensIn;
          if (parsed?.tokensOut !== undefined) record.tokens_out = parsed.tokensOut;
          if (parsed?.costUsd !== undefined) record.cost_usd = parsed.costUsd;
          if (run.exitCode !== 0) {
            record.error = `claude exited ${run.exitCode}: ${run.stderr.trim().slice(0, 500)}`;
          } else if (parsed === undefined) {
            record.error = 'claude produced no parseable JSON result';
          } else if (parsed.isError) {
            record.error = `claude reported is_error (subtype: ${parsed.subtype ?? 'unknown'})`;
          }
        }
      } catch (error: unknown) {
        if (!record.error) record.error = errorMessage(error);
      } finally {
        // Artifact retention runs on every path (success, error, timeout) and
        // must never lose the row (guard 3).
        try {
          const diffPath = join(forkDir, 'executor.diff');
          const diff = captureGitDiff(fork.repoDir, diffPath);
          record.diff_path = diffPath;
          if (!diff.ok && !record.error) record.error = diff.error ?? 'diff capture failed';
        } catch (error: unknown) {
          if (!record.error) record.error = `diff capture failed: ${errorMessage(error)}`;
        }

        try {
          const source = findSessionTranscript(fork.homeDir, sessionId);
          if (source) {
            const transcriptPath = join(forkDir, 'session-transcript.jsonl');
            copyFileSync(source, transcriptPath);
            record.transcript_path = transcriptPath;
            record.mem_search_calls = countMemSearchCalls(await readJsonl(transcriptPath));
          } else if (!record.error) {
            // A successful run MUST leave a session transcript — a CLI layout
            // change that hides it would otherwise silently zero
            // mem_search_calls for the whole lane.
            record.error = 'session transcript not found under fork HOME';
          }
        } catch (error: unknown) {
          if (!record.error) record.error = `transcript retention failed: ${errorMessage(error)}`;
        }
      }

      return record;
    },
  };
}
