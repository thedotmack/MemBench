/**
 * Executor lane B — minimal coding agent on @openrouter/agent 0.8.0
 * (plan Phase 5.2; §0.1 "OpenRouter Agent SDK"; §0.2 guards 1-4, 11).
 *
 * Verified against the installed package (0.8.0, bun.lock integrity match):
 *   - construction: `new OpenRouter({ apiKey, retryConfig, httpClient? })`
 *     (openrouter.d.ts:23-28; SDKOptions from @openrouter/sdk/lib/config —
 *     `httpClient` is the transport-injection seam tests use)
 *   - loop: `client.callModel({ model, input, tools, stopWhen, hooks, ... })`
 *     returning a ModelResult consumed via getText()/getResponse()/cancel()
 *   - tools: `tool({ name, description, inputSchema: z.object(...), execute })`
 *     (tool.d.ts; zod v4 schemas — zod is the SDK's own dependency)
 *   - stop conditions: `stepCountIs(n)` and `maxCost(usd)` BOTH exist in
 *     0.8.0 (stop-conditions.d.ts:12,67) — exactly as the plan describes.
 *     Verified loop semantics: one "step" = a tool round PLUS its follow-up
 *     model call, and stopWhen is evaluated after that follow-up lands — so
 *     a stop costs steps+1 model calls (inherent SDK overshoot) and pending
 *     tool calls in the halted turn are never executed.
 *     `allowFinalResponse: false` disables the SDK's default extra
 *     post-stop model turn so a budget stop spends nothing further.
 *   - lifecycle hooks (hooks-types.d.ts InlineHookConfig): PreToolUse (native
 *     mem_search_calls counting via matcher), PostToolUse/PostToolUseFailure
 *     (transcript rows), PostModelCall (per-model-call usage:
 *     {inputTokens, outputTokens, totalTokens, cachedTokens, reasoningTokens,
 *     cost?} — cost only when the server reported it)
 *
 * Usage discipline (guard 1): tokens/cost accumulate ONLY from reported
 * PostModelCall usage payloads; when nothing was reported the record fields
 * stay absent. No pricing constants, no token splits. The transcript's final
 * `result` row also carries model_calls vs cost_reporting_model_calls (when
 * they differ, cost_usd is a floor, not the total) and, when the accumulated
 * reported spend ended up over budget.max_cost_usd despite the maxCost stop,
 * budget_exceeded plus the cap and the actual spend.
 *
 * Row invariant (guard 3): execute() never throws — timeout, spawn failure,
 * SDK throw and budget stop all return a complete ExecutionRecord.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import {
  OpenRouter,
  maxCost,
  stepCountIs,
  tool,
  type InlineHookConfig,
  type Tool,
} from '@openrouter/agent';
import { z } from 'zod';
import { appendJsonl } from '../jsonl.js';
import type { Budget, ExecutionRecord, Executor, ForkContext } from '../types.js';
import {
  asFiniteNumber,
  buildExecEnv,
  capJson,
  capText,
  captureGitDiff,
  errorMessage,
  forkRootDir,
  runWithTimeout,
} from './shared.js';

/** The mem-search surface, same tool names as the production MCP server. */
const MEM_SEARCH_TOOL_RE = /^(search|timeline|get_observations)$/;

class ExecutorTimeout extends Error {
  constructor() {
    super('timeout');
  }
}

export class ToolPathError extends Error {}

/**
 * Realpath the deepest EXISTING ancestor of a path, then re-append the
 * not-yet-created suffix — so containment can be checked on real paths even
 * for files a tool is about to create.
 */
function realpathExisting(path: string): string {
  let current = path;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    suffix.unshift(basename(current));
    current = parent;
  }
  let real: string;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return suffix.length > 0 ? join(real, ...suffix) : real;
}

