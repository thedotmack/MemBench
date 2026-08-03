/**
 * `membench publish` — redacted, reviewable result bundles (plan Phase 7.2).
 *
 * ORSB convention (§0.1): raw run artifacts stay in gitignored `runs/`; what
 * gets COMMITTED is a redacted bundle under `published-runs/<run-id>/`, and
 * only after a human has read it.
 *
 * The bundle carries exactly what a reader needs to check the numbers:
 *
 *   results.jsonl       one row per fork-run (the raw measurements)
 *   summary.json        every derived number, machine-readable
 *   scoreboard.md       the rendering
 *   run-spec.toml       the reviewed spec the run was launched from
 *   run-meta.json       run identity + variants + shuffled map + spec
 *                       (machine-local absolute paths REMOVED)
 *   corpus-hashes.json  the frozen corpus content hashes the run measured
 *   README.md           what this is, how to reproduce it, OpenRouter citation
 *
 * REDACTED OUT, deliberately: executor transcripts, git diffs, fork/ trees,
 * per-model observation artifacts and judge.jsonl (which quotes raw model
 * replies). Those stay in `runs/` for audit.
 *
 * After writing, the bundle is SELF-CHECKED for leaked machine paths, key-
 * shaped tokens and third-party emails. Any hit deletes the bundle and refuses
 * — a published bundle is a commit, and an unpublish is not a thing.
 */

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { EMAIL_ALLOWLIST } from './sanitize.js';
import {
  renderScoreboard,
  requireManifest,
  runIdError,
  summarizeRun,
  type RunManifest,
  type RunSummary,
} from './scoreboard.js';

export class PublishError extends Error {}

/** Repo-root published-runs/ resolved from this file's location (membench/src/). */
export function defaultPublishedRunsDir(): string {
  return join(import.meta.dir, '..', '..', 'published-runs');
}

// ---------------------------------------------------------------------------
// Self-check
// ---------------------------------------------------------------------------

export interface LeakPattern {
  name: string;
  pattern: RegExp;
  /** Optional filter: return false to accept a match (e.g. allowlisted emails). */
  accept?: (match: string) => boolean;
}

/**
 * The sanitizer rewrites the recording user's home to these placeholders
 * (sanitize.ts v3 `username` rule). They are what a CLEAN corpus looks like,
 * so refusing them would make every legitimate run unpublishable — while any
 * OTHER user path still refuses.
 */
const SANITIZED_HOME = '/Users/user';
const SANITIZED_ENCODED_HOME = /^-Users-user(-|$)/;

/**
 * Emails that are not third-party leaks:
 *   - sanitize.ts's EMAIL_ALLOWLIST — the repo owner's own public address,
 *     Anthropic's public Co-Authored-By address, and the git@github.com SSH
 *     remote user@host. These survive sanitization by design, so refusing them
 *     here would make a correctly sanitized run unpublishable.
 *   - the RFC 2606/6761 reserved TLDs (`example.*`, `*.invalid`) the fixtures
 *     and mocks use: reserved names cannot belong to a real third party.
 */
const RESERVED_EMAIL_DOMAINS = /(?:@example\.(?:com|org|net)|\.invalid|\.test)$/i;

function isAllowedEmail(match: string): boolean {
  return EMAIL_ALLOWLIST.includes(match.toLowerCase()) || RESERVED_EMAIL_DOMAINS.test(match);
}

/**
 * What a published bundle may never contain. Patterns are deliberately shaped
 * (length-bounded token bodies, not bare prefixes) so ordinary words — `task-`
 * contains `sk-` — cannot false-positive a refusal into permanent uselessness.
 */
