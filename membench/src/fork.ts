/**
 * Fork infrastructure — plan Phase 4 (§0.1 "Worker-per-variant isolation",
 * "Context injection"; §0.2 guards 4, 7-8).
 *
 * Per (item, variant) fork:
 *   - fresh CLAUDE_MEM_DATA_DIR=<runsDir>/<runId>/forks/<item>/<variant>/mem
 *     and a unique port from a pool allocator (guard 4: never share a worker
 *     between variants, never touch the user's real ~/.claude-mem)
 *   - a claude-mem worker spawned from CLAUDE_MEM_ROOT and awaited on
 *     GET /api/readiness (Server.ts:244-256 @ 132b46343: 200 when
 *     initialization is complete, 503 while initializing)
 *   - seeding via POST /api/import ONLY (guard 7: the schema has 30+
 *     conditional migrations — no raw INSERTs). Payload shape copied from
 *     scripts/import-memories.ts:48-53 ({sessions, summaries, observations,
 *     prompts}); row shapes from SessionStore.importSdkSession:3013-3023 and
 *     importObservation:3110-3127 @ 132b46343.
 *   - repo clone at the item's pinned commit (shallow-fetch-by-sha pattern,
 *     evals swebench run.py:122-168: init, remote add, fetch --depth 1
 *     origin <sha>, checkout FETCH_HEAD; full fetch fallback)
 *   - the injection block from GET /api/context/inject?project=<slug>
 *     (SearchRoutes.ts:151,282-374 @ 132b46343, text/plain); the `none`
 *     control gets '' (bare task floor)
 *
 * Worker spawn command: CM package.json's worker script is
 * `worker:start: bun plugin/scripts/worker-service.cjs start` — but the
 * `start` subcommand daemonizes (worker-service.ts:1083-1090 →
 * ensureWorkerStarted → spawnDaemon spawns a DETACHED `--daemon` child and
 * the CLI exits), which would orphan the worker outside MemBench's process
 * tree. MemBench therefore spawns the SAME script's daemon entry directly —
 * `bun plugin/scripts/worker-service.cjs --daemon` (worker-service.ts:1422,
 * the exact case the detached child runs) — so the spawned child IS the
 * worker and teardown can process-tree-kill it.
 */

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadConfig } from './config.js';
import { firstHumanPrompt, type TranscriptRow } from './corpus.js';
import { readJsonl } from './jsonl.js';
import type { CorpusItem, ForkContext, Variant } from './types.js';
import type { ParsedObservation } from './vendor/parser.js';

export class ForkError extends Error {}

// ---------------------------------------------------------------------------
// Guards (plan §0.2 guards 4, 7-8)
// ---------------------------------------------------------------------------

/**
 * Guard 4: no fork data dir may be — or live inside — the user's real
 * ~/.claude-mem. Checked before any mkdir/spawn/prune touches the path.
 */
export function assertOutsideUserClaudeMem(path: string): void {
  const target = resolve(path);
  const forbidden = join(homedir(), '.claude-mem');
  if (target === forbidden || target.startsWith(forbidden + sep)) {
    throw new ForkError(`refusing to use a fork path inside ${forbidden}: ${target} (guard 4)`);
  }
}

/**
 * Guard 8: every spawned worker env must force CLAUDE_MEM_RUNTIME=worker —
 * otherwise search can silently reroute to a different backend
 * (CM/src/servers/mcp-server.ts:506-513).
 */
function assertWorkerRuntime(env: Record<string, string>): void {
  if (env.CLAUDE_MEM_RUNTIME !== 'worker') {
    throw new ForkError('spawned worker env must set CLAUDE_MEM_RUNTIME=worker (guard 8)');
  }
}

// ---------------------------------------------------------------------------
// Port pool
// ---------------------------------------------------------------------------

export interface PortPool {
  /** Synchronous — two concurrent prepareForks can never receive the same port. */
  acquire(): number;
  release(port: number): void;
}

/**
 * Pool allocator over [start, start+count). acquire() is fully synchronous
 * (no await between "pick" and "mark in use"), so concurrent prepareFork
 * calls on the single-threaded event loop can never double-allocate. With
 * `probe` (default), each candidate is bind-tested via Bun.serve — also
 * synchronous — and busy host ports are skipped for the lifetime of the pool.
 * Range default sits away from claude-mem's own 37700+uid%100 defaults
 * (SettingsDefaultsManager.ts:105 @ 132b46343).
 */
