import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeContentHash,
  listItems,
  type ToolCallRecord,
  type TranscriptRow,
} from '../src/corpus-item.ts';
import {
  CorpusBuildError,
  buildItem,
  extractToolCalls,
  filterTranscriptRows,
  freezeItem,
  listCandidates,
  mineCommitSha,
  pinRepo,
  resanitizeItem,
  resolveBuildInputs,
  transcriptIndex,
  type GitRunner,
} from '../src/corpus.ts';
import { SANITIZER_VERSION, sanitizeString, type Redaction } from '../src/sanitize.ts';

const FIXTURE = join(import.meta.dir, 'fixtures', 'fixture-transcript.jsonl');
const FAKE_SHA = '1111111111111111111111111111111111111111';
const MINED_SHA = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
const RAW_SK = 'sk-or-v1-XXXXsecretsecretsecret';

function fixtureRows(): TranscriptRow[] {
  return readFileSync(FIXTURE, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TranscriptRow);
}

function tempDir(name: string): string {
  return mkdtempSync(join(tmpdir(), `membench-corpus-${name}-`));
}

/** git runner that pins successfully via git log. */
const happyGit: GitRunner = (args) => {
  if (args.includes('remote')) return { ok: true, stdout: 'https://github.com/example/demo.git' };
  if (args.includes('log')) return { ok: true, stdout: FAKE_SHA };
  return { ok: false, stdout: '' };
};

/** git runner where the branch is gone: remote works, log fails → SHA mining. */
const logFailGit: GitRunner = (args) => {
  if (args.includes('remote')) return { ok: true, stdout: 'https://github.com/example/demo.git' };
  return { ok: false, stdout: '' };
};

/** git runner where the cwd is gone entirely. */
const deadGit: GitRunner = () => ({ ok: false, stdout: '' });

