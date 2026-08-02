/**
 * Corpus builder pipeline — plan Phase 3 (§0.1 "Corpus data sources", §0.3,
 * §0.2 guards 9-10). AUTHORING/CLI side only: the run path reads frozen items
 * through corpus-item.ts and never imports this file (or `bun:sqlite`).
 *
 * Sub-actions (wired as `membench corpus <action>`):
 *   candidates — list N→N+1 session pairs from the live claude-mem DB
 *                (READ-ONLY) joined against on-disk transcripts
 *   build      — build one UNFROZEN item dir from a session-N transcript
 *   freeze     — verify no draft markers remain, content-hash the item
 *   list       — table of items with file completeness + frozen status
 *
 * Live-data rules: the claude-mem DB is opened read-only (guard 10 — no
 * write path in MemBench may touch ~/.claude-mem); transcript parsing uses
 * `sessionId` (camelCase) from rows, never decodes project dir names, and
 * excludes the observer-sessions dir (guard 9).
 */

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  HASH_EXCLUDED,
  REQUIRED_FILES,
  assertOutsideClaudeMem,
  computeContentHash,
  defaultCorpusDir,
  firstHumanPrompt,
  listItems,
  walkFiles,
  type ContentBlock,
  type ToolCallRecord,
  type TranscriptRow,
} from './corpus-item.js';
import { readJsonl } from './jsonl.js';
import { SANITIZER_VERSION, sanitizeString, sanitizeValue, type Redaction } from './sanitize.js';

export class CorpusBuildError extends Error {}

/** Claude-mem's own observer runs — never corpus material (guard 9). */
const OBSERVER_SESSIONS_DIR = '-Users-alexnewman--claude-mem-observer-sessions';

/**
 * Draft markers the builder stamps into stub files. Deliberately distinctive
 * strings: freeze scans every content file for them, and plain "TODO" would
 * false-positive on real source code inside transcript.jsonl.
 */
const TODO_MARKER = 'MEMBENCH:TODO';
const DRAFT_MARKER = 'MEMBENCH:DRAFT';

function defaultDbPath(): string {
  return join(homedir(), '.claude-mem', 'claude-mem.db');
}

function defaultProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

/**
 * The ONLY place MemBench opens the live claude-mem DB: read-only, no
 * create. bun:sqlite's `readonly` flag is verified behavior — writes throw
 * "attempt to write a readonly database".
 */
function openLiveDb(dbPath: string): Database {
  return new Database(dbPath, { readonly: true });
}

// ---------------------------------------------------------------------------
// Transcript filtering
// ---------------------------------------------------------------------------

/**
 * Keep: metadata rows (system, mode, attachment, …), human user rows
 * (`.type=="user" && .origin.kind=="human"`), tool-result user rows
 * (`sourceToolAssistantUUID` present), assistant rows.
 * Drop: `file-history-snapshot` rows (bulk file backups) and user rows that
 * are neither human nor tool-result (e.g. task notifications).
 */
