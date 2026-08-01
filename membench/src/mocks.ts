/**
 * Offline mocks for `--mock` (plan Phase 6.4) — the whole loop, zero network.
 *
 * Every seam the live pipeline uses is already injectable, so the mocks are
 * drop-in replacements rather than a parallel code path:
 *   - observe + judge transport → observe-runner's QueryModelFn seam
 *   - executors                 → the Executor interface (both lanes)
 *   - claude-mem worker         → fork.ts's spawnWorker seam, backed by a
 *                                 local Bun.serve stub on the pool's port
 *                                 (/api/readiness, /api/import,
 *                                 /api/context/inject + the mem-search routes)
 *   - repo clone                → fork.ts's cloneRepo seam (git init + a
 *                                 baseline commit, so `git diff` and check.sh
 *                                 behave exactly as in a live fork)
 *
 * Mock spend is FAKE money. Runs made with these mocks write
 * manifest.json {"mock": true}, and the cost estimator skips mock run dirs —
 * fabricated rates must never leak into a real cost estimate (guard 1).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureGitDiff, forkRootDir } from './executors/shared.js';
import type { CloneRepoFn, SpawnWorkerFn, WorkerHandle } from './fork.js';
import { JUDGE_PROMPT_MARKER } from './measure.js';
import type { QueryModelFn } from './observe-runner.js';
import type { ExecutionRecord, Executor, ExecutorName, ForkContext } from './types.js';

// ---------------------------------------------------------------------------
// Mock provider (observe turns + judge calls)
// ---------------------------------------------------------------------------

/** Canned, parser-valid observation XML (shape per the vendored parser). */
export const MOCK_OBSERVATION_XML = `<observation>
  <type>discovery</type>
  <title>Mock observation</title>
  <subtitle>canned offline reply</subtitle>
  <facts>
    <fact>The mock provider returns a fixed observation per tool call</fact>
  </facts>
  <narrative>Offline mock reply used by --mock runs.</narrative>
  <concepts>
    <concept>how-it-works</concept>
  </concepts>
  <files_read>
    <file>src/mocks.ts</file>
  </files_read>
  <files_modified>
  </files_modified>
</observation>`;

/** Canned JSON-mode reply for models driven down the accommodation path. */
export const MOCK_OBSERVATION_JSON = JSON.stringify({
  observations: [
    {
      type: 'discovery',
      title: 'Mock observation (json mode)',
      subtitle: 'canned offline reply',
      facts: ['The mock provider answered in JSON mode'],
      narrative: 'Offline mock reply used by --mock runs after the JSON accommodation.',
      concepts: ['how-it-works'],
      files_read: ['src/mocks.ts'],
      files_modified: [],
    },
  ],
});

export interface MockQueryOptions {
  /** Reported input tokens per call (omit to report none). */
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Reported cost per call (null → "provider reported no cost"). */
  costUsd?: number | null;
  /** Judge verdict for drift. */
  drift?: boolean;
  /** Judge verdict for success on judge-gated items. */
  judgeSuccess?: boolean;
  /**
   * Models whose XML replies are unparseable prose, so observe-runner's
   * >50% parse-fail rule triggers the JSON accommodation; the JSON-mode pass
   * then returns valid JSON observations.
   */
  jsonAccommodationModels?: string[];
  /** When set, every judge call throws with this message (transport failure). */
  judgeFails?: string;
  /** Records every call for assertions. */
  calls?: { model: string; prompt: string }[];
}

/**
 * A QueryModelFn that answers observe turns with canned valid XML and judge
 * calls with a canned JSON verdict (keyed on measure.ts's prompt marker).
 */
export function createMockQueryModel(options: MockQueryOptions = {}): QueryModelFn {
  const {
    tokensIn = 900,
    tokensOut = 120,
    costUsd = 0.0004,
    drift = false,
    judgeSuccess = true,
    jsonAccommodationModels = [],
    judgeFails,
    calls,
  } = options;

  return async (model, messages, opts) => {
    const last = messages[messages.length - 1];
    const prompt = typeof last?.content === 'string' ? last.content : '';
    calls?.push({ model, prompt });

    const usage = {
      ...(tokensIn !== null ? { inputTokens: tokensIn } : {}),
      ...(tokensOut !== null ? { outputTokens: tokensOut } : {}),
      ...(costUsd !== null ? { costUsd } : {}),
      servedModel: model,
    };

    if (prompt.includes(JUDGE_PROMPT_MARKER)) {
      if (judgeFails) throw new Error(judgeFails);
      const verdict: Record<string, unknown> = { drift, note: 'mock judge verdict' };
      if (prompt.includes('SUCCESS RUBRIC')) verdict.success = judgeSuccess;
      return { content: JSON.stringify(verdict), ...usage };
    }

    // The init turn (history length 1) is a prose acknowledgment in
    // production; observation turns return observation XML.
    if (messages.length === 1) {
      return { content: 'Ready to observe this session.', ...usage };
    }
    if (jsonAccommodationModels.includes(model)) {
      // Tag discipline fails in the XML pass; content arrives in JSON mode.
      return opts?.response_format?.type === 'json_object'
        ? { content: MOCK_OBSERVATION_JSON, ...usage }
        : { content: 'I noticed a few things but I will describe them in prose.', ...usage };
    }
    return { content: MOCK_OBSERVATION_XML, ...usage };
  };
}