/**
 * Resolve a model-supplied path against the repo root and reject anything
 * that escapes it: `..` traversal, absolute paths outside the repo, AND
 * in-repo symlinks pointing outside (containment is checked on realpaths of
 * the existing portion of both sides). Cloned task repos can legitimately
 * contain symlinks; file-tool containment is benchmark honesty — every edit
 * must land inside the repo so it shows up in the captured diff. The bash
 * tool remains unsandboxed by design (cwd-locked only).
 */
export function resolveInRepo(repoDir: string, candidate: string): string {
  const root = resolve(repoDir);
  const target = resolve(root, candidate);
  const realRoot = realpathExisting(root);
  const realTarget = realpathExisting(target);
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new ToolPathError(`path escapes the repository root: ${candidate}`);
  }
  return target;
}

export interface CodingToolOptions {
  /** Spawn env for the bash tool (allowlisted; HOME = fork home). */
  env: Record<string, string>;
  /** Per-command bash timeout. Default 120s. */
  bashTimeoutMs?: number;
  /** Output cap for tool results fed back to the model. Default ~50KB. */
  outputCapBytes?: number;
  /** SIGTERM→SIGKILL grace for bash timeout kills. Default 2000ms. */
  gracefulKillMs?: number;
}

/**
 * The four coding tools, all locked to the fork's repo checkout: bash runs
 * with cwd = repoDir; the file tools resolve every path through
 * resolveInRepo. Returned keyed by name so tests can drive execute() direct.
 */
export function buildCodingTools(repoDir: string, options: CodingToolOptions) {
  const { env, bashTimeoutMs = 120_000, outputCapBytes = 50_000, gracefulKillMs = 2_000 } = options;

  const bash = tool({
    name: 'bash',
    description:
      'Run a shell command in the repository root. Returns exit_code, stdout and stderr (output capped).',
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }: { command: string }) => {
      const run = await runWithTimeout(['bash', '-c', command], {
        cwd: repoDir,
        env,
        timeoutMs: bashTimeoutMs,
        gracefulKillMs,
      });
      if (run.outcome === 'spawn-error') {
        throw new Error(`bash spawn failed: ${run.spawnError ?? 'unknown'}`);
      }
      return {
        exit_code: run.exitCode,
        timed_out: run.outcome === 'timeout',
        stdout: capText(run.stdout, outputCapBytes),
        stderr: capText(run.stderr, outputCapBytes),
      };
    },
  });

  const readFile = tool({
    name: 'read_file',
    description: 'Read a file inside the repository. Path is relative to the repository root.',
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }: { path: string }) => {
      const target = resolveInRepo(repoDir, path);
      if (!existsSync(target)) throw new Error(`file not found: ${path}`);
      return { path, content: capText(readFileSync(target, 'utf-8'), outputCapBytes) };
    },
  });

  const writeFile = tool({
    name: 'write_file',
    description:
      'Create or overwrite a file inside the repository. Path is relative to the repository root.',
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }: { path: string; content: string }) => {
      const target = resolveInRepo(repoDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return { ok: true, path: relative(resolve(repoDir), target) };
    },
  });

  const editFile = tool({
    name: 'edit_file',
    description:
      'Exact string replacement in a repository file. old_string must occur exactly once unless replace_all is true.',
    inputSchema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      replace_all: z.boolean().optional(),
    }),
    execute: async ({
      path,
      old_string,
      new_string,
      replace_all,
    }: {
      path: string;
      old_string: string;
      new_string: string;
      replace_all?: boolean | undefined;
    }) => {
      const target = resolveInRepo(repoDir, path);
      if (!existsSync(target)) throw new Error(`file not found: ${path}`);
      if (old_string === '') throw new Error('old_string must not be empty');
      const original = readFileSync(target, 'utf-8');
      const occurrences = original.split(old_string).length - 1;
      if (occurrences === 0) throw new Error(`old_string not found in ${path}`);
      if (occurrences > 1 && !replace_all) {
        throw new Error(`old_string occurs ${occurrences} times in ${path}; pass replace_all or a unique string`);
      }
      const updated = replace_all
        ? original.split(old_string).join(new_string)
        : original.replace(old_string, new_string);
      writeFileSync(target, updated);
      return { ok: true, replacements: replace_all ? occurrences : 1 };
    },
  });

  return { bash, read_file: readFile, write_file: writeFile, edit_file: editFile };
}

