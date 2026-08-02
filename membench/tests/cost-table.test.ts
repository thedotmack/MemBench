/**
 * Cost-table tests (plan Phase 7.3 + its verification list):
 *   - measured rates come ONLY from reported usage; unknown-cost calls are
 *     counted and surfaced, never folded in as $0 (guard 1)
 *   - the plan's formula is applied exactly, with both executor routes side by
 *     side and every number labeled measured or extrapolated
 *   - a lane with no measured rate stays n/a and is excluded from the total
 *   - a run that reported no cost at all is REFUSED, not estimated
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROL_VARIANT_COUNT,
  combineSamples,
  costMain,
  estimateObservePass,
  estimateRoute,
  readRunCostSample,
  renderCostTable,
  resolveTarget,
} from '../src/cost-table.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-cost-${name}-`));
}

interface RunFixture {
  runId: string;
  runsDir?: string;
  mock?: boolean;
  /** 'missing' / 'broken' exercise the provenance refusal. */
  manifest?: 'valid' | 'missing' | 'broken';
  /** obs record cost per model; null = the provider reported none. */
  observe?: Record<string, (number | null)[]>;
  /** executor row cost per lane; null = unreported. */
  executors?: Record<string, (number | null)[]>;
  judge?: (number | null)[];
  spec?: { models: number; items: number; k: number; lanes: string[] };
}

function makeRun(fixture: RunFixture): string {
  const runsDir = fixture.runsDir ?? tempDir('runs');
  const runDir = join(runsDir, fixture.runId);
  mkdirSync(join(runDir, 'obs', 'it-1'), { recursive: true });

  // One observe record per (item, model): costs[i] is the cost for item i+1.
  for (const [model, costs] of Object.entries(fixture.observe ?? {})) {
    for (let i = 0; i < costs.length; i++) {
      const itemId = `it-${i + 1}`;
      const itemDir = join(runDir, 'obs', itemId);
      mkdirSync(itemDir, { recursive: true });
      writeFileSync(
        join(itemDir, `${model.replace(/\//g, '-')}.json`),
        JSON.stringify({
          item_id: itemId,
          model,
          observations: [{ title: 't' }],
          parse_notes: [],
          usage_notes: [],
          obs_tokens_in: 10,
          obs_tokens_out: 2,
          obs_cost_usd: costs[i],
        }),
      );
    }
  }

  const rows: string[] = [];
  for (const [lane, costs] of Object.entries(fixture.executors ?? {})) {
    for (let i = 0; i < costs.length; i++) {
      rows.push(
        JSON.stringify({
          run_id: fixture.runId,
          item_id: 'it-1',
          variant: i === 0 ? 'model:good' : 'none',
          ...(i === 0 ? { observer_model: 'good' } : {}),
          executor: lane,
          run_index: i,
          success: true,
          tokens_in: 100,
          tokens_out: 20,
          tokens_total: 120,
          cost_usd: costs[i],
          duration_s: 1,
          mem_search_calls: 1,
          drift_flag: false,
          judged: true,
        }),
      );
    }
  }
  writeFileSync(join(runDir, 'results.jsonl'), rows.join('\n') + (rows.length > 0 ? '\n' : ''));

  if (fixture.judge) {
    writeFileSync(
      join(runDir, 'judge.jsonl'),
      fixture.judge.map((cost) => JSON.stringify({ run_id: fixture.runId, cost_usd: cost })).join('\n') + '\n',
    );
  }

  const manifestMode = fixture.manifest ?? 'valid';
  if (manifestMode === 'missing') return runsDir;
  if (manifestMode === 'broken') {
    writeFileSync(join(runDir, 'manifest.json'), '{"run_id":');
    return runsDir;
  }

  const spec = fixture.spec;
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      run_id: fixture.runId,
      created_at: '2026-07-31T00:00:00.000Z',
      mock: fixture.mock === true,
      ...(spec
        ? {
            spec: {
              corpus_items: Array.from({ length: spec.items }, (_, i) => `it-${i + 1}`),
              observer_models: Array.from({ length: spec.models }, (_, i) => `m-${i + 1}`),
              executors: spec.lanes,
              k: spec.k,
              observe_timeout_s: 30,
              execute_timeout_s: 30,
              judge_model: 'judge/model',
              max_cost_usd: 10,
              max_steps: 5,
              max_cost_per_run_usd: 1,
            },
          }
        : {}),
      items: [{ id: 'it-1', content_hash: 'abc' }],
    }),
  );
  return runsDir;
}

