/**
 * Fork infrastructure — plan Phase 4 (§0.1 "Worker-per-variant isolation",
 * "Context injection"; §0.2 guards 4, 7-8).
 *
 * Per (item, variant) fork:
 *   - fresh CLAUDE_MEM_DATA_DIR=<runsDir>/<runId>/forks/<item>/<variant>/mem
 *     and its own OS-assigned port (guard 4: never share a worker between
 *     variants, never touch the user's real ~/.claude-mem)
 *   - a claude-mem worker spawned from CLAUDE_MEM_ROOT and awaited on
 *     GET /api/readiness (Server.ts:244-256 @ 132b46343: 200 when
 *     initialization is complete, 503 while initializing)
 *   - seeding via POST /api/import ONLY (guard 7: the schema has 30+
 *     conditional migrations — no raw INSERTs). Payload shape copied from
 *     scripts/import-memories.ts:48-53 ({sessions, summaries, observations,
 *     prompts}); row shapes from SessionStore.importSdkSession:3013-3023 and
 *     importObservation:3110-3127 @ 132b46343.
 *   - repo clone at the item's pinned commit (shallow-fetch-by-sha, evals
 *     swebench run.py:122-168: init, remote add, fetch --depth 1 origin
 *     <sha>, checkout FETCH_HEAD)
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
 * the exact case the detached child runs) — detached into its own process
 * group, so teardown can group-signal the worker and every descendant.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { assertOutsideClaudeMem, firstHumanPrompt, type TranscriptRow } from './corpus-item.js';
import { allowlistedParentEnv } from './executors/shared.js';
import { readJsonl } from './jsonl.js';
import { modelSlug, type ItemProvenance } from './observe-stage.js';
import type { CorpusItem, ForkContext, Variant } from './types.js';
import type { ParsedObservation } from './vendor/parser.js';

export class ForkError extends Error {}

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

/**
 * Ports handed out by freePort() and not yet released. The probe socket is
 * closed before the worker binds, so without this two concurrent
 * prepareFork() calls could be issued the same number (PR #2 review P1).
 */
const issuedPorts = new Set<number>();

/**
 * An OS-assigned free port: bind port 0, read the assignment, release it.
 * Issued numbers are tracked until releasePort() so concurrent callers always
 * get distinct ports; the remaining race — an unrelated process claiming the
 * number in the probe-to-bind window — is handled by prepareFork's respawn
 * retry.
 */
export function freePort(): number {
  for (let attempt = 0; attempt < 50; attempt++) {
    const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
    const port = probe.port!;
    probe.stop(true);
    if (!issuedPorts.has(port)) {
      issuedPorts.add(port);
      return port;
    }
  }
  throw new ForkError('freePort: no unissued port after 50 attempts');
}

/** Return a freePort()-issued number to the pool (no-op for pinned ports). */
export function releasePort(port: number): void {
  issuedPorts.delete(port);
}

// ---------------------------------------------------------------------------
// Worker spawn + readiness
// ---------------------------------------------------------------------------

/** Handle to a spawned worker process (fakeable in tests). */
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
 * Build the spawned worker's env: the allowlisted baseline from the parent
 * environment (shared.ts allowlistedParentEnv — an ALLOWLIST, not a
 * strip-list: a strip-list leaks every secret it didn't anticipate; stricter
 * than CM's own sanitizeEnv, worker-service.ts:931-939 @ 132b46343, which
 * only strips CLAUDE_CODE_* and Anthropic keys) plus the fork's isolation
 * vars — no other parent key (and so no secret, and no user CLAUDE_MEM_* /
 * CLAUDE_CODE_* / ANTHROPIC_* value that could repoint the fork at real
 * data) survives. HOME and CLAUDE_CONFIG_DIR are pointed inside the fork's
 * home so the worker's homedir fallbacks (paths.ts:38-67), plugin-disabled
 * gate (plugin-state.ts:10-22) and marketplace paths never read the user's
 * real ~/.claude or ~/.claude-mem.
 */