// ---------------------------------------------------------------------------
// Mock claude-mem worker (fork.ts spawnWorker/killTree seams)
// ---------------------------------------------------------------------------

interface MockWorkerState {
  /** Bun.serve handle; only stop() is used, so the concrete generic is irrelevant. */
  server: { stop(closeActiveConnections?: boolean): void };
  imports: unknown[];
  markExited: () => void;
}

export interface MockWorkerFarm {
  spawnWorker: SpawnWorkerFn;
  killTree: (worker: WorkerHandle) => Promise<void>;
  /** Import bodies received, per port — for assertions. */
  importsByPort: Map<number, unknown[]>;
  /** Stop every still-running stub (test teardown safety net). */
  stopAll(): void;
}

interface SeedObservationLike {
  title?: unknown;
  narrative?: unknown;
  facts?: unknown;
}

/** Render an injection block from what was seeded — mirrors the real shape loosely. */
function renderInjection(imports: unknown[]): string {
  const titles: string[] = [];
  for (const body of imports) {
    const observations = (body as { observations?: unknown }).observations;
    if (!Array.isArray(observations)) continue;
    for (const observation of observations as SeedObservationLike[]) {
      if (typeof observation.title === 'string' && observation.title.trim() !== '') {
        titles.push(observation.title);
      }
    }
  }
  if (titles.length === 0) return '## Past work\n\n(no observations)\n';
  return `## Past work\n\n${titles.map((title) => `- ${title}`).join('\n')}\n`;
}

/**
 * A farm of stub workers: each spawn starts a Bun.serve on the port fork.ts
 * assigned via CLAUDE_MEM_WORKER_PORT and answers the four routes prepareFork
 * and the SDK executor's mem-search tools use.
 */
