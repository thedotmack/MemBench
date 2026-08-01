import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SpecError, loadRunSpec, validateRunSpec } from '../src/spec.ts';

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name);

/** A fresh, fully valid spec table for mutation in validateRunSpec tests. */
const baseSpec = (): Record<string, unknown> => ({
  corpus_items: ['claude-mem-pro-001'],
  observer_models: ['google/gemini-2.5-flash'],
  executors: ['claude-cli'],
  k: 1,
  observe_timeout_s: 300,
  execute_timeout_s: 1800,
  judge_model: 'anthropic/claude-sonnet-4.5',
  max_cost_usd: 25.0,
  max_steps: 50,
  max_cost_per_run_usd: 2.5,
});

describe('loadRunSpec', () => {
  test('loads a valid TOML run spec', async () => {
    const spec = await loadRunSpec(fixture('valid-spec.toml'));
    expect(spec).toEqual({
      corpus_items: ['claude-mem-pro-001', 'freckle-nail-001'],
      observer_models: ['google/gemini-2.5-flash', 'openai/gpt-5-mini'],
      executors: ['claude-cli', 'openrouter-agent'],
      k: 3,
      observe_timeout_s: 300,
      execute_timeout_s: 1800,
      judge_model: 'anthropic/claude-sonnet-4.5',
      max_cost_usd: 25.0,
      max_steps: 50,
      max_cost_per_run_usd: 2.5,
    });
  });

  test('rejects unknown keys, naming them', async () => {
    await expect(loadRunSpec(fixture('unknown-key-spec.toml'))).rejects.toThrow(SpecError);
    await expect(loadRunSpec(fixture('unknown-key-spec.toml'))).rejects.toThrow('max_cots_usd');
  });

  test('rejects missing required keys, naming them', async () => {
    await expect(loadRunSpec(fixture('missing-key-spec.toml'))).rejects.toThrow(SpecError);
    await expect(loadRunSpec(fixture('missing-key-spec.toml'))).rejects.toThrow('judge_model');
  });

  test('rejects executors outside the two lanes', async () => {
    await expect(loadRunSpec(fixture('bad-executor-spec.toml'))).rejects.toThrow(SpecError);
    await expect(loadRunSpec(fixture('bad-executor-spec.toml'))).rejects.toThrow('codex');
  });

  test('rejects a nonexistent spec file', async () => {
    await expect(loadRunSpec(fixture('nope.toml'))).rejects.toThrow(SpecError);
  });
});

describe('validateRunSpec value validation', () => {
  test('accepts the base valid spec', () => {
    const expected = baseSpec() as unknown as ReturnType<typeof validateRunSpec>;
    expect(validateRunSpec(baseSpec(), 'base')).toEqual(expected);
  });

  test('rejects k = 0', () => {
    expect(() => validateRunSpec({ ...baseSpec(), k: 0 }, 'spec')).toThrow(SpecError);
    expect(() => validateRunSpec({ ...baseSpec(), k: 0 }, 'spec')).toThrow('k must be a positive integer');
  });

  test('rejects non-integer k', () => {
    expect(() => validateRunSpec({ ...baseSpec(), k: 1.5 }, 'spec')).toThrow('k must be a positive integer');
  });

  test('rejects wrong-typed k (string)', () => {
    expect(() => validateRunSpec({ ...baseSpec(), k: '3' }, 'spec')).toThrow(SpecError);
  });

  test('rejects negative timeout', () => {
    expect(() => validateRunSpec({ ...baseSpec(), observe_timeout_s: -5 }, 'spec')).toThrow(
      'observe_timeout_s must be a positive number',
    );
    expect(() => validateRunSpec({ ...baseSpec(), execute_timeout_s: -1 }, 'spec')).toThrow(
      'execute_timeout_s must be a positive number',
    );
  });

  test('rejects empty judge_model', () => {
    expect(() => validateRunSpec({ ...baseSpec(), judge_model: '' }, 'spec')).toThrow(
      'judge_model must be a non-empty string',
    );
    expect(() => validateRunSpec({ ...baseSpec(), judge_model: '   ' }, 'spec')).toThrow(
      'judge_model must be a non-empty string',
    );
  });

  test('rejects empty corpus_items array', () => {
    expect(() => validateRunSpec({ ...baseSpec(), corpus_items: [] }, 'spec')).toThrow(
      'corpus_items must be a non-empty array of strings',
    );
  });

  test('rejects wrong-typed corpus_items (string, mixed array)', () => {
    expect(() => validateRunSpec({ ...baseSpec(), corpus_items: 'item-1' }, 'spec')).toThrow(SpecError);
    expect(() => validateRunSpec({ ...baseSpec(), corpus_items: ['item-1', 42] }, 'spec')).toThrow(SpecError);
  });

  test('rejects duplicate corpus_items', () => {
    expect(() =>
      validateRunSpec({ ...baseSpec(), corpus_items: ['item-1', 'item-1'] }, 'spec'),
    ).toThrow('corpus_items contains duplicate entries');
  });

  test('rejects duplicate executors', () => {
    expect(() =>
      validateRunSpec({ ...baseSpec(), executors: ['claude-cli', 'claude-cli'] }, 'spec'),
    ).toThrow('executors contains duplicate entries');
  });

  test('rejects a non-table spec', () => {
    expect(() => validateRunSpec(null, 'spec')).toThrow(SpecError);
    expect(() => validateRunSpec(['not', 'a', 'table'], 'spec')).toThrow(SpecError);
  });
});