export function buildWorkerEnv(dataDir: string, port: number, homeDir: string): Record<string, string> {
  const env = allowlistedParentEnv();
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

/**
 * Default spawner: the worker daemon entry from CLAUDE_MEM_ROOT, detached
 * into its own process group so killWorkerTree can group-signal it.
 */
export const spawnWorkerProcess: SpawnWorkerFn = (opts) => {
  const script = join(opts.claudeMemRoot, 'plugin', 'scripts', 'worker-service.cjs');
  if (!existsSync(script)) {
    throw new ForkError(`claude-mem worker script not found: ${script} (is CLAUDE_MEM_ROOT a built checkout?)`);
  }
  const proc = spawn(process.execPath, [script, '--daemon'], {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: 'ignore', // worker logs go to <CLAUDE_MEM_DATA_DIR>/logs/ (paths.ts:65)
  });
  proc.unref();
  const exited = new Promise<unknown>((resolveExited) => {
    proc.once('exit', (code) => resolveExited(code));
    proc.once('error', () => resolveExited(-1));
  });
  return { pid: proc.pid ?? -1, kill: (signal) => void proc.kill(signal), exited };
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
 * the shape POST /api/import consumes: body per import-memories.ts:48-53,
 * session row per SessionStore.importSdkSession:3013-3023, observation rows
 * per importObservation:3110-3127 (array fields JSON-encoded — the DB storage
 * form DataRoutes.ts:432-435 parses back). Deliberately variant-agnostic
 * content: nothing here (session ids, prompts) may leak the variant label
 * into what the executor later sees via /api/context/inject.
 */
export function buildSeedPayload(options: BuildSeedPayloadOptions) {
  const { itemId, projectSlug, userPrompt, observations, baseEpoch } = options;
  const memorySessionId = `membench-seed-${itemId}`;
  const completedEpoch = baseEpoch + observations.length + 1;

  return {
    sessions: [
      {
        content_session_id: memorySessionId,
        memory_session_id: memorySessionId,
        project: projectSlug,
        user_prompt: userPrompt,
        started_at: new Date(baseEpoch).toISOString(),
        started_at_epoch: baseEpoch,
        completed_at: new Date(completedEpoch).toISOString(),
        completed_at_epoch: completedEpoch,
        status: 'completed',
      },
    ],
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

async function seedWorker(port: number, payload: ReturnType<typeof buildSeedPayload>): Promise<void> {
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

function runGit(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['git', ...args], { ...(cwd ? { cwd } : {}), stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
}

export type CloneRepoFn = (url: string, commit: string, destDir: string) => Promise<void>;

/**
 * Shallow-fetch-by-sha clone (evals swebench run.py:122-168 @ cancun-v1):
 * init, remote add origin, `fetch --depth 1 origin <sha>` + checkout
 * FETCH_HEAD. Every repo.lock URL is github.com (which serves fetch-by-sha),
 * so there is no full-fetch fallback. Always verifies HEAD is exactly the
 * pinned commit afterwards.
 */
export const cloneRepoAtCommit: CloneRepoFn = async (url, commit, destDir) => {
  if (existsSync(destDir)) {
    rmSync(destDir, { recursive: true, force: true });
  }
  const init = runGit(['init', '--quiet', destDir]);
  if (!init.ok) throw new ForkError(`git init failed for ${destDir}: ${init.stderr}`);
  const remote = runGit(['remote', 'add', 'origin', url], destDir);
  if (!remote.ok) throw new ForkError(`git remote add failed for ${url}: ${remote.stderr}`);

  const fetch = runGit(['fetch', '--quiet', '--depth', '1', 'origin', commit], destDir);
  if (!fetch.ok) throw new ForkError(`git fetch --depth 1 origin ${commit} failed for ${url}: ${fetch.stderr}`);
  const checkout = runGit(['checkout', '--quiet', 'FETCH_HEAD'], destDir);
  if (!checkout.ok) throw new ForkError(`git checkout FETCH_HEAD failed for ${commit}: ${checkout.stderr}`);

  const head = runGit(['rev-parse', 'HEAD'], destDir);
  if (!head.ok || head.stdout !== commit) {
    throw new ForkError(`repo pin verification failed: HEAD is ${head.stdout || '?'}, expected ${commit}`);
  }
};

// ---------------------------------------------------------------------------
// prepareFork / teardownFork
// ---------------------------------------------------------------------------

/**
 * The on-disk location of one fork. Exported so the orchestrator can inspect
 * (or quarantine) a fork dir left behind by a crashed attempt WITHOUT
 * duplicating the layout rule. Variant dir names use the shared collision-safe
 * slug (observe-stage.ts modelSlug).
 */
export function forkDirPath(
  runsDir: string,
  runId: string,
  itemId: string,
  variant: Variant,
  cellLabel?: string,
): string {
  const dirName = cellLabel ? `${modelSlug(variant)}-${cellLabel}` : modelSlug(variant);
  return resolve(runsDir, runId, 'forks', itemId, dirName);
}

interface ItemRepoLock {
  url?: string;
  commit?: string;
}

/** ForkContext plus the process handles teardownFork needs. */
export interface PreparedFork extends ForkContext {
  worker: WorkerHandle;
  /** The fork's <runsDir>/<runId>/forks/<item>/<variant>/ root. */
  forkDir: string;
  /** Bound at construction — kills THIS fork's worker tree. */
  killTree(): Promise<void>;
}

export interface PrepareForkOptions {
  runId: string;
  /**
   * The variant's observation set (model output, oracle rows, or the
   * shuffled donor's rows). REQUIRED for every variant except `none` — may
   * be empty (an observer that produced nothing is a legitimate outcome) —
   * and FORBIDDEN for `none`, which seeds nothing by definition.
   */
  observations?: ParsedObservation[];
  claudeMemRoot?: string;
  /**
   * Disambiguates fork dirs when the SAME (item, variant) is forked more than
   * once in a run — which it always is: k repetitions × N executor lanes all
   * share (item, variant). Without it those fork-runs would collide on
   * <runs>/<run_id>/forks/<item>/<variant>/ (shared repo checkout, overwritten
   * transcripts/diffs, and a data-dir race when they run concurrently), so
   * Phase 6 passes `<executor>-<run_index>`. Appended to the variant dir name;
   * omitted = the bare Phase 4 layout.
   */
  cellLabel?: string;
  /** Worker port override (offline tests pin it to a stub server's port). */
  port?: number;
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
    observations,
    cellLabel,
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

  const forkDir = forkDirPath(runsDir, runId, item.id, variant, cellLabel);
  const dataDir = join(forkDir, 'mem');
  const homeDir = join(forkDir, 'home');
  const repoDir = join(forkDir, 'repo');
  // Guard 4 BEFORE anything touches the disk.
  assertOutsideClaudeMem(forkDir, ForkError);
  assertOutsideClaudeMem(dataDir, ForkError);

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

  // Spawn + readiness, with one respawn retry on the port-steal signature:
  // freePort() closes its probe before the worker binds, so an unrelated
  // process can claim the number in that window — the worker then exits
  // without serving. A retry gets a fresh number (or re-tries a pinned one).
  let port: number;
  let worker: WorkerHandle;
  for (let attempt = 1; ; attempt++) {
    port = options.port ?? freePort();
    const env = buildWorkerEnv(dataDir, port, homeDir);
    assertWorkerRuntime(env); // guard 8
    worker = spawnWorker({ claudeMemRoot, env, cwd: claudeMemRoot });
    try {
      await waitForReadiness(port, worker, readinessTimeoutMs);
      break;
    } catch (error) {
      await killTree(worker);
      releasePort(port);
      const earlyExit =
        error instanceof Error && error.message.includes('exited before /api/readiness');
      if (attempt >= 2 || !earlyExit) throw error;
    }
  }

  const fork: PreparedFork = {
    repoDir,
    homeDir,
    baseSha: lock.commit,
    workerPort: port,
    dataDir,
    injectionBlock: '',
    item,
    variant,
    projectSlug,
    worker,
    forkDir,
    killTree: () => killTree(worker),
  };

  try {
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
 * Kill the fork's worker (whole process group) and — on the happy path —
 * prune mem/. The kill runs before the prune so a live worker can never be
 * left writing into a half-deleted data dir.
 */
export async function teardownFork(fork: PreparedFork, options: TeardownForkOptions): Promise<void> {
  await fork.killTree();
  releasePort(fork.workerPort);
  if (!options.keepData) {
    assertOutsideClaudeMem(fork.dataDir, ForkError); // guard 4, defense in depth before rm -rf
    rmSync(fork.dataDir, { recursive: true, force: true });
  }
}

/**
 * Default killTree: the worker is spawned detached (its own process group),
 * so signal the whole group — SIGTERM, a grace window, then SIGKILL
 * survivors. Same pattern as executors/shared.ts runWithTimeout.
 */
export async function killWorkerTree(worker: WorkerHandle, gracefulMs = 3_000): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals) => {
    if (worker.pid <= 0) return;
    try {
      process.kill(-worker.pid, signal);
    } catch {
      // Group already gone — exactly what teardown wants.
    }
  };
  signalGroup('SIGTERM');
  worker.kill('SIGTERM');
  await Promise.race([worker.exited.catch(() => {}), Bun.sleep(gracefulMs)]);
  signalGroup('SIGKILL');
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
