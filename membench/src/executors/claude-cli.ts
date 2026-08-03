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
 *   - cost taken ONLY from the CLI's JSON result `total_cost_usd` (guard 1:
 *     missing → absent, never estimated); TOKENS are summed per turn off the
 *     RETAINED session transcript instead (sumTranscriptUsage), because the
 *     result block reports only the last turn and omits cache tokens. The
 *     result-block token numbers are a fallback used only when no transcript
 *     was retained. NOTE: token semantics are LANE-SPECIFIC — this lane counts
 *     cache-creation + cache-read prompt tokens, while the openrouter-agent
 *     lane reports OpenRouter's prompt/completion counts. That asymmetry is
 *     one more reason the scoreboard never puts two lanes in the same cell.
 *   - the session transcript retained from the isolated HOME, and the diff
 *     saved as `git diff <pinned base sha>` (NOT bare `git diff`, which goes
 *     empty the moment the agent commits its work)
 *   - auth seeded into the fork HOME before spawn and DELETED in the finally
 *     block, so live OAuth tokens never persist in a kept fork dir
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
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { loadConfig } from '../config.js';
import { readJsonl } from '../jsonl.js';
import type { Budget, ExecutionRecord, Executor, ForkContext } from '../types.js';
import {
  asFiniteNumber,
  buildExecEnv,
  captureDiffInto,
  errorMessage,
  fail,
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
  /**
   * Contents of a Claude Code `.credentials.json` to seed into the fork HOME
   * before spawning (see seedClaudeCredentials). Injected by the caller —
   * resolveClaudeCredentials() does the host lookup — so this module stays
   * pure and offline tests can pass a fixture (or omit it entirely).
   */
  credentialsJson?: string;
}

/** Keychain service holding Claude Code's OAuth credentials on macOS. */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Seed the isolated fork HOME with the MINIMUM Claude Code needs to
 * authenticate: a single `<home>/.claude/.credentials.json`, mode 600
 * (the CLI checks permissions), containing only the `claudeAiOauth` object.
 *
 * Pattern ported from SWB evals/swebench/run-instance.sh:55-61 @ vancouver
 * (cp creds → $CLAUDE_DIR/.credentials.json; chmod 600).
 *
 * Guard 4 stays intact: nothing else from the real ~/.claude is copied — no
 * history.jsonl, no projects/, no settings, no agents. Verified on macOS
 * 2026-08-01 that this one file is sufficient: the CLI authenticates without
 * ~/.claude.json (no oauthAccount/userID/onboarding keys required).
 */
export function seedClaudeCredentials(homeDir: string, credentialsJson: string): string {
  const dir = join(homeDir, '.claude');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, '.credentials.json');
  // mode on write covers the create case; the CLI rejects group/other-readable
  // credential files, and a fork HOME is freshly created so no chmod race.
  writeFileSync(path, credentialsJson, { mode: 0o600 });
  return path;
}

/**
 * Resolve Claude Code OAuth credentials from the HOST, for seeding into fork
 * homes. Returns a JSON string carrying ONLY `claudeAiOauth` (the `mcpOAuth`
 * blob that shares the keychain item is deliberately dropped — fork runs must
 * not inherit the user's MCP server tokens), or null when nothing is found.
 *
 * Lookup order:
 *   1. MEMBENCH_CLAUDE_CREDENTIALS_FILE — explicit override (mirrors SWB's
 *      CLAUDE_MEM_CREDENTIALS_FILE contract, run-instance.sh:31-39)
 *   2. macOS Keychain, service "Claude Code-credentials", account = $USER.
 *      The account matters: this machine also has a second item under the
 *      SAME service with account "unknown" holding only mcpOAuth, and a
 *      lookup without -a returns that one (SWB's run-batch.py:86-101 omits
 *      -a and would mis-resolve here).
 *   3. ~/.claude/.credentials.json (Linux, and macOS installs without keychain)
 */
export function resolveClaudeCredentials(): string | null {
  const pick = (raw: string): string | null => {
    try {
      const parsed = JSON.parse(raw) as { claudeAiOauth?: unknown };
      if (!parsed || typeof parsed !== 'object' || !parsed.claudeAiOauth) return null;
      return JSON.stringify({ claudeAiOauth: parsed.claudeAiOauth });
    } catch {
      return null;
    }
  };

  const override = process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE;
  if (override) {
    if (!existsSync(override)) return null;
    return pick(readFileSync(override, 'utf8'));
  }

  if (process.platform === 'darwin') {
    try {
      const account = process.env.USER ?? process.env.LOGNAME ?? '';
      const args = ['find-generic-password', '-s', KEYCHAIN_SERVICE];
      if (account) args.push('-a', account);
      args.push('-w');
      const out = execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const picked = pick(out.trim());
      if (picked) return picked;
    } catch {
      // fall through to the on-disk form
    }
  }

  const file = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(file)) return pick(readFileSync(file, 'utf8'));
  return null;
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
  const candidates = [stdout.trim(), stdout.trimEnd().split('\n').at(-1) ?? ''];

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

/** Per-turn usage summed off the retained session transcript. */
export interface TranscriptUsage {
  tokensIn?: number;
  tokensOut?: number;
}

