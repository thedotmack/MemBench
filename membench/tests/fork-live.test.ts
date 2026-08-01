/**
 * LIVE isolation test (plan Phase 4 item 3 / verification bullet 3) — spawns
 * TWO real claude-mem workers from CLAUDE_MEM_ROOT on distinct ports/data
 * dirs concurrently and proves per-fork memory isolation (guard 4):
 *   - seeding worker B leaves worker A's /api/stats unchanged
 *   - each /api/context/inject response contains only its own titles
 *
 * Guarded by MEMBENCH_LIVE_WORKER=1 so CI/offline runs skip it:
 *   MEMBENCH_LIVE_WORKER=1 bun test tests/fork-live.test.ts
 *
 * Worker B is seeded with the REAL claude-mem-001 oracle observation set;
 * worker A with a synthetic set whose titles cannot collide with it. The
 * repos are local fixture clones, so the test needs no network beyond
 * localhost.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseOracleObservations } from '../src/controls.ts';
import { createPortPool, prepareFork, teardownFork, type PreparedFork } from '../src/fork.ts';
import type { CorpusItem } from '../src/types.ts';
import type { ParsedObservation } from '../src/vendor/parser.ts';

const LIVE = Bun.env.MEMBENCH_LIVE_WORKER === '1';
const CLAUDE_MEM_ROOT = Bun.env.CLAUDE_MEM_ROOT ?? '/Users/alexnewman/Scripts/claude-mem';
const describeLive = LIVE ? describe : describe.skip;

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-fork-live-${name}-`));
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function makeFixtureRepo(): { repoPath: string; commit: string } {
  const repoPath = tempDir('gitrepo');
  git(['init', '--quiet', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'membench@example.invalid'], repoPath);
  git(['config', 'user.name', 'MemBench Fixture'], repoPath);
  writeFileSync(join(repoPath, 'README.md'), 'live isolation fixture\n');
  git(['add', '.'], repoPath);
  git(['commit', '--quiet', '-m', 'fixture'], repoPath);
  return { repoPath, commit: git(['rev-parse', 'HEAD'], repoPath) };
}

function makeItemDir(id: string, projectSlug: string, repoPath: string, commit: string): CorpusItem {
  const dir = tempDir(`item-${id}`);
  writeFileSync(
    join(dir, 'provenance.json'),
    JSON.stringify({ project_slug: projectSlug, dates: { session_n_ended: '2026-07-29T03:26:51.650Z' } }),
  );
  writeFileSync(join(dir, 'repo.lock'), JSON.stringify({ url: repoPath, commit, branch: 'main' }));
  writeFileSync(
    join(dir, 'transcript.jsonl'),
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: `Live isolation seed session for ${id}` },
    }) + '\n',
  );
  return { id, dir };
}

/**
 * Titles deliberately disjoint from anything in the claude-mem-001 oracle.
 * The concepts must come from code-mode's concept list — injection renders
 * only observations whose concepts intersect it (ObservationCompiler.ts:56-59
 * @ 132b46343).
 */
const WORKER_A_OBSERVATIONS: ParsedObservation[] = [
  {
    type: 'discovery',
    title: 'ALPHA-ONLY marker observation one',
    subtitle: null,
    facts: ['alpha fact 1: the isolation test seeded this into worker A only'],
    narrative: 'ALPHA-ONLY narrative: worker A memory, must never appear in worker B.',
    concepts: ['gotcha'],
    files_read: [],
    files_modified: [],
  },
  {
    type: 'decision',
    title: 'ALPHA-ONLY marker observation two',
    subtitle: null,
    facts: ['alpha fact 2'],
    narrative: null,
    concepts: ['pattern'],
    files_read: [],
    files_modified: [],
  },
];

interface StatsSnapshot {
  observations: number;
  sessions: number;
  summaries: number;
}

async function fetchStats(port: number): Promise<StatsSnapshot> {
  const response = await fetch(`http://127.0.0.1:${port}/api/stats`);
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { database: StatsSnapshot };
  return {
    observations: body.database.observations,
    sessions: body.database.sessions,
    summaries: body.database.summaries,
  };
}

