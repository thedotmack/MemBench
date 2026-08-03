/**
 * Offline tests for the fork infrastructure (plan Phase 4). The "worker" is
 * a local Bun.serve stub mimicking /api/readiness, /api/import and
 * /api/context/inject — no real claude-mem worker is spawned and no network
 * is touched. The repo clone runs real git against a local fixture
 * repository created per test run.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ControlSynthesisError,
  ORACLE_OBSERVATION_CONCEPTS,
  ORACLE_OBSERVATION_TYPE,
  parseOracleObservations,
} from '../src/controls.ts';
import {
  ForkError,
  buildSeedPayload,
  buildWorkerEnv,
  cloneRepoAtCommit,
  freePort,
  prepareFork,
  releasePort,
  teardownFork,
  type PreparedFork,
  type SpawnWorkerFn,
  type WorkerHandle,
} from '../src/fork.ts';
import { modelSlug } from '../src/observe-stage.ts';
import type { CorpusItem } from '../src/types.ts';
import type { ParsedObservation } from '../src/vendor/parser.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-fork-${name}-`));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** Local fixture git repo with two commits; returns its path and the FIRST commit's sha. */
function makeFixtureRepo(): { repoPath: string; pinnedCommit: string } {
  const repoPath = tempDir('gitrepo');
  git(['init', '--quiet', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'membench@example.invalid'], repoPath);
  git(['config', 'user.name', 'MemBench Fixture'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), 'pinned state\n');
  git(['add', '.'], repoPath);
  git(['commit', '--quiet', '-m', 'pinned'], repoPath);
  const pinnedCommit = git(['rev-parse', 'HEAD'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), 'later state\n');
  git(['add', '.'], repoPath);
  git(['commit', '--quiet', '-m', 'later'], repoPath);
  return { repoPath, pinnedCommit };
}

const HUMAN_PROMPT = 'Investigate the flaky startup context';

function makeItemDir(id: string, repoPath: string, commit: string): CorpusItem {
  const dir = tempDir(`item-${id}`);
  writeFileSync(
    join(dir, 'provenance.json'),
    JSON.stringify({
      project_slug: 'membench-fixture/worktree',
      dates: { session_n_ended: '2026-07-29T03:26:51.650Z' },
    }),
  );
  writeFileSync(join(dir, 'repo.lock'), JSON.stringify({ url: repoPath, commit, branch: 'main' }));
  writeFileSync(
    join(dir, 'transcript.jsonl'),
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: HUMAN_PROMPT },
    }) + '\n',
  );
  return { id, dir };
}

const OBS_A: ParsedObservation = {
  type: 'discovery',
  title: 'Startup context is stale',
  subtitle: 'coverage gap',
  facts: ['index spans May 4 - Jun 18', 'DB holds 30 more days'],
  narrative: 'The injected startup index lags the database by a month.',
  concepts: ['staleness'],
  files_read: ['src/hooks/session-start.ts'],
  files_modified: [],
};
const OBS_B: ParsedObservation = {
  type: 'decision',
  title: 'Projects are worktree-qualified',
  subtitle: null,
  facts: ['project="claude-mem" returns nothing'],
  narrative: null,
  concepts: [],
  files_read: [],
  files_modified: [],
};

// ---------------------------------------------------------------------------
// Stub worker (Bun.serve)
// ---------------------------------------------------------------------------

interface StubWorker {
  port: number;
  importBodies: unknown[];
  injectRequests: URL[];
  readinessPolls: number;
  stop(): void;
}

