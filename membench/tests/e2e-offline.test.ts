/**
 * Offline end-to-end test for the Phase 6 orchestration loop.
 *
 * The whole pipeline runs with `--mock`: mock provider (canned observation XML
 * + canned judge JSON), mock executors (both lanes), a stub claude-mem worker
 * per fork (Bun.serve on the port fork.ts assigned) and a mock repo clone.
 * No network, no real claude-mem, no `claude` binary.
 *
 * The mini-corpus lives in tests/fixtures/mini-corpus/ as two complete frozen
 * items; each test copies it to a temp dir and rewrites repo.lock (pointing at
 * a freshly created LOCAL git fixture repo) and provenance.json (with the real
 * sorted-file content hash), because both are machine-specific.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeContentHash } from '../src/corpus.ts';
import { createPortPool, type PortPool } from '../src/fork.ts';
import { readJsonl } from '../src/jsonl.ts';
import type { ObserveRecord } from '../src/observe-stage.ts';
import {
  estimateCost,
  computeCallMatrix,
  observeMain,
  readMeasuredRates,
  runMain,
  type RunOverrides,
} from '../src/run-command.ts';
import { loadRunSpec } from '../src/spec.ts';
import type { ResultRow } from '../src/types.ts';

const FIXTURES = join(import.meta.dir, 'fixtures');
const MINI_CORPUS = join(FIXTURES, 'mini-corpus');
const SPEC_ONE_ITEM = join(FIXTURES, 'e2e-spec.toml');
const SPEC_TWO_ITEMS = join(FIXTURES, 'e2e-spec-two-items.toml');

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-e2e-${name}-`));
}

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

/** A local git repo the fixture items' repo.lock can legitimately point at. */
function makeFixtureRepo(): { repoPath: string; commit: string } {
  const repoPath = tempDir('repo');
  git(['init', '--quiet', '-b', 'main'], repoPath);
  git(['config', 'user.email', 'membench@example.invalid'], repoPath);
  git(['config', 'user.name', 'MemBench Fixture'], repoPath);
  mkdirSync(join(repoPath, 'src'), { recursive: true });
  writeFileSync(join(repoPath, 'src', 'counter.ts'), 'export let count = 0;\n');
  git(['add', '.'], repoPath);
  git(['commit', '--quiet', '-m', 'fixture baseline'], repoPath);
  return { repoPath, commit: git(['rev-parse', 'HEAD'], repoPath) };
}

/** Copy the committed mini-corpus to a temp dir and freeze it for this machine. */
async function materializeCorpus(): Promise<string> {
  const corpusDir = tempDir('corpus');
  cpSync(MINI_CORPUS, corpusDir, { recursive: true });
  const { repoPath, commit } = makeFixtureRepo();
  for (const itemId of ['mini-001', 'mini-002']) {
    const dir = join(corpusDir, itemId);
    const lock = JSON.parse(readFileSync(join(dir, 'repo.lock'), 'utf-8')) as Record<string, unknown>;
    lock.url = repoPath;
    lock.commit = commit;
    writeFileSync(join(dir, 'repo.lock'), JSON.stringify(lock, null, 2) + '\n');
    // Hash AFTER repo.lock is final (provenance.json is excluded from the hash).
    const hash = await computeContentHash(dir);
    const provenance = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf-8')) as Record<string, unknown>;
    provenance.content_hash = hash;
    writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
  }
  return corpusDir;
}

interface Harness {
  corpusDir: string;
  runsDir: string;
  logs: string[];
  errors: string[];
  prompts: { lane: string; variant: string; item: string; prompt: string }[];
  run(args: string[], overrides?: RunOverrides): Promise<number>;
  observe(args: string[], overrides?: RunOverrides): Promise<number>;
  rows(runId: string): Promise<ResultRow[]>;
  runDir(runId: string): string;
}

let harness: Harness;
let originalConsoleError: typeof console.error;

