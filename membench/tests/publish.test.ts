/**
 * Publish tests (plan Phase 7.2 + its verification list):
 *   - the bundle carries results/summary/scoreboard/spec/hashes and NO
 *     transcripts, diffs or fork trees
 *   - machine-local paths from manifest.json are redacted out
 *   - an existing bundle is never silently overwritten
 *   - the self-check REFUSES on a planted /Users/ path, a key-shaped token or
 *     a third-party email, and deletes the partial bundle
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishError, maskSecret, publishRun, scanTextForLeaks } from '../src/publish.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-publish-${name}-`));
}

interface RunDirOptions {
  /** Extra text spliced into a result row's drift_note (the leak plant). */
  plantedNote?: string;
  withSpecFile?: boolean;
  manifest?: 'valid' | 'missing';
}

/** A minimal but complete run dir, plus artifacts a bundle must NOT carry. */
function makeRunDir(options: RunDirOptions = {}): { runDir: string; specPath: string } {
  const base = tempDir('run');
  const runDir = join(base, 'runs', 'r1');
  mkdirSync(join(runDir, 'obs', 'it-1'), { recursive: true });
  mkdirSync(join(runDir, 'forks', 'it-1', 'none'), { recursive: true });

  const specPath = join(base, 'spec.toml');
  if (options.withSpecFile !== false) {
    writeFileSync(
      specPath,
      [
        'corpus_items = ["it-1"]',
        'observer_models = ["good"]',
        'executors = ["claude-cli"]',
        'k = 1',
        'observe_timeout_s = 30',
        'execute_timeout_s = 30',
        'judge_model = "judge/model"',
        'max_cost_usd = 1.0',
        'max_steps = 5',
        'max_cost_per_run_usd = 0.5',
      ].join('\n') + '\n',
    );
  }

  const rows = [
    {
      run_id: 'r1',
      item_id: 'it-1',
      variant: 'model:good',
      observer_model: 'good',
      executor: 'claude-cli',
      run_index: 0,
      success: true,
      tokens_in: 900,
      tokens_out: 100,
      tokens_total: 1000,
      cost_usd: 0.01,
      duration_s: 3,
      mem_search_calls: 1,
      drift_flag: false,
      judged: true,
      drift_note: options.plantedNote ?? 'stayed in scope',
    },
    {
      run_id: 'r1',
      item_id: 'it-1',
      variant: 'none',
      executor: 'claude-cli',
      run_index: 0,
      success: false,
      tokens_in: 1800,
      tokens_out: 200,
      tokens_total: 2000,
      cost_usd: 0.02,
      duration_s: 4,
      mem_search_calls: 0,
      drift_flag: false,
      judged: true,
    },
  ];
  writeFileSync(join(runDir, 'results.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

  writeFileSync(
    join(runDir, 'obs', 'it-1', 'good.json'),
    JSON.stringify({
      item_id: 'it-1',
      model: 'good',
      observations: [{ title: 'a' }],
      parse_notes: [],
      usage_notes: [],
      obs_tokens_in: 100,
      obs_tokens_out: 20,
      obs_cost_usd: 0.0004,
    }),
  );
  // Artifacts the bundle must never carry.
  writeFileSync(join(runDir, 'judge.jsonl'), JSON.stringify({ run_id: 'r1', cost_usd: 0.0001, raw: 'judge said things' }) + '\n');
  writeFileSync(join(runDir, 'forks', 'it-1', 'none', 'executor.diff'), 'diff --git a/x b/x\n');
  writeFileSync(join(runDir, 'forks', 'it-1', 'none', 'transcript.jsonl'), '{"type":"prompt"}\n');

  if (options.manifest === 'missing') return { runDir, specPath };
  writeFileSync(
    join(runDir, 'manifest.json'),
    JSON.stringify({
      run_id: 'r1',
      created_at: '2026-07-31T00:00:00.000Z',
      mock: false,
      spec_path: specPath,
      spec: {
        corpus_items: ['it-1'],
        observer_models: ['good'],
        executors: ['claude-cli'],
        k: 1,
        observe_timeout_s: 30,
        execute_timeout_s: 30,
        judge_model: 'judge/model',
        max_cost_usd: 1,
        max_steps: 5,
        max_cost_per_run_usd: 0.5,
      },
      // Machine-local absolute paths the bundle must redact away.
      corpus_dir: '/Users/somebody/MemBench/corpus',
      runs_dir: '/Users/somebody/MemBench/runs',
      items: [{ id: 'it-1', content_hash: 'abc123' }],
      variants: ['model:good', 'none', 'oracle', 'shuffled'],
      shuffled_source_map: { 'it-1': { donor_item: 'it-2', donor_source: 'oracle' } },
    }),
  );
  return { runDir, specPath };
}

describe('leak scanner', () => {
  test('flags machine paths, key shapes and third-party emails', () => {
    const hits = scanTextForLeaks(
      'x.jsonl',
      [
        'no problem here',
        'ran in /Users/someone/Scripts/thing',
        'key sk-or-v1-0123456789abcdef0123456789abcdef',
        'token ghp_0123456789abcdef0123456789abcdef',
        'aws AKIAIOSFODNN7EXAMPLE',
        'jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'Authorization: Bearer abcdefghijklmnopqrst',
        '-----BEGIN RSA PRIVATE KEY-----',
        'mail someone@gmail.com',
      ].join('\n'),
    );
    const patterns = hits.map((hit) => hit.pattern);
    expect(patterns).toContain('absolute /Users/ path');
    expect(patterns).toContain('OpenAI/OpenRouter-style API key');
    expect(patterns).toContain('GitHub token');
    expect(patterns).toContain('AWS access key id');
    expect(patterns).toContain('JWT / bearer JSON web token');
    expect(patterns).toContain('Authorization: Bearer token');
    expect(patterns).toContain('PEM key block');
    expect(patterns).toContain('third-party email address');
    expect(hits[0].line).toBe(2);
  });

  test('does not false-positive on ordinary text', () => {
    // "task-" contains "sk-"; the fixtures' example.invalid mail is allowlisted.
    const hits = scanTextForLeaks(
      'x.md',
      'the task-runner emailed membench@example.invalid about a risk-free ask-me-anything',
    );
    expect(hits).toEqual([]);
  });

  test('accepts the sanitizer placeholders but nothing else home-shaped', () => {
    // sanitize.ts rewrites the recording user's home to these; refusing them
    // would make every correctly sanitized run unpublishable.
    expect(scanTextForLeaks('x.jsonl', 'ran in /Users/user/Scripts/mini')).toEqual([]);
    expect(scanTextForLeaks('x.jsonl', 'under -Users-user-Scripts-mini/out')).toEqual([]);

    const other = scanTextForLeaks('x.jsonl', 'ran in /Users/anyoneelse/Scripts/mini');
    expect(other.map((hit) => hit.pattern)).toEqual(['absolute /Users/ path']);
    const encoded = scanTextForLeaks('x.jsonl', 'under -Users-anyoneelse-Scripts-mini');
    expect(encoded.map((hit) => hit.pattern)).toEqual(['encoded home path']);
    // A username that merely STARTS with the placeholder is still a leak.
    expect(scanTextForLeaks('x.jsonl', '-Users-username-Scripts')).toHaveLength(1);
  });

  test('catches a PGP PRIVATE KEY BLOCK header (parity with sanitize.ts v3)', () => {
    const hits = scanTextForLeaks('x.md', '-----BEGIN PGP PRIVATE KEY BLOCK-----');
    expect(hits.map((hit) => hit.pattern)).toEqual(['PEM key block']);
  });

  test('accepts sanitize.ts EMAIL_ALLOWLIST addresses, refuses other real ones', () => {
    // These three survive sanitization by design (repo owner's public address,
    // Anthropic's Co-Authored-By trailer, the git@github.com SSH remote).
    for (const allowed of ['thedotmack@gmail.com', 'noreply@anthropic.com', 'git@github.com']) {
      expect(scanTextForLeaks('x.jsonl', `contact ${allowed} about it`)).toEqual([]);
    }
    expect(scanTextForLeaks('x.jsonl', 'contact someone@gmail.com about it')).toHaveLength(1);
  });

  test('masks what it reports so a refusal never re-leaks the secret', () => {
    const secret = 'sk-or-v1-0123456789abcdef0123456789abcdef';
    const masked = maskSecret(secret);
    expect(masked).not.toContain('0123456789');
    expect(masked.startsWith('sk-o')).toBe(true);
  });
});

describe('publish bundle', () => {
  test('writes the redacted bundle and nothing else', async () => {
    const { runDir } = makeRunDir();
    const bundleDir = join(tempDir('bundle'), 'r1');
    const result = await publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} });

    expect(result.files.sort()).toEqual(
      ['README.md', 'corpus-hashes.json', 'results.jsonl', 'run-meta.json', 'run-spec.toml', 'scoreboard.md', 'summary.json'].sort(),
    );
    // No raw audit material.
    expect(existsSync(join(bundleDir, 'judge.jsonl'))).toBe(false);
    expect(existsSync(join(bundleDir, 'forks'))).toBe(false);
    expect(existsSync(join(bundleDir, 'obs'))).toBe(false);
    expect(existsSync(join(bundleDir, 'manifest.json'))).toBe(false);

    const meta = JSON.parse(await Bun.file(join(bundleDir, 'run-meta.json')).text()) as Record<string, unknown>;
    expect(meta.spec_path).toBeUndefined();
    expect(meta.corpus_dir).toBeUndefined();
    expect(meta.runs_dir).toBeUndefined();
    expect(meta.shuffled_source_map).toBeDefined();
    expect(JSON.stringify(meta)).not.toContain('/Users/');

    const hashes = JSON.parse(await Bun.file(join(bundleDir, 'corpus-hashes.json')).text()) as {
      items: Record<string, string>;
    };
    expect(hashes.items['it-1']).toBe('abc123');

    const scoreboard = await Bun.file(join(bundleDir, 'scoreboard.md')).text();
    expect(scoreboard).toContain('## Executor lane: `claude-cli`');
    const readme = await Bun.file(join(bundleDir, 'README.md')).text();
    expect(readme).toContain('OpenRouter');
  });

  test('refuses to overwrite an existing bundle', async () => {
    const { runDir } = makeRunDir();
    const bundleDir = join(tempDir('bundle'), 'r1');
    await publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} });
    const before = await Bun.file(join(bundleDir, 'results.jsonl')).text();

    await expect(publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} })).rejects.toThrow(
      /already exists/,
    );
    // The existing bundle is untouched.
    expect(await Bun.file(join(bundleDir, 'results.jsonl')).text()).toBe(before);
  });

  test('self-check REFUSES on a planted /Users/ path and cleans up the bundle', async () => {
    const { runDir } = makeRunDir({ plantedNote: 'agent wandered into /Users/someone/secrets while working' });
    const bundleDir = join(tempDir('bundle'), 'r1');
    let error: unknown;
    try {
      await publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PublishError);
    const message = (error as Error).message;
    expect(message).toContain('self-check FAILED');
    expect(message).toContain('absolute /Users/ path');
    expect(message).toContain('results.jsonl');
    // Partial output cleaned up: nothing half-published survives.
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('self-check REFUSES on a key-shaped token and cleans up the bundle', async () => {
    const { runDir } = makeRunDir({
      plantedNote: 'the agent echoed sk-or-v1-0123456789abcdef0123456789abcdef into the log',
    });
    const bundleDir = join(tempDir('bundle'), 'r1');
    let error: unknown;
    try {
      await publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} });
    } catch (caught: unknown) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PublishError);
    const message = (error as Error).message;
    expect(message).toContain('OpenAI/OpenRouter-style API key');
    // The refusal names the leak but does not repeat it.
    expect(message).not.toContain('0123456789abcdef0123456789abcdef');
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('self-check REFUSES on a third-party email', async () => {
    const { runDir } = makeRunDir({ plantedNote: 'contacted someone@gmail.com about the failure' });
    const bundleDir = join(tempDir('bundle'), 'r1');
    await expect(publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} })).rejects.toThrow(
      /third-party email address/,
    );
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('a sanitized /Users/user path publishes fine', async () => {
    const { runDir } = makeRunDir({ plantedNote: 'worked under /Users/user/Scripts/mini as recorded' });
    const bundleDir = join(tempDir('bundle'), 'r1');
    const result = await publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} });
    expect(result.files).toContain('results.jsonl');
    expect(existsSync(bundleDir)).toBe(true);
  });

  test('publishes without a spec file when the manifest no longer points at one', async () => {
    const { runDir } = makeRunDir({ withSpecFile: false });
    const bundleDir = join(tempDir('bundle'), 'r1');
    const logs: string[] = [];
    const result = await publishRun({
      runDir,
      runId: 'r1',
      bundleDir,
      log: (message) => logs.push(message),
      warn: () => {},
    });
    expect(result.files).not.toContain('run-spec.toml');
    expect(existsSync(join(bundleDir, 'run-spec.toml'))).toBe(false);
    expect(logs.join('\n')).toContain('the validated spec is still recorded in run-meta.json');
    // The spec is still reviewable — it just travels inside run-meta.json.
    const meta = JSON.parse(await Bun.file(join(bundleDir, 'run-meta.json')).text()) as { spec?: unknown };
    expect(meta.spec).toBeDefined();
    const readme = await Bun.file(join(bundleDir, 'README.md')).text();
    expect(readme).not.toContain('run-spec.toml');
  });

  test('refuses a run whose manifest is missing (provenance unknown)', async () => {
    const { runDir } = makeRunDir({ manifest: 'missing' });
    const bundleDir = join(tempDir('bundle'), 'r1');
    await expect(publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} })).rejects.toThrow(
      /no readable manifest\.json/,
    );
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('refuses a path-traversing run id before touching the filesystem', async () => {
    const { runDir } = makeRunDir();
    const parent = tempDir('bundle');
    const bundleDir = join(parent, '..', 'escape');
    await expect(
      publishRun({ runDir, runId: '../escape', bundleDir, log: () => {}, warn: () => {} }),
    ).rejects.toThrow(/invalid --run-id/);
    expect(existsSync(bundleDir)).toBe(false);
  });

  test('refuses a run with no results.jsonl', async () => {
    const runDir = join(tempDir('bare'), 'runs', 'r1');
    mkdirSync(runDir, { recursive: true });
    const bundleDir = join(tempDir('bundle'), 'r1');
    await expect(publishRun({ runDir, runId: 'r1', bundleDir, log: () => {}, warn: () => {} })).rejects.toThrow(
      /no results\.jsonl/,
    );
    expect(existsSync(bundleDir)).toBe(false);
  });
});