function startStubWorker(
  options: { readinessFailures?: number; importFailures?: number; injectionText?: string } = {},
): StubWorker {
  const importBodies: unknown[] = [];
  const injectRequests: URL[] = [];
  const injectionText = options.injectionText ?? '## recent memory\n- Startup context is stale\n';
  let readinessFailures = options.readinessFailures ?? 0;
  let importFailures = options.importFailures ?? 0;
  const stub: StubWorker = {
    port: 0,
    importBodies,
    injectRequests,
    readinessPolls: 0,
    stop: () => {},
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/readiness') {
        stub.readinessPolls++;
        if (readinessFailures > 0) {
          readinessFailures--;
          return Response.json({ status: 'initializing' }, { status: 503 });
        }
        return Response.json({ status: 'ready', mcpReady: true });
      }
      if (url.pathname === '/api/import' && request.method === 'POST') {
        if (importFailures > 0) {
          importFailures--;
          return Response.json({ error: 'stubbed import failure' }, { status: 500 });
        }
        const body = (await request.json()) as { sessions?: unknown[]; observations?: unknown[] };
        importBodies.push(body);
        return Response.json({
          stats: {
            sessionsImported: body.sessions?.length ?? 0,
            sessionsSkipped: 0,
            summariesImported: 0,
            summariesSkipped: 0,
            observationsImported: body.observations?.length ?? 0,
            observationsSkipped: 0,
            promptsImported: 0,
            promptsSkipped: 0,
          },
        });
      }
      if (url.pathname === '/api/context/inject') {
        injectRequests.push(url);
        return new Response(injectionText, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return new Response('not found', { status: 404 });
    },
  });
  stub.port = server.port!;
  stub.stop = () => server.stop(true);
  return stub;
}

function fakeWorker(overrides: Partial<WorkerHandle> = {}): WorkerHandle & { kills: (number | NodeJS.Signals | undefined)[] } {
  const kills: (number | NodeJS.Signals | undefined)[] = [];
  return {
    pid: 4_000_000, // no such pid — never touched, killTree is stubbed
    kill: (signal?: number | NodeJS.Signals) => {
      kills.push(signal);
    },
    exited: new Promise(() => {}),
    kills,
    ...overrides,
  };
}

interface ForkHarness {
  stub: StubWorker;
  worker: ReturnType<typeof fakeWorker>;
  spawns: number;
  killed: WorkerHandle[];
  runsDir: string;
  prepare(item: CorpusItem, variant: Parameters<typeof prepareFork>[1], observations?: ParsedObservation[]): Promise<PreparedFork>;
}

function makeHarness(stubOptions: Parameters<typeof startStubWorker>[0] = {}): ForkHarness {
  const stub = startStubWorker(stubOptions);
  const worker = fakeWorker();
  const killed: WorkerHandle[] = [];
  const harness: ForkHarness = {
    stub,
    worker,
    spawns: 0,
    killed,
    runsDir: tempDir('runs'),
    prepare(item, variant, observations) {
      const spawnWorker: SpawnWorkerFn = () => {
        harness.spawns++;
        return worker;
      };
      return prepareFork(item, variant, harness.runsDir, {
        runId: 'run-001',
        port: stub.port,
        ...(observations !== undefined ? { observations } : {}),
        spawnWorker,
        killTree: async (target) => {
          killed.push(target);
        },
        readinessTimeoutMs: 2_000,
      });
    },
  };
  return harness;
}

// ---------------------------------------------------------------------------
// prepareFork end-to-end against the stub
// ---------------------------------------------------------------------------

