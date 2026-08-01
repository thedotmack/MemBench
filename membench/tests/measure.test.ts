/**
 * Unit tests for stage 4 measurement (src/measure.ts) — plan Phase 6.3.
 * Offline: check.sh runs are real local bash, and the judge transport is a
 * stub QueryModelFn. No network.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JUDGE_PROMPT_MARKER,
  buildJudgePrompt,
  callJudge,
  measureRun,
  parseJudgeReply,
  runCheckScript,
} from '../src/measure.ts';
import type { QueryModelFn } from '../src/observe-runner.ts';
import type { CorpusItem } from '../src/types.ts';

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-measure-${name}-`));
}

/** A corpus-item-shaped dir with the given check.sh (and optional rubric). */
function makeItem(checkScript: string, rubric?: string): CorpusItem {
  const dir = tempDir('item');
  writeFileSync(join(dir, 'check.sh'), checkScript);
  if (rubric !== undefined) writeFileSync(join(dir, 'success.md'), rubric);
  return { id: 'measure-fixture', dir };
}

function makeFork(): { repoDir: string; homeDir: string; diffPath: string } {
  const forkDir = tempDir('fork');
  const repoDir = join(forkDir, 'repo');
  const homeDir = join(forkDir, 'home');
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  return { repoDir, homeDir, diffPath: join(forkDir, 'executor.diff') };
}

const DIFF = 'diff --git a/a.md b/a.md\n+++ b/a.md\n@@\n+hello\n';

describe('parseJudgeReply', () => {
  test('parses a bare JSON verdict', () => {
    expect(parseJudgeReply('{"drift": true, "note": "touched unrelated files"}')).toEqual({
      drift: true,
      note: 'touched unrelated files',
    });
  });

  test('parses a fenced JSON verdict', () => {
    const verdict = parseJudgeReply('```json\n{"drift": false, "note": "in scope", "success": true}\n```');
    expect(verdict).toEqual({ drift: false, note: 'in scope', success: true });
  });

  test('parses JSON embedded in prose', () => {
    const verdict = parseJudgeReply('Here is my verdict:\n{"drift": false, "note": "ok"}\nHope that helps.');
    expect(verdict).toEqual({ drift: false, note: 'ok' });
  });

  test('returns undefined for malformed replies and non-verdict JSON', () => {
    expect(parseJudgeReply('the agent stayed in scope')).toBeUndefined();
    expect(parseJudgeReply('{"note": "no drift field"}')).toBeUndefined();
    expect(parseJudgeReply('{"drift": "yes"}')).toBeUndefined(); // wrong type
    expect(parseJudgeReply('')).toBeUndefined();
  });

  test('tolerates a missing note but keeps the boolean', () => {
    expect(parseJudgeReply('{"drift": true}')).toEqual({ drift: true, note: '' });
  });
});

describe('buildJudgePrompt', () => {
  const base = { taskMd: 'Fix the counter', diff: DIFF, executorOutput: 'done' };

  test('omits the rubric and the success field when the check decided mechanically', () => {
    const prompt = buildJudgePrompt(base);
    expect(prompt).toContain(JUDGE_PROMPT_MARKER);
    expect(prompt).toContain('Fix the counter');
    expect(prompt).toContain(DIFF);
    expect(prompt).not.toContain('SUCCESS RUBRIC');
    expect(prompt).toContain('{"drift": true|false, "note": "<one sentence>"}');
  });

  test('includes the rubric and asks for success when one is supplied', () => {
    const prompt = buildJudgePrompt({ ...base, rubric: 'RUBRIC-MARKER pass requires X' });
    expect(prompt).toContain('=== SUCCESS RUBRIC ===');
    expect(prompt).toContain('RUBRIC-MARKER pass requires X');
    expect(prompt).toContain('"success": true|false');
  });

  test('renders empty diff/output placeholders instead of blank sections', () => {
    const prompt = buildJudgePrompt({ taskMd: 'task', diff: '', executorOutput: '' });
    expect(prompt).toContain('(empty diff)');
    expect(prompt).toContain('(no output)');
  });
});