beforeEach(async () => {
  const corpusDir = await materializeCorpus();
  const runsDir = tempDir('runs');
  const logs: string[] = [];
  const errors: string[] = [];
  const prompts: Harness['prompts'] = [];

  originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };

  const baseArgs = ['--corpus-dir', corpusDir, '--runs-dir', runsDir];
  const withDefaults = (overrides: RunOverrides = {}): RunOverrides => ({
    ...overrides,
    log: overrides.log ?? ((message: string) => logs.push(message)),
    mock: {
      ...(overrides.mock ?? {}),
      executor: { calls: prompts, ...(overrides.mock?.executor ?? {}) },
    },
  });

  harness = {
    corpusDir,
    runsDir,
    logs,
    errors,
    prompts,
    run: (args, overrides) => runMain([...args, ...baseArgs], withDefaults(overrides)),
    observe: (args, overrides) => observeMain([...args, ...baseArgs], withDefaults(overrides)),
    runDir: (runId: string) => join(runsDir, runId),
    rows: (runId: string) => readJsonl<ResultRow>(join(runsDir, runId, 'results.jsonl')),
  };
});

afterEach(() => {
  console.error = originalConsoleError;
});

const REQUIRED_ROW_FIELDS = [
  'run_id',
  'item_id',
  'variant',
  'executor',
  'run_index',
  'success',
  'tokens_in',
  'tokens_out',
  'tokens_total',
  'cost_usd',
  'duration_s',
  'mem_search_calls',
  'drift_flag',
  'judged',
] as const;

function cellKeyOf(row: ResultRow): string {
  return `${row.item_id}|${row.variant}|${row.executor}|${row.run_index}`;
}