export function createMockWorkerFarm(): MockWorkerFarm {
  const byPid = new Map<number, MockWorkerState>();
  const importsByPort = new Map<number, unknown[]>();
  let nextPid = 900_000;

  const spawnWorker: SpawnWorkerFn = ({ env }) => {
    const port = Number.parseInt(env.CLAUDE_MEM_WORKER_PORT ?? '', 10);
    if (!Number.isInteger(port)) {
      throw new Error('mock worker: CLAUDE_MEM_WORKER_PORT missing from the spawn env');
    }
    const imports: unknown[] = [];
    importsByPort.set(port, imports);
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/api/readiness') {
          return Response.json({ status: 'ready', mcpReady: true });
        }
        if (url.pathname === '/api/import' && request.method === 'POST') {
          const body = (await request.json()) as { sessions?: unknown[]; observations?: unknown[] };
          imports.push(body);
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
          return new Response(renderInjection(imports), {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        if (url.pathname === '/api/search' || url.pathname === '/api/timeline') {
          return Response.json({ results: [] });
        }
        if (url.pathname === '/api/observations/batch') {
          return Response.json({ observations: [] });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const pid = nextPid++;
    let markExited = () => {};
    const exited = new Promise<void>((resolveExited) => {
      markExited = () => resolveExited();
    });
    byPid.set(pid, { server, imports, markExited });
    return {
      pid,
      kill: () => {
        stop(pid);
      },
      exited,
    };
  };

  function stop(pid: number): void {
    const state = byPid.get(pid);
    if (!state) return;
    byPid.delete(pid);
    state.server.stop(true);
    state.markExited();
  }

  return {
    spawnWorker,
    killTree: async (worker) => {
      stop(worker.pid);
    },
    importsByPort,
    stopAll: () => {
      for (const pid of [...byPid.keys()]) stop(pid);
    },
  };
}

// ---------------------------------------------------------------------------
// Mock repo clone (fork.ts cloneRepo seam)
// ---------------------------------------------------------------------------

function git(args: string[], cwd?: string): void {
  const result = Bun.spawnSync(['git', ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: 'ignore',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
}

/**
 * Mock clone: a real local git repo with one baseline commit recording the
 * pinned url/commit. Real git (so `git diff` and check.sh behave as live) but
 * no network and no fetch of the pinned sha.
 */
export const mockCloneRepo: CloneRepoFn = async (url, commit, destDir) => {
  mkdirSync(destDir, { recursive: true });
  git(['init', '--quiet', '-b', 'main', destDir]);
  git(['config', 'user.email', 'membench@example.invalid'], destDir);
  git(['config', 'user.name', 'MemBench Mock'], destDir);
  writeFileSync(join(destDir, 'PINNED.md'), `mock clone\nurl: ${url}\ncommit: ${commit}\n`);
  git(['add', '.'], destDir);
  git(['commit', '--quiet', '-m', 'mock baseline'], destDir);
};

// ---------------------------------------------------------------------------
// Mock executors (both lanes)
// ---------------------------------------------------------------------------

/** The file a successful mock run leaves behind; fixture check.sh looks for it. */
export const MOCK_MARKER_FILE = 'membench-mock-marker.md';

export interface MockExecutorOptions {
  lane: ExecutorName;
  /**
   * Injected failure: return an error string to make THIS run fail (no marker
   * file written, `error` set on the record → error row).
   */
  failFor?: (context: { fork: ForkContext; prompt: string; callIndex: number }) => string | undefined;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  memSearchCalls?: number;
  /** Records every execute() call for assertions. */
  calls?: { lane: ExecutorName; variant: string; item: string; prompt: string }[];
}

/**
 * A canned Executor: writes a marker file into the fork repo (a trivial but
 * REAL diff, captured through the same captureGitDiff path as the live
 * lanes), writes a transcript, and returns a complete ExecutionRecord —
 * including on an injected failure (guard 3).
 */
export function createMockExecutor(options: MockExecutorOptions): Executor {
  const {
    lane,
    failFor,
    tokensIn = 4_200,
    tokensOut = 800,
    costUsd = 0.011,
    memSearchCalls = 2,
    calls,
  } = options;
  let callIndex = 0;

  return {
    async execute(fork: ForkContext, prompt: string): Promise<ExecutionRecord> {
      const index = callIndex++;
      calls?.push({ lane, variant: fork.variant, item: fork.item.id, prompt });
      const forkDir = forkRootDir(fork);
      const transcriptPath = join(forkDir, `mock-${lane}-transcript.jsonl`);
      const diffPath = join(forkDir, 'executor.diff');
      const record: ExecutionRecord = {
        output: '',
        mem_search_calls: 0,
        transcript_path: transcriptPath,
        diff_path: diffPath,
      };

      const failure = failFor?.({ fork, prompt, callIndex: index });
      try {
        writeFileSync(
          transcriptPath,
          JSON.stringify({
            type: 'prompt',
            lane,
            variant: fork.variant,
            item: fork.item.id,
            prompt,
            failure: failure ?? null,
          }) + '\n',
        );

        if (failure) {
          record.error = failure;
        } else {
          writeFileSync(
            join(fork.repoDir, MOCK_MARKER_FILE),
            `# mock run\n\nlane: ${lane}\nvariant: ${fork.variant}\nitem: ${fork.item.id}\n`,
          );
          record.output = `mock ${lane} run complete for ${fork.item.id} (${fork.variant})`;
          record.mem_search_calls = memSearchCalls;
          if (tokensIn !== null) record.tokens_in = tokensIn;
          if (tokensOut !== null) record.tokens_out = tokensOut;
          if (costUsd !== null) record.cost_usd = costUsd;
        }
      } catch (error: unknown) {
        record.error = error instanceof Error ? error.message : String(error);
      } finally {
        const diff = captureGitDiff(fork.repoDir, diffPath);
        if (!diff.ok && !record.error) record.error = diff.error ?? 'diff capture failed';
      }
      return record;
    },
  };
}

export interface MockDepsOptions {
  lanes?: ExecutorName[];
  query?: MockQueryOptions;
  executor?: Omit<MockExecutorOptions, 'lane'>;
}

export interface MockDeps {
  query: QueryModelFn;
  executors: Partial<Record<ExecutorName, Executor>>;
  spawnWorker: SpawnWorkerFn;
  cloneRepo: CloneRepoFn;
  killTree: (worker: WorkerHandle) => Promise<void>;
  farm: MockWorkerFarm;
}

/** Everything `--mock` swaps in, in one object. */
export function createMockDeps(options: MockDepsOptions = {}): MockDeps {
  const lanes = options.lanes ?? (['claude-cli', 'openrouter-agent'] as ExecutorName[]);
  const farm = createMockWorkerFarm();
  const executors: Partial<Record<ExecutorName, Executor>> = {};
  for (const lane of lanes) {
    executors[lane] = createMockExecutor({ lane, ...(options.executor ?? {}) });
  }
  return {
    query: createMockQueryModel(options.query ?? {}),
    executors,
    spawnWorker: farm.spawnWorker,
    cloneRepo: mockCloneRepo,
    killTree: farm.killTree,
    farm,
  };
}