export function createPortPool(start = 38700, count = 200, probe = true): PortPool {
  const free: number[] = [];
  for (let port = start; port < start + count; port++) free.push(port);
  const inUse = new Set<number>();

  function bindable(port: number): boolean {
    try {
      const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('') });
      server.stop(true);
      return true;
    } catch {
      return false;
    }
  }

  return {
    acquire(): number {
      while (free.length > 0) {
        const port = free.shift()!;
        if (probe && !bindable(port)) continue; // busy on the host — drop it
        inUse.add(port);
        return port;
      }
      throw new ForkError(`port pool exhausted (range ${start}-${start + count - 1})`);
    },
    release(port: number): void {
      if (inUse.delete(port)) free.push(port);
    },
  };
}

// ---------------------------------------------------------------------------
// Worker spawn + readiness
// ---------------------------------------------------------------------------

/** Handle to a spawned worker process (Bun.spawn subset; fakeable in tests). */
export interface WorkerHandle {
  pid: number;
  kill(signal?: number | NodeJS.Signals): void;
  exited: Promise<unknown>;
}

export interface SpawnWorkerOptions {
  claudeMemRoot: string;
  env: Record<string, string>;
  /** Worker stdio destination; logs also land in <dataDir>/logs regardless. */
  cwd: string;
}

export type SpawnWorkerFn = (opts: SpawnWorkerOptions) => WorkerHandle;

/**
 * The ONLY parent-env keys a spawned worker inherits. An ALLOWLIST, not a
 * strip-list: a strip-list leaks every secret it didn't anticipate
 * (OPENROUTER_API_KEY, OPENAI_API_KEY, GITHUB_TOKEN, …) into every worker.
 * This is stricter than CM's own sanitizeEnv (worker-service.ts:931-939
 * @ 132b46343, which only strips CLAUDE_CODE_* and Anthropic keys) — a
 * benchmark worker needs nothing but a shell-ish baseline. LC_* passes as a
 * prefix (locale vars).
 */
