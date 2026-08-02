import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SpecError, loadRunSpec, validateRunSpec } from '../src/spec.ts';

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name);

/** A fresh, fully valid spec table for mutation in validateRunSpec tests. */
const baseSpec = (): Record<string, unknown> => ({
  corpus_items: ['claude-mem-pro-004'],
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
      corpus_items: ['claude-mem-pro-004', 'freckle-nail-001'],
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

  test('rejects corpus_items that are not single safe path segments', () => {
    // Ids become directory segments under the corpus root and runs/<id>/obs/;
    // traversal or separator ids would read/write outside those roots.
    for (const bad of ['../../victim', 'a/b', 'a\\b', '/etc/passwd', '..', '.', '.hidden', '']) {
      expect(() => validateRunSpec({ ...baseSpec(), corpus_items: [bad] }, 'spec')).toThrow(
        'corpus_items entries must be single path segments',
      );
    }
  });

  test('accepts ordinary corpus item ids', () => {
    const spec = validateRunSpec(
      { ...baseSpec(), corpus_items: ['claude-mem-pro-004', 'item_2.v1'] },
      'spec',
    );
    expect(spec.corpus_items).toEqual(['claude-mem-pro-004', 'item_2.v1']);
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

describe('optional Phase 6 keys', () => {
  test('accepts them when present and omits them when absent', () => {
    const withOptional = validateRunSpec(
      { ...baseSpec(), executor_model: 'vendor/model', cli_model: 'haiku', fork_concurrency: 3, observe_concurrency: 8 },
      'spec',
    );
    expect(withOptional.executor_model).toBe('vendor/model');
    expect(withOptional.cli_model).toBe('haiku');
    expect(withOptional.fork_concurrency).toBe(3);
    expect(withOptional.observe_concurrency).toBe(8);

    const bare = validateRunSpec(baseSpec(), 'spec');
    expect('executor_model' in bare).toBe(false);
    expect('cli_model' in bare).toBe(false);
    expect('fork_concurrency' in bare).toBe(false);
    expect('observe_concurrency' in bare).toBe(false);
  });

  test('rejects an empty executor_model', () => {
    expect(() => validateRunSpec({ ...baseSpec(), executor_model: '' }, 'spec')).toThrow(
      'executor_model must be a non-empty string when present',
    );
    expect(() => validateRunSpec({ ...baseSpec(), executor_model: '  ' }, 'spec')).toThrow(SpecError);
    expect(() => validateRunSpec({ ...baseSpec(), executor_model: 42 }, 'spec')).toThrow(SpecError);
  });

  test('rejects an empty cli_model', () => {
    expect(() => validateRunSpec({ ...baseSpec(), cli_model: '' }, 'spec')).toThrow(
      'cli_model must be a non-empty string when present',
    );
    expect(() => validateRunSpec({ ...baseSpec(), cli_model: 7 }, 'spec')).toThrow(SpecError);
  });

  test('rejects zero, negative and non-integer concurrency values', () => {
    for (const bad of [0, -1, 2.5, '4']) {
      expect(() => validateRunSpec({ ...baseSpec(), fork_concurrency: bad }, 'spec')).toThrow(
        'fork_concurrency must be a positive integer when present',
      );
      expect(() => validateRunSpec({ ...baseSpec(), observe_concurrency: bad }, 'spec')).toThrow(
        'observe_concurrency must be a positive integer when present',
      );
    }
  });
});
