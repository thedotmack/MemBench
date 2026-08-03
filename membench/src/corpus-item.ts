/**
 * Frozen corpus item access — the run-path half of the corpus code.
 *
 * Everything the benchmark loop (fork.ts, observe-stage.ts, run-command.ts)
 * needs to READ a frozen item lives here: required-file lists, transcript row
 * shapes, the content hash, and item listing. The authoring/CLI side
 * (candidate listing against the live claude-mem DB, build, freeze,
 * resanitize) stays in corpus.ts, which imports from this file — so no
 * run-path module ever pulls in `bun:sqlite`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The 7 content files of a corpus item (provenance.json is the 8th, written by build/freeze). */
export const REQUIRED_FILES = [
  'transcript.jsonl',
  'toolcalls.jsonl',
  'repo.lock',
  'task.md',
  'check.sh',
  'success.md',
  'oracle.md',
] as const;

/** Excluded from the content hash: the hash lives in provenance.json, and the report is review-only. */
export const HASH_EXCLUDED = new Set(['provenance.json', 'sanitization-report.md']);

/**
 * Repo-root corpus/ resolved from this file's location (membench/src/), not
 * the cwd — so `bun src/cli.ts corpus list` works from membench/.
 */
export function defaultCorpusDir(): string {
  return join(import.meta.dir, '..', '..', 'corpus');
}

/**
 * Guards 4/10: refuse any path that is — or lives inside — the user's real
 * ~/.claude-mem. Checked before any mkdir/spawn/write touches the path.
 */
export function assertOutsideClaudeMem(
  path: string,
  ErrorClass: new (message: string) => Error = Error,
): void {
  const target = resolve(path);
  const forbidden = join(homedir(), '.claude-mem');
  if (target === forbidden || target.startsWith(forbidden + sep)) {
    throw new ErrorClass(`refusing to use a path inside ${forbidden}: ${target} (guard 4)`);
  }
}

// ---------------------------------------------------------------------------
// Transcript row model (shapes verified against a real transcript,
// dac6a5b7-… in -Users-alexnewman-Scripts-claude-mem-pro)
// ---------------------------------------------------------------------------

export interface ContentBlock {
  type?: string;
  /** tool_use block id (e.g. "toolu_01…"). */
  id?: string;
  /** tool_use tool name. */
  name?: string;
  input?: unknown;
  text?: string;
  /** tool_result back-reference to the tool_use block id. */
  tool_use_id?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface TranscriptRow {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  origin?: { kind?: string };
  /** Tool-result user rows: uuid of the assistant row that issued the tool_use. */
  sourceToolAssistantUUID?: string;
  toolUseResult?: unknown;
  message?: { role?: string; content?: unknown };
  [key: string]: unknown;
}

/** One executor tool call for observe replay. */
export interface ToolCallRecord {
  tool_name: string;
  tool_input: unknown;
  /** toolUseResult of the paired result row (fallback: its tool_result content); null when unpaired (e.g. interrupted). */
  tool_output: unknown;
  /** Milliseconds since epoch of the result row (fallback: the tool_use's assistant row); null when untimestamped. */
  created_at_epoch: number | null;
  cwd: string | null;
}

/** Text of a message.content that may be a plain string or a block array. */
function textOfMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string)
      .join('\n');
  }
  return '';
}

/** First human prompt in a transcript (fallback task source, plan §0.1). */
export function firstHumanPrompt(rows: TranscriptRow[]): string | null {
  for (const row of rows) {
    if (row.type === 'user' && row.origin?.kind === 'human') {
      const text = textOfMessageContent(row.message?.content);
      if (text.trim()) return text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Sorted relative file list of an item dir, skipping dotfiles and everything
 * under dot-directories (.DS_Store and friends must not perturb the content
 * hash or the freeze scans).
 */
export function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((relative) => relative.split(sep).join('/'))
    .filter((relative) => !relative.split('/').some((part) => part.startsWith('.')))
    .filter((relative) => statSync(join(dir, relative)).isFile())
    .sort();
}

/**
 * Content hash of an item dir: sha256 over the sorted relative file list,
 * each contributing `path\0bytes\0` — excluding provenance.json (which holds
 * the hash) and sanitization-report.md (review-only). Deterministic, so
 * re-freezing an unchanged item reproduces the same hash.
 */
export async function computeContentHash(dir: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for (const relative of walkFiles(dir)) {
    if (HASH_EXCLUDED.has(relative)) continue;
    hasher.update(relative);
    hasher.update('\0');
    hasher.update(await Bun.file(join(dir, relative)).arrayBuffer());
    hasher.update('\0');
  }
  return hasher.digest('hex');
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

interface ItemStatus {
  id: string;
  /** Presence of each of the 7 required content files. */
  files: Record<string, boolean>;
  complete: boolean;
  frozen: boolean;
  hash: string | null;
}

export async function listItems(corpusDir: string): Promise<ItemStatus[]> {
  if (!existsSync(corpusDir)) return [];
  const statuses: ItemStatus[] = [];
  for (const entry of readdirSync(corpusDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(corpusDir, entry.name);
    const files: Record<string, boolean> = {};
    for (const name of REQUIRED_FILES) {
      files[name] = existsSync(join(dir, name));
    }
    let hash: string | null = null;
    const provenancePath = join(dir, 'provenance.json');
    if (existsSync(provenancePath)) {
      try {
        const provenance = JSON.parse(await Bun.file(provenancePath).text()) as { content_hash?: unknown };
        hash = typeof provenance.content_hash === 'string' ? provenance.content_hash : null;
      } catch {
        hash = null;
      }
    }
    statuses.push({
      id: entry.name,
      files,
      complete: Object.values(files).every(Boolean),
      frozen: hash !== null,
      hash,
    });
  }
  return statuses;
}
