/**
 * Scoreboard tests (plan Phase 7.1 + its verification list):
 *   - every metric renders, sectioned by executor, on a hand-built
 *     results.jsonl covering normal / null-cost / legacy-field / null-drift /
 *     degenerate / zero-success / malformed rows
 *   - NO NaN or Infinity anywhere in the rendered output or summary.json
 *   - guard 11: no cell mixes claude-cli and openrouter-agent rows
 *   - observation counts appear ONLY under Diagnostics (plan line 328)
 *   - malformed lines are skipped WITH a warning and surfaced in diagnostics
 *   - run-vs-run diff mode renders per (executor, variant) deltas
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildSummary,
  driftRate,
  mean,
  oracleSavingsPct,
  readResultRows,
  renderDiff,
  renderScoreboard,
  sampleStddev,
  scoreMain,
  scoreRun,
  summarizeRun,
  successRate,
  type NormalizedRow,
  type RunSummary,
} from '../src/scoreboard.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-scoreboard-${name}-`));
}

interface RowInput {
  item?: string;
  variant: string;
  executor: string;
  run_index: number;
  success: boolean;
  tokens_total?: number | null;
  cost_usd?: number | null;
  mem_search_calls?: number;
  drift_flag?: boolean | null;
  judged?: boolean;
  /** Legacy field from pre-cleanup runs — must be ignored on read, never fatal. */
  accommodation?: string;
  error?: string;
}

