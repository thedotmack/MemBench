/**
 * Offline tests for the claude-cli executor (plan Phase 5.1, guards 3-5).
 * The `claude` binary is a stub bash script written per test: it records its
 * argv and env, writes a fake session transcript under the isolated HOME's
 * .claude/projects/, mutates a tracked repo file, and prints a canned
 * --output-format json result. No real CLI, no network.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readJsonl } from '../src/jsonl.ts';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpConfig, countMemSearchCalls, createClaudeCliExecutor, findSessionTranscript, parseCliJsonOutput, resolveClaudeCredentials, seedClaudeCredentials, sumTranscriptUsage } from '../src/executors/claude-cli.ts';
import type { Budget, ForkContext } from '../src/types.ts';

const CLAUDE_MEM_ROOT = '/stub/claude-mem-root';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-cli-exec-${name}-`));
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** forkDir/{home,repo,mem} with a committed README so `git diff` has a baseline. */
function makeFork(name: string, workerPort = 39123): { fork: ForkContext; forkDir: string } {
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

/** Session transcript fixture: 4 mem-search tool_use blocks + decoys. */
const USAGE_A = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
const USAGE_B = { input_tokens: 20, cache_read_input_tokens: 2000, output_tokens: 7 };
const USAGE_D = { input_tokens: 30, cache_creation_input_tokens: 300, output_tokens: 11 };
const USAGE_E = { input_tokens: 40, cache_read_input_tokens: 4000, output_tokens: 13 };
// Counted ONCE per message.id: a=1110, b=2020, c=0, d=330, e=4040.
const FIXTURE_TRANSCRIPT_TOKENS_IN = 1110 + 2020 + 330 + 4040; // 7500
const FIXTURE_TRANSCRIPT_TOKENS_OUT = 5 + 7 + 9 + 11 + 13; // 45
// What per-ROW summing would wrongly produce (msg-a x3, msg-b x2).
const FIXTURE_NAIVE_TOKENS_IN = 1110 * 3 + 2020 * 2 + 330 + 4040; // 11740

function writeFixtureTranscript(dir: string): string {
  // Mirrors a REAL Claude Code transcript: one row PER CONTENT BLOCK, with
  // every row of a message repeating the SAME message.id and the SAME usage.
  // Two consequences the executor must get right, and this fixture pins both:
  //   - usage counts ONCE per message.id (naive per-row summing would give
  //     11,740 / 62 here instead of 7,500 / 45)
  //   - mem-search counting must NOT dedupe: each group's tool_use sits in its
  //     LAST row, so deduping would miss msg-a and msg-b entirely (4 -> 2).
  const rows = [
    { type: 'user', message: { role: 'user', content: 'hello' } },
    // msg-a: three rows, tool_use last.
    { type: 'assistant', requestId: 'req-a', message: { id: 'msg-a', content: [{ type: 'thinking', thinking: 'hmm' }], usage: USAGE_A } },
    { type: 'assistant', requestId: 'req-a', message: { id: 'msg-a', content: [{ type: 'text', text: 'searching' }], usage: USAGE_A } },
    { type: 'assistant', requestId: 'req-a', message: { id: 'msg-a', content: [{ type: 'tool_use', name: 'mcp__mcp-search__search', input: { query: 'x' } }], usage: USAGE_A } },
    // msg-b: two rows, tool_use last.
    { type: 'assistant', requestId: 'req-b', message: { id: 'msg-b', content: [{ type: 'text', text: 'more' }], usage: USAGE_B } },
    { type: 'assistant', requestId: 'req-b', message: { id: 'msg-b', content: [{ type: 'tool_use', name: 'mcp__mcp-search__timeline', input: { anchor: 1 } }], usage: USAGE_B } },
    // msg-c: single row, output-only usage (no prompt components).
    { type: 'assistant', message: { id: 'msg-c', content: [{ type: 'tool_use', name: 'mcp__mcp-search__get_observations', input: { ids: [1] } }], usage: { output_tokens: 9 } } },
    // Decoys: a non-mem-search tool (no usage, no id) and a lookalike name.
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a' } }] } },
    { type: 'assistant', message: { id: 'msg-d', content: [{ type: 'tool_use', name: 'mcp__mcp-search__rebuild_corpus', input: {} }], usage: USAGE_D } },
    { type: 'assistant', message: { id: 'msg-e', content: [{ type: 'tool_use', name: 'mcp__mcp-search__search', input: { query: 'y' } }], usage: USAGE_E } },
  ];
  const path = join(dir, 'fixture-session.jsonl');
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return path;
}

/**
 * Minimal session transcript (no mem-search blocks). A successful run MUST
 * leave a transcript under the fork HOME — the executor errors the row when it
 * cannot find one — so scenarios that are not about mem-search counting still
 * need the stub to write one.
 */
function writeMinimalTranscript(dir: string): string {
  const path = join(dir, 'minimal-session.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  return path;
}

const CANNED_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 3,
  result: 'Task complete: stub run',
  session_id: 'reported-by-cli',
  total_cost_usd: 0.0421,
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 5000 },
});