describeLive('live worker isolation (MEMBENCH_LIVE_WORKER=1)', () => {
  test(
    'two concurrent variant workers stay fully isolated',
    async () => {
      const oraclePath = join(import.meta.dir, '..', '..', 'corpus', 'claude-mem-001', 'oracle.md');
      const oracleRows = parseOracleObservations(await Bun.file(oraclePath).text(), 'claude-mem-001');
      expect(oracleRows.length).toBeGreaterThanOrEqual(3);

      const { repoPath, commit } = makeFixtureRepo();
      const itemA = makeItemDir('live-a', 'membench-live-a', repoPath, commit);
      const itemB = makeItemDir('live-b', 'membench-live-b', repoPath, commit);
      const runsDir = tempDir('runs');
      const pool = createPortPool();

      // Spawn + seed BOTH real workers concurrently (guard 4: distinct
      // ports, distinct data dirs, one worker per variant).
      const [forkA, forkB] = await Promise.all([
        prepareFork(itemA, 'model:live/alpha', runsDir, {
          runId: 'live-run',
          portPool: pool,
          observations: WORKER_A_OBSERVATIONS,
          claudeMemRoot: CLAUDE_MEM_ROOT,
          readinessTimeoutMs: 120_000,
        }),
        prepareFork(itemB, 'oracle', runsDir, {
          runId: 'live-run',
          portPool: pool,
          observations: oracleRows,
          claudeMemRoot: CLAUDE_MEM_ROOT,
          readinessTimeoutMs: 120_000,
        }),
      ]);

      let keepData = true; // keep both mem/ dirs for audit unless everything passes
      try {
        expect(forkA.workerPort).not.toBe(forkB.workerPort);
        expect(forkA.dataDir).not.toBe(forkB.dataDir);

        // Each DB holds exactly its own seed.
        const statsA = await fetchStats(forkA.workerPort);
        const statsB = await fetchStats(forkB.workerPort);
        expect(statsA.observations).toBe(WORKER_A_OBSERVATIONS.length);
        expect(statsA.sessions).toBe(1);
        expect(statsB.observations).toBe(oracleRows.length);
        expect(statsB.sessions).toBe(1);

        // Seed worker B AGAIN (extra import through the only sanctioned
        // write path) and prove worker A's /api/stats does not move.
        const before = await fetchStats(forkA.workerPort);
        const extra = await fetch(`http://127.0.0.1:${forkB.workerPort}/api/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessions: [],
            summaries: [],
            observations: [
              {
                memory_session_id: 'membench-seed-live-b',
                project: 'membench-live-b',
                text: null,
                type: 'discovery',
                title: 'BETA-ONLY extra observation',
                subtitle: null,
                facts: JSON.stringify(['beta extra fact']),
                narrative: null,
                concepts: JSON.stringify([]),
                files_read: JSON.stringify([]),
                files_modified: JSON.stringify([]),
                prompt_number: 1,
                discovery_tokens: 0,
                created_at: new Date().toISOString(),
                created_at_epoch: Date.now(),
              },
            ],
            prompts: [],
          }),
        });
        expect(extra.ok).toBe(true);
        const afterA = await fetchStats(forkA.workerPort);
        expect(afterA).toEqual(before); // A unchanged by B's seeding
        expect((await fetchStats(forkB.workerPort)).observations).toBe(oracleRows.length + 1);

        // Injection blocks captured at prepare time contain ONLY their own titles.
        expect(forkA.injectionBlock).toContain('ALPHA-ONLY marker observation one');
        expect(forkA.injectionBlock).not.toContain('Startup context');
        expect(forkB.injectionBlock).toContain('Session goal and outcome');
        expect(forkB.injectionBlock).not.toContain('ALPHA-ONLY');

        // Re-fetch A's injection AFTER the beta row exists in B — the
        // cross-contamination assertion is only meaningful against a block
        // rendered while the foreign row is live.
        const refetchA = await fetch(
          `http://127.0.0.1:${forkA.workerPort}/api/context/inject?project=${encodeURIComponent(forkA.projectSlug)}`,
          { headers: { Accept: 'text/plain' } },
        );
        expect(refetchA.ok).toBe(true);
        const freshBlockA = await refetchA.text();
        expect(freshBlockA).toContain('ALPHA-ONLY marker observation one');
        expect(freshBlockA).not.toContain('BETA-ONLY');
        expect(freshBlockA).not.toContain('Session goal and outcome');

        console.log(`worker A (port ${forkA.workerPort}) stats:`, JSON.stringify(afterA));
        console.log(`worker B (port ${forkB.workerPort}) stats:`, JSON.stringify(await fetchStats(forkB.workerPort)));
        console.log(`--- worker A injection block ---\n${forkA.injectionBlock}`);
        console.log(`--- worker B injection block ---\n${forkB.injectionBlock}`);
        keepData = false;
      } finally {
        await Promise.all([
          teardownFork(forkA, { keepData }),
          teardownFork(forkB, { keepData }),
        ]);
      }

      // Teardown proof: workers dead, mem/ pruned on the happy path.
      for (const fork of [forkA, forkB] as PreparedFork[]) {
        await expect(
          fetch(`http://127.0.0.1:${fork.workerPort}/api/readiness`, { signal: AbortSignal.timeout(1_000) }),
        ).rejects.toThrow();
        expect(existsSync(fork.dataDir)).toBe(keepData);
      }
    },
    300_000,
  );
});