function row(input: RowInput): Record<string, unknown> {
  const variant = input.variant;
  return {
    run_id: 'r1',
    item_id: input.item ?? 'it-1',
    variant,
    ...(variant.startsWith('model:') ? { observer_model: variant.slice('model:'.length) } : {}),
    executor: input.executor,
    run_index: input.run_index,
    success: input.success,
    tokens_in: null,
    tokens_out: null,
    tokens_total: input.tokens_total ?? null,
    cost_usd: input.cost_usd ?? null,
    duration_s: 12.5,
    mem_search_calls: input.mem_search_calls ?? 1,
    drift_flag: input.drift_flag ?? false,
    judged: input.judged ?? true,
    ...(input.accommodation ? { accommodation: input.accommodation } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

/**
 * A run directory covering every case the scoreboard must survive:
 *
 *   claude-cli        model:good  — 2 successes with usage + 1 success with NO
 *                                   reported usage (surfaced, not averaged in)
 *                                   and 1 row with NO reported cost
 *                     model:bad   — 0 successes, legacy accommodation field, drift
 *                     none        — floor mean 2100
 *                     oracle      — ceiling mean 1050
 *                     shuffled    — drift_flag null + judged false (unjudged)
 *   openrouter-agent  floor mean == oracle mean → the degenerate savings case
 *   results.jsonl     one unparseable line + one row missing `executor`
 */
function makeRunDir(options: { manifest?: 'valid' | 'missing' | 'broken' } = {}): string {
  const runsDir = tempDir('runs');
  const runDir = join(runsDir, 'r1');
  mkdirSync(join(runDir, 'obs', 'it-1'), { recursive: true });

  const rows: Record<string, unknown>[] = [
    // --- claude-cli lane ---
    row({ variant: 'model:good', executor: 'claude-cli', run_index: 0, success: true, tokens_total: 1000, cost_usd: 0.01, mem_search_calls: 1 }),
    row({ variant: 'model:good', executor: 'claude-cli', run_index: 1, success: true, tokens_total: 1200, cost_usd: null, mem_search_calls: 3 }),
    row({ variant: 'model:good', executor: 'claude-cli', run_index: 2, success: true, tokens_total: null, cost_usd: 0.01, mem_search_calls: 2 }),
    row({ variant: 'model:bad', executor: 'claude-cli', run_index: 0, success: false, tokens_total: null, cost_usd: 0.02, drift_flag: true, accommodation: 'json' }),
    row({ variant: 'model:bad', executor: 'claude-cli', run_index: 1, success: false, tokens_total: null, cost_usd: 0.02, drift_flag: true, accommodation: 'json', error: 'executor timeout' }),
    row({ variant: 'none', executor: 'claude-cli', run_index: 0, success: true, tokens_total: 2000, cost_usd: 0.03 }),
    row({ variant: 'none', executor: 'claude-cli', run_index: 1, success: true, tokens_total: 2200, cost_usd: 0.03 }),
    row({ variant: 'oracle', executor: 'claude-cli', run_index: 0, success: true, tokens_total: 1000, cost_usd: 0.01 }),
    row({ variant: 'oracle', executor: 'claude-cli', run_index: 1, success: true, tokens_total: 1100, cost_usd: 0.01 }),
    row({ variant: 'shuffled', executor: 'claude-cli', run_index: 0, success: true, tokens_total: 1900, cost_usd: 0.02, drift_flag: null, judged: false }),
    row({ variant: 'shuffled', executor: 'claude-cli', run_index: 1, success: true, tokens_total: 2100, cost_usd: 0.02, drift_flag: null, judged: false }),
    // --- openrouter-agent lane: floor == oracle (degenerate savings) ---
    row({ variant: 'model:good', executor: 'openrouter-agent', run_index: 0, success: true, tokens_total: 1400, cost_usd: 0.05 }),
    row({ variant: 'model:good', executor: 'openrouter-agent', run_index: 1, success: true, tokens_total: 1400, cost_usd: 0.05 }),
    row({ variant: 'none', executor: 'openrouter-agent', run_index: 0, success: true, tokens_total: 1500, cost_usd: 0.05 }),
    row({ variant: 'none', executor: 'openrouter-agent', run_index: 1, success: true, tokens_total: 1500, cost_usd: 0.05 }),
    row({ variant: 'oracle', executor: 'openrouter-agent', run_index: 0, success: true, tokens_total: 1500, cost_usd: 0.05 }),
    row({ variant: 'oracle', executor: 'openrouter-agent', run_index: 1, success: true, tokens_total: 1500, cost_usd: 0.05 }),
  ];

  const lines = rows.map((entry) => JSON.stringify(entry));
  // Malformed: unparseable JSON, and a well-formed object missing `executor`.
  lines.splice(3, 0, '{"run_id": "r1", "item_id": "it-1"');
  lines.push(JSON.stringify({ run_id: 'r1', item_id: 'it-1', variant: 'none', run_index: 9, success: true }));
  writeFileSync(join(runDir, 'results.jsonl'), lines.join('\n') + '\n');

  writeFileSync(
    join(runDir, 'obs', 'it-1', 'good.json'),
    JSON.stringify({
      item_id: 'it-1',
      model: 'good',
      observations: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
      parse_notes: [],
      usage_notes: [],
      obs_tokens_in: 5000,
      obs_tokens_out: 900,
      obs_cost_usd: 0.004,
    }),
  );
  writeFileSync(
    join(runDir, 'obs', 'it-1', 'bad.json'),
    JSON.stringify({
      item_id: 'it-1',
      model: 'bad',
      observations: [{ title: 'x' }],
      parse_notes: ['observation turn 2 (Bash): unparseable reply'],
      usage_notes: ['observation turn 2: no usage.cost reported'],
      obs_tokens_in: 4000,
      obs_tokens_out: null,
      obs_cost_usd: null,
      // Legacy field from pre-cleanup observe records: ignored on read.
      accommodation: 'json',
    }),
  );
  // An unreadable artifact must be skipped and surfaced, not crash the render.
  writeFileSync(join(runDir, 'obs', 'it-1', 'broken.json'), '{not json');

  writeFileSync(
    join(runDir, 'judge.jsonl'),
    [
      JSON.stringify({ run_id: 'r1', item_id: 'it-1', cost_usd: 0.0002 }),
      JSON.stringify({ run_id: 'r1', item_id: 'it-1', cost_usd: null }),
    ].join('\n') + '\n',
  );

  const manifestMode = options.manifest ?? 'valid';
  if (manifestMode === 'missing') return runDir;
  if (manifestMode === 'broken') {
    writeFileSync(join(runDir, 'manifest.json'), '{"run_id": "r1", ');
    return runDir;
  }
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      run_id: 'r1',
      created_at: '2026-07-31T00:00:00.000Z',
      mock: false,
      spec_path: '/Users/somebody/MemBench/run-specs/x.toml',
      spec: {
        corpus_items: ['it-1'],
        observer_models: ['good', 'bad'],
        executors: ['claude-cli', 'openrouter-agent'],
        k: 2,
        observe_timeout_s: 30,
        execute_timeout_s: 30,
        judge_model: 'judge/model',
        max_cost_usd: 1,
        max_steps: 5,
        max_cost_per_run_usd: 0.5,
        executor_model: 'exec/model',
      },
      corpus_dir: '/Users/somebody/MemBench/corpus',
      runs_dir: '/Users/somebody/MemBench/runs',
      items: [{ id: 'it-1', content_hash: 'abc123' }],
      variants: ['model:good', 'model:bad', 'none', 'oracle', 'shuffled'],
    }),
  );
  return runDir;
}