const CANNED_RESULT_NO_USAGE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'no usage reported',
});

interface StubOptions {
  outDir: string;
  fixtureTranscript?: string;
  cannedJson?: string;
  exitCode?: number;
  sleepSeconds?: number;
  mutateRepo?: boolean;
  /** Spawn a 30s background child (inherits the stdio pipes) before the main body. */
  orphanChild?: boolean;
}

/** Write an executable stub `claude` with all paths baked in (the executor's allowlisted env passes nothing else through). */
function writeStubClaude(dir: string, options: StubOptions): string {
  const { outDir, fixtureTranscript, cannedJson, exitCode = 0, sleepSeconds, mutateRepo = true, orphanChild = false } = options;
  const lines = [
    '#!/bin/bash',
    `printf '%s\\0' "$@" > "${outDir}/argv.txt"`,
    `env > "${outDir}/env.txt"`,
    // Snapshot the seeded credential AS THE CLI SEES IT: the executor deletes
    // it during teardown, so presence can only be asserted from in here.
    `if [ -f "$HOME/.claude/.credentials.json" ]; then cp "$HOME/.claude/.credentials.json" "${outDir}/seen-creds.json"; fi`,
    'SESSION_ID=""',
    'prev=""',
    'for a in "$@"; do',
    '  if [ "$prev" = "--session-id" ]; then SESSION_ID="$a"; fi',
    '  prev="$a"',
    'done',
    ...(orphanChild ? ['sleep 30 &', `echo $! > "${outDir}/orphan.pid"`] : []),
    ...(sleepSeconds !== undefined ? [`sleep ${sleepSeconds}`] : []),
    ...(fixtureTranscript
      ? [
          'mkdir -p "$HOME/.claude/projects/-membench-repo"',
          `cp "${fixtureTranscript}" "$HOME/.claude/projects/-membench-repo/\${SESSION_ID}.jsonl"`,
        ]
      : []),
    ...(mutateRepo ? ['echo "stub tweak" >> README.md'] : []),
    ...(cannedJson ? [`cat "${outDir}/canned.json"`] : []),
    `exit ${exitCode}`,
  ];
  if (cannedJson) writeFileSync(join(outDir, 'canned.json'), cannedJson);
  const path = join(dir, 'claude');
  writeFileSync(path, lines.join('\n') + '\n');
  chmodSync(path, 0o755);
  return path;
}

const BUDGET: Budget = { max_steps: 10, max_cost_usd: 1, timeout_s: 30 };
const PROMPT = 'Remembered context block\n\nFix the flaky test in ci.yml';

beforeAll(() => {
  // Poison the parent env: none of these may reach the spawned CLI.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-parent-secret';
  process.env.CLAUDE_MEM_DATA_DIR = '/parent/claude-mem-data';
  process.env.MEMBENCH_TEST_SECRET = 'leak-canary';
});