function build(outDir: string, git: GitRunner = happyGit) {
  return buildItem({
    transcriptPath: FIXTURE,
    outDir,
    meta: {
      sessionId: 'fixture-n',
      projectSlug: 'demo',
      nextSessionId: 'fixture-n-plus-1',
      nextSessionStarted: '2026-01-01T12:00:00.000Z',
      taskSource: 'user_prompts',
    },
    taskPrompt: 'Make the retry backoff deterministic in /Users/alexnewman/Scripts/demo and fix the flaky test',
    git,
  });
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

/** Replace the builder's stub/draft files with clean, marker-free content. */
function fillStubs(dir: string): void {
  writeFileSync(join(dir, 'task.md'), 'Make the retry backoff deterministic and fix the flaky test\n');
  writeFileSync(join(dir, 'check.sh'), '#!/usr/bin/env bash\nbun test tests/retry.test.ts\n');
  writeFileSync(join(dir, 'success.md'), 'Mechanical check only — no rubric needed.\n');
  writeFileSync(join(dir, 'oracle.md'), 'The backoff constant lives in src/retry.ts; the test must stub the timer.\n');
}

describe('filterTranscriptRows', () => {
  test('keeps metadata/human/tool-result/assistant rows, drops snapshots and non-human user rows', () => {
    const rows = fixtureRows();
    expect(rows.length).toBe(15);
    const kept = filterTranscriptRows(rows);
    expect(kept.length).toBe(13);
    expect(kept.some((row) => row.type === 'file-history-snapshot')).toBe(false);
    expect(kept.some((row) => row.origin?.kind === 'task-notification')).toBe(false);
    // Both human rows, all 6 assistant rows, both tool-result rows, and the metadata rows survive.
    expect(kept.filter((row) => row.type === 'user' && row.origin?.kind === 'human').length).toBe(2);
    expect(kept.filter((row) => row.type === 'user' && row.sourceToolAssistantUUID).length).toBe(2);
    expect(kept.filter((row) => row.type === 'assistant').length).toBe(6);
    expect(kept.some((row) => row.type === 'ai-title')).toBe(true);
    expect(kept.some((row) => row.type === 'mode')).toBe(true);
  });
});

describe('extractToolCalls', () => {
  test('joins tool_use blocks to tool-result rows via sourceToolAssistantUUID + tool_use_id', () => {
    const calls = extractToolCalls(filterTranscriptRows(fixtureRows()));
    expect(calls.length).toBe(3);

    const [bash, read, interrupted] = calls;
    expect(bash.tool_name).toBe('Bash');
    expect((bash.tool_input as { command: string }).command).toContain('git rev-parse');
    expect((bash.tool_output as { stdout: string }).stdout).toContain(RAW_SK);
    expect(bash.created_at_epoch).toBe(Date.parse('2026-01-01T10:00:25.000Z'));
    expect(bash.cwd).toBe('/Users/alexnewman/Scripts/demo');

    expect(read.tool_name).toBe('Read');
    expect((read.tool_output as { file: { content: string } }).file.content).toContain('backoff');

    // toolu_3 never got a result row (interrupted) — still emitted, output null.
    expect(interrupted.tool_name).toBe('Bash');
    expect(interrupted.tool_output).toBeNull();
    expect(interrupted.created_at_epoch).toBe(Date.parse('2026-01-01T10:01:10.000Z'));
  });

  test('parallel tool_use blocks with one surviving result do not mispair', () => {
    const rows: TranscriptRow[] = [
      {
        type: 'assistant',
        uuid: 'asst-par',
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: '/repo',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-a', name: 'Read', input: { file_path: 'a.ts' } },
            { type: 'tool_use', id: 'tu-b', name: 'Read', input: { file_path: 'b.ts' } },
          ],
        },
      },
      {
        type: 'user',
        uuid: 'res-a',
        sourceToolAssistantUUID: 'asst-par',
        timestamp: '2026-01-01T10:00:05.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-a', content: 'A' }] },
        toolUseResult: { type: 'text', file: { content: 'A' } },
      },
    ];
    const calls = extractToolCalls(rows);
    expect(calls.length).toBe(2);
    expect(calls[0].tool_output).toEqual({ type: 'text', file: { content: 'A' } });
    // tu-b's result is gone: the identifiable single candidate belongs to
    // tu-a, so tu-b must NOT inherit it.
    expect(calls[1].tool_output).toBeNull();
  });

  test('single result row with unmatchable shape (string content) still pairs via fallback', () => {
    const rows: TranscriptRow[] = [
      {
        type: 'assistant',
        uuid: 'asst-str',
        timestamp: '2026-01-01T10:00:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-x', name: 'Bash', input: { command: 'true' } }],
        },
      },
      {
        type: 'user',
        uuid: 'res-x',
        sourceToolAssistantUUID: 'asst-str',
        timestamp: '2026-01-01T10:00:05.000Z',
        message: { role: 'user', content: 'plain string result' },
        toolUseResult: { stdout: 'ok', stderr: '' },
      },
    ];
    const calls = extractToolCalls(rows);
    expect(calls.length).toBe(1);
    expect(calls[0].tool_output).toEqual({ stdout: 'ok', stderr: '' });
  });
});

describe('pinRepo', () => {
  test('pins via git log --until on the recorded cwd and branch', () => {
    const { lock, realCwd } = pinRepo(filterTranscriptRows(fixtureRows()), happyGit);
    expect(lock).toEqual({ url: 'https://github.com/example/demo.git', commit: FAKE_SHA, branch: 'main' });
    expect(realCwd).toBe('/Users/alexnewman/Scripts/demo');
  });

  test('falls back to mining Bash stdout for a 40-hex SHA when git log fails', () => {
    expect(mineCommitSha(fixtureRows())).toBe(MINED_SHA);
    const { lock } = pinRepo(filterTranscriptRows(fixtureRows()), logFailGit);
    expect(lock.commit).toBe(MINED_SHA);
  });

  test('rejects when neither git nor mined SHAs can pin the repo', () => {
    expect(() => pinRepo(filterTranscriptRows(fixtureRows()), deadGit)).toThrow(CorpusBuildError);
  });
});

