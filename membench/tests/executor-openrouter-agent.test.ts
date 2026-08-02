/**
 * Offline tests for the openrouter-agent executor (plan Phase 5.2,
 * guards 1-3). The SDK's transport is mocked at its documented injection
 * seam — `new OpenRouter({ httpClient: new HTTPClient({ fetcher }) })`
 * (@openrouter/sdk lib/http.d.ts) — driving canned Responses-API JSON
 * bodies through the real agent loop. The mem-search tools hit a local
 * Bun.serve stub worker. No real network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenRouter } from '@openrouter/agent';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import {
  ToolPathError,
  buildCodingTools,
  buildMemSearchTools,
  createOpenRouterAgentExecutor,
  resolveInRepo,
} from '../src/executors/openrouter-agent.ts';
import { readJsonl } from '../src/jsonl.ts';
import type { Budget, ForkContext } from '../src/types.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-ora-exec-${name}-`));
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

// ---------------------------------------------------------------------------
// Stub worker (mem-search HTTP surface)
// ---------------------------------------------------------------------------

interface StubWorker {
  port: number;
  requests: { method: string; path: string; search: string; body?: unknown }[];
  stop(): void;
}

interface StubWorkerOptions {
  /** Make /api/search answer with this HTTP status instead of a result body. */
  searchStatus?: number;
}

function startStubWorker(options: StubWorkerOptions = {}): StubWorker {
  const requests: StubWorker['requests'] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const entry: StubWorker['requests'][number] = {
        method: request.method,
        path: url.pathname,
        search: url.search,
      };
      if (request.method === 'POST') entry.body = await request.json();
      requests.push(entry);
      if (url.pathname === '/api/search') {
        if (options.searchStatus !== undefined) {
          return new Response('search backend exploded', { status: options.searchStatus });
        }
        return Response.json({ content: [{ type: 'text', text: '| 41 | Auth flow fix | 2026-07-01 |' }] });
      }
      if (url.pathname === '/api/timeline') {
        return Response.json({ content: [{ type: 'text', text: 'timeline context' }] });
      }
      if (url.pathname === '/api/observations/batch') {
        return Response.json({ observations: [{ id: 41, title: 'Auth flow fix' }] });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { port: server.port, requests, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------------------
// Fork fixture
// ---------------------------------------------------------------------------

function makeFork(name: string, workerPort: number): { fork: ForkContext; forkDir: string } {
  const forkDir = tempDir(name);
  const homeDir = join(forkDir, 'home');
  const repoDir = join(forkDir, 'repo');
  const dataDir = join(forkDir, 'mem');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'membench@example.invalid'], repoDir);
  git(['config', 'user.name', 'MemBench Fixture'], repoDir);
  writeFileSync(join(repoDir, 'README.md'), 'baseline\n');
  git(['add', '.'], repoDir);
  git(['commit', '--quiet', '-m', 'baseline'], repoDir);
  const fork: ForkContext = {
    repoDir,
    homeDir,
    workerPort,
    dataDir,
    injectionBlock: '',
    item: { id: 'item-test', dir: join(forkDir, 'no-item') },
    variant: 'none',
    projectSlug: 'membench-fixture/project',
  };
  return { fork, forkDir };
}

// ---------------------------------------------------------------------------
// Canned Responses-API bodies (snake_case wire shape the SDK parses)
// ---------------------------------------------------------------------------

function usageOf(inputTokens: number, outputTokens: number, cost?: number): Record<string, unknown> {
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function toolCallItem(callId: string, name: string, args: unknown): Record<string, unknown> {
  return {
    type: 'function_call',
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: JSON.stringify(args),
    status: 'completed',
  };
}

function messageItem(id: string, text: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }],
  };
}