/**
 * Sum usage across a retained session transcript, ONCE PER ASSISTANT MESSAGE.
 *
 * Two independent traps here, both measured on live-smoke-1's oracle fork:
 *
 * 1. The CLI's final result block reports only the LAST assistant turn's
 *    uncached input and omits cache tokens entirely, so it cannot serve as a
 *    session total: it said input_tokens=70 where the session truly consumed
 *    259,558 prompt tokens. Prompt tokens are therefore summed as
 *    input + cache_creation + cache_read — cached tokens are still tokens the
 *    model had to be given, and cache-creation volume scales with the size of
 *    the injected memory block, so dropping them biases tokens-to-done
 *    differently per variant.
 *
 * 2. Claude Code writes ONE TRANSCRIPT ROW PER CONTENT BLOCK (thinking, text,
 *    tool_use), and every row of a group repeats the SAME `message.usage`.
 *    Summing per row therefore multiplies a turn by its block count: that
 *    oracle fork has 25 usage-bearing rows for only 8 distinct messages and
 *    naive summing reported 806,344 / 6,698 against a true 259,558 / 2,296
 *    (3.11x / 2.92x). The inflation factor is the mean blocks-per-message,
 *    which VARIES BY VARIANT (measured +100% to +211% across forks), so it
 *    does not even cancel out as a constant — it silently reorders the
 *    headline metric. Usage is consequently counted once per distinct
 *    `message.id`; `requestId` agrees as a cross-check, and rows carrying no
 *    `message.id` are counted individually (nothing to group them by).
 *
 * NOTE: this dedupe is deliberately NOT applied to countMemSearchCalls — each
 * split row carries exactly ONE content block, so a group's tool_use lives in
 * its last row alone; deduping there would drop real search calls (verified:
 * 6 -> 0 on this same fork).
 *
 * Guard 1: a turn missing a component contributes nothing for it; if NO turn
 * carries usage at all, the field stays undefined rather than a fabricated 0.
 */
export function sumTranscriptUsage(rows: unknown[]): TranscriptUsage {
  let tokensIn = 0;
  let tokensOut = 0;
  let sawIn = false;
  let sawOut = false;
  const countedMessageIds = new Set<string>();

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const message = (row as { message?: unknown }).message;
    const holder =
      typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : (row as Record<string, unknown>);
    const usage = holder.usage;
    if (typeof usage !== 'object' || usage === null) continue;

    // One assistant message = one billed turn, however many content-block rows
    // it was split across. An id-less row has nothing to group by, so it counts
    // on its own rather than being silently dropped.
    const messageId = holder.id;
    if (typeof messageId === 'string' && messageId !== '') {
      if (countedMessageIds.has(messageId)) continue;
      countedMessageIds.add(messageId);
    }

    const u = usage as Record<string, unknown>;
    for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
      const value = asFiniteNumber(u[key]);
      if (value !== undefined) {
        tokensIn += value;
        sawIn = true;
      }
    }
    const out = asFiniteNumber(u.output_tokens);
    if (out !== undefined) {
      tokensOut += out;
      sawOut = true;
    }
  }

  const result: TranscriptUsage = {};
  if (sawIn) result.tokensIn = tokensIn;
  if (sawOut) result.tokensOut = tokensOut;
  return result;
}

/** Executor lane A: one headless claude CLI run per fork. */
export function createClaudeCliExecutor(options: ClaudeCliExecutorOptions = {}): Executor {
  const {
    claudeBin = 'claude',
    claudeMemRoot = loadConfig().claudeMemRoot,
    model,
    extraEnv,
    gracefulKillMs = 3_000,
    credentialsJson,
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
        // Auth for the isolated HOME (guard 4 keeps the real ~/.claude out of
        // reach, so the CLI would otherwise fail "Not logged in · /login").
        if (credentialsJson) seedClaudeCredentials(fork.homeDir, credentialsJson);

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
        fail(record, errorMessage(error));
      } finally {
        // Artifact retention runs on every path (success, error, timeout) and
        // must never lose the row (guard 3).
        captureDiffInto(record, fork.repoDir, forkDir, fork.baseSha);

        try {
          const source = findSessionTranscript(fork.homeDir, sessionId);
          if (source) {
            const transcriptPath = join(forkDir, 'session-transcript.jsonl');
            copyFileSync(source, transcriptPath);
            record.transcript_path = transcriptPath;
            const rows = await readJsonl(transcriptPath);
            record.mem_search_calls = countMemSearchCalls(rows);
            // The retained transcript is AUTHORITATIVE for usage: it carries
            // per-turn numbers including cache tokens, where the final result
            // block reports only the last turn without them. When a transcript
            // exists but no turn carries usage, the fields go back to undefined
            // rather than keeping the misleading result-block values (guard 1).
            const usage = sumTranscriptUsage(rows);
            if (usage.tokensIn !== undefined) record.tokens_in = usage.tokensIn;
            else delete record.tokens_in;
            if (usage.tokensOut !== undefined) record.tokens_out = usage.tokensOut;
            else delete record.tokens_out;
          } else {
            // A successful run MUST leave a session transcript — a CLI layout
            // change that hides it would otherwise silently zero
            // mem_search_calls for the whole lane.
            fail(record, 'session transcript not found under fork HOME');
          }
        } catch (error: unknown) {
          fail(record, `transcript retention failed: ${errorMessage(error)}`);
        }

        // Live OAuth credentials must never outlive the run that needed them.
        // Fork dirs are routinely KEPT for audit (transcript/diff), so this
        // cannot be left to fork teardown — the one seeded file is removed
        // here on every path (success, error, timeout) while the rest of the
        // audit trail stays intact.
        if (credentialsJson) {
          try {
            rmSync(join(fork.homeDir, '.claude', '.credentials.json'), { force: true });
          } catch (error: unknown) {
            fail(record, `credential cleanup failed: ${errorMessage(error)}`);
          }
        }
      }

      return record;
    },
  };
}
