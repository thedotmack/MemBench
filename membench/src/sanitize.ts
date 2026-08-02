/**
 * Corpus sanitizer — plan Phase 3 / §0.2 guard 10.
 *
 * A versioned regex pass over every string that ends up in a corpus item
 * (transcript rows, tool call records, repo.lock, task.md): key-shaped
 * tokens are redacted and the recording user's home path is rewritten to
 * /Users/user. Every replacement is logged as a Redaction so the per-item
 * sanitization report can be hand-reviewed before freezing.
 *
 * Report safety: context snippets are re-sanitized with the full rule set
 * before being recorded, so a snippet can never leak an adjacent secret
 * that a later rule would have caught in the actual output.
 */

/**
 * Bump when rules change; recorded in provenance.json.
 * v2: email redaction + allowlist, extra-strings literal list.
 * v3: gho_/ghs_ GitHub token variants; PEM rule also matches
 *     `-----BEGIN PGP PRIVATE KEY BLOCK-----` (BLOCK suffix).
 */
export const SANITIZER_VERSION = 3;

/**
 * Emails preserved verbatim (v2). Everything else email-shaped is redacted —
 * including synthetic test-fixture emails (redacting those is fine and
 * simpler than allowlisting them). Compared lowercased.
 *   - thedotmack@gmail.com: the repo owner's own public email (in repo source)
 *   - noreply@anthropic.com: Anthropic's public Co-Authored-By address
 *   - git@github.com: SSH remote user@host (infrastructure identifier, not a
 *     personal email) — redacting it would corrupt cloneable repo.lock URLs
 */
export const EMAIL_ALLOWLIST: readonly string[] = [
  'thedotmack@gmail.com',
  'noreply@anthropic.com',
  'git@github.com',
];

/**
 * Exact literal third-party strings to redact (v2), e.g. customer names and
 * usernames surfaced inside mem-search results or git contributor metadata.
 * Matched case-insensitively (so "ChenglinWei97" and "chenglinwei97" both
 * hit). Append as corpus reviews surface more.
 */
const EXTRA_REDACTION_STRINGS: readonly string[] = [
  'Jorge Rebuffo',
  'timvanmaurik7',
  'chenglinwei97',
];

/** One rule's replacements at one location (file + row/field path). */
export interface Redaction {
  /** Which rule fired, e.g. "sk-key", "username". */
  rule: string;
  /** Where the redaction landed, e.g. "transcript.jsonl row 12: .toolUseResult.stdout". */
  location: string;
  /** Number of replacements this rule made at this location. */
  count: number;
  /** Post-sanitization context snippets (never the original secret). */
  contexts: string[];
}

interface Rule {
  name: string;
  /** Must carry the `g` flag. */
  pattern: RegExp;
  replacement: string;
  /** Return true to preserve a match verbatim (allowlist hook). */
  keep?: (match: string) => boolean;
}

/**
 * Ordered rule list (order matters: PEM blocks and JWTs are consumed before
 * the generic Bearer rule so each secret gets its most specific label; the
 * email rule runs before the extra-strings list so `<extra-string>@host`
 * redacts cleanly as one `[REDACTED:email]`; the bare-username catchall runs
 * last).
 */
const RULES: readonly Rule[] = [
  {
    name: 'pem-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]*KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*KEY(?: BLOCK)?-----/g,
    replacement: '[REDACTED:pem-key]',
  },
  {
    name: 'jwt',
    pattern: /eyJhbGciOi[A-Za-z0-9_=-]+(?:\.[A-Za-z0-9_=-]+)*/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    name: 'sk-key',
    pattern: /\bsk-[A-Za-z0-9_-]{8,}/g,
    replacement: '[REDACTED:sk-key]',
  },
  {
    // ghp_ (personal), gho_ (OAuth), ghs_ (server-to-server).
    name: 'github-token',
    pattern: /\bgh[pos]_[A-Za-z0-9]{16,}/g,
    replacement: '[REDACTED:github-token]',
  },
  {
    name: 'github-pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
    replacement: '[REDACTED:github-pat]',
  },
  {
    name: 'aws-key-id',
    pattern: /\bAKIA[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:aws-key-id]',
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: 'Bearer [REDACTED:token]',
  },
  {
    name: 'email',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replacement: '[REDACTED:email]',
    keep: (match) => EMAIL_ALLOWLIST.includes(match.toLowerCase()),
  },
  ...(EXTRA_REDACTION_STRINGS.length > 0
    ? [
        {
          name: 'extra-string',
          pattern: new RegExp(EXTRA_REDACTION_STRINGS.map((s) => RegExp.escape(s)).join('|'), 'gi'),
          replacement: '[REDACTED:name]',
        },
      ]
    : []),
  {
    // Catchall so `grep -rn "alexnewman" corpus/` ends empty (guard 10). Also
    // covers home paths (/Users/alexnewman → /Users/user) and Claude Code's
    // path-encoded project dir names (-Users-alexnewman → -Users-user) —
    // byte-identical output to dedicated path rules.
    name: 'username',
    pattern: /alexnewman/g,
    replacement: 'user',
  },
];

const CONTEXT_RADIUS = 40;
const MAX_CONTEXTS_PER_ENTRY = 3;

/** Collapse whitespace so a context snippet stays a one-line table cell. */
function oneLine(snippet: string): string {
  return snippet.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize one string, appending one Redaction per rule that fired.
 */
export function sanitizeString(input: string, location: string, report: Redaction[]): string {
  let current = input;
  for (const rule of RULES) {
    const matches = [...current.matchAll(rule.pattern)].filter((match) => !rule.keep?.(match[0]));
    if (matches.length === 0) continue;
    const contexts: string[] = [];
    let output = '';
    let last = 0;
    for (const match of matches) {
      const start = match.index;
      output += current.slice(last, start) + rule.replacement;
      last = start + match[0].length;
      if (contexts.length < MAX_CONTEXTS_PER_ENTRY) {
        const before = current.slice(Math.max(0, start - CONTEXT_RADIUS), start);
        const after = current.slice(last, last + CONTEXT_RADIUS);
        // Context snippets are re-sanitized with the full rule set (report
        // thrown away) so a snippet never leaks an adjacent secret.
        contexts.push(sanitizeString(oneLine(before + rule.replacement + after), '', []));
      }
    }
    output += current.slice(last);
    current = output;
    report.push({ rule: rule.name, location, count: matches.length, contexts });
  }
  return current;
}

/**
 * Deep-sanitize a JSON-ish value: every string field (values AND object
 * keys) goes through sanitizeString; numbers/booleans/null pass through.
 * Covers toolUseResult.stdout/stderr/content/originalFile, Bash
 * input.command, MCP results, and everything else without a field list.
 */
export function sanitizeValue<T>(value: T, location: string, report: Redaction[]): T {
  if (typeof value === 'string') {
    return sanitizeString(value, location, report) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(item, `${location}[${i}]`, report)) as T;
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = sanitizeString(key, `${location}.${key} (key)`, report);
      result[cleanKey] = sanitizeValue(item, `${location}.${key}`, report);
    }
    return result as T;
  }
  return value;
}