function cannedResponse(id: string, output: unknown[], usage?: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    object: 'response',
    created_at: 1,
    completed_at: 2,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    model: 'test/executor-model',
    output,
    parallel_tool_calls: false,
    presence_penalty: null,
    frequency_penalty: null,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    ...(usage !== undefined ? { usage } : {}),
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Scripted = Record<string, unknown> | Error | 'hang';

/** OpenRouter client whose transport replays a scripted response sequence. */
function scriptedClient(script: Scripted[], captured?: { bodies: unknown[] }): OpenRouter {
  let call = 0;
  return new OpenRouter({
    apiKey: 'offline-test-key',
    retryConfig: { strategy: 'none' },
    httpClient: new HTTPClient({
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (captured) captured.bodies.push(JSON.parse(await request.text()));
        const step = script[Math.min(call, script.length - 1)];
        call++;
        if (step === 'hang') return new Promise<Response>(() => {});
        if (step instanceof Error) throw step;
        return jsonResponse(step);
      },
    }),
  });
}

const BUDGET: Budget = { max_steps: 5, max_cost_usd: 5, timeout_s: 30 };
const PROMPT = 'Remembered context block\n\nFix the auth flow bug';
const MODEL = 'test/executor-model';

let worker: StubWorker;

beforeAll(() => {
  worker = startStubWorker();
});

afterAll(() => {
  worker.stop();
});