afterAll(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_MEM_DATA_DIR;
  delete process.env.MEMBENCH_TEST_SECRET;
});

describe('claude-cli executor (stubbed binary)', () => {
  test('happy path: full record, verified argv, MCP config, transcript retention, mem-search count', async () => {
    const { fork, forkDir } = makeFork('happy');
    const stubDir = tempDir('stub-happy');
    const fixture = writeFixtureTranscript(stubDir);
    const claudeBin = writeStubClaude(stubDir, {
      outDir: stubDir,
      fixtureTranscript: fixture,
      cannedJson: CANNED_RESULT,
    });

    const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute(fork, PROMPT, BUDGET);

    // Complete record, no error.
    expect(record.error).toBeUndefined();
    expect(record.output).toBe('Task complete: stub run');
    // Tokens come from the TRANSCRIPT (per-turn, incl. cache), NOT the result
    // block — CANNED_RESULT claims 1200/340, which is only its last turn.
    expect(record.tokens_in).toBe(FIXTURE_TRANSCRIPT_TOKENS_IN);
    expect(record.tokens_out).toBe(FIXTURE_TRANSCRIPT_TOKENS_OUT);
    expect(record.cost_usd).toBe(0.0421);

    // Argv: verified flags present, guard-5 flag absent, prompt positional last.
    const argv = readFileSync(join(stubDir, 'argv.txt'), 'utf-8').split('\0').filter(Boolean);
    expect(argv).toContain('--print');
    expect(argv).toContain('--output-format');
    expect(argv).toContain('json');
    expect(argv).toContain('--permission-mode');
    expect(argv).toContain('bypassPermissions');
    expect(argv).toContain('--session-id');
    expect(argv).toContain('--mcp-config');
    expect(argv).not.toContain('--bare');
    expect(argv[argv.length - 1]).toBe(PROMPT);
    const sessionId = argv[argv.indexOf('--session-id') + 1];
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // MCP config written next to the fork, pointing at THIS fork's worker.
    const mcpConfigPath = argv[argv.indexOf('--mcp-config') + 1];
    expect(mcpConfigPath).toBe(join(forkDir, 'mcp-config.json'));
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    const server = mcpConfig.mcpServers['mcp-search'];
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('node');
    expect(server.args).toEqual([join(CLAUDE_MEM_ROOT, 'plugin', 'scripts', 'mcp-server.cjs')]);
    expect(server.env).toEqual({
      CLAUDE_MEM_WORKER_PORT: String(fork.workerPort),
      CLAUDE_MEM_DATA_DIR: fork.dataDir,
      CLAUDE_MEM_RUNTIME: 'worker',
    });

    // Isolated HOME + allowlisted env: fork home, no inherited secrets.
    const envDump = readFileSync(join(stubDir, 'env.txt'), 'utf-8');
    expect(envDump).toContain(`HOME=${fork.homeDir}`);
    expect(envDump).not.toContain('ANTHROPIC_API_KEY');
    expect(envDump).not.toContain('leak-canary');
    expect(envDump).not.toContain('/parent/claude-mem-data');

    // Transcript retained from the isolated HOME; mem-search counted from it.
    expect(record.transcript_path).toBe(join(forkDir, 'session-transcript.jsonl'));
    expect(existsSync(record.transcript_path)).toBe(true);
    expect(record.mem_search_calls).toBe(4);

    // git diff captured from the stub's tracked-file mutation.
    expect(record.diff_path).toBe(join(forkDir, 'executor.diff'));
    expect(readFileSync(record.diff_path, 'utf-8')).toContain('stub tweak');
  });

  test('extraEnv is passed through deliberately (and only deliberately)', async () => {
    const { fork } = makeFork('extraenv');
    const stubDir = tempDir('stub-extraenv');
    const claudeBin = writeStubClaude(stubDir, {
      outDir: stubDir,
      fixtureTranscript: writeMinimalTranscript(stubDir),
      cannedJson: CANNED_RESULT,
      mutateRepo: false,
    });

    const executor = createClaudeCliExecutor({
      claudeBin,
      claudeMemRoot: CLAUDE_MEM_ROOT,
      extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-deliberate' },
    });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeUndefined();
    const envDump = readFileSync(join(stubDir, 'env.txt'), 'utf-8');
    expect(envDump).toContain('ANTHROPIC_API_KEY=sk-ant-deliberate');
    expect(envDump).not.toContain('sk-ant-parent-secret');
  });

  test(
    'timeout: row survives with error:"timeout" and the process tree is killed promptly',
    async () => {
      const { fork, forkDir } = makeFork('timeout');
      const stubDir = tempDir('stub-timeout');
      const claudeBin = writeStubClaude(stubDir, { outDir: stubDir, sleepSeconds: 30, mutateRepo: false });

      const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT, gracefulKillMs: 200 });
      const startedAt = Date.now();
      const record = await executor.execute(fork, PROMPT, { ...BUDGET, timeout_s: 0.3 });
      const elapsedMs = Date.now() - startedAt;

      expect(record.error).toBe('timeout');
      // The stub sleeps 30s; execute() must come back far sooner (0.3s budget
      // + tree kill). 10s leaves headroom for a loaded machine.
      expect(elapsedMs).toBeLessThan(10_000);
      // Row invariant: the record is complete even on the timeout path.
      expect(record.output).toBe('');
      expect(record.mem_search_calls).toBe(0);
      expect(record.transcript_path).toBe(''); // stub never wrote one
      expect(record.diff_path).toBe(join(forkDir, 'executor.diff'));
      expect(existsSync(record.diff_path)).toBe(true);
    },
    30_000,
  );

  test(
    'orphaned background child cannot wedge the run or outlive it',
    async () => {
      // The stub backgrounds a 30s child (which inherits the stdio pipes) and
      // then exits normally. The runner must return promptly on the bounded
      // pipe drain, parse the result, and reap the orphan via the group kill.
      const { fork } = makeFork('orphan');
      const stubDir = tempDir('stub-orphan');
      const claudeBin = writeStubClaude(stubDir, {
        outDir: stubDir,
        fixtureTranscript: writeMinimalTranscript(stubDir),
        cannedJson: CANNED_RESULT,
        mutateRepo: false,
        orphanChild: true,
      });

      const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
      const startedAt = Date.now();
      const record = await executor.execute(fork, PROMPT, BUDGET);
      const elapsedMs = Date.now() - startedAt;

      expect(record.error).toBeUndefined();
      expect(record.output).toBe('Task complete: stub run');
      expect(elapsedMs).toBeLessThan(10_000); // not the orphan's 30s
      // The orphan was reaped by the post-run group kill.
      const orphanPid = Number.parseInt(readFileSync(join(stubDir, 'orphan.pid'), 'utf-8').trim(), 10);
      await Bun.sleep(100);
      let alive = true;
      try {
        process.kill(orphanPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    },
    30_000,
  );

  test('nonzero exit: error row with exit code, artifacts still captured', async () => {
    const { fork } = makeFork('exitfail');
    const stubDir = tempDir('stub-exitfail');
    const claudeBin = writeStubClaude(stubDir, { outDir: stubDir, exitCode: 3, mutateRepo: false });

    const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toContain('claude exited 3');
    expect(existsSync(record.diff_path)).toBe(true);
  });

  test('spawn failure (missing binary): error row, never a throw', async () => {
    const { fork } = makeFork('nospawn');
    const executor = createClaudeCliExecutor({
      claudeBin: join(tempDir('stub-missing'), 'does-not-exist'),
      claudeMemRoot: CLAUDE_MEM_ROOT,
    });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeDefined();
    expect(record.diff_path).not.toBe('');
  });

  test('missing usage/cost fields stay absent — never fabricated', async () => {
    const { fork } = makeFork('nousage');
    const stubDir = tempDir('stub-nousage');
    const claudeBin = writeStubClaude(stubDir, {
      outDir: stubDir,
      fixtureTranscript: writeMinimalTranscript(stubDir),
      cannedJson: CANNED_RESULT_NO_USAGE,
      mutateRepo: false,
    });

    const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeUndefined();
    expect(record.output).toBe('no usage reported');
    expect(record.tokens_in).toBeUndefined();
    expect(record.tokens_out).toBeUndefined();
    expect(record.cost_usd).toBeUndefined();
  });
});