export function filterTranscriptRows(rows: TranscriptRow[]): TranscriptRow[] {
  return rows.filter((row) => {
    if (row.type === 'file-history-snapshot') return false;
    if (row.type === 'user') {
      return row.origin?.kind === 'human' || typeof row.sourceToolAssistantUUID === 'string';
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tool call extraction
// ---------------------------------------------------------------------------

function toolResultBlock(row: TranscriptRow, toolUseId: string): ContentBlock | undefined {
  const content = row.message?.content;
  if (!Array.isArray(content)) return undefined;
  return (content as ContentBlock[]).find(
    (candidate) => candidate?.type === 'tool_result' && candidate.tool_use_id === toolUseId,
  );
}

/** Whether a result row carries any identifiable tool_result blocks at all. */
function hasToolResultBlocks(row: TranscriptRow): boolean {
  const content = row.message?.content;
  return Array.isArray(content) && (content as ContentBlock[]).some((block) => block?.type === 'tool_result');
}

/**
 * Join assistant `tool_use` blocks to their tool-result user rows: the result
 * row's `sourceToolAssistantUUID` names the assistant row's `uuid`, and its
 * `tool_result.tool_use_id` names the exact `tool_use` block `id` (verified
 * against a real transcript).
 */
export function extractToolCalls(rows: TranscriptRow[]): ToolCallRecord[] {
  const epochMs = (timestamp: string | undefined): number | null => {
    const parsed = timestamp ? Date.parse(timestamp) : NaN;
    return Number.isNaN(parsed) ? null : parsed;
  };

  const resultsByAssistant = new Map<string, TranscriptRow[]>();
  for (const row of rows) {
    if (row.type !== 'user' || typeof row.sourceToolAssistantUUID !== 'string') continue;
    const bucket = resultsByAssistant.get(row.sourceToolAssistantUUID) ?? [];
    bucket.push(row);
    resultsByAssistant.set(row.sourceToolAssistantUUID, bucket);
  }

  const records: ToolCallRecord[] = [];
  for (const row of rows) {
    if (row.type !== 'assistant' || typeof row.uuid !== 'string') continue;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as ContentBlock[]) {
      if (block?.type !== 'tool_use' || typeof block.id !== 'string') continue;
      const blockId = block.id;
      const candidates = resultsByAssistant.get(row.uuid) ?? [];
      // Exact pairing via tool_result.tool_use_id. The single-candidate
      // fallback applies ONLY when that row has no tool_result blocks at all
      // (unmatchable shape, e.g. string message content): with parallel
      // tool_use blocks, an unmatched id means the result belongs to a
      // sibling block — emit null rather than mispair.
      const exact = candidates.find((candidate) => toolResultBlock(candidate, blockId) !== undefined);
      const resultRow =
        exact ?? (candidates.length === 1 && !hasToolResultBlocks(candidates[0]) ? candidates[0] : undefined);
      records.push({
        tool_name: typeof block.name === 'string' ? block.name : 'unknown',
        tool_input: block.input ?? null,
        tool_output: resultRow
          ? (resultRow.toolUseResult ?? toolResultBlock(resultRow, blockId)?.content ?? null)
          : null,
        created_at_epoch: epochMs(resultRow?.timestamp) ?? epochMs(row.timestamp),
        cwd: resultRow?.cwd ?? row.cwd ?? null,
      });
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// Repo pinning (plan §0.3: no commit SHA exists in any data source)
// ---------------------------------------------------------------------------

interface RepoLock {
  url: string;
  commit: string;
  branch: string;
  /** Sanitized form (/Users/user/…) — the real cwd is used at build time only. */
  cwd_at_recording: string;
}

/** Injectable for tests; the default shells out to git. */
export type GitRunner = (args: string[]) => { ok: boolean; stdout: string };

function defaultGitRunner(args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

/** Last 40-hex SHA mentioned in any Bash tool result stdout (fallback pinning). */
export function mineCommitSha(rows: TranscriptRow[]): string | null {
  let last: string | null = null;
  for (const row of rows) {
    const result = row.toolUseResult;
    if (result === null || typeof result !== 'object') continue;
    const stdout = (result as Record<string, unknown>).stdout;
    if (typeof stdout !== 'string') continue;
    const matches = stdout.match(/\b[0-9a-f]{40}\b/g);
    if (matches && matches.length > 0) last = matches[matches.length - 1];
  }
  return last;
}

/**
 * Pin the exact repo state at session end: `git log <branch>
 * --until=<last-row-timestamp> -1` on the recorded cwd, falling back to
 * mining Bash stdout for a SHA. Unpinnable → CorpusBuildError (no "close
 * enough" — plan Phase 3 anti-pattern guard).
 */
export function pinRepo(
  rows: TranscriptRow[],
  git: GitRunner = defaultGitRunner,
): { lock: Omit<RepoLock, 'cwd_at_recording'>; realCwd: string } {
  const cwds = rows.map((row) => row.cwd).filter((cwd): cwd is string => typeof cwd === 'string');
  // Most frequent cwd; stable sort keeps first-seen ahead on ties.
  const realCwd =
    [...Map.groupBy(cwds, (cwd) => cwd).entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? null;
  if (!realCwd) {
    throw new CorpusBuildError('cannot pin repo: no row in the transcript carries a cwd');
  }
  const timestamps = rows.map((row) => row.timestamp).filter((t): t is string => typeof t === 'string');
  const endTimestamp = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : null;
  if (!endTimestamp) {
    throw new CorpusBuildError('cannot pin repo: no row in the transcript carries a timestamp');
  }
  const branches = rows.map((row) => row.gitBranch).filter((b): b is string => typeof b === 'string' && b.length > 0);
  const branch = branches.length > 0 ? branches[branches.length - 1] : 'HEAD';

  const remote = git(['-C', realCwd, 'remote', 'get-url', 'origin']);
  if (!remote.ok || !remote.stdout) {
    throw new CorpusBuildError(
      `cannot pin repo: \`git -C ${realCwd} remote get-url origin\` failed — ` +
        'the recorded cwd is gone or has no origin remote; candidate rejected',
    );
  }

  const log = git(['-C', realCwd, 'log', branch, `--until=${endTimestamp}`, '-1', '--format=%H']);
  let commit = log.ok && /^[0-9a-f]{40}$/.test(log.stdout) ? log.stdout : null;
  let pinnedVia = 'git-log';
  if (!commit) {
    commit = mineCommitSha(rows);
    pinnedVia = 'mined-sha';
  }
  if (!commit) {
    throw new CorpusBuildError(
      `cannot pin repo: \`git log ${branch} --until=${endTimestamp}\` on ${realCwd} produced no commit ` +
        'and no 40-hex SHA appears in any Bash tool result stdout; candidate rejected',
    );
  }
  console.error(`repo pinned via ${pinnedVia}: ${commit} (${branch} @ ${endTimestamp})`);
  return { lock: { url: remote.stdout, commit, branch }, realCwd };
}

// ---------------------------------------------------------------------------
// Candidate listing (live DB, read-only)
// ---------------------------------------------------------------------------

interface CandidatePair {
  project: string;
  session_n: string;
  session_n_started: string;
  session_n_plus_1: string;
  session_n_plus_1_started: string | null;
  transcript_n: string;
  transcript_n_plus_1: string | null;
  task_source: 'user_prompts' | 'transcript' | null;
  task_preview: string | null;
}

/**
 * Map sessionId → transcript path from on-disk `~/.claude/projects/<dir>/
 * <sessionId>.jsonl` files (filename stem == sessionId, plan §0.1),
 * excluding the observer-sessions dir. Dir names are never decoded (lossy).
 */
export function transcriptIndex(projectsDir: string): Map<string, string> {
  const index = new Map<string, string>();
  if (!existsSync(projectsDir)) return index;
  for (const dir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name === OBSERVER_SESSIONS_DIR) continue;
    const dirPath = join(projectsDir, dir.name);
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      index.set(entry.name.slice(0, -'.jsonl'.length), join(dirPath, entry.name));
    }
  }
  return index;
}

interface PairRow {
  project: string;
  session_n: string;
  started_n: string;
  session_n1: string | null;
  started_n1: string | null;
}

const PAIR_QUERY = `
  SELECT project,
         content_session_id AS session_n,
         started_at AS started_n,
         LEAD(content_session_id) OVER (PARTITION BY project ORDER BY started_at_epoch, id) AS session_n1,
         LEAD(started_at) OVER (PARTITION BY project ORDER BY started_at_epoch, id) AS started_n1
  FROM sdk_sessions
`;

function firstPromptFromDb(db: Database, contentSessionId: string): string | null {
  const row = db
    .query<{ prompt_text: string }, [string]>(
      'SELECT prompt_text FROM user_prompts WHERE content_session_id = ? AND prompt_number = 1 ORDER BY id LIMIT 1',
    )
    .get(contentSessionId);
  return row?.prompt_text ?? null;
}

async function firstPromptFromTranscript(path: string): Promise<string | null> {
  const rows = await readJsonl<TranscriptRow>(path);
  return firstHumanPrompt(rows);
}

export async function listCandidates(options: {
  dbPath?: string;
  projectsDir?: string;
  project?: string;
  limit?: number;
}): Promise<CandidatePair[]> {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const index = transcriptIndex(projectsDir);
  const db = openLiveDb(options.dbPath ?? defaultDbPath());
  try {
    const rows = db
      .query<PairRow, []>(`${PAIR_QUERY} ORDER BY project, started_at_epoch, id`)
      .all();
    const candidates: CandidatePair[] = [];
    for (const row of rows) {
      if (!row.session_n1) continue;
      if (options.project && row.project !== options.project) continue;
      const transcriptN = index.get(row.session_n);
      if (!transcriptN) continue;
      const transcriptN1 = index.get(row.session_n1) ?? null;
      let taskSource: CandidatePair['task_source'] = null;
      let prompt = firstPromptFromDb(db, row.session_n1);
      if (prompt) {
        taskSource = 'user_prompts';
      } else if (transcriptN1) {
        prompt = await firstPromptFromTranscript(transcriptN1);
        if (prompt) taskSource = 'transcript';
      }
      candidates.push({
        project: row.project,
        session_n: row.session_n,
        session_n_started: row.started_n,
        session_n_plus_1: row.session_n1,
        session_n_plus_1_started: row.started_n1,
        transcript_n: transcriptN,
        transcript_n_plus_1: transcriptN1,
        task_source: taskSource,
        task_preview: prompt ? prompt.replace(/\s+/g, ' ').trim().slice(0, 120) : null,
      });
      if (options.limit && candidates.length >= options.limit) break;
    }
    return candidates;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** DB-resolved facts about a session pair, gathered before buildItem runs. */
interface BuildInputs {
  sessionId: string;
  projectSlug: string;
  nextSessionId: string;
  nextSessionStarted: string | null;
  /** The N+1 opening human prompt (task source). */
  taskPrompt: string;
  taskSource: 'user_prompts' | 'transcript';
}

export async function resolveBuildInputs(
  sessionId: string,
  options: { dbPath?: string; projectsDir?: string },
): Promise<BuildInputs> {
  const db = openLiveDb(options.dbPath ?? defaultDbPath());
  try {
    const row = db
      .query<PairRow, [string]>(`SELECT * FROM (${PAIR_QUERY}) WHERE session_n = ? LIMIT 1`)
      .get(sessionId);
    if (!row) {
      throw new CorpusBuildError(`session ${sessionId} not found in sdk_sessions`);
    }
    if (!row.session_n1) {
      throw new CorpusBuildError(
        `session ${sessionId} is the last session of project "${row.project}" — no N+1 session, no hindsight task`,
      );
    }
    let taskSource: BuildInputs['taskSource'] = 'user_prompts';
    let prompt = firstPromptFromDb(db, row.session_n1);
    if (!prompt) {
      const index = transcriptIndex(options.projectsDir ?? defaultProjectsDir());
      const transcriptN1 = index.get(row.session_n1);
      if (transcriptN1) {
        prompt = await firstPromptFromTranscript(transcriptN1);
        taskSource = 'transcript';
      }
    }
    if (!prompt) {
      throw new CorpusBuildError(
        `no task source for N+1 session ${row.session_n1}: not in user_prompts and no first human turn in its transcript`,
      );
    }
    return {
      sessionId,
      projectSlug: row.project,
      nextSessionId: row.session_n1,
      nextSessionStarted: row.started_n1,
      taskPrompt: prompt,
      taskSource,
    };
  } finally {
    db.close();
  }
}

interface BuildItemOptions {
  transcriptPath: string;
  outDir: string;
  meta: {
    sessionId: string;
    projectSlug: string;
    nextSessionId: string;
    nextSessionStarted: string | null;
    taskSource: string;
  };
  taskPrompt: string;
  git?: GitRunner;
}

interface BuildSummary {
  itemId: string;
  outDir: string;
  rowsTotal: number;
  rowsKept: number;
  toolCalls: number;
  redactions: Redaction[];
  lock: RepoLock;
}

function checkShStub(): string {
  return `#!/usr/bin/env bash
# ${TODO_MARKER}: pass/fail check for this item — exit 0 = success.
# Written by the corpus author BEFORE any model runs (no post-hoc fitting).
# Delete this marker block when done.
echo "check.sh not written yet" >&2
exit 1
`;
}

function successStub(): string {
  return `<!-- ${TODO_MARKER}: judge rubric — fill in ONLY where check.sh cannot decide
mechanically, then delete this marker. -->
`;
}

function oracleStub(): string {
  return `<!-- ${TODO_MARKER}: hand-written perfect notes (the ceiling control),
drawn from what session N actually established. Delete this marker when done. -->
`;
}

function taskDraft(prompt: string, nextSessionId: string, taskSource: string): string {
  return `<!-- ${DRAFT_MARKER}: auto-extracted from the N+1 session's opening human prompt
(session ${nextSessionId}, source: ${taskSource}). Hand-edit ONLY to remove
machine-specific context — do not "improve" the task — then delete this marker. -->

${prompt}
`;
}

function renderRedactionBody(redactions: Redaction[]): string[] {
  const total = redactions.reduce((sum, entry) => sum + entry.count, 0);
  const byRule = new Map<string, number>();
  for (const entry of redactions) {
    byRule.set(entry.rule, (byRule.get(entry.rule) ?? 0) + entry.count);
  }
  const lines: string[] = [
    `- total replacements: ${total} (${redactions.length} entries)`,
    '',
    '## Totals by rule',
    '',
    '| Rule | Replacements |',
    '|------|--------------|',
  ];
  for (const [rule, count] of [...byRule.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${rule} | ${count} |`);
  }
  lines.push('', '## Every redaction (hand-review before freezing)', '');
  if (redactions.length === 0) {
    lines.push('No redactions.');
  }
  redactions.forEach((entry, i) => {
    lines.push(`### ${i + 1}. \`${entry.rule}\` ×${entry.count} — ${entry.location}`);
    for (const context of entry.contexts) {
      lines.push(`- \`${context.replace(/`/g, "'")}\``);
    }
    lines.push('');
  });
  return lines;
}

function renderSanitizationReport(itemId: string, meta: BuildItemOptions['meta'], redactions: Redaction[]): string {
  const lines: string[] = [
    `# Sanitization report — ${itemId}`,
    '',
    `- content_session_id: ${meta.sessionId}`,
    `- sanitizer_version: ${SANITIZER_VERSION}`,
    ...renderRedactionBody(redactions),
  ];
  return lines.join('\n') + '\n';
}

/**
 * Build one UNFROZEN corpus item dir from a session-N transcript. All DB
 * lookups happen in resolveBuildInputs — this function is offline-testable
 * with a fixture transcript and an injected GitRunner.
 */
export async function buildItem(options: BuildItemOptions): Promise<BuildSummary> {
  const { transcriptPath, outDir, meta, taskPrompt } = options;
  assertOutsideClaudeMem(outDir, CorpusBuildError);
  const itemId = basename(resolve(outDir));

  const provenancePath = join(outDir, 'provenance.json');
  if (existsSync(provenancePath)) {
    const existing = JSON.parse(await Bun.file(provenancePath).text()) as { content_hash?: unknown };
    if (existing.content_hash) {
      throw new CorpusBuildError(`${outDir} is already frozen — the corpus is append-only after freezing`);
    }
  }

  if (!existsSync(transcriptPath)) {
    throw new CorpusBuildError(`transcript not found: ${transcriptPath}`);
  }
  const rawRows = await readJsonl<TranscriptRow>(transcriptPath);
  if (rawRows.length === 0) {
    throw new CorpusBuildError(`transcript is empty: ${transcriptPath}`);
  }
  const keptRaw = filterTranscriptRows(rawRows);

  // Pin the repo BEFORE sanitizing — pinning needs the real cwd; only the
  // sanitized cwd is stored in the emitted repo.lock.
  const report: Redaction[] = [];
  const { lock: pinned, realCwd } = pinRepo(keptRaw, options.git);
  const lock: RepoLock = {
    url: sanitizeString(pinned.url, 'repo.lock: url', report),
    commit: pinned.commit,
    branch: sanitizeString(pinned.branch, 'repo.lock: branch', report),
    cwd_at_recording: sanitizeString(realCwd, 'repo.lock: cwd_at_recording', report),
  };

  const rows = keptRaw.map((row, i) => sanitizeValue(row, `transcript.jsonl row ${i + 1}`, report));
  // Extracted from the sanitized rows so tool inputs/outputs are clean too.
  const toolCalls = extractToolCalls(rows).map((record, i) =>
    sanitizeValue(record, `toolcalls.jsonl row ${i + 1}`, report),
  );
  const task = sanitizeString(taskPrompt, 'task.md', report);

  const timestamps = rows.map((row) => row.timestamp).filter((t): t is string => typeof t === 'string');
  const provenance = {
    content_session_id: meta.sessionId,
    project_slug: meta.projectSlug,
    session_n_plus_1_id: meta.nextSessionId,
    dates: {
      session_n_started: timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : null,
      session_n_ended: timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : null,
      session_n_plus_1_started: meta.nextSessionStarted,
    },
    sanitizer_version: SANITIZER_VERSION,
    content_hash: null as string | null,
  };

  mkdirSync(outDir, { recursive: true });
  await Bun.write(join(outDir, 'transcript.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await Bun.write(join(outDir, 'toolcalls.jsonl'), toolCalls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await Bun.write(join(outDir, 'repo.lock'), JSON.stringify(lock, null, 2) + '\n');
  await Bun.write(join(outDir, 'task.md'), taskDraft(task, meta.nextSessionId, meta.taskSource));
  await Bun.write(join(outDir, 'check.sh'), checkShStub());
  chmodSync(join(outDir, 'check.sh'), 0o755);
  await Bun.write(join(outDir, 'success.md'), successStub());
  await Bun.write(join(outDir, 'oracle.md'), oracleStub());
  await Bun.write(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  await Bun.write(join(outDir, 'sanitization-report.md'), renderSanitizationReport(itemId, meta, report));

  return {
    itemId,
    outDir: resolve(outDir),
    rowsTotal: rawRows.length,
    rowsKept: rows.length,
    toolCalls: toolCalls.length,
    redactions: report,
    lock,
  };
}

// ---------------------------------------------------------------------------
// Re-sanitize (sanitizer version upgrades over already-built items)
// ---------------------------------------------------------------------------

interface ResanitizeSummary {
  itemId: string;
  redactions: Redaction[];
  previousSanitizerVersion: number | null;
  /** The frozen hash that was cleared, if the item was frozen. */
  clearedHash: string | null;
}

/**
 * Re-run the current sanitizer over an existing item's MACHINE-GENERATED
 * files only — transcript.jsonl, toolcalls.jsonl, repo.lock — in place, so a
 * sanitizer version bump (e.g. v2's email/name rules) applies uniformly to
 * items built under an older version. Hand-authored files (task.md, check.sh,
 * success.md, oracle.md) are never touched. Appends a delta section to
 * sanitization-report.md (preserving the original pass's record — though
 * prior sections, being machine-generated, are themselves re-scrubbed so an
 * old context snippet cannot keep PII alive), stamps the new
 * sanitizer_version into provenance.json, and clears content_hash — the item
 * must be re-frozen afterwards.
 */
export async function resanitizeItem(dir: string): Promise<ResanitizeSummary> {
  assertOutsideClaudeMem(dir, CorpusBuildError);
  if (!existsSync(dir)) {
    throw new CorpusBuildError(`no such item dir: ${dir}`);
  }
  const provenancePath = join(dir, 'provenance.json');
  for (const name of ['transcript.jsonl', 'toolcalls.jsonl', 'repo.lock', 'provenance.json']) {
    if (!existsSync(join(dir, name))) {
      throw new CorpusBuildError(`cannot resanitize ${dir}: missing ${name}`);
    }
  }
  const itemId = basename(resolve(dir));
  const report: Redaction[] = [];

  const rows = await readJsonl<TranscriptRow>(join(dir, 'transcript.jsonl'));
  const cleanRows = rows.map((row, i) => sanitizeValue(row, `transcript.jsonl row ${i + 1}`, report));
  const calls = await readJsonl<ToolCallRecord>(join(dir, 'toolcalls.jsonl'));
  const cleanCalls = calls.map((record, i) => sanitizeValue(record, `toolcalls.jsonl row ${i + 1}`, report));
  const lock = JSON.parse(await Bun.file(join(dir, 'repo.lock')).text()) as RepoLock;
  const cleanLock = sanitizeValue(lock, 'repo.lock', report);

  const provenance = JSON.parse(await Bun.file(provenancePath).text()) as Record<string, unknown>;
  const previousSanitizerVersion =
    typeof provenance.sanitizer_version === 'number' ? provenance.sanitizer_version : null;
  const clearedHash = typeof provenance.content_hash === 'string' ? provenance.content_hash : null;
  provenance.sanitizer_version = SANITIZER_VERSION;
  provenance.content_hash = null;

  // Clear the frozen hash FIRST: an interruption mid-rewrite can then never
  // leave a "frozen" hash pointing at half-rewritten data files.
  await Bun.write(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  await Bun.write(join(dir, 'transcript.jsonl'), cleanRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await Bun.write(join(dir, 'toolcalls.jsonl'), cleanCalls.map((r) => JSON.stringify(r)).join('\n') + '\n');
  await Bun.write(join(dir, 'repo.lock'), JSON.stringify(cleanLock, null, 2) + '\n');

  const reportPath = join(dir, 'sanitization-report.md');
  const existingRaw = existsSync(reportPath) ? await Bun.file(reportPath).text() : '';
  // The report is machine-generated too: old context snippets were scrubbed
  // only against the rules of their day, so re-scrub them with the current set.
  const existing = sanitizeString(existingRaw, 'sanitization-report.md (prior sections)', report);
  const section = [
    '',
    '---',
    '',
    `# Re-sanitization pass — sanitizer_version ${SANITIZER_VERSION} (was ${previousSanitizerVersion ?? 'unknown'})`,
    '',
    '- files re-sanitized: transcript.jsonl, toolcalls.jsonl, repo.lock (hand-authored files untouched)',
    ...renderRedactionBody(report),
  ].join('\n');
  await Bun.write(reportPath, existing + section + '\n');

  return { itemId, redactions: report, previousSanitizerVersion, clearedHash };
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

interface FreezeResult {
  itemId: string;
  hash: string;
  /** True when the item was already frozen with this same hash (idempotent re-freeze). */
  unchanged: boolean;
}

export async function freezeItem(dir: string): Promise<FreezeResult> {
  assertOutsideClaudeMem(dir, CorpusBuildError);
  if (!existsSync(dir)) {
    throw new CorpusBuildError(`no such item dir: ${dir}`);
  }
  const missing = REQUIRED_FILES.filter((name) => !existsSync(join(dir, name)));
  if (missing.length > 0) {
    throw new CorpusBuildError(`cannot freeze ${dir}: missing required files: ${missing.join(', ')}`);
  }
  const provenancePath = join(dir, 'provenance.json');
  if (!existsSync(provenancePath)) {
    throw new CorpusBuildError(`cannot freeze ${dir}: missing provenance.json (build the item first)`);
  }

  const allFiles = walkFiles(dir);
  const markerHits: string[] = [];
  const usernameHits: string[] = [];
  for (const relative of allFiles) {
    const text = await Bun.file(join(dir, relative)).text();
    if (!HASH_EXCLUDED.has(relative) && (text.includes(TODO_MARKER) || text.includes(DRAFT_MARKER))) {
      markerHits.push(relative);
    }
    // Guard 10: `grep -rn "alexnewman" corpus/` must end empty — every file
    // counts, including the sanitization report and provenance.
    if (text.includes('alexnewman')) {
      usernameHits.push(relative);
    }
  }
  if (markerHits.length > 0) {
    throw new CorpusBuildError(
      `cannot freeze ${dir}: ${TODO_MARKER}/${DRAFT_MARKER} markers remain in: ${markerHits.join(', ')}`,
    );
  }
  if (usernameHits.length > 0) {
    throw new CorpusBuildError(
      `cannot freeze ${dir}: "alexnewman" appears in: ${usernameHits.join(', ')} (guard 10)`,
    );
  }

  const hash = await computeContentHash(dir);
  const provenance = JSON.parse(await Bun.file(provenancePath).text()) as Record<string, unknown>;
  const previous = provenance.content_hash;
  if (typeof previous === 'string' && previous !== hash) {
    throw new CorpusBuildError(
      `cannot re-freeze ${dir}: content changed since it was frozen (${previous} → ${hash}) — the corpus is append-only`,
    );
  }
  provenance.content_hash = hash;
  await Bun.write(provenancePath, JSON.stringify(provenance, null, 2) + '\n');
  return { itemId: basename(resolve(dir)), hash, unchanged: previous === hash };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const CORPUS_HELP = `Usage: membench corpus <action> [options]

Actions:
  candidates   List N->N+1 session pairs (live claude-mem DB, read-only)
                 --db <path>            (default ~/.claude-mem/claude-mem.db)
                 --projects-dir <path>  (default ~/.claude/projects)
                 --project <slug>       filter by project
                 --limit <n>            cap the list
  build <sessionId> --out <dir>
               Build an UNFROZEN item dir from a session-N transcript
                 --db / --projects-dir  as above
  resanitize <item-dir>
               Re-run the current sanitizer over transcript.jsonl,
               toolcalls.jsonl and repo.lock in place (hand-authored files
               untouched); clears the frozen hash — re-freeze afterwards
  freeze <item-dir>
               Verify no draft markers remain, write the content hash
  list         Item table: 7 required files + frozen status
                 --corpus-dir <path>    (default: <repo-root>/corpus)
`;

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

function parseFlags(args: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CorpusBuildError(`flag --${name} requires a value`);
      }
      flags[name] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 16) : '?';
}

async function corpusCandidates(parsed: ParsedFlags): Promise<number> {
  let limit: number | undefined;
  if (parsed.flags['limit'] !== undefined) {
    limit = Number(parsed.flags['limit']);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new CorpusBuildError(`--limit must be a positive integer, got "${parsed.flags['limit']}"`);
    }
  }
  const candidates = await listCandidates({
    dbPath: parsed.flags['db'],
    projectsDir: parsed.flags['projects-dir'],
    project: parsed.flags['project'],
    limit,
  });
  if (candidates.length === 0) {
    console.log('no candidate pairs (need session N transcript on disk and an N+1 session)');
    return 0;
  }
  for (const pair of candidates) {
    const n1Transcript = pair.transcript_n_plus_1 ? 'on disk' : 'db-only';
    console.log(
      `${pair.project}  ${pair.session_n} -> ${pair.session_n_plus_1}` +
        `  (${shortDate(pair.session_n_started)} -> ${shortDate(pair.session_n_plus_1_started)})  [n+1: ${n1Transcript}]`,
    );
    console.log(`    transcript: ${pair.transcript_n}`);
    console.log(
      pair.task_preview
        ? `    task[${pair.task_source}]: ${pair.task_preview}`
        : '    task: NO TASK SOURCE (not buildable)',
    );
  }
  console.log(`\n${candidates.length} candidate pair(s)`);
  return 0;
}

async function corpusBuild(parsed: ParsedFlags): Promise<number> {
  const sessionId = parsed.positional[0];
  const outDir = parsed.flags['out'];
  if (!sessionId || !outDir) {
    console.error('usage: membench corpus build <sessionId> --out <dir>');
    return 1;
  }
  const projectsDir = parsed.flags['projects-dir'] ?? defaultProjectsDir();
  const transcriptPath = transcriptIndex(projectsDir).get(sessionId);
  if (!transcriptPath) {
    console.error(`no transcript ${sessionId}.jsonl on disk under ${projectsDir} (observer sessions excluded)`);
    return 1;
  }
  const inputs = await resolveBuildInputs(sessionId, {
    dbPath: parsed.flags['db'],
    projectsDir,
  });
  const summary = await buildItem({
    transcriptPath,
    outDir,
    meta: {
      sessionId: inputs.sessionId,
      projectSlug: inputs.projectSlug,
      nextSessionId: inputs.nextSessionId,
      nextSessionStarted: inputs.nextSessionStarted,
      taskSource: inputs.taskSource,
    },
    taskPrompt: inputs.taskPrompt,
  });
  const replacements = summary.redactions.reduce((sum, entry) => sum + entry.count, 0);
  console.log(`built UNFROZEN item ${summary.itemId} at ${summary.outDir}`);
  console.log(`  rows: ${summary.rowsKept}/${summary.rowsTotal} kept, tool calls: ${summary.toolCalls}`);
  console.log(`  repo.lock: ${summary.lock.url} @ ${summary.lock.commit} (${summary.lock.branch})`);
  console.log(`  redactions: ${replacements} replacement(s) — review sanitization-report.md`);
  console.log(`  next: fill task.md / check.sh / success.md / oracle.md, then \`membench corpus freeze ${outDir}\``);
  return 0;
}

async function corpusResanitize(parsed: ParsedFlags): Promise<number> {
  const dir = parsed.positional[0];
  if (!dir) {
    console.error('usage: membench corpus resanitize <item-dir>');
    return 1;
  }
  const summary = await resanitizeItem(dir);
  const replacements = summary.redactions.reduce((sum, entry) => sum + entry.count, 0);
  console.log(
    `re-sanitized ${summary.itemId} (sanitizer_version ${summary.previousSanitizerVersion ?? '?'} -> ${SANITIZER_VERSION}): ` +
      `${replacements} new replacement(s)`,
  );
  if (summary.clearedHash) {
    console.log(`  cleared frozen hash ${summary.clearedHash.slice(0, 12)}… — re-freeze with \`membench corpus freeze ${dir}\``);
  }
  return 0;
}

async function corpusFreeze(parsed: ParsedFlags): Promise<number> {
  const dir = parsed.positional[0];
  if (!dir) {
    console.error('usage: membench corpus freeze <item-dir>');
    return 1;
  }
  const result = await freezeItem(dir);
  console.log(
    result.unchanged
      ? `item ${result.itemId} already frozen — hash unchanged: ${result.hash}`
      : `froze item ${result.itemId}: ${result.hash}`,
  );
  return 0;
}

async function corpusList(parsed: ParsedFlags): Promise<number> {
  const corpusDir = parsed.flags['corpus-dir'] ?? defaultCorpusDir();
  const items = await listItems(corpusDir);
  if (items.length === 0) {
    console.log(`no items under ${corpusDir}/`);
    return 0;
  }
  const width = Math.max(...items.map((item) => item.id.length), 4);
  console.log(`${'ITEM'.padEnd(width)}  FILES  FROZEN`);
  for (const item of items) {
    const present = Object.values(item.files).filter(Boolean).length;
    const missing = REQUIRED_FILES.filter((name) => !item.files[name]);
    const filesCell = `${present}/${REQUIRED_FILES.length}`;
    const frozenCell = item.frozen ? `yes (${item.hash?.slice(0, 12)}…)` : 'no';
    const suffix = missing.length > 0 ? `  missing: ${missing.join(', ')}` : '';
    console.log(`${item.id.padEnd(width)}  ${filesCell.padEnd(5)}  ${frozenCell}${suffix}`);
  }
  return 0;
}

/** Entry point for `membench corpus …` (dispatched from cli.ts). */
export async function corpusMain(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === '-h') {
    console.log(CORPUS_HELP);
    return action ? 0 : 1;
  }
  try {
    const parsed = parseFlags(rest);
    switch (action) {
      case 'candidates':
        return await corpusCandidates(parsed);
      case 'build':
        return await corpusBuild(parsed);
      case 'resanitize':
        return await corpusResanitize(parsed);
      case 'freeze':
        return await corpusFreeze(parsed);
      case 'list':
        return await corpusList(parsed);
      default:
        console.error(`membench corpus: unknown action "${action}"\n`);
        console.error(CORPUS_HELP);
        return 1;
    }
  } catch (error: unknown) {
    if (error instanceof CorpusBuildError) {
      console.error(`membench corpus ${action}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