/** The text of one executor section, used for the lane-purity assertion. */
function sectionText(markdown: string, executor: string): string {
  const start = markdown.indexOf(`## Executor lane: \`${executor}\``);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextSection = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, nextSection === -1 ? markdown.length : nextSection);
}

describe('metric primitives', () => {
  test('successRate guards a zero denominator', () => {
    expect(successRate(0, 0)).toBeNull();
    expect(successRate(1, 4)).toBe(0.25);
  });

  test('sample stddev needs 2+ samples and is Bessel-corrected', () => {
    expect(sampleStddev([])).toBeNull();
    expect(sampleStddev([5])).toBeNull();
    expect(sampleStddev([1000, 1200])).toBeCloseTo(141.4213, 3);
    expect(mean([1000, 1200])).toBe(1100);
  });

  test('oracle savings guards every degenerate case instead of returning NaN', () => {
    expect(oracleSavingsPct(1100, 2100, 1050)).toEqual({ pct: (1000 / 1050) * 100, note: null });
    expect(oracleSavingsPct(1400, 1500, 1500)).toEqual({ pct: null, note: 'n/a (floor==oracle)' });
    expect(oracleSavingsPct(1400, null, 1500)).toEqual({ pct: null, note: 'n/a (no floor tokens)' });
    expect(oracleSavingsPct(1400, 1500, null)).toEqual({ pct: null, note: 'n/a (no oracle tokens)' });
    expect(oracleSavingsPct(null, 2100, 1050)).toEqual({ pct: null, note: 'n/a (no successful runs)' });
  });

  test('an oracle ABOVE the floor is a broken ceiling, not negative savings', () => {
    // floor 1000 < oracle 1500: the denominator flips sign, so the ratio would
    // silently invert. Refuse to publish a number instead.
    expect(oracleSavingsPct(1200, 1000, 1500)).toEqual({ pct: null, note: 'n/a (oracle above floor)' });
  });

  test('a model worse than the floor reports NEGATIVE savings, unclamped', () => {
    // model 2500 vs floor 2100, oracle 1050 → (2100−2500)/1050 = −38.1%
    const { pct, note } = oracleSavingsPct(2500, 2100, 1050);
    expect(note).toBeNull();
    expect(pct).toBeCloseTo(-38.095, 3);
  });

  test('drift rate is over judged rows only', () => {
    expect(driftRate(0, 0)).toBeNull();
    expect(driftRate(1, 4)).toBe(0.25);
  });
});

describe('defensive loading', () => {
  test('skips malformed lines with a warning and records them', async () => {
    const runDir = makeRunDir();
    const warnings: string[] = [];
    const { rows, skipped } = await readResultRows(join(runDir, 'results.jsonl'), (message) =>
      warnings.push(message),
    );
    expect(rows).toHaveLength(17);
    expect(skipped).toHaveLength(2);
    expect(skipped[0].line).toBe(4);
    expect(skipped[0].reason).toContain('unparseable JSON');
    expect(skipped[1].reason).toContain('executor');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('line 4');
  });

  test('a missing results.jsonl warns and yields no rows (no throw)', async () => {
    const warnings: string[] = [];
    const { rows, skipped } = await readResultRows(join(tempDir('empty'), 'results.jsonl'), (message) =>
      warnings.push(message),
    );
    expect(rows).toHaveLength(0);
    expect(skipped).toHaveLength(0);
    expect(warnings[0]).toContain('not found');
  });
});