describe('claude-cli helpers', () => {
  test('parseCliJsonOutput: whole-stdout JSON, last-line fallback, garbage → undefined', () => {
    const whole = parseCliJsonOutput(CANNED_RESULT);
    expect(whole?.output).toBe('Task complete: stub run');
    expect(whole?.costUsd).toBe(0.0421);

    const mixed = parseCliJsonOutput(`some log line\n${CANNED_RESULT}\n`);
    expect(mixed?.tokensIn).toBe(1200);

    expect(parseCliJsonOutput('not json at all')).toBeUndefined();
    // Non-numeric usage values are dropped, not coerced.
    const weird = parseCliJsonOutput(JSON.stringify({ result: 'r', usage: { input_tokens: 'many' }, total_cost_usd: 'cheap' }));
    expect(weird?.tokensIn).toBeUndefined();
    expect(weird?.costUsd).toBeUndefined();
  });

  test('countMemSearchCalls counts only the three mem-search tools', () => {
    const dir = tempDir('count');
    const fixture = writeFixtureTranscript(dir);
    const rows = readFileSync(fixture, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(countMemSearchCalls(rows)).toBe(4);
    expect(countMemSearchCalls([])).toBe(0);
    expect(countMemSearchCalls([null, 42, { message: { content: 'not-an-array' } }])).toBe(0);
  });

  test('findSessionTranscript locates the session file under nested project dirs', () => {
    const home = tempDir('find-home');
    const projectDir = join(home, '.claude', 'projects', '-some-encoded-cwd');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'abc-123.jsonl'), '{}\n');
    expect(findSessionTranscript(home, 'abc-123')).toBe(join(projectDir, 'abc-123.jsonl'));
    expect(findSessionTranscript(home, 'missing-session')).toBeUndefined();
    expect(findSessionTranscript(tempDir('find-empty'), 'abc')).toBeUndefined();
  });

  test('buildMcpConfig pins the fork worker env (guard 8)', () => {
    const { fork } = makeFork('mcpconf');
    const config = buildMcpConfig(fork, CLAUDE_MEM_ROOT) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(Object.keys(config.mcpServers)).toEqual(['mcp-search']);
    expect(config.mcpServers['mcp-search'].env.CLAUDE_MEM_RUNTIME).toBe('worker');
  });
});