const WORKER_ENV_ALLOWLIST = new Set([
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

/**
 * Build the spawned worker's env: an allowlisted baseline from the parent
 * environment plus the fork's isolation vars — no other parent key (and so
 * no secret, and no user CLAUDE_MEM_* / CLAUDE_CODE_* / ANTHROPIC_* value
 * that could repoint the fork at real data) survives. HOME and CLAUDE_CONFIG_DIR
 * are pointed inside the fork's home so the worker's homedir fallbacks
 * (paths.ts:38-67), plugin-disabled gate (plugin-state.ts:10-22) and
 * marketplace paths never read the user's real ~/.claude or ~/.claude-mem.
 */
export function buildWorkerEnv(dataDir: string, port: number, homeDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (WORKER_ENV_ALLOWLIST.has(key) || key.startsWith('LC_')) env[key] = value;
  }
  env.HOME = homeDir;
  env.CLAUDE_MEM_DATA_DIR = dataDir;
  env.CLAUDE_MEM_WORKER_PORT = String(port);
  env.CLAUDE_MEM_WORKER_HOST = '127.0.0.1';
  env.CLAUDE_MEM_RUNTIME = 'worker';
  env.CLAUDE_MEM_CHROMA_ENABLED = 'false';
  // A fresh (empty) DB must still answer /api/context/inject with claude-mem's
  // real format, not the first-boot welcome hint (SearchRoutes.ts:305-319).
  env.CLAUDE_MEM_WELCOME_HINT_ENABLED = 'false';
  env.CLAUDE_CONFIG_DIR = join(homeDir, '.claude');
  return env;
}

/** Default spawner: Bun.spawn of the worker daemon entry from CLAUDE_MEM_ROOT. */
export const spawnWorkerProcess: SpawnWorkerFn = (opts) => {
  const script = join(opts.claudeMemRoot, 'plugin', 'scripts', 'worker-service.cjs');
  if (!existsSync(script)) {
    throw new ForkError(`claude-mem worker script not found: ${script} (is CLAUDE_MEM_ROOT a built checkout?)`);
  }
  const proc = Bun.spawn([process.execPath, script, '--daemon'], {
    cwd: opts.cwd,
    env: opts.env,
    stdin: 'ignore',
    stdout: 'ignore', // worker logs go to <CLAUDE_MEM_DATA_DIR>/logs/ (paths.ts:65)
    stderr: 'ignore',
  });
  return { pid: proc.pid, kill: (signal) => proc.kill(signal), exited: proc.exited };
};

/**
 * Poll GET /api/readiness until 200 (Server.ts:244-256: 503 while the worker
 * is still initializing). Fails fast if the worker process exits first.
 */
export async function waitForReadiness(
  port: number,
  worker: WorkerHandle,
  timeoutMs = 60_000,
  pollMs = 250,
): Promise<void> {
  let workerExited = false;
  worker.exited.then(
    () => { workerExited = true; },
    () => { workerExited = true; },
  );
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'no response yet';
  while (Date.now() < deadline) {
    if (workerExited) {
      throw new ForkError(`worker (pid ${worker.pid}) exited before /api/readiness became ready`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/readiness`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastStatus = `HTTP ${response.status}`;
    } catch (error: unknown) {
      lastStatus = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(pollMs);
  }
  throw new ForkError(`worker on port ${port} not ready within ${timeoutMs}ms (last: ${lastStatus})`);
}

// ---------------------------------------------------------------------------
// Seeding (POST /api/import — guard 7: never raw-INSERT)
// ---------------------------------------------------------------------------

/**
 * Session row per SessionStore.importSdkSession (SessionStore.ts:3013-3023
 * @ 132b46343) — the minimal record the variant's observations hang off.
 */
export interface SeedSessionRecord {
  content_session_id: string;
  memory_session_id: string;
  project: string;
  user_prompt: string;
  started_at: string;
  started_at_epoch: number;
  completed_at: string | null;
  completed_at_epoch: number | null;
  status: string;
}

/** Observation row per SessionStore.importObservation (SessionStore.ts:3110-3127). */
export interface SeedObservationRecord {
  memory_session_id: string;
  project: string;
  text: string | null;
  type: string;
  title: string | null;
  subtitle: string | null;
  /** JSON-encoded string[] — DB storage form (DataRoutes.ts:432-435 parses them back). */
  facts: string | null;
  narrative: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  discovery_tokens: number;
  created_at: string;
  created_at_epoch: number;
}

/** Body of POST /api/import, exactly as import-memories.ts:48-53 sends it. */
export interface SeedPayload {
  sessions: SeedSessionRecord[];
  summaries: never[];
  observations: SeedObservationRecord[];
  prompts: never[];
}

export interface BuildSeedPayloadOptions {
  itemId: string;
  projectSlug: string;
  /** Session N's opening human prompt (neutral fallback if unavailable). */
  userPrompt: string;
  observations: ParsedObservation[];
  /** Epoch-ms anchor for created_at rows; each row gets base+index so the
   * import dedupe key (memory_session_id, title, created_at_epoch —
   * SessionStore.ts:3129-3132) never collapses same-titled observations. */
  baseEpoch: number;
}

/**
 * Wrap a variant's observation set in a minimal session record, in exactly
 * the shape POST /api/import consumes. Deliberately variant-agnostic content:
 * nothing here (session ids, prompts) may leak the variant label into what
 * the executor later sees via /api/context/inject.
 */
export function buildSeedPayload(options: BuildSeedPayloadOptions): SeedPayload {
  const { itemId, projectSlug, userPrompt, observations, baseEpoch } = options;
  const memorySessionId = `membench-seed-${itemId}`;
  const startedAt = new Date(baseEpoch).toISOString();
  const completedEpoch = baseEpoch + observations.length + 1;

  const session: SeedSessionRecord = {
    content_session_id: memorySessionId,
    memory_session_id: memorySessionId,
    project: projectSlug,
    user_prompt: userPrompt,
    started_at: startedAt,
    started_at_epoch: baseEpoch,
    completed_at: new Date(completedEpoch).toISOString(),
    completed_at_epoch: completedEpoch,
    status: 'completed',
  };

  return {
    sessions: [session],
    summaries: [],
    observations: observations.map((obs, i) => ({
      memory_session_id: memorySessionId,
      project: projectSlug,
      text: null,
      type: obs.type,
      title: obs.title,
      subtitle: obs.subtitle,
      facts: JSON.stringify(obs.facts),
      narrative: obs.narrative,
      concepts: JSON.stringify(obs.concepts),
      files_read: JSON.stringify(obs.files_read),
      files_modified: JSON.stringify(obs.files_modified),
      prompt_number: 1,
      discovery_tokens: 0,
      created_at: new Date(baseEpoch + i).toISOString(),
      created_at_epoch: baseEpoch + i,
    })),
    prompts: [],
  };
}

async function seedWorker(port: number, payload: SeedPayload): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new ForkError(`POST /api/import failed: ${response.status} ${response.statusText} ${body}`.trim());
  }
  const result = (await response.json()) as { stats?: { observationsImported?: number; observationsSkipped?: number } };
  const imported = result.stats?.observationsImported ?? 0;
  if (imported !== payload.observations.length) {
    throw new ForkError(
      `seed import mismatch: sent ${payload.observations.length} observations, worker imported ${imported} ` +
        `(skipped ${result.stats?.observationsSkipped ?? '?'}) — a fresh variant DB must import every row`,
    );
  }
}

// ---------------------------------------------------------------------------
// Repo clone at the pinned commit
// ---------------------------------------------------------------------------

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

async function runGit(args: string[], cwd?: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], {
    ...(cwd ? { cwd } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim() };
}

export type CloneRepoFn = (url: string, commit: string, destDir: string) => Promise<void>;

/**
 * Shallow-fetch-by-sha clone (evals swebench run.py:122-168 @ cancun-v1):
 * init, remote add origin, `fetch --depth 1 origin <sha>` + checkout
 * FETCH_HEAD; when the server rejects the direct-sha shallow fetch (needs
 * allowReachableSHA1InWant), fall back to a full fetch + checkout <sha>.
 * Always verifies HEAD is exactly the pinned commit afterwards.
 */
export const cloneRepoAtCommit: CloneRepoFn = async (url, commit, destDir) => {
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  const init = await runGit(['init', '--quiet', destDir]);
  if (!init.ok) throw new ForkError(`git init failed for ${destDir}: ${init.stderr}`);
  const remote = await runGit(['remote', 'add', 'origin', url], destDir);
  if (!remote.ok) throw new ForkError(`git remote add failed for ${url}: ${remote.stderr}`);

  const shallow = await runGit(['fetch', '--quiet', '--depth', '1', 'origin', commit], destDir);
  if (shallow.ok) {
    const checkout = await runGit(['checkout', '--quiet', 'FETCH_HEAD'], destDir);
    if (!checkout.ok) throw new ForkError(`git checkout FETCH_HEAD failed for ${commit}: ${checkout.stderr}`);
  } else {
    const full = await runGit(['fetch', '--quiet', 'origin'], destDir);
    if (!full.ok) {
      throw new ForkError(`git fetch failed for ${url} (shallow: ${shallow.stderr}; full: ${full.stderr})`);
    }
    const checkout = await runGit(['checkout', '--quiet', commit], destDir);
    if (!checkout.ok) throw new ForkError(`git checkout ${commit} failed: ${checkout.stderr}`);
  }

  const head = await runGit(['rev-parse', 'HEAD'], destDir);
  if (!head.ok || head.stdout !== commit) {
    throw new ForkError(`repo pin verification failed: HEAD is ${head.stdout || '?'}, expected ${commit}`);
  }
};

// ---------------------------------------------------------------------------
// prepareFork / teardownFork
// ---------------------------------------------------------------------------

/**
 * Path-safe slug for a variant dir name. Cleaning alone can collide
 * (`model:a/b` and `model:a-b` both clean to `model-a-b`), so any LOSSY
 * cleaning appends the first 8 hex of sha256(raw variant) — e.g.
 * `model:openai/gpt-4o` → `model-openai-gpt-4o-<hash8>`. Lossless names
 * (the controls: none/oracle/shuffled) stay bare.
 */
export function variantSlug(variant: Variant): string {
  const cleaned = variant.replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (cleaned === variant) return cleaned;
  const hash = new Bun.CryptoHasher('sha256').update(variant).digest('hex').slice(0, 8);
  return `${cleaned}-${hash}`;
}

interface ItemProvenance {
  project_slug?: string;
  dates?: { session_n_ended?: string | null };
}

interface ItemRepoLock {
  url?: string;
  commit?: string;
}

/** ForkContext plus the process/pool handles teardownFork needs. */
export interface PreparedFork extends ForkContext {
  worker: WorkerHandle;
  /** The fork's <runsDir>/<runId>/forks/<item>/<variant>/ root. */
  forkDir: string;
  releasePort(): void;
  /** Bound at construction — kills THIS fork's worker tree. */
  killTree(): Promise<void>;
}

export interface PrepareForkOptions {
  runId: string;
  portPool: PortPool;
  /**
   * The variant's observation set (model output, oracle rows, or the
   * shuffled donor's rows). REQUIRED for every variant except `none` — may
   * be empty (an observer that produced nothing is a legitimate outcome) —
   * and FORBIDDEN for `none`, which seeds nothing by definition.
   */
  observations?: ParsedObservation[];
  claudeMemRoot?: string;
  /** Seams for offline tests (default: real spawn / real git / real tree kill). */
  spawnWorker?: SpawnWorkerFn;
  cloneRepo?: CloneRepoFn;
  killTree?: (worker: WorkerHandle) => Promise<void>;
  readinessTimeoutMs?: number;
}

/**
 * Prepare one fully-isolated fork for (item, variant): fresh data dir +
 * port, live seeded worker, pinned repo checkout, isolated HOME, and the
 * injection block. On any failure after the worker spawns, the worker is
 * killed and mem/ is KEPT for audit before the error propagates.
 */
export async function prepareFork(
  item: CorpusItem,
  variant: Variant,
  runsDir: string,
  options: PrepareForkOptions,
): Promise<PreparedFork> {
  const {
    runId,
    portPool,
    observations,
    // Same resolution as everything else: flag ?? CLAUDE_MEM_ROOT env ??
    // default (config.ts) — no second copy of the path.
    claudeMemRoot = loadConfig().claudeMemRoot,
    spawnWorker = spawnWorkerProcess,
    cloneRepo = cloneRepoAtCommit,
    killTree = killWorkerTree,
    readinessTimeoutMs = 60_000,
  } = options;

  if (variant === 'none' && observations !== undefined) {
    throw new ForkError('the `none` control seeds nothing — do not pass observations for it');
  }
  if (variant !== 'none' && observations === undefined) {
    throw new ForkError(`variant ${variant} requires an observation set (pass [] for an empty observer outcome)`);
  }

  const forkDir = resolve(runsDir, runId, 'forks', item.id, variantSlug(variant));
  const dataDir = join(forkDir, 'mem');
  const homeDir = join(forkDir, 'home');
  const repoDir = join(forkDir, 'repo');
  // Guard 4 BEFORE anything touches the disk.
  assertOutsideUserClaudeMem(forkDir);
  assertOutsideUserClaudeMem(dataDir);

  const provenance = await readItemJson<ItemProvenance>(item, 'provenance.json');
  const projectSlug = provenance.project_slug;
  if (!projectSlug) {
    throw new ForkError(`${item.dir}/provenance.json has no project_slug — cannot target injection`);
  }
  const lock = await readItemJson<ItemRepoLock>(item, 'repo.lock');
  if (!lock.url || !lock.commit) {
    throw new ForkError(`${item.dir}/repo.lock is missing url/commit — cannot pin the repo`);
  }

  // Stale-dir guard: a non-empty mem/ here is a kept-for-audit data dir from
  // a failed prior attempt — refuse to silently reuse (and re-seed over) it.
  if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
    throw new ForkError(
      `fork data dir already exists and is non-empty: ${dataDir} — ` +
        'likely kept for audit after a failed attempt; inspect/remove it or use a fresh run id',
    );
  }
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  // acquire → spawn inside one try so no throw in between can leak the port.
  let port!: number;
  let releasePort = () => {};
  let worker: WorkerHandle;
  try {
    port = portPool.acquire();
    releasePort = () => portPool.release(port);
    const env = buildWorkerEnv(dataDir, port, homeDir);
    assertWorkerRuntime(env); // guard 8
    worker = spawnWorker({ claudeMemRoot, env, cwd: claudeMemRoot });
  } catch (error) {
    releasePort();
    throw error;
  }

  const fork: PreparedFork = {
    repoDir,
    homeDir,
    workerPort: port,
    dataDir,
    injectionBlock: '',
    item,
    variant,
    projectSlug,
    worker,
    forkDir,
    releasePort,
    killTree: () => killTree(worker),
  };

  try {
    await waitForReadiness(port, worker, readinessTimeoutMs);

    if (variant !== 'none') {
      const baseEpochSource = provenance.dates?.session_n_ended;
      const baseEpoch = baseEpochSource ? Date.parse(baseEpochSource) : Date.now();
      const payload = buildSeedPayload({
        itemId: item.id,
        projectSlug,
        userPrompt: (await readSeedUserPrompt(item)) ?? 'Remembered work session',
        observations: observations!,
        baseEpoch: Number.isNaN(baseEpoch) ? Date.now() : baseEpoch,
      });
      await seedWorker(port, payload);
    }

    await cloneRepo(lock.url, lock.commit, repoDir);

    if (variant !== 'none') {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectSlug)}`,
        { headers: { Accept: 'text/plain' } },
      );
      if (!response.ok) {
        const body = await response.text();
        throw new ForkError(
          `GET /api/context/inject failed: ${response.status} ${response.statusText} ${body}`.trim(),
        );
      }
      fork.injectionBlock = await response.text();
    }

    return fork;
  } catch (error) {
    // Failure path: kill the worker but KEEP mem/ for audit (plan Phase 4).
    // A teardown failure here must never mask the ORIGINAL error — log it
    // and rethrow what actually broke the fork.
    try {
      await teardownFork(fork, { keepData: true });
    } catch (teardownError: unknown) {
      const message = teardownError instanceof Error ? teardownError.message : String(teardownError);
      console.error(`teardown after failed prepareFork(${item.id}, ${variant}) also failed: ${message}`);
    }
    throw error;
  }
}

export interface TeardownForkOptions {
  /** true = keep mem/ for audit (failure path); false = prune it (happy path). */
  keepData: boolean;
}

/**
 * Kill the fork's worker (whole process tree), release its port, and — on
 * the happy path — prune mem/. The kill runs before the prune so a live
 * worker can never be left writing into a half-deleted data dir.
 */
export async function teardownFork(fork: PreparedFork, options: TeardownForkOptions): Promise<void> {
  try {
    await fork.killTree();
  } finally {
    fork.releasePort();
  }
  if (!options.keepData) {
    assertOutsideUserClaudeMem(fork.dataDir); // guard 4, defense in depth before rm -rf
    rmSync(fork.dataDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Process-tree kill
// ---------------------------------------------------------------------------

/** Direct children of a pid via pgrep -P (exit 1 = none — not an error). */
function childPids(pid: number): number[] {
  const result = Bun.spawnSync(['pgrep', '-P', String(pid)], { stdout: 'pipe', stderr: 'ignore' });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .toString()
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((candidate) => Number.isInteger(candidate) && candidate > 0);
}

function collectTree(pid: number): number[] {
  const pids: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    pids.push(current);
    queue.push(...childPids(current));
  }
  return pids;
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // ESRCH — already gone. Exactly what teardown wants.
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Default killTree: SIGTERM the worker and every descendant (collected
 * BEFORE signalling, so nothing is orphaned mid-walk), give the tree a
 * graceful window, then SIGKILL survivors.
 */
export async function killWorkerTree(worker: WorkerHandle, gracefulMs = 3_000): Promise<void> {
  const pids = collectTree(worker.pid);
  for (const pid of pids) signalPid(pid, 'SIGTERM');
  worker.kill('SIGTERM');
  await Promise.race([worker.exited.catch(() => {}), Bun.sleep(gracefulMs)]);
  for (const pid of pids) {
    if (pidAlive(pid)) signalPid(pid, 'SIGKILL');
  }
}

// ---------------------------------------------------------------------------
// Item file helpers
// ---------------------------------------------------------------------------

async function readItemJson<T>(item: CorpusItem, name: string): Promise<T> {
  const path = join(item.dir, name);
  if (!existsSync(path)) {
    throw new ForkError(`corpus item ${item.id} is missing ${name} (${path})`);
  }
  try {
    return JSON.parse(await Bun.file(path).text()) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ForkError(`corpus item ${item.id}: could not parse ${name}: ${message}`);
  }
}

/**
 * Session N's opening human prompt from the frozen transcript — the faithful
 * user_prompt for the seed session record. Variant-neutral fallback when the
 * transcript has no human turn (nothing may leak the variant label into
 * injected context).
 */
async function readSeedUserPrompt(item: CorpusItem): Promise<string | null> {
  const path = join(item.dir, 'transcript.jsonl');
  if (!existsSync(path)) return null;
  const rows = await readJsonl<TranscriptRow>(path);
  return firstHumanPrompt(rows);
}
