/**
 * Control-variant synthesis — plan Phase 4 item 2 (Phase 6 calls this).
 *
 *   oracle   — the item's hand-written oracle.md parsed into observation
 *              rows: one row per `## section`, title = the heading, facts =
 *              the section's titled bullets flattened, narrative = the
 *              section body. The rows are ParsedObservation-shaped so the
 *              seeding path (fork.ts buildSeedPayload → POST /api/import,
 *              rows per SessionStore.importObservation:3110-3127 @
 *              132b46343) treats every variant identically.
 *   shuffled — a DIFFERENT item's model observations under a FIXED,
 *              deterministic mapping (sorted item ids rotated by 1; built in
 *              run-stage.ts resolveShuffledSources and recorded in the run
 *              manifest).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CorpusItem } from './types.js';
import type { ParsedObservation } from './vendor/parser.js';

export class ControlSynthesisError extends Error {}

/**
 * Default observation type for oracle rows: `discovery` is code-mode's
 * "learned something about the codebase" type (vendor/modes/code.json) —
 * the closest fit for remembered session notes.
 */
export const ORACLE_OBSERVATION_TYPE = 'discovery';

/**
 * Default concepts for oracle rows. LOAD-BEARING: the context injection
 * query only renders observations whose concepts intersect the mode's
 * concept list — `AND EXISTS (SELECT 1 FROM json_each(o.concepts) WHERE
 * value IN (...))`, CM/src/services/context/ObservationCompiler.ts:56-59
 * @ 132b46343 — so a concept-less oracle row would be silently invisible
 * to /api/context/inject (verified against a live worker). `how-it-works`
 * is code-mode's "knowledge about how the system behaves" concept — the
 * honest default for remembered session notes. (Model variants get NO such
 * help: they are seeded with exactly the concepts they emitted, and rows
 * without valid concepts stay invisible — that is claude-mem's production
 * behavior, which is what MemBench measures.)
 */
export const ORACLE_OBSERVATION_CONCEPTS = ['how-it-works'];

/** `- **Title**: rest` bullet (bold title optional colon placement handled below). */
const BULLET_START = /^[-*] /;

interface OracleSection {
  title: string;
  lines: string[];
}

function splitSections(markdown: string): OracleSection[] {
  const sections: OracleSection[] = [];
  let current: OracleSection | null = null;
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^## +(.+?)\s*$/);
    if (heading) {
      current = { title: heading[1], lines: [] };
      sections.push(current);
      continue;
    }
    // Content before the first ## (the # title and provenance preamble) is
    // framing, not memory — skipped by design.
    if (line.startsWith('# ') || current === null) continue;
    current.lines.push(line);
  }
  return sections;
}

/**
 * Flatten a section body into its titled bullets: each `- **Title**: text`
 * item (with hanging-indent continuation lines) becomes one `Title: text`
 * string with markdown bold stripped and whitespace collapsed.
 */
function bulletFacts(lines: string[]): string[] {
  const facts: string[] = [];
  // Bare `- ` bullets flatten to '' — drop them rather than seed empty facts.
  const pushFact = (parts: string[]) => {
    const fact = joinBullet(parts);
    if (fact !== '') facts.push(fact);
  };
  let current: string[] | null = null;
  for (const line of lines) {
    if (BULLET_START.test(line)) {
      if (current) pushFact(current);
      current = [line.replace(BULLET_START, '')];
    } else if (current && line.trim() !== '') {
      current.push(line.trim());
    } else if (line.trim() === '') {
      if (current) pushFact(current);
      current = null;
    }
  }
  if (current) pushFact(current);
  return facts;
}

function joinBullet(parts: string[]): string {
  return parts
    .join(' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse oracle.md into observation rows: one per `## section`. Sections with
 * no content are dropped. Throws when nothing parses — a corpus item whose
 * ceiling control would seed zero rows is a corpus bug, not a variant.
 */
export function parseOracleObservations(markdown: string, itemId: string): ParsedObservation[] {
  const observations: ParsedObservation[] = [];
  for (const section of splitSections(markdown)) {
    const facts = bulletFacts(section.lines);
    const narrative = section.lines.join('\n').trim();
    if (facts.length === 0 && narrative === '') continue;
    observations.push({
      type: ORACLE_OBSERVATION_TYPE,
      title: section.title,
      subtitle: null,
      facts,
      narrative: narrative === '' ? null : narrative,
      concepts: [...ORACLE_OBSERVATION_CONCEPTS],
      files_read: [],
      files_modified: [],
    });
  }
  if (observations.length === 0) {
    throw new ControlSynthesisError(
      `oracle.md for ${itemId} produced no observation rows — expected ## sections with titled bullets`,
    );
  }
  return observations;
}

/** Load + parse a corpus item's oracle.md (the ceiling control's seed set). */
export async function oracleObservations(item: CorpusItem): Promise<ParsedObservation[]> {
  const path = join(item.dir, 'oracle.md');
  if (!existsSync(path)) {
    throw new ControlSynthesisError(`corpus item ${item.id} has no oracle.md (${path})`);
  }
  return parseOracleObservations(await Bun.file(path).text(), item.id);
}