describe('claude-cli fork-HOME auth seeding', () => {
  const CREDS = JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token', refreshToken: 'fixture-refresh' } });

  test('seedClaudeCredentials writes exactly one 0600 file and nothing else', () => {
    const home = tempDir('seed-home');
    const path = seedClaudeCredentials(home, CREDS);
    expect(path).toBe(join(home, '.claude', '.credentials.json'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(JSON.parse(CREDS));
    // guard 4: only .credentials.json lands in the isolated .claude dir —
    // no history.jsonl / projects/ / settings copied from the real home.
    expect(readdirSync(join(home, '.claude'))).toEqual(['.credentials.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('executor seeds the fork HOME before spawning the CLI', async () => {
    const { fork, forkDir } = makeFork('seed-exec');
    const bin = writeStubClaude(forkDir, { outDir: forkDir });
    const executor = createClaudeCliExecutor({
      claudeBin: bin,
      claudeMemRoot: CLAUDE_MEM_ROOT,
      credentialsJson: CREDS,
    });
    await executor.execute(fork, 'do the thing', BUDGET);
    // Seeded before spawn (captured by the stub)...
    const seen = join(forkDir, 'seen-creds.json');
    expect(existsSync(seen)).toBe(true);
    expect(JSON.parse(readFileSync(seen, 'utf8')).claudeAiOauth.accessToken).toBe('fixture-token');
    // ...and scrubbed afterwards.
    expect(existsSync(join(fork.homeDir, '.claude', '.credentials.json'))).toBe(false);
  });

  test('no credentialsJson leaves the fork HOME untouched (offline/stub runs)', async () => {
    const { fork, forkDir } = makeFork('seed-none');
    const bin = writeStubClaude(forkDir, { outDir: forkDir });
    const executor = createClaudeCliExecutor({ claudeBin: bin, claudeMemRoot: CLAUDE_MEM_ROOT });
    await executor.execute(fork, 'do the thing', BUDGET);
    expect(existsSync(join(forkDir, 'seen-creds.json'))).toBe(false);
    expect(existsSync(join(fork.homeDir, '.claude', '.credentials.json'))).toBe(false);
  });

  test('resolveClaudeCredentials reads the override file and keeps ONLY claudeAiOauth', () => {
    const dir = tempDir('creds-override');
    const file = join(dir, 'creds.json');
    // mcpOAuth deliberately present: fork runs must not inherit MCP tokens.
    writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 't' }, mcpOAuth: { secret: 'nope' } }));
    process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE = file;
    try {
      const resolved = resolveClaudeCredentials();
      expect(resolved).not.toBeNull();
      const parsed = JSON.parse(resolved!);
      expect(parsed).toEqual({ claudeAiOauth: { accessToken: 't' } });
      expect(parsed.mcpOAuth).toBeUndefined();
    } finally {
      delete process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE;
    }
  });

  test('resolveClaudeCredentials returns null for a missing or shapeless override', () => {
    process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE = join(tempDir('creds-missing'), 'absent.json');
    try {
      expect(resolveClaudeCredentials()).toBeNull();
    } finally {
      delete process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE;
    }
    const dir = tempDir('creds-bad');
    const file = join(dir, 'creds.json');
    writeFileSync(file, JSON.stringify({ somethingElse: true }));
    process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE = file;
    try {
      expect(resolveClaudeCredentials()).toBeNull();
    } finally {
      delete process.env.MEMBENCH_CLAUDE_CREDENTIALS_FILE;
    }
  });
});