export const LEAK_PATTERNS: LeakPattern[] = [
  {
    name: 'absolute /Users/ path',
    pattern: /\/Users\/[A-Za-z0-9._-]+/g,
    accept: (match) => match === SANITIZED_HOME,
  },
  {
    // Claude Code's path-encoded project dir names (-Users-<user>-Scripts-…),
    // the form the plain-path rule cannot see.
    name: 'encoded home path',
    pattern: /-Users-[A-Za-z0-9._-]+/g,
    accept: (match) => SANITIZED_ENCODED_HOME.test(match),
  },
  { name: 'OpenAI/OpenRouter-style API key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'GitHub fine-grained PAT', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{12,}/g },
  { name: 'JWT / bearer JSON web token', pattern: /eyJhbGciOi[A-Za-z0-9_.-]{8,}/g },
  { name: 'Authorization: Bearer token', pattern: /\bBearer\s+[A-Za-z0-9._-]{12,}/g },
  {
    // Parity with sanitize.ts:85 — the ` BLOCK` suffix catches
    // `-----BEGIN PGP PRIVATE KEY BLOCK-----`.
    name: 'PEM key block',
    pattern: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)(?: BLOCK)?-----/g,
  },
  {
    name: 'third-party email address',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: isAllowedEmail,
  },
];

export interface LeakHit {
  file: string;
  line: number;
  pattern: string;
  /** The offending text, masked in the middle so a refusal never re-leaks a key. */
  masked: string;
}

/** Mask all but the first 4 characters, so the report says WHAT without repeating it. */
export function maskSecret(text: string): string {
  if (text.length <= 6) return `${text.slice(0, 2)}…`;
  return `${text.slice(0, 4)}…(${text.length} chars)`;
}

/** Scan one text blob for leaks. `file` is the label used in the report. */
export function scanTextForLeaks(file: string, text: string): LeakHit[] {
  const hits: LeakHit[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (const { name, pattern, accept } of LEAK_PATTERNS) {
      // Fresh regex per line: /g lastIndex must not leak across lines.
      const matcher = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(line)) !== null) {
        if (accept?.(match[0])) continue;
        hits.push({ file, line: index + 1, pattern: name, masked: maskSecret(match[0]) });
        if (hits.length > 200) return hits; // a flood is already a refusal
      }
    }
  }
  return hits;
}