describe('openrouter-agent executor (mocked transport)', () => {
  test('3-step tool loop: mem-search counting, reported usage sums, transcript, diff', async () => {
    const { fork, forkDir } = makeFork('loop', worker.port);
    const captured = { bodies: [] as unknown[] };
    const client = scriptedClient(
      [
        cannedResponse('r1', [toolCallItem('c1', 'search', { query: 'auth flow' })], usageOf(10, 5, 0.01)),
        cannedResponse('r2', [toolCallItem('c2', 'bash', { command: 'echo tweak >> README.md' })], usageOf(20, 6, 0.02)),
        cannedResponse('r3', [messageItem('m1', 'All done.')], usageOf(30, 7, 0.03)),
      ],
      captured,
    );

    const executor = createOpenRouterAgentExecutor({ model: MODEL, client });
    const requestsBefore = worker.requests.length;
    const record = await executor.execute(fork, PROMPT, BUDGET);

    expect(record.error).toBeUndefined();
    expect(record.output).toBe('All done.');
    expect(record.mem_search_calls).toBe(1);

    // Usage: sums of REPORTED per-call usage only (guard 1).
    expect(record.tokens_in).toBe(60);
    expect(record.tokens_out).toBe(18);
    expect(record.cost_usd).toBeCloseTo(0.06, 10);

    // The loop made exactly 3 model calls, with model + prompt in the first body.
    expect(captured.bodies.length).toBe(3);
    const first = captured.bodies[0] as { model: string; input: unknown };
    expect(first.model).toBe(MODEL);
    expect(JSON.stringify(first.input)).toContain('Fix the auth flow bug');

    // The search tool proxied to the fork worker's /api/search with the args as query params.
    const searchHits = worker.requests.slice(requestsBefore).filter((r) => r.path === '/api/search');
    expect(searchHits.length).toBe(1);
    expect(searchHits[0].search).toContain('query=auth+flow');

    // The bash tool really ran in the repo: git diff captured the tracked change.
    expect(record.diff_path).toBe(join(forkDir, 'executor.diff'));
    expect(readFileSync(record.diff_path, 'utf-8')).toContain('tweak');

    // JSONL transcript: prompt, per-model-call, tool call/result, final result rows.
    expect(record.transcript_path).toBe(join(forkDir, 'agent-transcript.jsonl'));
    const rows = await readJsonl<{ type: string; tool?: string; usage?: unknown; error?: unknown }>(record.transcript_path);
    const types = rows.map((row) => row.type);
    expect(types[0]).toBe('prompt');
    expect(types.filter((type) => type === 'model_call').length).toBe(3);
    expect(rows.filter((row) => row.type === 'tool_call').map((row) => row.tool)).toEqual(['search', 'bash']);
    expect(rows.filter((row) => row.type === 'tool_result').map((row) => row.tool)).toEqual(['search', 'bash']);
    expect(types[types.length - 1]).toBe('result');
  });

  test('budget cost stop: maxCost halts the loop, pending tool calls stay unexecuted', async () => {
    const { fork } = makeFork('coststop', worker.port);
    const captured = { bodies: [] as unknown[] };
    // Every response asks for another search; cost 0.02/call blows a 0.005 budget after step 1.
    // SDK stop semantics (verified against 0.8.0): a "step" is one tool round
    // PLUS its follow-up model call, and stopWhen is evaluated on the step
    // history after the follow-up lands — so a budget stop costs steps+1
    // model calls, and allowFinalResponse:false forbids any further turn.
    const client = scriptedClient(
      [
        cannedResponse('r1', [toolCallItem('c1', 'search', { query: 'x' })], usageOf(10, 5, 0.02)),
        cannedResponse('r2', [messageItem('m2', 'working'), toolCallItem('c2', 'search', { query: 'y' })], usageOf(10, 5, 0.02)),
        cannedResponse('r3', [toolCallItem('c3', 'search', { query: 'z' })], usageOf(10, 5, 0.02)),
      ],
      captured,
    );

    const executor = createOpenRouterAgentExecutor({ model: MODEL, client });
    const record = await executor.execute(fork, PROMPT, { ...BUDGET, max_cost_usd: 0.005 });

    expect(record.error).toBeUndefined();
    // step 1 = r1's tool round + follow-up r2; the stop fires there: no third call.
    expect(captured.bodies.length).toBe(2);
    // r2's pending search was NOT executed after the stop.
    expect(record.mem_search_calls).toBe(1);
    expect(record.cost_usd).toBeCloseTo(0.04, 10);
    expect(record.output).toBe('working');

    // The stop UNDERCOUNTS (it sees only the follow-up call's usage, and fires
    // after that call landed): $0.04 actually spent against a $0.005 cap. The
    // result row must say so rather than let the overshoot pass silently.
    const rows = await readJsonl<Record<string, unknown>>(record.transcript_path);
    const resultRow = rows[rows.length - 1];
    expect(resultRow.type).toBe('result');
    expect(resultRow.budget_exceeded).toBe(true);
    expect(resultRow.max_cost_usd).toBe(0.005);
    expect(resultRow.cost_usd_spent).toBeCloseTo(0.04, 10);
    // Both model calls reported a cost, so cost_usd is the total, not a floor.
    expect(resultRow.model_calls).toBe(2);
    expect(resultRow.cost_reporting_model_calls).toBe(2);
  });

  test('step-count stop + unreported cost: cost_usd stays absent (guard 1)', async () => {
    const { fork } = makeFork('stepstop', worker.port);
    const captured = { bodies: [] as unknown[] };
    // Usage reported WITHOUT cost — tokens sum, cost must stay undefined.
    const client = scriptedClient(
      [
        cannedResponse('r1', [toolCallItem('c1', 'search', { query: 'x' })], usageOf(10, 5)),
        cannedResponse('r2', [toolCallItem('c2', 'search', { query: 'y' })], usageOf(20, 6)),
        cannedResponse('r3', [toolCallItem('c3', 'search', { query: 'z' })], usageOf(30, 7)),
      ],
      captured,
    );

    const executor = createOpenRouterAgentExecutor({ model: MODEL, client });
    const record = await executor.execute(fork, PROMPT, { ...BUDGET, max_steps: 2 });

    expect(record.error).toBeUndefined();
    // stepCountIs(2): two tool rounds each with a follow-up = 3 model calls,
    // then the loop halts (r3's pending call is never executed).
    expect(captured.bodies.length).toBe(3);
    expect(record.mem_search_calls).toBe(2);
    expect(record.tokens_in).toBe(60);
    expect(record.tokens_out).toBe(18);
    expect(record.cost_usd).toBeUndefined();

    // Partial-cost visibility: 3 model calls, none of which reported a cost —
    // so there is nothing to compare against the cap either.
    const rows = await readJsonl<Record<string, unknown>>(record.transcript_path);
    const resultRow = rows[rows.length - 1];
    expect(resultRow.model_calls).toBe(3);
    expect(resultRow.cost_reporting_model_calls).toBe(0);
    expect(resultRow.budget_exceeded).toBeUndefined();
  });

  test('mid-loop mem-search HTTP failure: tool error is fed back, the loop continues', async () => {
    // A worker that 500s on /api/search: the failure must reach the model as a
    // tool result (the SDK's tool-error path), not abort the run. Losing the
    // memory tool mid-run is exactly the "mem" variant degrading to "none" —
    // the row has to survive and say so.
    const failingWorker = startStubWorker({ searchStatus: 500 });
    try {
      const { fork } = makeFork('searchfail', failingWorker.port);
      const captured = { bodies: [] as unknown[] };
      const client = scriptedClient(
        [
          cannedResponse('r1', [toolCallItem('c1', 'search', { query: 'auth flow' })], usageOf(10, 5, 0.01)),
          cannedResponse('r2', [toolCallItem('c2', 'bash', { command: 'echo recovered >> README.md' })], usageOf(20, 6, 0.01)),
          cannedResponse('r3', [messageItem('m1', 'Recovered without memory.')], usageOf(30, 7, 0.01)),
        ],
        captured,
      );

      const executor = createOpenRouterAgentExecutor({ model: MODEL, client });
      const record = await executor.execute(fork, PROMPT, BUDGET);

      // The tool threw, the SDK caught it — the run is NOT an error row.
      expect(record.error).toBeUndefined();
      expect(record.output).toBe('Recovered without memory.');
      // The attempt is still a mem-search call (PreToolUse fires before execute).
      expect(record.mem_search_calls).toBe(1);
      // The loop kept going past the failure: 3 model calls, bash really ran.
      expect(captured.bodies.length).toBe(3);
      expect(readFileSync(record.diff_path, 'utf-8')).toContain('recovered');

      // The transcript records the failure, and no tool_result stands in for it.
      const rows = await readJsonl<{ type: string; tool?: string; error?: string }>(record.transcript_path);
      const failures = rows.filter((row) => row.type === 'tool_failure');
      expect(failures.length).toBe(1);
      expect(failures[0].tool).toBe('search');
      expect(failures[0].error).toContain('500');
      expect(rows.filter((row) => row.type === 'tool_result').map((row) => row.tool)).toEqual(['bash']);

      // The error text went back to the model as the tool's output.
      expect(JSON.stringify(captured.bodies[1])).toContain('/api/search failed (500)');
    } finally {
      failingWorker.stop();
    }
  });

  test('row invariant: injected mid-loop transport error still yields a complete record', async () => {
    const { fork } = makeFork('midloop', worker.port);
    const client = scriptedClient([
      cannedResponse('r1', [toolCallItem('c1', 'search', { query: 'x' })], usageOf(10, 5, 0.01)),
      new Error('injected transport failure'),
    ]);

    const executor = createOpenRouterAgentExecutor({ model: MODEL, client });
    const record = await executor.execute(fork, PROMPT, BUDGET);

    expect(record.error).toBeDefined();
    expect(record.error).toContain('injected transport failure');
    // Usage accumulated before the failure is preserved (reported-only).
    expect(record.tokens_in).toBe(10);
    expect(record.cost_usd).toBeCloseTo(0.01, 10);
    expect(record.mem_search_calls).toBe(1);
    // Artifacts still captured on the failure path.
    expect(existsSync(record.transcript_path)).toBe(true);
    expect(existsSync(record.diff_path)).toBe(true);
    const rows = await readJsonl<{ type: string; error?: unknown }>(record.transcript_path);
    expect(rows.filter((row) => row.type === 'model_call').length).toBe(1);
    const resultRow = rows[rows.length - 1] as { type: string; error: string | null };
    expect(resultRow.type).toBe('result');
    expect(resultRow.error).toContain('injected transport failure');
  });

  test(
    'timeout: hung transport yields error:"timeout" promptly, record complete',
    async () => {
      const { fork } = makeFork('timeout', worker.port);
      const client = scriptedClient(['hang']);
      const executor = createOpenRouterAgentExecutor({ model: MODEL, client });

      const startedAt = Date.now();
      const record = await executor.execute(fork, PROMPT, { ...BUDGET, timeout_s: 0.3 });
      const elapsedMs = Date.now() - startedAt;

      expect(record.error).toBe('timeout');
      // The transport hangs forever; execute() must come back on the 0.3s
      // budget. 10s leaves headroom for a loaded machine.
      expect(elapsedMs).toBeLessThan(10_000);
      expect(record.output).toBe('');
      expect(record.mem_search_calls).toBe(0);
      expect(existsSync(record.transcript_path)).toBe(true);
      expect(existsSync(record.diff_path)).toBe(true);
    },
    30_000,
  );

  test('missing API key without injected client: error row, never a throw', async () => {
    const { fork } = makeFork('nokey', worker.port);
    const previous = Bun.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const executor = createOpenRouterAgentExecutor({ model: MODEL });
      const record = await executor.execute(fork, PROMPT, BUDGET);
      expect(record.error).toContain('OPENROUTER_API_KEY');
      expect(record.diff_path).not.toBe('');
    } finally {
      if (previous !== undefined) process.env.OPENROUTER_API_KEY = previous;
    }
  });
});