describe('runCheckScript', () => {
  test('runs check.sh from the fork repo root and returns its exit code', async () => {
    const item = makeItem('#!/usr/bin/env bash\n[ -f marker.txt ] && exit 0\nexit 1\n');
    const fork = makeFork();
    const fail = await runCheckScript(item, fork.repoDir, fork.homeDir);
    expect(fail.exitCode).toBe(1);
    expect(fail.outcome).toBe('exit');

    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    const pass = await runCheckScript(item, fork.repoDir, fork.homeDir);
    expect(pass.exitCode).toBe(0);
  });

  test('cwd is the fork repo and HOME is the fork home', async () => {
    const item = makeItem('#!/usr/bin/env bash\necho "cwd=$PWD home=$HOME"\nexit 0\n');
    const fork = makeFork();
    const result = await runCheckScript(item, fork.repoDir, fork.homeDir);
    // realpathSync: macOS resolves $TMPDIR through the /private symlink.
    expect(result.stdout).toContain(`cwd=${realpathSync(fork.repoDir)}`);
    expect(result.stdout).toContain(`home=${fork.homeDir}`);
  });

  test('a hanging check is killed at the timeout and reported, never hung', async () => {
    const item = makeItem('#!/usr/bin/env bash\nsleep 30\n');
    const fork = makeFork();
    const started = Date.now();
    const result = await runCheckScript(item, fork.repoDir, fork.homeDir, 500);
    expect(result.outcome).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  test('a missing check.sh is a spawn-error, not a throw', async () => {
    const fork = makeFork();
    const result = await runCheckScript({ id: 'x', dir: tempDir('empty') }, fork.repoDir, fork.homeDir);
    expect(result.outcome).toBe('spawn-error');
    expect(result.stderr).toContain('check.sh not found');
  });
});

describe('callJudge', () => {
  test('marks a completed-but-unparseable call as called with no verdict', async () => {
    const query: QueryModelFn = async () => ({ content: 'I think it is fine', costUsd: 0.001 });
    const result = await callJudge('judge/model', { taskMd: 't', diff: DIFF, executorOutput: 'o' }, { query });
    expect(result.called).toBe(true);
    expect(result.verdict).toBeUndefined();
    expect(result.cost_usd).toBe(0.001);
  });

  test('marks a thrown call as NOT called, with no cost recorded', async () => {
    const query: QueryModelFn = async () => {
      throw new Error('transport exploded');
    };
    const result = await callJudge('judge/model', { taskMd: 't', diff: DIFF, executorOutput: 'o' }, { query });
    expect(result.called).toBe(false);
    expect(result.cost_usd).toBeNull();
    expect(result.error).toContain('transport exploded');
  });
});

describe('measureRun', () => {
  const PASS_CHECK = '#!/usr/bin/env bash\n[ -f marker.txt ] && exit 0\nexit 1\n';
  const JUDGE_CHECK = '#!/usr/bin/env bash\n[ -f marker.txt ] && exit 3\nexit 1\n';

  function verdictQuery(verdict: Record<string, unknown>): QueryModelFn {
    return async () => ({ content: JSON.stringify(verdict), costUsd: 0.0002, inputTokens: 10, outputTokens: 5 });
  }

  test('mechanical pass + non-empty diff → judge decides drift only', async () => {
    const item = makeItem(PASS_CHECK);
    const fork = makeFork();
    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    writeFileSync(fork.diffPath, DIFF);
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: 'out',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: verdictQuery({ drift: true, note: 'refactored an unrelated module' }),
    });
    expect(result.success).toBe(true);
    expect(result.drift_flag).toBe(true);
    expect(result.judged).toBe(true);
    expect(result.judge_cost_usd).toBe(0.0002);
    expect(result.drift_note).toContain('unrelated module');
  });

  test('empty diff + decided check → no judge call at all', async () => {
    const item = makeItem(PASS_CHECK);
    const fork = makeFork();
    writeFileSync(fork.diffPath, '');
    let calls = 0;
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: '',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: async () => {
        calls += 1;
        return { content: '{"drift": false, "note": ""}' };
      },
    });
    expect(calls).toBe(0);
    expect(result.judged).toBe(false);
    expect(result.drift_flag).toBe(false); // provably no out-of-scope work
    expect(result.success).toBe(false); // no marker file
    expect(result.drift_note).toContain('no diff');
  });

  test('CHECK_EXIT_JUDGE → the rubric is sent and the judge decides success', async () => {
    const item = makeItem(JUDGE_CHECK, 'RUBRIC-MARKER: pass when the doc exists');
    const fork = makeFork();
    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    writeFileSync(fork.diffPath, DIFF);
    let seenPrompt = '';
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: 'out',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: async (_model, messages) => {
        seenPrompt = String(messages[0].content);
        return { content: '{"drift": false, "note": "in scope", "success": true}' };
      },
    });
    expect(result.check_exit).toBe(3);
    expect(seenPrompt).toContain('RUBRIC-MARKER');
    expect(result.success).toBe(true);
    expect(result.drift_flag).toBe(false);
    expect(result.judged).toBe(true);
  });

  test('judge transport failure → judged false, drift UNKNOWN, gated success denied', async () => {
    const item = makeItem(JUDGE_CHECK, 'rubric');
    const fork = makeFork();
    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    writeFileSync(fork.diffPath, DIFF);
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: 'out',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: async () => {
        throw new Error('judge down');
      },
    });
    expect(result.judged).toBe(false);
    expect(result.drift_flag).toBeNull();
    expect(result.success).toBe(false);
    expect(result.judge_cost_usd).toBeNull();
    expect(result.drift_note).toContain('judge unavailable');
  });

  test('unparseable judge reply → judged true (it was paid for), drift UNKNOWN', async () => {
    const item = makeItem(PASS_CHECK);
    const fork = makeFork();
    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    writeFileSync(fork.diffPath, DIFF);
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: 'out',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: async () => ({ content: 'no json here', costUsd: 0.0001 }),
    });
    expect(result.judged).toBe(true);
    expect(result.drift_flag).toBeNull();
    expect(result.judge_cost_usd).toBe(0.0001);
    expect(result.success).toBe(true); // the mechanical check still decided
  });

  test('judge-gated item with no success.md → success denied, drift unknown, no call', async () => {
    const item = makeItem(JUDGE_CHECK); // no rubric written
    const fork = makeFork();
    writeFileSync(join(fork.repoDir, 'marker.txt'), 'x');
    writeFileSync(fork.diffPath, DIFF);
    let calls = 0;
    const result = await measureRun({
      item,
      repoDir: fork.repoDir,
      homeDir: fork.homeDir,
      taskMd: 'task',
      executorOutput: 'out',
      diffPath: fork.diffPath,
      judgeModel: 'judge/model',
      query: async () => {
        calls += 1;
        return { content: '{"drift": false, "note": ""}' };
      },
    });
    expect(calls).toBe(0);
    expect(result.success).toBe(false);
    expect(result.judged).toBe(false);
    expect(result.drift_flag).toBeNull();
    expect(result.drift_note).toContain('success.md');
  });
});