/** Scan every file of a written bundle. */
export async function scanBundle(bundleDir: string, files: string[]): Promise<LeakHit[]> {
  const hits: LeakHit[] = [];
  for (const relative of files) {
    const path = join(bundleDir, relative);
    if (!existsSync(path)) continue;
    hits.push(...scanTextForLeaks(relative, await Bun.file(path).text()));
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------

/**
 * The manifest with machine-local absolute paths stripped. `spec_path`,
 * `corpus_dir` and `runs_dir` are exactly the fields that carry the operator's
 * home directory — they are dropped, not rewritten.
 */
export function redactManifest(manifest: RunManifest | null): Record<string, unknown> {
  if (!manifest) return { note: 'no manifest.json in the run directory' };
  const { spec_path, corpus_dir, runs_dir, ...rest } = manifest;
  return {
    ...rest,
    redaction_note:
      'machine-local paths (spec_path, corpus_dir, runs_dir) removed by `membench publish`; ' +
      'transcripts, diffs, fork trees, observe artifacts and judge replies are not published',
  };
}

function bundleReadme(summary: RunSummary, hasSpec: boolean): string {
  return `# MemBench published run \`${summary.run_id}\`

${summary.mock ? '> **MOCK RUN — every token and cost number here is fabricated by the offline mocks. Do not cite.**\n\n' : ''}Redacted result bundle written by \`membench publish\`. Raw transcripts, git diffs,
fork trees, per-model observation artifacts and judge replies are deliberately
NOT included; they stay in the runner's gitignored \`runs/\` directory for audit.

## Contents

| file | what it is |
|---|---|
| \`results.jsonl\` | one row per fork-run — the raw measurements |
| \`summary.json\` | every derived number, machine-readable |
| \`scoreboard.md\` | the rendered scoreboard (sectioned by executor) |
${hasSpec ? '| `run-spec.toml` | the reviewed run spec this run was launched from |\n' : ''}| \`run-meta.json\` | run identity, variants, shuffled-control mapping, spec |
| \`corpus-hashes.json\` | frozen corpus content hashes this run measured |

## Reproduce

\`\`\`bash
git clone <this repo> && cd MemBench/membench
bun install
bun test                      # offline suite
bun src/cli.ts run --spec run-specs/<spec>.toml --run-id <new-id> --approve-cost-usd <ceiling>
bun src/cli.ts score --run-id <new-id>
\`\`\`

The corpus item content hashes in \`corpus-hashes.json\` must match the frozen
\`corpus/\` items, or the runner refuses to start — a published number always
names the exact bytes it measured.

## Credits

All observer, executor (openrouter-agent lane) and judge models are routed
through [OpenRouter](https://openrouter.ai). Every cost in this bundle is a
reported \`usage.cost\` value; nothing is priced from a table or estimated.
`;
}

export interface PublishOptions {
  runDir: string;
  runId: string;
  bundleDir: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  now?: Date;
}

export interface PublishResult {
  bundleDir: string;
  files: string[];
  summary: RunSummary;
}

/**
 * Write the redacted bundle, then self-check it. On any leak the bundle
 * directory is deleted (partial output cleaned up) and PublishError is thrown
 * with the full what/where list.
 */
export async function publishRun(options: PublishOptions): Promise<PublishResult> {
  const { runDir, runId, bundleDir } = options;
  const log = options.log ?? ((message: string) => console.log(message));
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const problem = runIdError(runId);
  if (problem) {
    // A run id becomes a path here, and a failed self-check DELETES that path.
    throw new PublishError(problem);
  }
  if (!existsSync(runDir)) {
    throw new PublishError(`run directory not found: ${runDir}`);
  }
  const resultsPath = join(runDir, 'results.jsonl');
  if (!existsSync(resultsPath)) {
    throw new PublishError(`run "${runId}" has no results.jsonl at ${resultsPath} — nothing to publish`);
  }
  // No silent overwrite: a published bundle is a reviewed artifact.
  if (existsSync(bundleDir)) {
    throw new PublishError(
      `published bundle already exists: ${bundleDir} — refusing to overwrite it. ` +
        'Remove it deliberately (after checking what is already committed) or publish under a different run id.',
    );
  }

  // Both refuse a run whose manifest is missing/unparseable: a bundle must
  // always be able to say whether its numbers are real or mock.
  const summary = await summarizeRun({ runDir, runId, warn, ...(options.now ? { now: options.now } : {}) });
  const manifest = await requireManifest(runDir, runId);

  const files: string[] = [];
  mkdirSync(bundleDir, { recursive: true });
  try {
    cpSync(resultsPath, join(bundleDir, 'results.jsonl'));
    files.push('results.jsonl');

    await Bun.write(join(bundleDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    files.push('summary.json');

    await Bun.write(join(bundleDir, 'scoreboard.md'), renderScoreboard(summary));
    files.push('scoreboard.md');

    // The run spec is a reviewed, committed, machine-agnostic file — copy it
    // verbatim when the manifest still points at it.
    let hasSpec = false;
    if (manifest?.spec_path && existsSync(manifest.spec_path)) {
      cpSync(manifest.spec_path, join(bundleDir, 'run-spec.toml'));
      files.push('run-spec.toml');
      hasSpec = true;
    } else if (manifest?.spec) {
      log('note: the original spec file is gone; the validated spec is still recorded in run-meta.json');
    }

    await Bun.write(join(bundleDir, 'run-meta.json'), JSON.stringify(redactManifest(manifest), null, 2) + '\n');
    files.push('run-meta.json');

    const hashes = Object.fromEntries((manifest?.items ?? []).map((item) => [item.id, item.content_hash]));
    await Bun.write(
      join(bundleDir, 'corpus-hashes.json'),
      JSON.stringify(
        {
          note: 'sorted-file sha256 of each frozen corpus item (provenance.json + sanitization report excluded)',
          items: hashes,
        },
        null,
        2,
      ) + '\n',
    );
    files.push('corpus-hashes.json');

    await Bun.write(join(bundleDir, 'README.md'), bundleReadme(summary, hasSpec));
    files.push('README.md');

    const hits = await scanBundle(bundleDir, files);
    if (hits.length > 0) {
      rmSync(bundleDir, { recursive: true, force: true });
      const detail = hits
        .slice(0, 40)
        .map((hit) => `  ${hit.file}:${hit.line} — ${hit.pattern}: ${hit.masked}`)
        .join('\n');
      throw new PublishError(
        `self-check FAILED: ${hits.length} leak(s) found; the bundle was deleted and nothing was published.\n` +
          `${detail}${hits.length > 40 ? `\n  … and ${hits.length - 40} more` : ''}\n` +
          '  Fix the run artifacts (or the sanitizer) and publish again.',
      );
    }
  } catch (error: unknown) {
    // Any failure mid-assembly leaves no half-written bundle behind.
    if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true, force: true });
    throw error instanceof PublishError
      ? error
      : new PublishError(`publish failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { bundleDir, files, summary };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const PUBLISH_HELP = `Usage: membench publish --run-id <id> [options]

Writes a REDACTED bundle to published-runs/<run-id>/ — results.jsonl,
summary.json, scoreboard.md, the run spec, corpus hashes. No transcripts, no
diffs, no fork trees, no judge replies.

Required:
  --run-id <id>            the completed run to publish

Options:
  --runs-dir <path>        default: MEMBENCH_RUNS_DIR or ./runs
  --published-dir <path>   default: <repo-root>/published-runs
  -h, --help               show this help

The bundle is self-checked for machine paths, key-shaped tokens and
third-party emails; any hit deletes the bundle and refuses to publish.
`;

interface PublishFlags {
  runId?: string;
  runsDir?: string;
  publishedDir?: string;
  help: boolean;
}

function parsePublishFlags(args: string[]): PublishFlags {
  const { values } = parseArgs({
    args,
    options: {
      'run-id': { type: 'string' },
      'runs-dir': { type: 'string' },
      'published-dir': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  return {
    runId: values['run-id'],
    runsDir: values['runs-dir'],
    publishedDir: values['published-dir'],
    help: values.help ?? false,
  };
}

/** `membench publish`. Returns a process exit code; never throws for user errors. */
export async function publishMain(
  args: string[],
  overrides: { log?: (message: string) => void } = {},
): Promise<number> {
  const log = overrides.log ?? ((message: string) => console.log(message));
  let flags: PublishFlags;
  try {
    flags = parsePublishFlags(args);
  } catch (error: unknown) {
    console.error(`membench publish: ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(PUBLISH_HELP);
    return 1;
  }
  if (flags.help) {
    log(PUBLISH_HELP);
    return 0;
  }
  if (!flags.runId) {
    console.error('membench publish: --run-id is required\n');
    console.error(PUBLISH_HELP);
    return 1;
  }
  const invalidRunId = runIdError(flags.runId);
  if (invalidRunId) {
    console.error(`membench publish: ${invalidRunId}`);
    return 1;
  }

  const config = loadConfig({ ...(flags.runsDir ? { runsDir: flags.runsDir } : {}) });
  const runDir = join(resolve(config.runsDir), flags.runId);
  const bundleDir = join(resolve(flags.publishedDir ?? defaultPublishedRunsDir()), flags.runId);

  try {
    const result = await publishRun({ runDir, runId: flags.runId, bundleDir, log });
    log(`published bundle: ${result.bundleDir}`);
    for (const file of result.files) log(`  ${file}`);
    log('self-check passed: no machine paths, key-shaped tokens or third-party emails.');
    if (result.summary.mock) {
      log('!! this run is a MOCK run — its costs and tokens are fabricated. Do not present it as a result.');
    }
    log('');
    log('REMINDER: this bundle is NOT committed yet. Read it end to end first — publishing is a commit,');
    log('          and every number in it becomes a claim you have to stand behind.');
    return 0;
  } catch (error: unknown) {
    console.error(`membench publish: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