async function workerGet(port: number, path: string, params: Record<string, unknown>): Promise<unknown> {
  // Param passing mirrors the production MCP server's callWorker (CM
  // mcp-server.ts:86-93 @ 132b46343): every defined arg becomes a query
  // param, String()-coerced; null/undefined are dropped.
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) searchParams.append(key, String(value));
  }
  const response = await fetch(`http://127.0.0.1:${port}${path}?${searchParams}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`worker ${path} failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

async function workerPost(port: number, path: string, body: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`worker ${path} failed (${response.status}): ${await response.text()}`);
  }
  return await response.json();
}

/**
 * The mem-search tools — named exactly like the production MCP surface
 * (search / timeline / get_observations) and implemented as direct HTTP to
 * the fork's worker, mirroring the MCP server's thin proxying
 * (CM mcp-server.ts:474-558 @ 132b46343): GET /api/search, GET /api/timeline,
 * POST /api/observations/batch. Schemas mirror the MCP inputSchema params.
 */
export function buildMemSearchTools(workerPort: number) {
  const search = tool({
    name: 'search',
    description:
      'Step 1: Search memory. Returns index with IDs. Params: query, limit, project, platformSource, type, obs_type, dateStart, dateEnd, offset, orderBy',
    inputSchema: z.object({
      query: z.string().optional(),
      limit: z.number().optional(),
      project: z.string().optional(),
      platformSource: z.string().optional(),
      type: z.string().optional(),
      obs_type: z.string().optional(),
      dateStart: z.string().optional(),
      dateEnd: z.string().optional(),
      offset: z.number().optional(),
      orderBy: z.string().optional(),
    }),
    execute: async (params: Record<string, unknown>) => workerGet(workerPort, '/api/search', params),
  });

  const timeline = tool({
    name: 'timeline',
    description:
      'Step 2: Get context around results. Params: anchor (observation ID) OR query (finds anchor automatically), depth_before, depth_after, project',
    inputSchema: z.object({
      anchor: z.number().optional(),
      query: z.string().optional(),
      depth_before: z.number().optional(),
      depth_after: z.number().optional(),
      project: z.string().optional(),
    }),
    execute: async (params: Record<string, unknown>) => workerGet(workerPort, '/api/timeline', params),
  });

  const getObservations = tool({
    name: 'get_observations',
    description:
      'Step 3: Fetch full details for filtered IDs. Params: ids (array of observation IDs, required)',
    inputSchema: z.object({ ids: z.array(z.number()) }),
    execute: async (params: { ids: number[] }) =>
      workerPost(workerPort, '/api/observations/batch', params),
  });

  return { search, timeline, get_observations: getObservations };
}

export interface OpenRouterAgentExecutorOptions {
  /** Executor model id from the run spec (any OpenRouter model). */
  model: string;
  /** Defaults to OPENROUTER_API_KEY from the environment (ignored when `client` is given). */
  apiKey?: string;
  /**
   * Test seam: a prebuilt OpenRouter client (e.g. with an httpClient whose
   * fetcher is mocked). When absent a real client is constructed.
   */
  client?: OpenRouter;
  /** Per-command bash tool timeout. Default 120s. */
  bashTimeoutMs?: number;
  /** Cap for tool outputs and transcript payload rows. Default ~50KB. */
  outputCapBytes?: number;
}