describe('buildItem', () => {
  test('emits all item files with filtered rows, joined tool calls, and sanitized content', async () => {
    const outDir = tempDir('build');
    const summary = await build(outDir);

    for (const name of [
      'transcript.jsonl',
      'toolcalls.jsonl',
      'repo.lock',
      'task.md',
      'check.sh',
      'success.md',
      'oracle.md',
      'provenance.json',
      'sanitization-report.md',
    ]) {
      expect(statSync(join(outDir, name)).isFile()).toBe(true);
    }
    expect(summary.rowsTotal).toBe(15);
    expect(summary.rowsKept).toBe(13);
    expect(summary.toolCalls).toBe(3);

    const transcript = readFileSync(join(outDir, 'transcript.jsonl'), 'utf-8');
    expect(transcript.trim().split('\n').length).toBe(13);
    expect(transcript).toContain('[REDACTED:sk-key]');
    expect(transcript).toContain('/Users/user/Scripts/demo');
    expect(transcript).toContain('Bearer [REDACTED:token]');
    expect(transcript).toContain('[REDACTED:jwt]');
    expect(transcript).not.toContain(RAW_SK);
    // v2: third-party emails and extra-strings names are redacted; the
    // allowlisted emails survive verbatim.
    expect(transcript).toContain('[REDACTED:email]');
    expect(transcript).not.toContain('jorge.rebuffo@example.com');
    expect(transcript).toContain('[REDACTED:name]');
    expect(transcript).not.toContain('Jorge Rebuffo');
    expect(transcript).toContain('thedotmack@gmail.com');
    expect(transcript).toContain('noreply@anthropic.com');

    const toolcalls = readFileSync(join(outDir, 'toolcalls.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ToolCallRecord);
    expect(toolcalls.length).toBe(3);
    expect((toolcalls[0].tool_output as { stdout: string }).stdout).toContain('[REDACTED:sk-key]');
    expect(toolcalls[0].cwd).toBe('/Users/user/Scripts/demo');

    const lock = JSON.parse(readFileSync(join(outDir, 'repo.lock'), 'utf-8'));
    expect(lock).toEqual({
      url: 'https://github.com/example/demo.git',
      commit: FAKE_SHA,
      branch: 'main',
      cwd_at_recording: '/Users/user/Scripts/demo',
    });

    const task = readFileSync(join(outDir, 'task.md'), 'utf-8');
    expect(task).toContain('MEMBENCH:DRAFT');
    expect(task).toContain('Make the retry backoff deterministic in /Users/user/Scripts/demo');

    const provenance = JSON.parse(readFileSync(join(outDir, 'provenance.json'), 'utf-8'));
    expect(provenance.content_session_id).toBe('fixture-n');
    expect(provenance.session_n_plus_1_id).toBe('fixture-n-plus-1');
    expect(provenance.sanitizer_version).toBe(SANITIZER_VERSION);
    expect(provenance.content_hash).toBeNull();
    expect(provenance.dates.session_n_started).toBe('2026-01-01T10:00:00.000Z');
    expect(provenance.dates.session_n_ended).toBe('2026-01-01T10:02:00.000Z');

    // Guard 10: no emitted file may mention the real username — report included.
    for (const path of walk(outDir)) {
      expect(readFileSync(path, 'utf-8')).not.toContain('alexnewman');
    }

    const report = readFileSync(join(outDir, 'sanitization-report.md'), 'utf-8');
    expect(report).toContain('sk-key');
    expect(report).toContain('username');
    expect(report).toContain('bearer-token');
    expect(report).toContain('jwt');
    expect(report).not.toContain(RAW_SK);
    const ruleNames = new Set(summary.redactions.map((entry) => entry.rule));
    expect(ruleNames.has('sk-key')).toBe(true);
    expect(ruleNames.has('username')).toBe(true);
  });

  test('building the same session twice reproduces identical content hashes', async () => {
    const dirA = tempDir('hash-a');
    const dirB = tempDir('hash-b');
    await build(dirA);
    await build(dirB);
    expect(await computeContentHash(dirA)).toBe(await computeContentHash(dirB));
  });
});

describe('freezeItem', () => {
  test('refuses while TODO/DRAFT markers remain', async () => {
    const outDir = tempDir('freeze-markers');
    await build(outDir);
    await expect(freezeItem(outDir)).rejects.toThrow(/MEMBENCH:TODO|markers remain/);
  });

  test('refuses when "alexnewman" appears in any file (guard 10)', async () => {
    const outDir = tempDir('freeze-username');
    await build(outDir);
    fillStubs(outDir);
    writeFileSync(join(outDir, 'oracle.md'), 'Notes referencing /Users/alexnewman/Scripts/demo\n');
    await expect(freezeItem(outDir)).rejects.toThrow(/alexnewman/);
  });

  test('freezes deterministically and idempotently once markers are gone', async () => {
    const outDir = tempDir('freeze-ok');
    await build(outDir);
    fillStubs(outDir);

    const first = await freezeItem(outDir);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.unchanged).toBe(false);

    const second = await freezeItem(outDir);
    expect(second.hash).toBe(first.hash);
    expect(second.unchanged).toBe(true);

    const provenance = JSON.parse(readFileSync(join(outDir, 'provenance.json'), 'utf-8'));
    expect(provenance.content_hash).toBe(first.hash);

    const listed = await listItems(join(outDir, '..'));
    const item = listed.find((entry) => entry.id === outDir.split('/').pop());
    expect(item?.complete).toBe(true);
    expect(item?.frozen).toBe(true);
  });

  test('refuses to re-freeze when content changed after freezing (append-only corpus)', async () => {
    const outDir = tempDir('freeze-mutate');
    await build(outDir);
    fillStubs(outDir);
    await freezeItem(outDir);
    writeFileSync(join(outDir, 'oracle.md'), 'Different notes now.\n');
    await expect(freezeItem(outDir)).rejects.toThrow(/append-only/);
  });

  test('build refuses to overwrite a frozen item', async () => {
    const outDir = tempDir('build-frozen');
    await build(outDir);
    fillStubs(outDir);
    await freezeItem(outDir);
    await expect(build(outDir)).rejects.toThrow(/append-only/);
  });
});

/**
 * Temp fixture DB (never the live one) with the two tables the candidate
 * queries read. Projects: "demo" (s1→s2→s3), "other" (o1, epoch between
 * s1/s2 — proves LEAD partition isolation), "tie" (t1/t2 at the same epoch —
 * proves the `, id` tie-break).
 */
function makeFixtureDb(dir: string): string {
  const path = join(dir, 'fixture.db');
  const db = new Database(path);
  db.run(
    'CREATE TABLE sdk_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, ' +
      'project TEXT NOT NULL, started_at TEXT NOT NULL, started_at_epoch INTEGER NOT NULL)',
  );
  db.run(
    'CREATE TABLE user_prompts (id INTEGER PRIMARY KEY AUTOINCREMENT, content_session_id TEXT NOT NULL, ' +
      'prompt_number INTEGER NOT NULL, prompt_text TEXT NOT NULL)',
  );
  const insert = db.prepare(
    'INSERT INTO sdk_sessions (content_session_id, project, started_at, started_at_epoch) VALUES (?, ?, ?, ?)',
  );
  insert.run('s1', 'demo', '2026-01-01T10:00:00.000Z', 100);
  insert.run('s2', 'demo', '2026-01-01T11:00:00.000Z', 200);
  insert.run('s3', 'demo', '2026-01-01T12:00:00.000Z', 300);
  insert.run('o1', 'other', '2026-01-01T10:30:00.000Z', 150);
  insert.run('t1', 'tie', '2026-01-01T09:00:00.000Z', 500);
  insert.run('t2', 'tie', '2026-01-01T09:00:00.000Z', 500);
  db.prepare('INSERT INTO user_prompts (content_session_id, prompt_number, prompt_text) VALUES (?, ?, ?)').run(
    's2',
    1,
    'next task for s2',
  );
  db.close();
  return path;
}

/** On-disk transcripts for s1, s2, t1, t2 (t2 with a human turn — the task fallback). */
function makeFixtureProjects(dir: string): string {
  const projectsDir = join(dir, 'projects');
  const demo = join(projectsDir, '-Users-user-demo');
  const tie = join(projectsDir, '-Users-user-tie');
  mkdirSync(demo, { recursive: true });
  mkdirSync(tie, { recursive: true });
  writeFileSync(join(demo, 's1.jsonl'), '{"type":"system","sessionId":"s1"}\n');
  writeFileSync(join(demo, 's2.jsonl'), '{"type":"system","sessionId":"s2"}\n');
  writeFileSync(join(tie, 't1.jsonl'), '{"type":"system","sessionId":"t1"}\n');
  writeFileSync(
    join(tie, 't2.jsonl'),
    JSON.stringify({
      type: 'user',
      origin: { kind: 'human' },
      message: { role: 'user', content: 'tie task from transcript' },
      sessionId: 't2',
    }) + '\n',
  );
  return projectsDir;
}

describe('candidate queries against a fixture DB', () => {
  test('LEAD partitioning pairs N->N+1 per project, joins on-disk transcripts, breaks epoch ties by id', async () => {
    const dir = tempDir('db');
    const dbPath = makeFixtureDb(dir);
    const projectsDir = makeFixtureProjects(dir);

    const candidates = await listCandidates({ dbPath, projectsDir });
    const byN = new Map(candidates.map((pair) => [pair.session_n, pair]));

    // demo: s1→s2 (NOT s1→o1 — partitions are isolated) with the DB prompt.
    expect(byN.get('s1')?.session_n_plus_1).toBe('s2');
    expect(byN.get('s1')?.task_source).toBe('user_prompts');
    expect(byN.get('s1')?.task_preview).toContain('next task for s2');
    // s2→s3: s3 has no prompt row and no transcript — listed, but no task source.
    expect(byN.get('s2')?.session_n_plus_1).toBe('s3');
    expect(byN.get('s2')?.task_source).toBeNull();
    // Last session of each project is never a session_n; o1 is alone.
    expect(byN.has('s3')).toBe(false);
    expect(byN.has('o1')).toBe(false);
    expect(byN.has('t2')).toBe(false);
    // tie: same epoch — id order decides t1→t2; task falls back to t2's transcript.
    expect(byN.get('t1')?.session_n_plus_1).toBe('t2');
    expect(byN.get('t1')?.task_source).toBe('transcript');
    expect(candidates.length).toBe(3);
  });

  test('resolveBuildInputs resolves the pair and task; rejects last-session and missing task source', async () => {
    const dir = tempDir('db-resolve');
    const dbPath = makeFixtureDb(dir);
    const projectsDir = makeFixtureProjects(dir);

    const inputs = await resolveBuildInputs('s1', { dbPath, projectsDir });
    expect(inputs.projectSlug).toBe('demo');
    expect(inputs.nextSessionId).toBe('s2');
    expect(inputs.taskPrompt).toBe('next task for s2');
    expect(inputs.taskSource).toBe('user_prompts');

    // s3 is the last session of "demo" — no N+1, no hindsight task.
    await expect(resolveBuildInputs('s3', { dbPath, projectsDir })).rejects.toThrow(/last session/);
    // s2's N+1 (s3) has neither a prompt row nor a transcript.
    await expect(resolveBuildInputs('s2', { dbPath, projectsDir })).rejects.toThrow(/no task source/);
  });
});

describe('buildItem edge cases', () => {
  test('a transcript with zero tool calls builds fine', async () => {
    const dir = tempDir('zero-tools');
    const transcriptPath = join(dir, 'zero.jsonl');
    const rows = [
      {
        type: 'user',
        origin: { kind: 'human' },
        message: { role: 'user', content: 'hello' },
        uuid: 'u1',
        timestamp: '2026-01-01T10:00:00.000Z',
        cwd: '/Users/alexnewman/Scripts/demo',
        gitBranch: 'main',
        sessionId: 'zero',
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        uuid: 'a1',
        timestamp: '2026-01-01T10:01:00.000Z',
        cwd: '/Users/alexnewman/Scripts/demo',
        gitBranch: 'main',
        sessionId: 'zero',
      },
    ];
    writeFileSync(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const outDir = join(dir, 'out');
    const summary = await buildItem({
      transcriptPath,
      outDir,
      meta: {
        sessionId: 'zero',
        projectSlug: 'demo',
        nextSessionId: 'zero-plus-1',
        nextSessionStarted: null,
        taskSource: 'user_prompts',
      },
      taskPrompt: 'follow-up task',
      git: happyGit,
    });
    expect(summary.toolCalls).toBe(0);
    expect(summary.rowsKept).toBe(2);
    expect(statSync(join(outDir, 'toolcalls.jsonl')).isFile()).toBe(true);
    expect(readFileSync(join(outDir, 'toolcalls.jsonl'), 'utf-8').trim()).toBe('');
  });
});

describe('resanitizeItem', () => {
  test('re-sanitizes machine files in place, leaves hand-authored files alone, clears the frozen hash', async () => {
    const outDir = tempDir('resan');
    await build(outDir);
    fillStubs(outDir);

    // Simulate PII that an older sanitizer version missed: splice a row with a
    // third-party email and an extra-strings name into the built transcript.
    const transcriptPath = join(outDir, 'transcript.jsonl');
    const leakedRow = JSON.stringify({
      type: 'system',
      subtype: 'info',
      content: 'contact chenglin.test@gmail.com or Jorge Rebuffo about the invoice',
      uuid: 'sys-leak',
      sessionId: 'fixture-n',
    });
    writeFileSync(transcriptPath, readFileSync(transcriptPath, 'utf-8') + leakedRow + '\n');
    const frozen = await freezeItem(outDir);

    const handAuthored = ['task.md', 'check.sh', 'success.md', 'oracle.md'];
    const before = handAuthored.map((name) => readFileSync(join(outDir, name), 'utf-8'));

    const summary = await resanitizeItem(outDir);
    expect(summary.clearedHash).toBe(frozen.hash);
    expect(summary.redactions.length).toBeGreaterThan(0);

    const transcript = readFileSync(transcriptPath, 'utf-8');
    expect(transcript).not.toContain('chenglin.test@gmail.com');
    expect(transcript).not.toContain('Jorge Rebuffo');
    expect(transcript).toContain('[REDACTED:email]');
    expect(transcript).toContain('[REDACTED:name]');

    // Hand-authored files are byte-identical.
    expect(handAuthored.map((name) => readFileSync(join(outDir, name), 'utf-8'))).toEqual(before);

    const provenance = JSON.parse(readFileSync(join(outDir, 'provenance.json'), 'utf-8'));
    expect(provenance.sanitizer_version).toBe(SANITIZER_VERSION);
    expect(provenance.content_hash).toBeNull();

    const report = readFileSync(join(outDir, 'sanitization-report.md'), 'utf-8');
    expect(report).toContain('Re-sanitization pass');
    expect(report).not.toContain('chenglin.test@gmail.com');

    // Re-freezing works and produces a different hash (content changed).
    const refrozen = await freezeItem(outDir);
    expect(refrozen.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(refrozen.hash).not.toBe(frozen.hash);
  });
});

describe('transcriptIndex', () => {
  test('maps filename stems to paths and excludes the observer-sessions dir', () => {
    const projectsDir = tempDir('projects');
    const projectA = join(projectsDir, '-Users-user-Scripts-demo');
    const observer = join(projectsDir, '-Users-alexnewman--claude-mem-observer-sessions');
    mkdirSync(projectA, { recursive: true });
    mkdirSync(join(projectA, 'aaaa-1111'), { recursive: true }); // session subdir — not a transcript
    mkdirSync(observer, { recursive: true });
    writeFileSync(join(projectA, 'aaaa-1111.jsonl'), '{}\n');
    writeFileSync(join(observer, 'bbbb-2222.jsonl'), '{}\n');

    const index = transcriptIndex(projectsDir);
    expect(index.get('aaaa-1111')).toBe(join(projectA, 'aaaa-1111.jsonl'));
    expect(index.has('bbbb-2222')).toBe(false);
    expect(index.size).toBe(1);
  });
});

describe('sanitizeString', () => {
  test('redacts every key shape on the guard-10 list', () => {
    const report: Redaction[] = [];
    const input = [
      'openai sk-abcdefgh12345678',
      'github ghp_ABCDEFGHIJKLMNOP1234',
      'oauth gho_ABCDEFGHIJKLMNOP1234',
      'server ghs_ABCDEFGHIJKLMNOP1234',
      'pat github_pat_ABCDEFGHIJKLMNOPQRSTU123',
      'aws AKIAABCDEFGHIJKLMNOP',
      'auth Bearer sometoken12345',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nxsFN\n-----END PGP PRIVATE KEY BLOCK-----',
      'home /Users/alexnewman/x and encoded /tmp/-Users-alexnewman-Scripts-x',
    ].join('\n');
    const output = sanitizeString(input, 'test', report);
    expect(output).toContain('[REDACTED:sk-key]');
    expect(output).toContain('[REDACTED:github-token]');
    expect(output).not.toContain('ghp_');
    expect(output).not.toContain('gho_');
    expect(output).not.toContain('ghs_');
    expect(output).not.toContain('xsFN');
    expect(output).not.toContain('PGP PRIVATE KEY BLOCK');
    expect(output).toContain('[REDACTED:github-pat]');
    expect(output).toContain('[REDACTED:aws-key-id]');
    expect(output).toContain('Bearer [REDACTED:token]');
    expect(output).toContain('[REDACTED:jwt]');
    expect(output).toContain('[REDACTED:pem-key]');
    expect(output).toContain('/Users/user/x');
    expect(output).toContain('-Users-user-Scripts-x');
    expect(output).not.toContain('alexnewman');
    expect(output).not.toContain('sk-abcdefgh');
    expect(output).not.toContain('MIIB');
    expect(report.length).toBeGreaterThanOrEqual(8);
  });

  test('context snippets never leak an adjacent secret of a later rule', () => {
    const report: Redaction[] = [];
    // jwt fires before sk-key, so the jwt entry's raw context would contain the
    // sk token — the snippet must come back scrubbed.
    sanitizeString('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln next to sk-abcdefgh12345678', 'test', report);
    const all = JSON.stringify(report);
    expect(all).not.toContain('sk-abcdefgh12345678');
    expect(all).toContain('[REDACTED:jwt]');
  });

  test('redacts emails except the explicit allowlist (case-insensitive)', () => {
    const report: Redaction[] = [];
    const input =
      'from carol@airbnb.com and THEDOTMACK@GMAIL.COM via noreply@anthropic.com, remote git@github.com, bot 198982749+Copilot@users.noreply.github.com';
    const output = sanitizeString(input, 'test', report);
    expect(output).toContain('[REDACTED:email]');
    expect(output).not.toContain('carol@airbnb.com');
    expect(output).not.toContain('Copilot@users.noreply.github.com');
    expect(output).toContain('THEDOTMACK@GMAIL.COM');
    expect(output).toContain('noreply@anthropic.com');
    expect(output).toContain('git@github.com');
    const emailEntry = report.find((entry) => entry.rule === 'email');
    expect(emailEntry?.count).toBe(2);
  });

  test('redacts extra-strings literals case-insensitively', () => {
    const report: Redaction[] = [];
    const output = sanitizeString('ping Jorge Rebuffo (aka jorge rebuffo) today', 'test', report);
    expect(output).toBe('ping [REDACTED:name] (aka [REDACTED:name]) today');
    expect(report.find((entry) => entry.rule === 'extra-string')?.count).toBe(2);
  });

  test('does not fire on ordinary text or bare 40-hex SHAs', () => {
    const report: Redaction[] = [];
    const input = 'commit abcdefabcdefabcdefabcdefabcdefabcdefabcd on task-list by a user';
    expect(sanitizeString(input, 'test', report)).toBe(input);
    expect(report.length).toBe(0);
  });
});