describe('prepareFork against a stub worker', () => {
  const { repoPath, pinnedCommit } = makeFixtureRepo();

  test('seeds, clones at the pinned commit, and captures the injection block', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-e2e', repoPath, pinnedCommit);
    const fork = await harness.prepare(item, 'model:test/observer-1', [OBS_A, OBS_B]);
    try {
      // Fork layout: <runsDir>/<runId>/forks/<item>/<variant-slug>/{mem,home,repo}
      const forkDir = join(harness.runsDir, 'run-001', 'forks', 'item-e2e', modelSlug('model:test/observer-1'));
      expect(fork.dataDir).toBe(join(forkDir, 'mem'));
      expect(fork.homeDir).toBe(join(forkDir, 'home'));
      expect(fork.repoDir).toBe(join(forkDir, 'repo'));
      expect(existsSync(fork.dataDir)).toBe(true);
      expect(existsSync(fork.homeDir)).toBe(true);
      expect(fork.workerPort).toBe(harness.stub.port);
      expect(harness.spawns).toBe(1);

      // Repo is checked out at exactly the pinned (non-HEAD) commit.
      expect(git(['rev-parse', 'HEAD'], fork.repoDir)).toBe(pinnedCommit);
      expect(git(['rev-parse', 'HEAD'], repoPath)).not.toBe(pinnedCommit);

      // Injection block landed in the ForkContext, targeted at the item's
      // project slug — which the context also records for the run manifest.
      expect(fork.injectionBlock).toContain('Startup context is stale');
      expect(fork.projectSlug).toBe('membench-fixture/worktree');
      expect(harness.stub.injectRequests).toHaveLength(1);
      expect(harness.stub.injectRequests[0].searchParams.get('project')).toBe('membench-fixture/worktree');
    } finally {
      await teardownFork(fork, { keepData: false });
      harness.stub.stop();
    }
  });

  test('POSTs the import-memories payload shape: minimal session + DB-shaped observation rows', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-shape', repoPath, pinnedCommit);
    const fork = await harness.prepare(item, 'oracle', [OBS_A, OBS_B]);
    try {
      expect(harness.stub.importBodies).toHaveLength(1);
      const body = harness.stub.importBodies[0] as Record<string, unknown[]>;
      // Top-level keys exactly as import-memories.ts:48-53 sends them.
      expect(Object.keys(body).sort()).toEqual(['observations', 'prompts', 'sessions', 'summaries']);
      expect(body.summaries).toEqual([]);
      expect(body.prompts).toEqual([]);

      const session = body.sessions[0] as Record<string, unknown>;
      expect(Object.keys(session).sort()).toEqual([
        'completed_at',
        'completed_at_epoch',
        'content_session_id',
        'memory_session_id',
        'project',
        'started_at',
        'started_at_epoch',
        'status',
        'user_prompt',
      ]);
      expect(session.project).toBe('membench-fixture/worktree');
      expect(session.status).toBe('completed');
      // Seed session carries session N's real opening prompt, and nothing
      // that names the variant (no context leak into injection).
      expect(session.user_prompt).toBe(HUMAN_PROMPT);
      expect(JSON.stringify(session)).not.toContain('oracle');

      expect(body.observations).toHaveLength(2);
      const row = body.observations[0] as Record<string, unknown>;
      expect(row.memory_session_id).toBe(session.memory_session_id);
      expect(row.project).toBe('membench-fixture/worktree');
      expect(row.type).toBe('discovery');
      expect(row.title).toBe('Startup context is stale');
      // Array fields are JSON-encoded strings — the DB storage form.
      expect(JSON.parse(row.facts as string)).toEqual(OBS_A.facts);
      expect(JSON.parse(row.concepts as string)).toEqual(['staleness']);
      expect(JSON.parse(row.files_read as string)).toEqual(OBS_A.files_read);
      expect(row.narrative).toBe(OBS_A.narrative);
      expect(row.discovery_tokens).toBe(0);

      // Distinct created_at_epoch per row (import dedupe key includes it).
      const epochs = (body.observations as Record<string, unknown>[]).map((o) => o.created_at_epoch);
      expect(new Set(epochs).size).toBe(2);
      // Anchored to the item's recorded session end, not wall-clock.
      expect(epochs[0]).toBe(Date.parse('2026-07-29T03:26:51.650Z'));
    } finally {
      await teardownFork(fork, { keepData: false });
      harness.stub.stop();
    }
  });

  test('`none` seeds nothing and gets the bare-task empty injection block', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-none', repoPath, pinnedCommit);
    const fork = await harness.prepare(item, 'none');
    try {
      expect(harness.stub.importBodies).toHaveLength(0);
      expect(harness.stub.injectRequests).toHaveLength(0);
      expect(fork.injectionBlock).toBe('');
      // Still fully provisioned: repo + home + live worker.
      expect(git(['rev-parse', 'HEAD'], fork.repoDir)).toBe(pinnedCommit);
      expect(existsSync(fork.homeDir)).toBe(true);
    } finally {
      await teardownFork(fork, { keepData: false });
      harness.stub.stop();
    }
  });

  test('refuses observations for `none` and requires them for every other variant', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-args', repoPath, pinnedCommit);
    await expect(harness.prepare(item, 'none', [OBS_A])).rejects.toThrow('seeds nothing');
    await expect(harness.prepare(item, 'shuffled')).rejects.toThrow('requires an observation set');
    harness.stub.stop();
  });

  test('teardown kills the worker tree and prunes mem/ only on the happy path', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-teardown', repoPath, pinnedCommit);

    const kept = await harness.prepare(item, 'oracle', [OBS_A]);
    await teardownFork(kept, { keepData: true });
    expect(harness.killed).toHaveLength(1);
    expect(existsSync(kept.dataDir)).toBe(true); // audit trail kept

    // A different variant of the same item — the kept-for-audit oracle mem/
    // above would (correctly) trip the stale-dir guard.
    const pruned = await harness.prepare(item, 'shuffled', [OBS_A]);
    await teardownFork(pruned, { keepData: false });
    expect(harness.killed).toHaveLength(2);
    expect(existsSync(pruned.dataDir)).toBe(false); // mem/ pruned
    expect(existsSync(pruned.homeDir)).toBe(true); // repo/home stay for the executor phases
    harness.stub.stop();
  });

  test('refuses to reuse a non-empty (kept-for-audit) data dir', async () => {
    const harness = makeHarness();
    const item = makeItemDir('item-stale', repoPath, pinnedCommit);

    const first = await harness.prepare(item, 'oracle', [OBS_A]);
    await teardownFork(first, { keepData: true }); // mem/ kept for audit
    // A real worker leaves its DB/settings/logs in mem/ — the stub writes
    // nothing, so plant the leftover the guard exists to protect.
    writeFileSync(join(first.dataDir, 'claude-mem.db'), 'audit leftover');
    await expect(harness.prepare(item, 'oracle', [OBS_A])).rejects.toThrow('already exists and is non-empty');

    // After a happy-path prune of the same dir, re-preparing is fine again.
    const second = await harness.prepare(item, 'shuffled', [OBS_A]);
    await teardownFork(second, { keepData: false });
    const third = await harness.prepare(item, 'shuffled', [OBS_A]);
    await teardownFork(third, { keepData: false });
    harness.stub.stop();
  });

  test('seed failure (500 from /api/import) tears down: worker killed, mem/ kept', async () => {
    const stub = startStubWorker({ importFailures: 1 });
    const killed: WorkerHandle[] = [];
    const item = makeItemDir('item-seedfail', repoPath, pinnedCommit);
    const runsDir = tempDir('runs-seedfail');

    const attempt = prepareFork(item, 'oracle', runsDir, {
      runId: 'run-001',
      port: stub.port,
      observations: [OBS_A],
      spawnWorker: () => fakeWorker(),
      killTree: async (target) => {
        killed.push(target);
      },
      readinessTimeoutMs: 2_000,
    });
    await expect(attempt).rejects.toThrow('POST /api/import failed: 500');
    expect(killed).toHaveLength(1);
    expect(stub.importBodies).toHaveLength(0); // the 500 attempt was not recorded as a seed
    const dataDir = join(runsDir, 'run-001', 'forks', 'item-seedfail', 'oracle', 'mem');
    expect(existsSync(dataDir)).toBe(true); // kept for audit
    stub.stop();
  });

  test('readiness timeout tears down (kill + keep mem/) and rethrows', async () => {
    const stub = startStubWorker({ readinessFailures: 1_000_000 });
    const worker = fakeWorker();
    const killed: WorkerHandle[] = [];
    const item = makeItemDir('item-notready', repoPath, pinnedCommit);
    const runsDir = tempDir('runs-notready');

    const attempt = prepareFork(item, 'oracle', runsDir, {
      runId: 'run-001',
      port: stub.port,
      observations: [OBS_A],
      spawnWorker: () => worker,
      killTree: async (target) => {
        killed.push(target);
      },
      readinessTimeoutMs: 400,
    });
    await expect(attempt).rejects.toThrow('not ready within');
    expect(killed).toHaveLength(1);
    const dataDir = join(runsDir, 'run-001', 'forks', 'item-notready', 'oracle', 'mem');
    expect(existsSync(dataDir)).toBe(true); // kept for audit
    expect(stub.readinessPolls).toBeGreaterThan(0);
    stub.stop();
  });

  test('fails fast when the worker process exits before readiness (after one respawn retry)', async () => {
    const stub = startStubWorker({ readinessFailures: 1_000_000 });
    const item = makeItemDir('item-earlyexit', repoPath, pinnedCommit);
    let spawns = 0;
    const attempt = prepareFork(item, 'oracle', tempDir('runs-earlyexit'), {
      runId: 'run-001',
      port: stub.port,
      observations: [OBS_A],
      spawnWorker: () => {
        spawns++;
        return fakeWorker({ exited: Promise.resolve(1) });
      },
      killTree: async () => {},
      readinessTimeoutMs: 5_000,
    });
    await expect(attempt).rejects.toThrow('exited before');
    expect(spawns).toBe(2); // port-steal signature earns exactly one respawn
    stub.stop();
  });

  test('recovers when the first worker dies before readiness and the respawn binds', async () => {
    // One readiness 503 so the poll loop observes the dead worker's exit
    // (a 200-first stub would succeed before noticing the exit — see
    // waitForReadiness's check-then-fetch ordering).
    const stub = startStubWorker({ readinessFailures: 1 });
    const item = makeItemDir('item-respawn', repoPath, pinnedCommit);
    const deadWorker = fakeWorker({ exited: Promise.resolve(1) });
    const liveWorker = fakeWorker();
    const killed: WorkerHandle[] = [];
    let spawns = 0;
    const fork = await prepareFork(item, 'none', tempDir('runs-respawn'), {
      runId: 'run-001',
      port: stub.port,
      spawnWorker: () => (++spawns === 1 ? deadWorker : liveWorker),
      killTree: async (target) => {
        killed.push(target);
      },
      readinessTimeoutMs: 5_000,
    });
    expect(spawns).toBe(2);
    expect(killed[0]).toBe(deadWorker); // the dead first attempt was reaped
    expect(fork.worker).toBe(liveWorker);
    await teardownFork(fork, { keepData: false });
    stub.stop();
  });

  test('guard 4: refuses a fork rooted inside the user\'s real ~/.claude-mem', async () => {
    const item = makeItemDir('item-guard', repoPath, pinnedCommit);
    const attempt = prepareFork(item, 'none', join(homedir(), '.claude-mem', 'runs'), {
      runId: 'run-001',
      spawnWorker: () => fakeWorker(),
      killTree: async () => {},
    });
    await expect(attempt).rejects.toThrow('guard 4');
    // Nothing was created inside the forbidden tree.
    expect(existsSync(join(homedir(), '.claude-mem', 'runs', 'run-001'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Worker env (guards 4 + 8)
// ---------------------------------------------------------------------------

describe('buildWorkerEnv', () => {
  test('is an allowlist: no parent secret (known or unknown) reaches a spawned worker', () => {
    const saved: Record<string, string | undefined> = {
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      EXTRA_SECRET: process.env.EXTRA_SECRET,
      CLAUDE_MEM_DATA_DIR: process.env.CLAUDE_MEM_DATA_DIR,
    };
    process.env.OPENROUTER_API_KEY = 'sk-or-parent-secret';
    process.env.EXTRA_SECRET = 'a-secret-no-strip-list-anticipated';
    process.env.CLAUDE_MEM_DATA_DIR = '/tmp/parent-claude-mem-override';
    try {
      const dataDir = '/tmp/membench-forks/item/variant/mem';
      const homeDir = '/tmp/membench-forks/item/variant/home';
      const env = buildWorkerEnv(dataDir, 39_111, homeDir);

      // Secrets do NOT pass through — including ones no strip-list names.
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.EXTRA_SECRET).toBeUndefined();
      // Nor can a parent CLAUDE_MEM_* value repoint the fork at real data.
      expect(env.CLAUDE_MEM_DATA_DIR).toBe(dataDir);

      // Every key is either the shell-ish allowlist or explicitly set.
      const allowed = new Set(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'SHELL', 'USER', 'LOGNAME', 'TZ', 'TERM']);
      const explicit = new Set([
        'HOME',
        'CLAUDE_CONFIG_DIR',
        'CLAUDE_MEM_CHROMA_ENABLED',
        'CLAUDE_MEM_DATA_DIR',
        'CLAUDE_MEM_RUNTIME',
        'CLAUDE_MEM_WELCOME_HINT_ENABLED',
        'CLAUDE_MEM_WORKER_HOST',
        'CLAUDE_MEM_WORKER_PORT',
      ]);
      for (const key of Object.keys(env)) {
        expect(allowed.has(key) || explicit.has(key) || key.startsWith('LC_')).toBe(true);
      }

      // Isolation vars all forced.
      expect(env.PATH).toBe(process.env.PATH!); // worker must still find bun/git
      expect(env.HOME).toBe(homeDir); // isolated HOME
      expect(env.CLAUDE_MEM_WORKER_PORT).toBe('39111');
      expect(env.CLAUDE_MEM_RUNTIME).toBe('worker'); // guard 8
      expect(env.CLAUDE_MEM_CHROMA_ENABLED).toBe('false');
      expect(env.CLAUDE_CONFIG_DIR).toBe(join(homeDir, '.claude'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// freePort
// ---------------------------------------------------------------------------

describe('freePort', () => {
  test('returns an OS-assigned port that is immediately bindable', () => {
    const port = freePort();
    expect(port).toBeGreaterThan(0);
    const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
    server.stop(true);
    releasePort(port);
  });

  test('issues distinct ports to concurrent callers until released', () => {
    const ports = Array.from({ length: 8 }, () => freePort());
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) releasePort(port);
  });
});

// ---------------------------------------------------------------------------
// buildSeedPayload / modelSlug / clone
// ---------------------------------------------------------------------------

describe('buildSeedPayload', () => {
  test('emits the exact import row shapes (SessionStore import signatures)', () => {
    const payload = buildSeedPayload({
      itemId: 'item-x',
      projectSlug: 'proj',
      userPrompt: 'Fix the thing',
      observations: [OBS_B],
      baseEpoch: 1_753_000_000_000,
    });
    expect(payload.sessions).toHaveLength(1);
    expect(payload.sessions[0].content_session_id).toBe('membench-seed-item-x');
    expect(payload.sessions[0].started_at_epoch).toBe(1_753_000_000_000);
    const row = payload.observations[0];
    expect(Object.keys(row).sort()).toEqual([
      'concepts',
      'created_at',
      'created_at_epoch',
      'discovery_tokens',
      'facts',
      'files_modified',
      'files_read',
      'memory_session_id',
      'narrative',
      'project',
      'prompt_number',
      'subtitle',
      'text',
      'title',
      'type',
    ]);
    expect(row.text).toBeNull();
    expect(row.narrative).toBeNull(); // null preserved, not ''
    expect(JSON.parse(row.facts as string)).toEqual(OBS_B.facts);
  });
});

describe('modelSlug (shared variant/model slug)', () => {
  test('makes model variants path-safe and leaves controls alone', () => {
    // Lossy cleaning appends an 8-hex disambiguator.
    expect(modelSlug('model:openai/gpt-4o')).toMatch(/^model-openai-gpt-4o-[0-9a-f]{8}$/);
    expect(modelSlug('none')).toBe('none');
    expect(modelSlug('oracle')).toBe('oracle');
    expect(modelSlug('shuffled')).toBe('shuffled');
  });

  test('distinct model ids that clean identically cannot collide', () => {
    expect(modelSlug('model:a/b')).not.toBe(modelSlug('model:a-b'));
    // Deterministic across calls.
    expect(modelSlug('model:a/b')).toBe(modelSlug('model:a/b'));
  });
});

describe('cloneRepoAtCommit', () => {
  test('rejects an unknown commit instead of leaving a wrong checkout', async () => {
    const { repoPath } = makeFixtureRepo();
    const dest = join(tempDir('clone-bad'), 'repo');
    await expect(
      cloneRepoAtCommit(repoPath, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', dest),
    ).rejects.toThrow(ForkError);
  });
});

// ---------------------------------------------------------------------------
// controls.ts — oracle parsing + shuffled mapping
// ---------------------------------------------------------------------------

const ORACLE_FIXTURE = `# Oracle notes — fixture-001

Preamble framing that must NOT become an observation.

## Session goal and outcome

- **What happened**: a two-part memory-inspection exercise,
  no code changes were made.

## Findings

- **Query gotcha**: \`project="claude-mem"\` returns nothing — projects are
  stored worktree-qualified.
- **The stale index**: coverage stopped a month before the DB did.

## State left behind

Free-form paragraph without bullets.
`;

describe('parseOracleObservations', () => {
  test('one observation row per ## section, titled bullets flattened into facts', () => {
    const rows = parseOracleObservations(ORACLE_FIXTURE, 'fixture-001');
    expect(rows.map((row) => row.title)).toEqual(['Session goal and outcome', 'Findings', 'State left behind']);
    expect(rows.every((row) => row.type === ORACLE_OBSERVATION_TYPE)).toBe(true);
    // Injection-visible concepts (ObservationCompiler.ts:56-59 requires the
    // intersection to be non-empty, or the row never renders).
    expect(rows.every((row) => row.concepts.length > 0)).toBe(true);
    expect(rows[0].concepts).toEqual(ORACLE_OBSERVATION_CONCEPTS);

    // Multi-line bullet flattened, bold stripped, "Title: rest" preserved.
    expect(rows[0].facts).toEqual([
      'What happened: a two-part memory-inspection exercise, no code changes were made.',
    ]);
    expect(rows[1].facts).toHaveLength(2);
    expect(rows[1].facts[0]).toStartWith('Query gotcha:');
    expect(rows[1].facts[1]).toBe('The stale index: coverage stopped a month before the DB did.');

    // Bullet-less section still carries its narrative.
    expect(rows[2].facts).toEqual([]);
    expect(rows[2].narrative).toBe('Free-form paragraph without bullets.');

    // Preamble is framing, not memory.
    expect(JSON.stringify(rows)).not.toContain('Preamble framing');
  });

  test('parses the real claude-mem-001 oracle into seedable rows', async () => {
    const path = join(import.meta.dir, '..', '..', 'corpus', 'claude-mem-001', 'oracle.md');
    const rows = parseOracleObservations(await Bun.file(path).text(), 'claude-mem-001');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[0].title).toBe('Session goal and outcome');
    expect(rows.every((row) => row.facts.length > 0 || row.narrative !== null)).toBe(true);
  });

  test('drops empty facts from bare `- ` bullets', () => {
    const rows = parseOracleObservations('## Section\n\n- \n- **Real**: a fact\n- \n', 'bare-bullets');
    expect(rows[0].facts).toEqual(['Real: a fact']);
  });

  test('throws when no sections parse (a ceiling that seeds nothing is a corpus bug)', () => {
    expect(() => parseOracleObservations('no headings here', 'bad-item')).toThrow(ControlSynthesisError);
  });
});
