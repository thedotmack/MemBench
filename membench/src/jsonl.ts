/**
 * JSONL append/read utilities.
 *
 * appendJsonl ports the locked-append pattern from
 * evals/swebench/run-batch.py append_prediction_row (lines 225-241):
 * "Append one JSONL prediction row under a lock (appends are NOT atomic
 * across threads)." — here an async mutex (per-path promise chain) plays
 * the role of the threading.Lock.
 *
 * readJsonl ports the tolerant reader from
 * evals/swebench/summarize.py load_expected_instance_ids (lines 14-39):
 * warn (with line number) and continue on unparseable lines, skip blanks,
 * warn-and-return-empty on a missing file.
 */

import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Per-path append chains: appends to the same file are serialized. Keyed by
 * resolved absolute path so `./a.jsonl` and `a.jsonl` share one lock.
 */
const appendLocks = new Map<string, Promise<void>>();

/**
 * Append one row to a JSONL file as `JSON.stringify(row) + "\n"`, guarded by
 * an async mutex so concurrent appends to the same path never interleave.
 */
export function appendJsonl(path: string, row: unknown): Promise<void> {
  const line = JSON.stringify(row) + '\n';
  const lockKey = resolve(path);
  const previous = appendLocks.get(lockKey) ?? Promise.resolve();
  // A failed append must not wedge the chain for subsequent writers.
  const next = previous.catch(() => {}).then(() => appendFile(path, line, 'utf-8'));
  appendLocks.set(lockKey, next);
  return next;
}

/**
 * Read a JSONL file into an array of rows. Blank lines are skipped;
 * unparseable lines emit a stderr warning with their 1-based line number and
 * are skipped; a missing file warns and returns [].
 */
export async function readJsonl<T = unknown>(path: string): Promise<T[]> {
  const rows: T[] = [];
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`warning: jsonl file not found or unreadable: ${path}: ${message}`);
    return rows;
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const stripped = lines[i].trim();
    if (!stripped) continue;
    try {
      rows.push(JSON.parse(stripped) as T);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`warning: could not parse jsonl line ${lineNumber} of ${path}: ${message}`);
    }
  }
  return rows;
}