describe('claude-cli token accounting (transcript is authoritative)', () => {
  test('counts usage ONCE per message.id when Claude Code splits a turn across content-block rows', () => {
    // Three rows, one message, identical usage repeated on each — the real
    // transcript shape (verified on live-smoke-1: 25 usage rows / 8 messages).
    const usage = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5 };
    const split = [
      { requestId: 'r1', message: { id: 'm1', content: [{ type: 'thinking' }], usage } },
      { requestId: 'r1', message: { id: 'm1', content: [{ type: 'text' }], usage } },
      { requestId: 'r1', message: { id: 'm1', content: [{ type: 'tool_use', name: 'mcp__mcp-search__search' }], usage } },
    ];
    expect(sumTranscriptUsage(split)).toEqual({ tokensIn: 1110, tokensOut: 5 });
    // ...and emphatically NOT the 3x per-row total.
    expect(sumTranscriptUsage(split)).not.toEqual({ tokensIn: 3330, tokensOut: 15 });
    // mem-search counting deliberately does NOT dedupe: the tool_use lives in
    // the LAST row of the group, so a dedupe here would report 0.
    expect(countMemSearchCalls(split)).toBe(1);
  });

  test('rows with no message.id are counted individually (nothing to group by)', () => {
    const u = { input_tokens: 5, output_tokens: 1 };
    expect(sumTranscriptUsage([{ message: { usage: u } }, { message: { usage: u } }])).toEqual({
      tokensIn: 10,
      tokensOut: 2,
    });
  });

  test('the whole fixture transcript pins deduped tokens AND undeduped mem-search', async () => {
    const dir = tempDir('fixture-dedupe');
    const rows = await readJsonl(writeFixtureTranscript(dir));
    expect(sumTranscriptUsage(rows)).toEqual({
      tokensIn: FIXTURE_TRANSCRIPT_TOKENS_IN,
      tokensOut: FIXTURE_TRANSCRIPT_TOKENS_OUT,
    });
    expect(sumTranscriptUsage(rows).tokensIn).not.toBe(FIXTURE_NAIVE_TOKENS_IN);
    expect(countMemSearchCalls(rows)).toBe(4);
  });

  test('sumTranscriptUsage adds input + cache_creation + cache_read per turn', () => {
    const rows = [
      { message: { usage: { input_tokens: 5, cache_creation_input_tokens: 50, cache_read_input_tokens: 500, output_tokens: 3 } } },
      { message: { usage: { input_tokens: 7, output_tokens: 4 } } },
    ];
    expect(sumTranscriptUsage(rows)).toEqual({ tokensIn: 5 + 50 + 500 + 7, tokensOut: 7 });
  });

  test('sumTranscriptUsage omits a component no turn reported, never zero-fills', () => {
    // output only: tokensIn must be ABSENT (guard 1), not 0.
    expect(sumTranscriptUsage([{ message: { usage: { output_tokens: 9 } } }])).toEqual({ tokensOut: 9 });
    // no usage anywhere at all
    expect(sumTranscriptUsage([{ message: { content: [] } }, 'junk', null])).toEqual({});
    // non-numeric values are ignored rather than coerced
    expect(sumTranscriptUsage([{ message: { usage: { input_tokens: 'lots', output_tokens: 2 } } }])).toEqual({ tokensOut: 2 });
  });

  test('a retained transcript with NO usage clears the result-block numbers', async () => {
    const { fork, forkDir } = makeFork('tok-noturn');
    const stubDir = tempDir('tok-noturn-stub');
    const claudeBin = writeStubClaude(stubDir, {
      outDir: stubDir,
      // minimal transcript carries no usage at all
      fixtureTranscript: writeMinimalTranscript(stubDir),
      cannedJson: CANNED_RESULT, // claims 1200 / 340
    });
    const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeUndefined();
    expect(record.tokens_in).toBeUndefined();
    expect(record.tokens_out).toBeUndefined();
    // cost still comes from the result block — only TOKENS moved to the transcript.
    expect(record.cost_usd).toBe(0.0421);
    expect(forkDir).toBeTruthy();
  });

  test('falls back to result-block tokens when no transcript was retained', async () => {
    const { fork } = makeFork('tok-notranscript');
    const stubDir = tempDir('tok-notranscript-stub');
    // No fixtureTranscript => the stub writes none, so the fallback applies
    // (and the existing "transcript not found" error fires alongside it).
    const claudeBin = writeStubClaude(stubDir, { outDir: stubDir, cannedJson: CANNED_RESULT });
    const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBe('session transcript not found under fork HOME');
    expect(record.tokens_in).toBe(1200);
    expect(record.tokens_out).toBe(340);
  });
});