// ---------------------------------------------------------------------------
// Tool-level tests (direct execute, no model loop)
// ---------------------------------------------------------------------------

interface ExecutableTool {
  function: { execute: (params: never) => Promise<unknown> };
}

function exec(toolObj: unknown, params: unknown): Promise<unknown> {
  return (toolObj as ExecutableTool).function.execute(params as never);
}

describe('coding tools are cwd-locked to the fork repo', () => {
  test('path escapes are rejected by every file tool', async () => {
    const { fork } = makeFork('escape', worker.port);
    const tools = buildCodingTools(fork.repoDir, { env: { PATH: process.env.PATH ?? '' } });

    await expect(exec(tools.read_file, { path: '../outside.txt' })).rejects.toThrow('escapes the repository root');
    await expect(exec(tools.read_file, { path: '/etc/hosts' })).rejects.toThrow('escapes the repository root');
    await expect(exec(tools.write_file, { path: '../../pwned.txt', content: 'x' })).rejects.toThrow(
      'escapes the repository root',
    );
    await expect(exec(tools.write_file, { path: '/tmp/pwned.txt', content: 'x' })).rejects.toThrow(
      'escapes the repository root',
    );
    await expect(
      exec(tools.edit_file, { path: 'sub/../../README.md', old_string: 'a', new_string: 'b' }),
    ).rejects.toThrow('escapes the repository root');
  });

  test('resolveInRepo accepts in-repo paths and the root itself, rejects escapes', () => {
    const { fork } = makeFork('resolve', worker.port);
    expect(resolveInRepo(fork.repoDir, 'a/b.txt')).toBe(join(fork.repoDir, 'a', 'b.txt'));
    expect(resolveInRepo(fork.repoDir, '.')).toBe(fork.repoDir);
    expect(resolveInRepo(fork.repoDir, join(fork.repoDir, 'inside.txt'))).toBe(join(fork.repoDir, 'inside.txt'));
    // A sibling dir sharing the repo dir's name prefix must NOT pass.
    expect(() => resolveInRepo(fork.repoDir, `${fork.repoDir}-sibling/file`)).toThrow(ToolPathError);
    expect(() => resolveInRepo(fork.repoDir, '../x')).toThrow(ToolPathError);
  });

  test('read/write/edit work inside the repo; edit enforces uniqueness', async () => {
    const { fork } = makeFork('rw', worker.port);
    const tools = buildCodingTools(fork.repoDir, { env: { PATH: process.env.PATH ?? '' } });

    await exec(tools.write_file, { path: 'sub/dir/note.txt', content: 'alpha beta alpha' });
    const read = (await exec(tools.read_file, { path: 'sub/dir/note.txt' })) as { content: string };
    expect(read.content).toBe('alpha beta alpha');

    await expect(
      exec(tools.edit_file, { path: 'sub/dir/note.txt', old_string: 'alpha', new_string: 'gamma' }),
    ).rejects.toThrow('occurs 2 times');
    const edited = (await exec(tools.edit_file, {
      path: 'sub/dir/note.txt',
      old_string: 'alpha',
      new_string: 'gamma',
      replace_all: true,
    })) as { replacements: number };
    expect(edited.replacements).toBe(2);
    await expect(
      exec(tools.edit_file, { path: 'sub/dir/note.txt', old_string: 'missing', new_string: 'x' }),
    ).rejects.toThrow('not found');
  });

  test(
    'bash runs with cwd = repo root, captures output, honors its timeout',
    async () => {
      const { fork } = makeFork('bash', worker.port);
      const tools = buildCodingTools(fork.repoDir, {
        env: { PATH: process.env.PATH ?? '' },
        bashTimeoutMs: 300,
        gracefulKillMs: 100,
      });

      const pwd = (await exec(tools.bash, { command: 'pwd' })) as { exit_code: number; stdout: string };
      expect(pwd.exit_code).toBe(0);
      // realpath both sides: on macOS the tmpdir rides the /var → /private/var symlink.
      expect(realpathSync(pwd.stdout.trim())).toBe(realpathSync(fork.repoDir));

      const fail = (await exec(tools.bash, { command: 'exit 7' })) as { exit_code: number };
      expect(fail.exit_code).toBe(7);

      const hung = (await exec(tools.bash, { command: 'sleep 30' })) as { timed_out: boolean };
      expect(hung.timed_out).toBe(true);
    },
    30_000,
  );

  test('tool output is capped', async () => {
    const { fork } = makeFork('cap', worker.port);
    const tools = buildCodingTools(fork.repoDir, {
      env: { PATH: process.env.PATH ?? '' },
      outputCapBytes: 100,
    });
    const big = (await exec(tools.bash, { command: 'head -c 5000 /dev/zero | tr "\\0" "a"' })) as { stdout: string };
    expect(big.stdout.length).toBeLessThan(200);
    expect(big.stdout).toContain('truncated');
  });
});