/** Executor lane B: one @openrouter/agent tool loop per fork. */
export function createOpenRouterAgentExecutor(options: OpenRouterAgentExecutorOptions): Executor {
  const { model, bashTimeoutMs, outputCapBytes = 50_000 } = options;

  return {
    async execute(fork: ForkContext, prompt: string, budget: Budget): Promise<ExecutionRecord> {
      const forkDir = forkRootDir(fork);
      const transcriptPath = join(forkDir, 'agent-transcript.jsonl');
      const record: ExecutionRecord = {
        output: '',
        mem_search_calls: 0,
        transcript_path: transcriptPath,
        diff_path: '',
      };

      // Reported-usage accumulator (guard 1): totals exist only when at least
      // one PostModelCall carried usage; cost only when the server reported it.
      // modelCalls/costReportingCalls make partial cost visible — when only
      // some calls came back with a cost, cost_usd is a floor, not the total.
      const totals = {
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        usageSeen: false,
        costSeen: false,
        modelCalls: 0,
        costReportingCalls: 0,
      };
      let memSearchCalls = 0;
      let result: ReturnType<OpenRouter['callModel']> | undefined;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      try {
        const client =
          options.client ??
          (() => {
            const apiKey = options.apiKey ?? Bun.env.OPENROUTER_API_KEY;
            if (!apiKey) {
              throw new Error('OPENROUTER_API_KEY not set — cannot run the openrouter-agent executor');
            }
            // Deterministic budget behavior: a failed request is an error row,
            // not an unbounded SDK-internal backoff loop.
            return new OpenRouter({ apiKey, retryConfig: { strategy: 'none' } });
          })();

        const coding = buildCodingTools(fork.repoDir, {
          env: buildExecEnv(fork.homeDir),
          ...(bashTimeoutMs !== undefined ? { bashTimeoutMs } : {}),
          outputCapBytes,
        });
        const memSearch = buildMemSearchTools(fork.workerPort);
        const tools: Tool[] = [
          coding.bash,
          coding.read_file,
          coding.write_file,
          coding.edit_file,
          memSearch.search,
          memSearch.timeline,
          memSearch.get_observations,
        ];

        const hooks: InlineHookConfig = {
          PreToolUse: [
            {
              matcher: MEM_SEARCH_TOOL_RE,
              handler: () => {
                memSearchCalls += 1;
              },
            },
            {
              handler: (payload) =>
                appendJsonl(transcriptPath, {
                  type: 'tool_call',
                  at: Date.now(),
                  tool: payload.toolName,
                  input: capJson(payload.toolInput, outputCapBytes),
                }),
            },
          ],
          PostToolUse: [
            {
              handler: (payload) =>
                appendJsonl(transcriptPath, {
                  type: 'tool_result',
                  at: Date.now(),
                  tool: payload.toolName,
                  duration_ms: payload.durationMs,
                  output: capJson(payload.toolOutput, outputCapBytes),
                }),
            },
          ],
          PostToolUseFailure: [
            {
              handler: (payload) =>
                appendJsonl(transcriptPath, {
                  type: 'tool_failure',
                  at: Date.now(),
                  tool: payload.toolName,
                  error: capJson(errorMessage(payload.error), outputCapBytes),
                }),
            },
          ],
          PostModelCall: [
            {
              handler: (payload) => {
                totals.modelCalls += 1;
                const usage = payload.usage;
                if (usage) {
                  // Every field is taken through asFiniteNumber (parity with
                  // the CLI lane): a NaN/absent count must not poison the sum
                  // into NaN, and nothing is coerced from a string (guard 1).
                  const inputTokens = asFiniteNumber(usage.inputTokens);
                  const outputTokens = asFiniteNumber(usage.outputTokens);
                  if (inputTokens !== undefined || outputTokens !== undefined) {
                    totals.usageSeen = true;
                    totals.tokensIn += inputTokens ?? 0;
                    totals.tokensOut += outputTokens ?? 0;
                  }
                  const cost = asFiniteNumber(usage.cost);
                  if (cost !== undefined) {
                    totals.costSeen = true;
                    totals.costReportingCalls += 1;
                    totals.cost += cost;
                  }
                }
                return appendJsonl(transcriptPath, {
                  type: 'model_call',
                  at: Date.now(),
                  response_id: payload.responseId,
                  model: payload.model,
                  turn_type: payload.turnType,
                  turn_number: payload.turnNumber,
                  duration_ms: payload.durationMs,
                  usage: usage ?? null,
                });
              },
            },
          ],
        };

        await appendJsonl(transcriptPath, {
          type: 'prompt',
          at: Date.now(),
          model,
          max_steps: budget.max_steps,
          max_cost_usd: budget.max_cost_usd,
          timeout_s: budget.timeout_s,
          input: prompt,
        });

        result = client.callModel({
          model,
          input: prompt,
          tools,
          // Budget stops (plan Phase 5.2): step cap + per-run cost cap.
          stopWhen: [stepCountIs(budget.max_steps), maxCost(budget.max_cost_usd)],
          // No post-stop final model turn: a budget stop must not spend more.
          allowFinalResponse: false,
          hooks,
          onTurnEnd: (context, response) =>
            appendJsonl(transcriptPath, {
              type: 'turn_end',
              at: Date.now(),
              turn: context.numberOfTurns,
              output: capJson(response.output, outputCapBytes),
              usage: response.usage ?? null,
            }),
        });

        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new ExecutorTimeout()), budget.timeout_s * 1000);
        });
        record.output = await Promise.race([result.getText(), timeout]);
      } catch (error: unknown) {
        record.error = error instanceof ExecutorTimeout ? 'timeout' : errorMessage(error);
        if (result) {
          try {
            await result.cancel();
          } catch {
            // cancel() is best-effort teardown; the original error stands.
          }
        }
      } finally {
        clearTimeout(timeoutHandle);
        record.mem_search_calls = memSearchCalls;
        if (totals.usageSeen) {
          record.tokens_in = totals.tokensIn;
          record.tokens_out = totals.tokensOut;
        }
        if (totals.costSeen) record.cost_usd = totals.cost;

        // The SDK's maxCost stop UNDERCOUNTS: it sees only the follow-up
        // model call's usage and fires after that call has already landed, so
        // a run can finish over the cap without erroring. Overshoot is real
        // spend — surface it on the result row so Phase 6 cost governance can
        // see it instead of trusting the stop condition.
        const budgetExceeded = totals.costSeen && totals.cost > budget.max_cost_usd;

        try {
          // The awaited append also flushes every earlier hook append (the
          // per-path mutex chain in jsonl.ts serializes them ahead of this).
          await appendJsonl(transcriptPath, {
            type: 'result',
            at: Date.now(),
            output: capText(record.output, outputCapBytes),
            error: record.error ?? null,
            mem_search_calls: record.mem_search_calls,
            tokens_in: record.tokens_in ?? null,
            tokens_out: record.tokens_out ?? null,
            cost_usd: record.cost_usd ?? null,
            // Partial-cost visibility: when these differ, cost_usd is a floor.
            model_calls: totals.modelCalls,
            cost_reporting_model_calls: totals.costReportingCalls,
            ...(budgetExceeded
              ? {
                  budget_exceeded: true,
                  max_cost_usd: budget.max_cost_usd,
                  cost_usd_spent: totals.cost,
                }
              : {}),
          });
        } catch (error: unknown) {
          if (!record.error) record.error = `transcript write failed: ${errorMessage(error)}`;
        }

        try {
          const diffPath = join(forkDir, 'executor.diff');
          const diff = captureGitDiff(fork.repoDir, diffPath, fork.baseSha);
          record.diff_path = diffPath;
          if (!diff.ok && !record.error) record.error = diff.error ?? 'diff capture failed';
        } catch (error: unknown) {
          if (!record.error) record.error = `diff capture failed: ${errorMessage(error)}`;
        }
      }

      return record;
    },
  };
}