describe('measured rates', () => {
  test('sums reported costs per pass and counts the unreported ones separately', async () => {
    const runsDir = makeRun({
      runId: 'live-1',
      observe: { 'obs/a': [0.001], 'obs/b': [null] },
      executors: { 'claude-cli': [0.01, 0.03], 'openrouter-agent': [0.05, null] },
      judge: [0.0002, 0.0002, null],
    });
    const sample = await readRunCostSample(join(runsDir, 'live-1'), 'live-1');

    expect(sample.observeByModel['obs/a'].meanUsd).toBeCloseTo(0.001, 10);
    expect(sample.observeByModel['obs/b'].meanUsd).toBeNull();
    expect(sample.observeByModel['obs/b'].unreported).toBe(1);
    expect(sample.observeAll.calls).toBe(1);
    expect(sample.observeAll.unreported).toBe(1);

    expect(sample.executors['claude-cli'].meanUsd).toBeCloseTo(0.02, 10);
    expect(sample.executors['openrouter-agent'].calls).toBe(1);
    expect(sample.executors['openrouter-agent'].unreported).toBe(1);
    expect(sample.executors['openrouter-agent'].meanUsd).toBeCloseTo(0.05, 10);

    expect(sample.judge.calls).toBe(2);
    expect(sample.judge.unreported).toBe(1);
    // Reported only: 0.001 + 0.04 + 0.05 + 0.0004
    expect(sample.totalReportedUsd).toBeCloseTo(0.0914, 6);
    expect(sample.totalUnreported).toBe(3);
  });

  test('combines several runs into one basis, weighted by call count', async () => {
    const runsDir = makeRun({
      runId: 'a',
      observe: { 'obs/a': [0.001] },
      // Two calls in run a, one in run b: a call-weighted mean (0.01+0.01+0.04)/3
      // differs from a mean-of-means ((0.01+0.04)/2), so the weighting is visible.
      executors: { 'claude-cli': [0.01, 0.01] },
      judge: [0.0002],
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    makeRun({
      runId: 'b',
      runsDir,
      observe: { 'obs/a': [0.003] },
      executors: { 'claude-cli': [0.04] },
      judge: [0.0004],
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    const combined = combineSamples([
      await readRunCostSample(join(runsDir, 'a'), 'a'),
      await readRunCostSample(join(runsDir, 'b'), 'b'),
    ]);
    expect(combined.runId).toBe('a + b');
    expect(combined.observeAll.calls).toBe(2);
    expect(combined.observeAll.meanUsd).toBeCloseTo(0.002, 10);
    expect(combined.executors['claude-cli'].calls).toBe(3);
    expect(combined.executors['claude-cli'].meanUsd).toBeCloseTo(0.06 / 3, 10);
    expect(combined.executors['claude-cli'].meanUsd).not.toBeCloseTo(0.025, 5);
    expect(combined.judge.meanUsd).toBeCloseTo(0.0003, 10);
    expect(combined.specConflicts).toBeUndefined();
  });

  test('items are the UNION across runs and spec disagreements are recorded', async () => {
    const runsDir = makeRun({
      runId: 'x',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    makeRun({
      runId: 'y',
      runsDir,
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      spec: { models: 2, items: 3, k: 2, lanes: ['claude-cli', 'openrouter-agent'] },
    });
    const sampleX = await readRunCostSample(join(runsDir, 'x'), 'x');
    const sampleY = await readRunCostSample(join(runsDir, 'y'), 'y');
    const combined = combineSamples([sampleX, sampleY]);
    // Both fixtures write rows for it-1 only, so the union is 1 — and it is a
    // UNION, not a max over per-run counts.
    expect(combined.itemIds).toEqual(['it-1']);
    expect(combined.items).toBe(1);
    expect(combined.specConflicts?.length).toBeGreaterThan(0);
    expect(combined.specConflicts?.join('\n')).toContain('spec.observer_models');
    expect(combined.specConflicts?.join('\n')).toContain('spec.k');

    const markdown = renderCostTable({
      samples: [sampleX, sampleY],
      combined,
      target: resolveTarget(combined, {}),
    });
    expect(markdown).toContain('The source runs did not run the same matrix');
  });
});

describe('provenance is mandatory', () => {
  test('a run with no manifest.json is REFUSED (mock costs are non-zero, so nothing else would catch it)', async () => {
    const runsDir = makeRun({
      runId: 'nomanifest',
      manifest: 'missing',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
    });
    await expect(readRunCostSample(join(runsDir, 'nomanifest'), 'nomanifest')).rejects.toThrow(
      /no readable manifest\.json/,
    );

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      expect(await costMain(['nomanifest', '--runs-dir', runsDir], { log: () => {} })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('provenance unknown');
  });

  test('an unparseable manifest.json is REFUSED too', async () => {
    const runsDir = makeRun({
      runId: 'brokenmanifest',
      manifest: 'broken',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
    });
    await expect(readRunCostSample(join(runsDir, 'brokenmanifest'), 'brokenmanifest')).rejects.toThrow(
      /no readable manifest\.json/,
    );
  });

  test('a path-traversing run id is refused before any path is built', async () => {
    await expect(readRunCostSample(join(tempDir('x'), '..'), '..')).rejects.toThrow(/invalid --run-id/);
  });
});

describe('extrapolation', () => {
  test('applies the plan formula exactly, per route', async () => {
    const runsDir = makeRun({
      runId: 'live-2',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01], 'openrouter-agent': [0.02] },
      judge: [0.0002],
      spec: { models: 3, items: 2, k: 2, lanes: ['claude-cli', 'openrouter-agent'] },
    });
    const sample = await readRunCostSample(join(runsDir, 'live-2'), 'live-2');
    const target = resolveTarget(sample, {});
    expect(target).toMatchObject({ models: 3, items: 2, k: 2 });
    expect(target.sources.models).toBe('run spec');

    const cli = estimateRoute(sample, 'claude-cli', target);
    // observe: items(2) × models(3) × $0.001
    expect(cli.observeCalls).toBe(6);
    expect(cli.observeUsd).toBeCloseTo(0.006, 10);
    // executor: items(2) × (models(3)+3 controls) × k(2) = 24 fork-runs
    expect(cli.executorRuns).toBe(2 * (3 + CONTROL_VARIANT_COUNT) * 2);
    expect(cli.executorUsd).toBeCloseTo(24 * 0.01, 10);
    expect(cli.judgeUsd).toBeCloseTo(24 * 0.0002, 10);
    expect(cli.totalUsd).toBeCloseTo(0.006 + 0.24 + 0.0048, 10);
    expect(cli.missing).toEqual([]);

    const agent = estimateRoute(sample, 'openrouter-agent', target);
    expect(agent.executorUsd).toBeCloseTo(24 * 0.02, 10);
  });

  test('flag overrides beat the spec defaults', async () => {
    const runsDir = makeRun({
      runId: 'live-3',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      spec: { models: 3, items: 2, k: 2, lanes: ['claude-cli'] },
    });
    const sample = await readRunCostSample(join(runsDir, 'live-3'), 'live-3');
    const target = resolveTarget(sample, { models: 6, items: 5, k: 3 });
    expect(target).toMatchObject({ models: 6, items: 5, k: 3 });
    expect(target.sources).toEqual({ models: '--models', items: '--items', k: '--k' });
    const route = estimateRoute(sample, 'claude-cli', target);
    expect(route.observeCalls).toBe(30);
    expect(route.executorRuns).toBe(5 * (6 + 3) * 3);
  });

  test('prices the observe pass PER MODEL, not at a blended rate', async () => {
    // A cheap model and an expensive one: the blend would misprice both.
    const runsDir = makeRun({
      runId: 'live-per-model',
      observe: { 'cheap/model': [0.001], 'spendy/model': [0.009] },
      executors: { 'claude-cli': [0.01] },
      judge: [0.0002],
      spec: { models: 2, items: 4, k: 1, lanes: ['claude-cli'] },
    });
    const sample = await readRunCostSample(join(runsDir, 'live-per-model'), 'live-per-model');
    const target = resolveTarget(sample, {});
    const observe = estimateObservePass(sample, target);
    // items(4) × (0.001 + 0.009), NOT items × models × blended 0.005 (same
    // here by construction, but the per-model path is what is asserted).
    expect(observe.usd).toBeCloseTo(4 * 0.01, 10);
    expect(observe.measuredModels).toBe(2);
    expect(observe.blendedModels).toBe(0);

    // Extrapolating to MORE models than were measured falls back to the blend,
    // and says how many models that covers.
    const wider = estimateObservePass(sample, resolveTarget(sample, { models: 3 }));
    expect(wider.measuredModels).toBe(2);
    expect(wider.blendedModels).toBe(1);
    expect(wider.usd).toBeCloseTo(4 * (0.001 + 0.009 + 0.005), 10);
  });

  test('a lane with no measured rate is n/a and excluded from the total', async () => {
    const runsDir = makeRun({
      runId: 'live-4',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      judge: [0.0002],
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    const sample = await readRunCostSample(join(runsDir, 'live-4'), 'live-4');
    const target = resolveTarget(sample, {});
    const agent = estimateRoute(sample, 'openrouter-agent', target);
    expect(agent.executorUsd).toBeNull();
    expect(agent.missing).toEqual(['executor pass (openrouter-agent)']);
    // The total still sums the components that WERE measured, and says so.
    expect(agent.totalUsd).toBeCloseTo(1 * 1 * 0.001 + 4 * 0.0002, 10);
  });
});

describe('rendering', () => {
  async function render(fixture: RunFixture): Promise<string> {
    const runsDir = makeRun(fixture);
    const sample = await readRunCostSample(join(runsDir, fixture.runId), fixture.runId);
    const combined = combineSamples([sample]);
    return renderCostTable({ samples: [sample], combined, target: resolveTarget(combined, {}) });
  }

  test('labels every number, shows both routes, names the source run and cites OpenRouter', async () => {
    const markdown = await render({
      runId: 'live-5',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01], 'openrouter-agent': [0.02] },
      judge: [0.0002],
      spec: { models: 2, items: 1, k: 2, lanes: ['claude-cli', 'openrouter-agent'] },
    });
    expect(markdown).toContain('`live-5`');
    expect(markdown).toContain('[OpenRouter](https://openrouter.ai)');
    expect(markdown).toContain('Route `claude-cli`');
    expect(markdown).toContain('Route `openrouter-agent`');
    expect(markdown).toContain('**measured**');
    expect(markdown).toContain('**extrapolated**');
    // The formula printed is the one actually computed…
    expect(markdown).toContain('observe  = items × Σ(per-model measured observe mean)');
    expect(markdown).toContain('executor = items × (models + 3 controls) × k × mean cost per fork-run in that lane');
    // …with the plan's formula cited alongside it.
    expect(markdown).toContain('N_models × (obs pass) + (N_models + 3) × k × N_executors × ');
    // The judge term is labeled an upper bound (measure.ts skips it on empty
    // diffs with a mechanically decided check).
    expect(markdown).toContain('judge pass (upper bound)');
    expect(markdown).toContain('UPPER BOUND');
    expect(markdown).toContain('the judge is skipped entirely when `check.sh` decided');
    expect(markdown).not.toMatch(/NaN|Infinity/);
    // No pricing constants anywhere (guard 1): the only rates are measured means.
    expect(markdown).not.toMatch(/per (?:1M|million) tokens/i);
  });

  test('surfaces unknown-cost calls instead of treating them as free', async () => {
    const markdown = await render({
      runId: 'live-6',
      observe: { 'obs/a': [0.001], 'obs/b': [null] },
      executors: { 'claude-cli': [0.01, null] },
      judge: [null],
      spec: { models: 2, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    expect(markdown).toContain('calls with NO reported cost');
    expect(markdown).toMatch(/3 measured call\(s\) returned no cost/);
    expect(markdown).toContain('lower bound');
    // The judge rate is unmeasured, so it is excluded and named.
    expect(markdown).toContain('Excluded from the totals (no measured rate yet)');
    expect(markdown).toContain('judge pass');
  });

  test('marks a mock run as fabricated', async () => {
    const markdown = await render({
      runId: 'mock-1',
      mock: true,
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    expect(markdown).toContain('MOCK DATA');
    expect(markdown).toContain('`mock-1`');
  });
});

describe('costMain', () => {
  test('refuses a run with no reported costs at all (never estimates)', async () => {
    const runsDir = makeRun({
      runId: 'nocost',
      observe: { 'obs/a': [null] },
      executors: { 'claude-cli': [null, null] },
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      const code = await costMain(['nocost', '--runs-dir', runsDir], { log: () => {} });
      expect(code).toBe(1);
    } finally {
      console.error = originalError;
    }
    const message = errors.join('\n');
    expect(message).toContain('reports no usage cost anywhere');
    expect(message).toContain('never estimates cost from a pricing table');
    expect(message).toContain('3 call(s) in that run returned no cost');
  });

  test('renders a table for a run with real reported costs', async () => {
    const runsDir = makeRun({
      runId: 'live-7',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      judge: [0.0002],
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    const logs: string[] = [];
    const outPath = join(runsDir, 'cost.md');
    const code = await costMain(['live-7', '--runs-dir', runsDir, '--out', outPath], {
      log: (message) => logs.push(message),
    });
    expect(code).toBe(0);
    const markdown = logs.join('\n');
    expect(markdown).toContain('# MemBench cost estimate');
    expect(await Bun.file(outPath).text()).toContain('# MemBench cost estimate');
  });

  test('deduplicates repeated run ids so one run cannot be double-weighted', async () => {
    const runsDir = makeRun({
      runId: 'live-8',
      observe: { 'obs/a': [0.001] },
      executors: { 'claude-cli': [0.01] },
      judge: [0.0002],
      spec: { models: 1, items: 1, k: 1, lanes: ['claude-cli'] },
    });
    const logs: string[] = [];
    expect(
      await costMain(['live-8', 'live-8', '--runs-dir', runsDir], { log: (message) => logs.push(message) }),
    ).toBe(0);
    const output = logs.join('\n');
    expect(output).toContain('ignoring duplicate run id(s)');
    expect(output).toContain('Source run(s): `live-8`');
    // One executor call in the basis, not two.
    expect(output).toContain('| executor: claude-cli | 1 |');
  });

  test('refuses a path-traversing run id', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      expect(await costMain(['../escape'], { log: () => {} })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('invalid --run-id');
  });

  test('requires at least one run id', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      expect(await costMain([], { log: () => {} })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('at least one <run-id> is required');
  });
});