describe('claude-cli credential lifecycle', () => {
  const CREDS2 = JSON.stringify({ claudeAiOauth: { accessToken: 'live-ish-token' } });

  test('seeded credentials are deleted after the run even though the fork dir is kept', async () => {
    const { fork, forkDir } = makeFork('creds-teardown');
    const stubDir = tempDir('creds-teardown-stub');
    const claudeBin = writeStubClaude(stubDir, {
      outDir: stubDir,
      fixtureTranscript: writeFixtureTranscript(stubDir),
      cannedJson: CANNED_RESULT,
    });
    const executor = createClaudeCliExecutor({
      claudeBin,
      claudeMemRoot: CLAUDE_MEM_ROOT,
      credentialsJson: CREDS2,
    });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeUndefined();
    // The audit trail survives...
    expect(existsSync(join(forkDir, 'session-transcript.jsonl'))).toBe(true);
    // ...but the live credential does not.
    expect(existsSync(join(fork.homeDir, '.claude', '.credentials.json'))).toBe(false);
  });

  test('credentials are deleted on the failure path too', async () => {
    const { fork } = makeFork('creds-teardown-fail');
    const stubDir = tempDir('creds-teardown-fail-stub');
    // exit 1 and no transcript => error row, teardown must still scrub creds.
    const claudeBin = writeStubClaude(stubDir, { outDir: stubDir, exitCode: 1, mutateRepo: false });
    const executor = createClaudeCliExecutor({
      claudeBin,
      claudeMemRoot: CLAUDE_MEM_ROOT,
      credentialsJson: CREDS2,
    });
    const record = await executor.execute(fork, PROMPT, BUDGET);
    expect(record.error).toBeDefined();
    expect(existsSync(join(fork.homeDir, '.claude', '.credentials.json'))).toBe(false);
  });
});