describe('summary + scoreboard rendering', () => {
  async function score(): Promise<{ summary: RunSummary; markdown: string; runDir: string }> {
    const runDir = makeRunDir();
    const { summary, markdown } = await scoreRun({ runDir, runId: 'r1', warn: () => {} });
    return { summary, markdown, runDir };
  }

  test('writes summary.json + scoreboard.md into the run dir', async () => {
    const { runDir } = await score();
    expect(await Bun.file(join(runDir, 'summary.json')).exists()).toBe(true);
    expect(await Bun.file(join(runDir, 'scoreboard.md')).exists()).toBe(true);
  });

  test('never renders NaN or Infinity, anywhere', async () => {
    const { summary, markdown } = await score();
    expect(markdown).not.toMatch(/NaN|Infinity/);
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity|null,"stddev":NaN/);
    // A JSON round-trip proves no non-finite number survived into summary.json.
    expect(() => JSON.parse(JSON.stringify(summary))).not.toThrow();
  });

  test('is sectioned by executor and no cell mixes lanes (guard 11)', async () => {
    const { markdown } = await score();
    expect(markdown).toContain('## Executor lane: `claude-cli`');
    expect(markdown).toContain('## Executor lane: `openrouter-agent`');
    const cliSection = sectionText(markdown, 'claude-cli');
    expect(cliSection).not.toContain('openrouter-agent');
    const agentSection = sectionText(markdown, 'openrouter-agent');
    expect(agentSection).not.toContain('claude-cli');
  });

  test('headline metrics per model, computed within one lane', async () => {
    const { summary } = await score();
    const cli = summary.executors.find((section) => section.executor === 'claude-cli')!;
    const good = cli.models.find((entry) => entry.variant === 'model:good')!;
    expect(good.runs).toBe(3);
    expect(good.successes).toBe(3);
    expect(good.success_rate).toBe(1);
    // Successful runs with reported usage only: 1000, 1200 (the third is null).
    expect(good.tokens.counted).toBe(2);
    expect(good.tokens.missing_usage).toBe(1);
    expect(good.tokens.mean).toBe(1100);
    expect(good.tokens.stddev).toBeCloseTo(141.42, 1);
    // (floor 2100 − model 1100) / (floor 2100 − oracle 1050)
    expect(good.oracle_savings_pct).toBeCloseTo((1000 / 1050) * 100, 6);
    // Reported costs only: 0.01 + 0.01, with one row reporting nothing.
    expect(good.exec_cost_usd).toBeCloseTo(0.02, 10);
    expect(good.exec_cost_unreported_rows).toBe(1);
    expect(good.obs_cost_usd).toBeCloseTo(0.004, 10);
    expect(good.search_burden_mean).toBe(2);
    expect(good.drift_rate).toBe(0);
  });

  test('a model with zero successful runs reads n/a, never 0 or NaN', async () => {
    const { summary, markdown } = await score();
    const cli = summary.executors.find((section) => section.executor === 'claude-cli')!;
    const bad = cli.models.find((entry) => entry.variant === 'model:bad')!;
    expect(bad.successes).toBe(0);
    expect(bad.success_rate).toBe(0);
    expect(bad.tokens.mean).toBeNull();
    expect(bad.tokens.stddev).toBeNull();
    expect(bad.oracle_savings_pct).toBeNull();
    expect(bad.oracle_savings_note).toBe('n/a (no successful runs)');
    expect(markdown).toContain('n/a (0 successful runs)');
  });

  test('the degenerate floor==oracle case is labeled, not divided by zero', async () => {
    const { summary, markdown } = await score();
    const agent = summary.executors.find((section) => section.executor === 'openrouter-agent')!;
    expect(agent.floor_tokens_mean).toBe(1500);
    expect(agent.oracle_tokens_mean).toBe(1500);
    const good = agent.models.find((entry) => entry.variant === 'model:good')!;
    expect(good.oracle_savings_pct).toBeNull();
    expect(good.oracle_savings_note).toBe('n/a (floor==oracle)');
    expect(sectionText(markdown, 'openrouter-agent')).toContain('n/a (floor==oracle)');
  });

  test('controls are rendered as reference rows in each lane', async () => {
    const { summary, markdown } = await score();
    const cli = summary.executors.find((section) => section.executor === 'claude-cli')!;
    expect(cli.controls.map((entry) => entry.variant)).toEqual(['none', 'oracle', 'shuffled']);
    const section = sectionText(markdown, 'claude-cli');
    expect(section).toContain('### Controls (reference rows)');
    expect(section).toContain('`none` — floor');
    expect(section).toContain('`oracle` — ceiling');
    expect(section).toContain('`shuffled` — relevance control');
  });

  test('missing usage, unreported cost and unjudged rows are SURFACED', async () => {
    const { summary, markdown } = await score();
    const cli = summary.executors.find((section) => section.executor === 'claude-cli')!;
    const shuffled = cli.controls.find((entry) => entry.variant === 'shuffled')!;
    expect(shuffled.drift_judged).toBe(0);
    expect(shuffled.drift_unjudged).toBe(2);
    expect(shuffled.drift_rate).toBeNull();

    const section = sectionText(markdown, 'claude-cli');
    // In the table itself, not only in a footnote.
    expect(section).toContain('+ 1 without usage');
    expect(section).toContain('**missing usage**');
    expect(section).toContain('**unreported cost**');
    expect(section).toContain('**unjudged**');
    expect(section).toContain('**errors**');
  });

  test('drift rate counts judged rows only', async () => {
    const { summary } = await score();
    const cli = summary.executors.find((section) => section.executor === 'claude-cli')!;
    const bad = cli.models.find((entry) => entry.variant === 'model:bad')!;
    expect(bad.drift_judged).toBe(2);
    expect(bad.drift_flagged).toBe(2);
    expect(bad.drift_rate).toBe(1);
    expect(bad.drift_unjudged).toBe(0);
  });

  test('observation counts appear ONLY under Diagnostics (plan line 328)', async () => {
    const { markdown } = await score();
    const diagnosticsAt = markdown.indexOf('## Diagnostics');
    expect(diagnosticsAt).toBeGreaterThan(0);
    const lower = markdown.toLowerCase();
    // Every mention of an observation (count, table, header) is below the fold.
    let index = lower.indexOf('observation');
    while (index !== -1) {
      expect(index).toBeGreaterThan(diagnosticsAt);
      index = lower.indexOf('observation', index + 1);
    }
    expect(markdown).toContain('### Observation counts and observe-side usage');
  });

  test('diagnostics carry the counts, parse notes, splits, deltas and skipped rows', async () => {
    const { summary, markdown } = await score();
    const diagnostics = summary.diagnostics;
    expect(diagnostics.observations.find((entry) => entry.model === 'good')?.observation_count).toBe(3);
    expect(diagnostics.parse_note_samples[0]).toContain('unparseable reply');
    expect(diagnostics.skipped_result_rows).toHaveLength(2);
    expect(diagnostics.skipped_observe_records).toHaveLength(1);
    expect(diagnostics.error_rows).toHaveLength(1);
    expect(diagnostics.per_item.length).toBeGreaterThan(0);
    // Cross-executor deltas exist, and ONLY under Diagnostics.
    expect(diagnostics.cross_executor.length).toBeGreaterThan(0);
    const deltasAt = markdown.indexOf('### Cross-executor deltas');
    expect(deltasAt).toBeGreaterThan(markdown.indexOf('## Diagnostics'));
  });

  test('run totals separate observe / executor / judge spend and count unreported calls', async () => {
    const { summary } = await score();
    expect(summary.totals.rows).toBe(17);
    expect(summary.totals.exec_cost_unreported_rows).toBe(1);
    expect(summary.totals.obs_cost_usd).toBeCloseTo(0.004, 10);
    expect(summary.totals.obs_cost_unreported).toBe(1);
    expect(summary.totals.judge_cost_usd).toBeCloseTo(0.0002, 10);
    expect(summary.totals.judge_cost_unreported).toBe(1);
  });

  test('an empty run renders without throwing', () => {
    const summary = buildSummary({
      runId: 'empty',
      rows: [] as NormalizedRow[],
      skippedRows: [],
      observeRecords: [],
      skippedObserveRecords: [],
      manifest: null,
      judgeCost: { usd: 0, unreported: 0 },
    });
    const markdown = renderScoreboard(summary);
    expect(markdown).toContain('_No usable result rows in this run._');
    expect(markdown).not.toMatch(/NaN|Infinity/);
  });
});