describe('mem-search tools mirror the MCP surface over worker HTTP', () => {
  test('search → GET /api/search with String()-coerced params, nulls dropped', async () => {
    const tools = buildMemSearchTools(worker.port);
    const before = worker.requests.length;
    const result = await exec(tools.search, { query: 'auth', limit: 5 });
    const hit = worker.requests[before];
    expect(hit.method).toBe('GET');
    expect(hit.path).toBe('/api/search');
    expect(hit.search).toContain('query=auth');
    expect(hit.search).toContain('limit=5');
    expect(JSON.stringify(result)).toContain('Auth flow fix');
  });

  test('timeline → GET /api/timeline', async () => {
    const tools = buildMemSearchTools(worker.port);
    const before = worker.requests.length;
    await exec(tools.timeline, { anchor: 41, depth_before: 2 });
    const hit = worker.requests[before];
    expect(hit.path).toBe('/api/timeline');
    expect(hit.search).toContain('anchor=41');
    expect(hit.search).toContain('depth_before=2');
  });

  test('get_observations → POST /api/observations/batch with a JSON ids body', async () => {
    const tools = buildMemSearchTools(worker.port);
    const before = worker.requests.length;
    await exec(tools.get_observations, { ids: [41, 42] });
    const hit = worker.requests[before];
    expect(hit.method).toBe('POST');
    expect(hit.path).toBe('/api/observations/batch');
    expect(hit.body).toEqual({ ids: [41, 42] });
  });

  test('non-OK worker response surfaces as a tool error carrying the status', async () => {
    const failingWorker = startStubWorker({ searchStatus: 500 });
    try {
      const tools = buildMemSearchTools(failingWorker.port);
      await expect(exec(tools.search, { query: 'x' })).rejects.toThrow('worker /api/search failed (500)');
    } finally {
      failingWorker.stop();
    }

    // A refused connection is a tool error too — never a silent empty result.
    const dead = buildMemSearchTools(1);
    await expect(exec(dead.search, { query: 'x' })).rejects.toThrow();
  });
});