describe('captureGitDiff vs the pinned base commit', () => {
  test('captures work the agent COMMITTED (bare `git diff` would be empty)', async () => {
    const { fork, forkDir } = makeFork('diff-committed');
    const baseSha = git(['rev-parse', 'HEAD'], fork.repoDir);
    const stubDir = tempDir('diff-committed-stub');
    // Stub agent: edit a tracked file, add a new file, then COMMIT both.
    const bin = join(stubDir, 'claude');
    writeFileSync(
      bin,
      [
        '#!/bin/bash',
        'echo "agent change" >> README.md',
        'echo "brand new" > NEWFILE.md',
        'git add -A',
        'git -c user.email=a@b.invalid -c user.name=Stub commit --quiet -m "agent work"',
        `cat "${stubDir}/canned.json"`,
      ].join('\n') + '\n',
    );
    chmodSync(bin, 0o755);
    writeFileSync(join(stubDir, 'canned.json'), CANNED_RESULT);

    const executor = createClaudeCliExecutor({ claudeBin: bin, claudeMemRoot: CLAUDE_MEM_ROOT });
    const record = await executor.execute({ ...fork, baseSha }, PROMPT, BUDGET);

    // Sanity: the agent really did commit, so the worktree is clean.
    expect(git(['status', '--porcelain'], fork.repoDir)).toBe('');
    const diff = readFileSync(join(forkDir, 'executor.diff'), 'utf-8');
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('agent change');
    expect(diff).toContain('NEWFILE.md');
    expect(record.diff_path).toBe(join(forkDir, 'executor.diff'));
  });

  test('still captures uncommitted and untracked work', async () => {
    const { fork, forkDir } = makeFork('diff-uncommitted');
    const baseSha = git(['rev-parse', 'HEAD'], fork.repoDir);
    const stubDir = tempDir('diff-uncommitted-stub');
    const bin = writeStubClaude(stubDir, {
      outDir: stubDir,
      fixtureTranscript: writeMinimalTranscript(stubDir),
      cannedJson: CANNED_RESULT,
    });
    // writeStubClaude's mutateRepo appends to README.md without committing.
    const record = await executor_execute(bin, { ...fork, baseSha });
    expect(record.error).toBeUndefined();
    const diff = readFileSync(join(forkDir, 'executor.diff'), 'utf-8');
    expect(diff).toContain('stub tweak');
  });
});

/** Small helper so the uncommitted-work case reads like the committed one. */
async function executor_execute(claudeBin: string, fork: ForkContext) {
  const executor = createClaudeCliExecutor({ claudeBin, claudeMemRoot: CLAUDE_MEM_ROOT });
  return executor.execute(fork, PROMPT, BUDGET);
}