describe('rendering edge cases', () => {
  function normalized(input: Partial<NormalizedRow> & { variant: string; executor: string }): NormalizedRow {
    return {
      run_id: 'r',
      item_id: 'it-1',
      observer_model: input.variant.startsWith('model:') ? input.variant.slice('model:'.length) : null,
      run_index: 0,
      success: true,
      tokens_total: null,
      cost_usd: null,
      duration_s: 1,
      mem_search_calls: 1,
      drift_flag: false,
      judged: true,
      error: null,
      ...input,
    };
  }

  function summaryOf(rows: NormalizedRow[], observeRecords: Parameters<typeof buildSummary>[0]['observeRecords'] = []) {
    return buildSummary({
      runId: 'edge',
      rows,
      skippedRows: [],
      observeRecords,
      skippedObserveRecords: [],
      manifest: null,
      judgeCost: { usd: 0, unreported: 0 },
    });
  }

  test('a single successful run renders "± n/a", never a fake 0 spread', () => {
    const markdown = renderScoreboard(
      summaryOf([
        normalized({ variant: 'model:solo', executor: 'claude-cli', tokens_total: 1234 }),
        normalized({ variant: 'none', executor: 'claude-cli', tokens_total: 2000 }),
      ]),
    );
    expect(markdown).toContain('1,234 ± n/a (n=1)');
    expect(markdown).not.toMatch(/NaN|Infinity/);
  });

  test('a model worse than the floor renders a negative savings percentage', () => {
    const markdown = renderScoreboard(
      summaryOf([
        normalized({ variant: 'model:worse', executor: 'claude-cli', tokens_total: 2500 }),
        normalized({ variant: 'model:worse', executor: 'claude-cli', run_index: 1, tokens_total: 2500 }),
        normalized({ variant: 'none', executor: 'claude-cli', tokens_total: 2000 }),
        normalized({ variant: 'none', executor: 'claude-cli', run_index: 1, tokens_total: 2200 }),
        normalized({ variant: 'oracle', executor: 'claude-cli', tokens_total: 1000 }),
        normalized({ variant: 'oracle', executor: 'claude-cli', run_index: 1, tokens_total: 1100 }),
      ]),
    );
    expect(markdown).toContain('-38.1%');
    expect(markdown).toContain('A negative % means the model did WORSE than the no-memory floor');
  });

  test('an oracle above the floor is labeled, not inverted', () => {
    const markdown = renderScoreboard(
      summaryOf([
        normalized({ variant: 'model:m', executor: 'claude-cli', tokens_total: 1200 }),
        normalized({ variant: 'none', executor: 'claude-cli', tokens_total: 1000 }),
        normalized({ variant: 'oracle', executor: 'claude-cli', tokens_total: 1500 }),
      ]),
    );
    expect(markdown).toContain('n/a (oracle above floor)');
  });

  test('a variant pooling different items than the floor gets a footnote', () => {
    const markdown = renderScoreboard(
      summaryOf([
        // The model only succeeded on it-1; the floor succeeded on both items.
        normalized({ variant: 'model:m', executor: 'claude-cli', item_id: 'it-1', tokens_total: 900 }),
        normalized({ variant: 'model:m', executor: 'claude-cli', item_id: 'it-2', success: false }),
        normalized({ variant: 'none', executor: 'claude-cli', item_id: 'it-1', tokens_total: 2000 }),
        normalized({ variant: 'none', executor: 'claude-cli', item_id: 'it-2', tokens_total: 3000 }),
      ]),
    );
    expect(markdown).toContain('**pooled items**');
    expect(markdown).toContain('tokens-to-done pools it-1 while the floor pools it-1, it-2');
  });

  test('an observe pass that reported no cost renders n/a + count, not an em dash', () => {
    const markdown = renderScoreboard(
      summaryOf(
        [normalized({ variant: 'model:m', executor: 'claude-cli', tokens_total: 100 })],
        [
          {
            item_id: 'it-1',
            model: 'm',
            observations: [],
            parse_notes: [],
            usage_notes: [],
            obs_tokens_in: null,
            obs_tokens_out: null,
            obs_cost_usd: null,
          },
        ],
      ),
    );
    expect(markdown).toContain('n/a + 1 unreported');
  });

  test('the header line reports skipped malformed lines', async () => {
    const runDir = makeRunDir();
    const { markdown } = await scoreRun({ runDir, runId: 'r1', warn: () => {} });
    expect(markdown).toContain('2 malformed line(s) SKIPPED');
  });
});