describe('mock end-to-end run', () => {
  test('writes (models+3) × executors × k rows with every ResultRow field present', async () => {
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-1', '--mock']);
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-1');
    // (2 observer models + 3 controls) × 2 executors × k=2
    expect(rows).toHaveLength(20);

    for (const row of rows) {
      for (const field of REQUIRED_ROW_FIELDS) {
        expect(row).toHaveProperty(field);
        expect((row as Record<string, unknown>)[field]).not.toBeUndefined();
      }
      expect(row.run_id).toBe('e2e-1');
      expect(row.item_id).toBe('mini-001');
      expect(typeof row.success).toBe('boolean');
      expect(typeof row.duration_s).toBe('number');
      expect(typeof row.mem_search_calls).toBe('number');
      expect(typeof row.judged).toBe('boolean');
      // Tri-state: boolean when a judge decided, null when it could not.
      expect(row.drift_flag === null || typeof row.drift_flag === 'boolean').toBe(true);
      // observer_model is present exactly on the model variants (guard: a
      // control row must never claim an observer).
      if (row.variant.startsWith('model:')) {
        expect(row.observer_model).toBe(row.variant.slice('model:'.length));
      } else {
        expect(row.observer_model).toBeUndefined();
      }
    }

    // Every planned cell exactly once — no duplicates, no missing lanes.
    const keys = rows.map(cellKeyOf);
    expect(new Set(keys).size).toBe(20);
    const variants = new Set(rows.map((row) => row.variant));
    expect([...variants].sort()).toEqual([
      'model:mock/observer-a',
      'model:mock/observer-b',
      'none',
      'oracle',
      'shuffled',
    ]);
    expect(rows.filter((row) => row.executor === 'claude-cli')).toHaveLength(10);
    expect(rows.filter((row) => row.executor === 'openrouter-agent')).toHaveLength(10);

    // The mock executor writes the marker file check.sh looks for, so the
    // mechanical check passes and the judge (drift only) says no drift.
    expect(rows.every((row) => row.success)).toBe(true);
    expect(rows.every((row) => row.drift_flag === false)).toBe(true);
    expect(rows.every((row) => row.judged === true)).toBe(true);
    expect(rows.every((row) => row.error === undefined)).toBe(true);
    expect(rows.every((row) => row.cost_usd === 0.011)).toBe(true);
    expect(rows.every((row) => row.tokens_total === 5_000)).toBe(true);
    expect(rows.every((row) => row.mem_search_calls === 2)).toBe(true);
    expect(rows.every((row) => row.drift_note === 'mock judge verdict')).toBe(true);
  });

  test('emits one observe record per (item, model) with the full field set', async () => {
    await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-obs', '--mock']);
    const obsDir = join(harness.runDir('e2e-obs'), 'obs', 'mini-001');
    const record = JSON.parse(
      readFileSync(join(obsDir, 'mock-observer-a-c0f8fc44.json'), 'utf-8'),
    ) as ObserveRecord;
    // Self-identifying: the slug in the filename is a one-way hash.
    expect(record.item_id).toBe('mini-001');
    expect(record.model).toBe('mock/observer-a');
    expect(record.observations.length).toBe(2); // one per replayed tool call
    expect(record.parse_notes).toEqual([]);
    expect(record.usage_notes).toEqual([]);
    expect(record.obs_tokens_in).toBe(2_700); // 3 turns × 900, real reported usage
    expect(record.obs_tokens_out).toBe(360);
    expect(record.obs_cost_usd).toBeCloseTo(0.0012, 10);
    expect(record.error).toBeUndefined();
  });

  test('writes a manifest recording the mock flag and the shuffled donor mapping', async () => {
    await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-man', '--mock']);
    const manifest = JSON.parse(
      readFileSync(join(harness.runDir('e2e-man'), 'manifest.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(manifest.mock).toBe(true);
    expect(manifest.run_id).toBe('e2e-man');
    expect(manifest.shuffled_source_map).toEqual({
      'mini-001': { donor_item: 'mini-002', donor_source: 'oracle' },
    });
    expect(manifest.variants).toEqual([
      'model:mock/observer-a',
      'model:mock/observer-b',
      'none',
      'oracle',
      'shuffled',
    ]);
    expect((manifest.items as { content_hash: string }[])[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('hidden-field discipline: no oracle/rubric text ever reaches an executor prompt', async () => {
    await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-hidden', '--mock']);
    expect(harness.prompts).toHaveLength(20);
    for (const call of harness.prompts) {
      expect(call.prompt).not.toContain('MINI001-ORACLE-MARKER');
      expect(call.prompt).not.toContain('MINI001-RUBRIC-MARKER');
      expect(call.prompt).not.toContain('membench-mock-marker.md'); // check.sh internals
      expect(call.prompt).toContain('Add a short note file'); // task.md IS the prompt
    }
    // The floor gets the bare task; seeded variants get the injection block.
    const floor = harness.prompts.find((call) => call.variant === 'none')!;
    const oracle = harness.prompts.find((call) => call.variant === 'oracle')!;
    expect(floor.prompt.startsWith('Add a short note file')).toBe(true);
    expect(oracle.prompt).toContain('## Past work');
    // The oracle's SECTION TITLES arrive as seeded memory (by design) — the
    // marker line above the first heading is framing and is never seeded.
    expect(oracle.prompt).toContain('Counter module layout');
  });

  test('an injected mid-run executor failure still yields a row with error set', async () => {
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-fail', '--mock'], {
      mock: {
        executor: {
          failFor: ({ fork }) => (fork.variant === 'oracle' ? 'injected executor crash' : undefined),
        },
      },
    });
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-fail');
    expect(rows).toHaveLength(20); // guard 3: no row is ever dropped
    const failed = rows.filter((row) => row.variant === 'oracle');
    expect(failed).toHaveLength(4); // 2 executors × k=2
    for (const row of failed) {
      expect(row.error).toBe('injected executor crash');
      // No marker file was written, so check.sh fails mechanically.
      expect(row.success).toBe(false);
      expect(row.cost_usd).toBeNull();
      expect(row.tokens_total).toBeNull();
      // Nothing changed in the repo and the check decided: drift is provably
      // false and no judge call was spent on it.
      expect(row.drift_flag).toBe(false);
      expect(row.judged).toBe(false);
    }
    for (const row of rows.filter((row) => row.variant !== 'oracle')) {
      expect(row.error).toBeUndefined();
      expect(row.success).toBe(true);
    }
  });

  test('a blocked variant (observe failure) still produces error rows', async () => {
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-obsfail', '--mock'], {
      query: async (model, messages) => {
        if (model === 'mock/observer-b') throw new Error('injected observe transport failure');
        const { createMockQueryModel } = await import('../src/mocks.ts');
        return createMockQueryModel({})(model, messages);
      },
    });
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-obsfail');
    expect(rows).toHaveLength(20);
    const blocked = rows.filter((row) => row.variant === 'model:mock/observer-b');
    expect(blocked).toHaveLength(4);
    for (const row of blocked) {
      expect(row.error).toContain('observe failed');
      expect(row.success).toBe(false);
      // Never ran → drift is unknown, not "clean".
      expect(row.drift_flag).toBeNull();
      expect(row.judged).toBe(false);
    }
    // The failed observe is recorded as an error artifact, not an empty seed.
    const record = JSON.parse(
      readFileSync(join(harness.runDir('e2e-obsfail'), 'obs', 'mini-001', 'mock-observer-b-2a31c6bb.json'), 'utf-8'),
    ) as ObserveRecord;
    expect(record.error).toContain('injected observe transport failure');
    expect(record.obs_cost_usd).toBeNull();
  });

  test('the JSON accommodation surfaces on the obs record AND every row of that variant', async () => {
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-accom', '--mock'], {
      mock: { query: { jsonAccommodationModels: ['mock/observer-b'] } },
    });
    expect(code).toBe(0);

    const record = JSON.parse(
      readFileSync(join(harness.runDir('e2e-accom'), 'obs', 'mini-001', 'mock-observer-b-2a31c6bb.json'), 'utf-8'),
    ) as ObserveRecord;
    expect(record.accommodation).toBe('json');
    expect(record.observations.length).toBeGreaterThan(0);
    expect(record.parse_notes.join(' ')).toContain('JSON accommodation');

    const rows = await harness.rows('e2e-accom');
    const accommodated = rows.filter((row) => row.variant === 'model:mock/observer-b');
    expect(accommodated).toHaveLength(4);
    expect(accommodated.every((row) => row.accommodation === 'json')).toBe(true);
    // Only that model's rows are tagged — the others competed on XML.
    expect(rows.filter((row) => row.accommodation !== undefined)).toHaveLength(4);
  });

  test('a judge transport failure lands a row with judged:false, drift null and success false', async () => {
    const code = await harness.run(
      ['--spec', SPEC_TWO_ITEMS, '--run-id', 'e2e-judgefail', '--mock'],
      { mock: { query: { judgeFails: 'injected judge transport failure' } } },
    );
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-judgefail');
    expect(rows).toHaveLength(20);

    // mini-002's check.sh exits CHECK_EXIT_JUDGE: with no judge, success is
    // NOT granted and drift is unknown — never a silent pass, never "no drift".
    const gated = rows.filter((row) => row.item_id === 'mini-002');
    expect(gated).toHaveLength(10);
    for (const row of gated) {
      expect(row.judged).toBe(false);
      expect(row.drift_flag).toBeNull();
      expect(row.success).toBe(false);
      expect(row.drift_note).toContain('judge unavailable');
    }
    // mini-001 is decided mechanically, so it still passes; drift is unknown.
    const mechanical = rows.filter((row) => row.item_id === 'mini-001');
    expect(mechanical.every((row) => row.success)).toBe(true);
    expect(mechanical.every((row) => row.drift_flag === null && row.judged === false)).toBe(true);
    // A judge call that never happened books NO unknown cost.
    expect(existsSync(join(harness.runDir('e2e-judgefail'), 'judge.jsonl'))).toBe(false);
  });
});

describe('governance', () => {
  test('dry-run prints the matrix and makes ZERO network calls', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      throw new Error(`network call during --dry-run: ${String(args[0])}`);
    }) as unknown as typeof fetch;
    try {
      const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-dry', '--dry-run']);
      expect(code).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(fetchCalls).toBe(0);

    const output = harness.logs.join('\n');
    expect(output).toContain('DRY RUN');
    expect(output).toContain('observe calls         items × models = 2');
    expect(output).toContain('items × (models+3) × executors × k = 20');
    expect(output).toContain('no measured rates yet');
    // Nothing was written.
    expect(existsSync(harness.runDir('e2e-dry'))).toBe(false);
  });

  test('the cost estimate uses measured rates from prior live runs and skips mock runs', async () => {
    // A prior LIVE run's artifacts.
    const live = join(harness.runsDir, 'prior-live');
    mkdirSync(join(live, 'obs', 'mini-001'), { recursive: true });
    writeFileSync(join(live, 'manifest.json'), JSON.stringify({ run_id: 'prior-live', mock: false }));
    writeFileSync(
      join(live, 'obs', 'mini-001', 'mock-observer-a-c0f8fc44.json'),
      JSON.stringify({
        item_id: 'mini-001',
        model: 'mock/observer-a',
        observations: [],
        parse_notes: [],
        usage_notes: [],
        obs_tokens_in: 1,
        obs_tokens_out: 1,
        obs_cost_usd: 0.02,
      }),
    );
    writeFileSync(
      join(live, 'results.jsonl'),
      [
        JSON.stringify({ executor: 'claude-cli', cost_usd: 0.5 }),
        JSON.stringify({ executor: 'claude-cli', cost_usd: 0.7 }),
        JSON.stringify({ executor: 'openrouter-agent', cost_usd: null }),
      ].join('\n') + '\n',
    );
    writeFileSync(join(live, 'judge.jsonl'), JSON.stringify({ cost_usd: 0.001 }) + '\n');
    // A prior MOCK run whose fabricated spend must never enter an estimate.
    const mock = join(harness.runsDir, 'prior-mock');
    mkdirSync(mock, { recursive: true });
    writeFileSync(join(mock, 'manifest.json'), JSON.stringify({ run_id: 'prior-mock', mock: true }));
    writeFileSync(join(mock, 'results.jsonl'), JSON.stringify({ executor: 'claude-cli', cost_usd: 99 }) + '\n');

    const rates = await readMeasuredRates(harness.runsDir);
    expect(rates.sourceRuns).toEqual(['prior-live']);
    expect(rates.skippedMockRuns).toEqual(['prior-mock']);
    // Observe rates are keyed per observer model, not blended.
    expect(rates.observeByModel['mock/observer-a'].meanUsd).toBeCloseTo(0.02, 10);
    expect(rates.observeByModel['mock/observer-b']).toBeUndefined();
    expect(rates.executors['claude-cli'].meanUsd).toBeCloseTo(0.6, 10);
    // A row without a reported cost is an UNKNOWN, never a $0 sample.
    expect(rates.executors['openrouter-agent'].meanUsd).toBeNull();
    expect(rates.executors['openrouter-agent'].unknown).toBe(1);

    const spec = await loadRunSpec(SPEC_ONE_ITEM);
    const matrix = computeCallMatrix(spec);
    const estimate = estimateCost(matrix, spec, rates);
    // observe(observer-a) 1 item × 0.02 + claude-cli 10 × 0.6 + judge 20 × 0.001
    expect(estimate.totalUsd).toBeCloseTo(0.02 + 6 + 0.02, 10);
    // observer-b has no measured rate of its own, so it is excluded by name.
    expect(estimate.missing).toEqual(['observe:mock/observer-b', 'openrouter-agent']);
  });

  test('a live run without --approve-cost-usd refuses to start', async () => {
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-noapprove']);
    expect(code).toBe(1);
    expect(harness.errors.join('\n')).toContain('live runs require --approve-cost-usd');
    expect(existsSync(join(harness.runDir('e2e-noapprove'), 'results.jsonl'))).toBe(false);
  });

  test('the overwrite guard refuses to clobber an existing results.jsonl', async () => {
    await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-guard', '--mock']);
    const before = await harness.rows('e2e-guard');
    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-guard', '--mock']);
    expect(code).toBe(1);
    expect(harness.errors.join('\n')).toContain('refusing to clobber');
    expect(await harness.rows('e2e-guard')).toHaveLength(before.length);
  });

  test('observe then run on the same run id reuses the observe records instead of re-spending', async () => {
    const calls: { model: string; prompt: string }[] = [];
    const observeCode = await harness.observe(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-reuse', '--mock'], {
      mock: { query: { calls } },
    });
    expect(observeCode).toBe(0);
    const afterObserve = calls.length; // 2 models × (init + 2 tool calls)
    expect(afterObserve).toBe(6);

    // A run dir with a manifest is an existing run: continuing it needs --resume.
    const refused = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-reuse', '--mock']);
    expect(refused).toBe(1);
    expect(harness.errors.join('\n')).toContain('already exists');

    const code = await harness.run(
      ['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-reuse', '--mock', '--resume'],
      { mock: { query: { calls } } },
    );
    expect(code).toBe(0);
    // Only judge calls were added — not one observe replay was re-spent.
    const added = calls.slice(afterObserve);
    expect(added).toHaveLength(20);
    expect(added.every((call) => call.prompt.includes('MemBench drift judge'))).toBe(true);
    expect(await harness.rows('e2e-reuse')).toHaveLength(20);
    expect(harness.logs.join('\n')).toContain('observe: reusing mini-001 × mock/observer-a');
  });

  test('--resume refuses when the prior manifest disagrees (mock flag / spec / corpus hash)', async () => {
    await harness.observe(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-integrity', '--mock']);

    // Same run id, but now claiming to be a LIVE run: refuse (a mock run's
    // canned costs must never be relabelled as measured rates).
    const code = await harness.run([
      '--spec',
      SPEC_ONE_ITEM,
      '--run-id',
      'e2e-integrity',
      '--resume',
      '--approve-cost-usd',
      '1',
    ]);
    expect(code).toBe(1);
    expect(harness.errors.join('\n')).toContain('created with mock=true');

    // Same run id, different spec: refuse.
    const specCode = await harness.run([
      '--spec',
      SPEC_TWO_ITEMS,
      '--run-id',
      'e2e-integrity',
      '--mock',
      '--resume',
    ]);
    expect(specCode).toBe(1);
    expect(harness.errors.join('\n')).toContain('run spec differs');

    // Same run id, mutated corpus item: refuse (hash mismatch).
    writeFileSync(join(harness.corpusDir, 'mini-001', 'task.md'), 'a different task\n');
    const hashCode = await harness.run([
      '--spec',
      SPEC_ONE_ITEM,
      '--run-id',
      'e2e-integrity',
      '--mock',
      '--resume',
    ]);
    expect(hashCode).toBe(1);
    // The frozen-hash recheck fires before the manifest comparison.
    expect(harness.errors.join('\n')).toContain('changed since it was frozen');
  });

  test('--retry-failed re-runs errored cells without duplicating rows', async () => {
    let failing = true;
    await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-retry', '--mock'], {
      mock: {
        executor: {
          failFor: ({ fork }) => (failing && fork.variant === 'none' ? 'injected crash' : undefined),
        },
      },
    });
    const first = await harness.rows('e2e-retry');
    expect(first.filter((row) => row.error !== undefined)).toHaveLength(4);

    failing = false;
    const code = await harness.run(
      ['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-retry', '--mock', '--resume', '--retry-failed'],
      { mock: { executor: { failFor: () => undefined } } },
    );
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-retry');
    expect(rows).toHaveLength(20);
    expect(new Set(rows.map(cellKeyOf)).size).toBe(20); // no duplicate cells
    expect(rows.every((row) => row.error === undefined)).toBe(true);
    // The failed attempt is preserved for audit, not discarded.
    const retried = await readJsonl<{ row: ResultRow }>(join(harness.runDir('e2e-retry'), 'retried-rows.jsonl'));
    expect(retried).toHaveLength(4);
    expect(retried.every((entry) => entry.row.error === 'injected crash')).toBe(true);
  });

  test('the unreported-cost circuit breaker stops a run whose spend is unknowable', async () => {
    const code = await harness.run(
      ['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-unreported', '--mock', '--max-unreported-calls', '4'],
      { mock: { query: { costUsd: null }, executor: { costUsd: null } } },
    );
    expect(code).toBe(2); // stopped early, resumable
    const output = harness.logs.join('\n');
    expect(output).toContain('UNREPORTED-COST LIMIT REACHED');
    expect(output).toContain('unbounded-unknown');
    // Abandoned cells wrote NO rows, so --resume can still run them.
    const rows = await harness.rows('e2e-unreported');
    expect(rows.length).toBeLessThan(20);
    expect(output).toContain('abandoned unrun');
  });

  test('a fork-preparation failure yields an error row and releases the port', async () => {
    const acquired: number[] = [];
    const released: number[] = [];
    const inner = createPortPool(39500, 8, false);
    const countingPool: PortPool = {
      size: 8,
      acquire: () => {
        const port = inner.acquire();
        acquired.push(port);
        return port;
      },
      release: (port: number) => {
        released.push(port);
        inner.release(port);
      },
    };

    const code = await harness.run(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-forkfail', '--mock'], {
      portPool: countingPool,
      deps: {
        spawnWorker: () => {
          throw new Error('injected worker spawn failure');
        },
      },
    });
    expect(code).toBe(0);

    const rows = await harness.rows('e2e-forkfail');
    expect(rows).toHaveLength(20); // guard 3 again: still one row per cell
    for (const row of rows) {
      expect(row.error).toContain('fork preparation failed');
      expect(row.error).toContain('injected worker spawn failure');
      expect(row.success).toBe(false);
      expect(row.judged).toBe(false);
      expect(row.drift_flag).toBeNull();
    }
    // Every acquired port came back to the pool — no leak across 20 failures.
    expect(acquired.length).toBe(20);
    expect(released.length).toBe(20);
  });

  test('unknown cost is surfaced, never treated as $0', async () => {
    await harness.run(
      ['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-unknown', '--mock', '--max-unreported-calls', '1000'],
      { mock: { query: { costUsd: null }, executor: { costUsd: null } } },
    );
    const output = harness.logs.join('\n');
    expect(output).toContain('UNKNOWN COST');
    expect(output).toContain('NOT counted as $0');
    expect(output).toContain('REAL SPEND: $0.0000');
    const rows = await harness.rows('e2e-unknown');
    expect(rows.every((row) => row.cost_usd === null)).toBe(true);
  });

  test('the cost ceiling stops between items and the partial run resumes with no duplicates', async () => {
    // Ceiling below one item's mock spend: the run halts after item 1.
    const first = await harness.run([
      '--spec',
      SPEC_TWO_ITEMS,
      '--run-id',
      'e2e-resume',
      '--mock',
      '--approve-cost-usd',
      '0.05',
    ]);
    expect(first).toBe(2); // stopped early, resumable
    expect(harness.logs.join('\n')).toContain('COST CEILING REACHED');
    // The pre-flight stops at the FIRST cell after the ceiling is crossed, so
    // the stop lands mid-item; abandoned cells wrote no rows at all.
    expect(harness.logs.join('\n')).toContain('abandoned unrun');

    const partial = await harness.rows('e2e-resume');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(20);
    expect(new Set(partial.map((row) => row.item_id))).toEqual(new Set(['mini-001']));

    const second = await harness.run([
      '--spec',
      SPEC_TWO_ITEMS,
      '--run-id',
      'e2e-resume',
      '--mock',
      '--resume',
      '--approve-cost-usd',
      '10',
    ]);
    expect(second).toBe(0);
    expect(harness.logs.join('\n')).toContain(`resume: ${partial.length} completed row(s) will be skipped`);

    const rows = await harness.rows('e2e-resume');
    expect(rows).toHaveLength(20);
    const keys = rows.map(cellKeyOf);
    expect(new Set(keys).size).toBe(20); // no duplicated (item, variant, executor, run_index)
    expect(rows.filter((row) => row.item_id === 'mini-001')).toHaveLength(10);
    expect(rows.filter((row) => row.item_id === 'mini-002')).toHaveLength(10);
    // mini-002's check.sh defers (exit 3) — the judge decided success there.
    expect(rows.filter((row) => row.item_id === 'mini-002').every((row) => row.success)).toBe(true);
    // The resumed attempt is recorded in the manifest.
    const manifest = JSON.parse(
      readFileSync(join(harness.runDir('e2e-resume'), 'manifest.json'), 'utf-8'),
    ) as { resumes: string[]; shuffled_source_map: Record<string, unknown> };
    expect(manifest.resumes).toHaveLength(1);
    // Two items in the run: the donor mapping rotates within the run and uses
    // the donor's first observer model.
    expect(manifest.shuffled_source_map).toEqual({
      'mini-001': { donor_item: 'mini-002', donor_source: 'mock/observer-a' },
      'mini-002': { donor_item: 'mini-001', donor_source: 'mock/observer-a' },
    });
  });
});

describe('membench observe', () => {
  test('runs stage 1 only', async () => {
    const code = await harness.observe(['--spec', SPEC_ONE_ITEM, '--run-id', 'e2e-observe', '--mock']);
    expect(code).toBe(0);
    const runDir = harness.runDir('e2e-observe');
    expect(existsSync(join(runDir, 'obs', 'mini-001'))).toBe(true);
    expect(existsSync(join(runDir, 'results.jsonl'))).toBe(false);
    expect(harness.logs.join('\n')).toContain('observe stage complete: 2 (item × model) record(s)');
  });
});