describe('provenance is mandatory', () => {
  test('a run with no manifest.json is REFUSED, not assumed live', async () => {
    const runDir = makeRunDir({ manifest: 'missing' });
    await expect(summarizeRun({ runDir, runId: 'r1', warn: () => {} })).rejects.toThrow(
      /no readable manifest\.json/,
    );
    // The refusal says WHY: a lost manifest means mock/live is unknown, and a
    // mock run rendered as live would publish fabricated numbers.
    await expect(summarizeRun({ runDir, runId: 'r1', warn: () => {} })).rejects.toThrow(
      /provenance unknown/,
    );
  });

  test('an unparseable manifest.json is REFUSED too', async () => {
    const runDir = makeRunDir({ manifest: 'broken' });
    await expect(summarizeRun({ runDir, runId: 'r1', warn: () => {} })).rejects.toThrow(
      /no readable manifest\.json/,
    );
  });

  test('scoreMain refuses a path-traversing run id', async () => {
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.map(String).join(' '));
    try {
      expect(await scoreMain(['--run-id', '../escape'], { log: () => {} })).toBe(1);
      expect(await scoreMain(['--run-id', 'ok', '--diff', '..'], { log: () => {} })).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('invalid --run-id');
  });
});

describe('run-vs-run diff mode', () => {
  test('renders per (executor, variant) deltas without NaN', async () => {
    const runDir = makeRunDir();
    const current = await summarizeRun({ runDir, runId: 'r1', warn: () => {} });
    // A second run where the good model got worse and one lane is absent.
    const otherRows: NormalizedRow[] = [
      {
        run_id: 'r0',
        item_id: 'it-1',
        variant: 'model:good',
        observer_model: 'good',
        executor: 'claude-cli',
        run_index: 0,
        success: false,
        tokens_total: 1800,
        cost_usd: 0.01,
        duration_s: 1,
        mem_search_calls: 5,
        drift_flag: false,
        judged: true,
        error: null,
      },
    ];
    const other = buildSummary({
      runId: 'r0',
      rows: otherRows,
      skippedRows: [],
      observeRecords: [],
      skippedObserveRecords: [],
      manifest: null,
      judgeCost: { usd: 0, unreported: 0 },
    });

    const markdown = renderDiff(current, other);
    expect(markdown).toContain('# Diff — run `r1` vs `r0`');
    expect(markdown).toContain('## Executor lane: `claude-cli`');
    expect(markdown).toContain('## Executor lane: `openrouter-agent`');
    // model:good success went 0% → 100%: +100.0pp.
    expect(markdown).toContain('+100.0pp');
    // Cells present in only one run read as `absent`, never as a fake 0.
    expect(markdown).toContain('absent');
    expect(markdown).not.toMatch(/NaN|Infinity/);
  });
});

/**
 * The plan's Final-Phase audit greps over `membench/src` are the safety net for
 * guards 1/2/5/7/9 — and grep SKIPS a file it considers binary. A stray NUL
 * byte in a source file would therefore silently exempt that file from every
 * guard check, so the suite asserts the sources stay plain text.
 */
describe('sources stay grep-able (audit-grep safety net)', () => {
  test('no source or test file contains a NUL byte', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const root = join(import.meta.dir, '..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'runs' || entry.name.startsWith('.')) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|json|toml|md|sh)$/.test(entry.name)) continue;
        if (statSync(path).size === 0) continue;
        offenders.push(path);
      }
    };
    walk(join(root, 'src'));
    walk(join(root, 'tests'));

    const withNul: string[] = [];
    for (const path of offenders) {
      const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
      if (bytes.includes(0)) withNul.push(path);
    }
    expect(withNul).toEqual([]);
  });
});
