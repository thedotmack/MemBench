/**
 * Behavior tests for the VENDORED parser (claude-mem src/sdk/parser.ts
 * @ 132b46343) — fixtures built against the vendored source, not rewritten
 * logic (plan §0.2 guard 6). Offline; no network.
 */
import { describe, expect, test } from 'bun:test';
import { parseAgentXml } from '../src/vendor/parser.ts';

const OBSERVATION_A = `<observation>
  <type>discovery</type>
  <title>Worker port is env-driven</title>
  <subtitle>Env beats settings</subtitle>
  <facts>
    <fact>CLAUDE_MEM_WORKER_PORT overrides settings</fact>
    <fact>Settings fall back to the default port</fact>
  </facts>
  <narrative>The worker port resolution prefers the environment.</narrative>
  <concepts>
    <concept>how-it-works</concept>
    <concept>gotcha: exact-string matched downstream</concept>
  </concepts>
  <files_read>
    <file>src/shared/SettingsDefaultsManager.ts</file>
  </files_read>
  <files_modified>
  </files_modified>
</observation>`;

const OBSERVATION_B = `<observation>
  <type>bugfix</type>
  <title>Locked JSONL appends</title>
  <facts><fact>Appends are serialized per path</fact></facts>
  <narrative>Concurrent appends no longer interleave.</narrative>
</observation>`;

describe('vendored parseAgentXml', () => {
  test('parses valid multi-observation XML (fields, arrays, concept cleanup)', () => {
    const parsed = parseAgentXml(`${OBSERVATION_A}\n${OBSERVATION_B}`, 'parser-test');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.summary).toBeNull();

    const [a, b] = parsed.observations;
    expect(a.type).toBe('discovery');
    expect(a.title).toBe('Worker port is env-driven');
    expect(a.subtitle).toBe('Env beats settings');
    expect(a.facts).toHaveLength(2);
    // Concept cleanup: colon-prefixed tag truncated at ':' (parser.ts:121-129).
    expect(a.concepts).toEqual(['how-it-works', 'gotcha']);
    expect(a.files_read).toEqual(['src/shared/SettingsDefaultsManager.ts']);
    expect(a.files_modified).toEqual([]);
    expect(b.type).toBe('bugfix');
  });

  test('parses fenced XML (```xml ... ```)', () => {
    const fenced = '```xml\n' + OBSERVATION_B + '\n```';
    const parsed = parseAgentXml(fenced, 'parser-test');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].title).toBe('Locked JSONL appends');
  });

  test('a valid observation embedded in surrounding prose still parses', () => {
    const embedded = `Sure — here is what I recorded from that tool use:

${OBSERVATION_B}

Let me know if you want more detail on the append path.`;
    const parsed = parseAgentXml(embedded, 'parser-test');
    expect(parsed.valid).toBe(true);
    if (!parsed.valid) return;
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.observations[0].title).toBe('Locked JSONL appends');
  });

  test('<skip_summary/> yields a valid skipped summary (reason captured when present)', () => {
    const bare = parseAgentXml('<skip_summary/>', 'parser-test');
    expect(bare.valid).toBe(true);
    if (bare.valid) {
      expect(bare.observations).toEqual([]);
      expect(bare.summary?.skipped).toBe(true);
      expect(bare.summary?.skip_reason).toBeNull();
    }

    const reasoned = parseAgentXml('<skip_summary reason="trivial session"/>', 'parser-test');
    expect(reasoned.valid).toBe(true);
    if (reasoned.valid) {
      expect(reasoned.summary?.skip_reason).toBe('trivial session');
    }
  });

  test('plain prose is {valid:false}', () => {
    expect(parseAgentXml('Skipping — no substantive tool executions.', 'parser-test')).toEqual({ valid: false });
    expect(parseAgentXml('', 'parser-test')).toEqual({ valid: false });
    expect(parseAgentXml('   \n  ', 'parser-test')).toEqual({ valid: false });
  });

  test('unknown observation type is preserved, not coerced', () => {
    const parsed = parseAgentXml(`<observation>
  <type>totally_unknown_type</type>
  <title>Kept as-is</title>
  <facts><fact>Unknown types survive parsing</fact></facts>
</observation>`, 'parser-test');
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.observations[0].type).toBe('totally_unknown_type');
    }
  });

  test('an all-empty observation is dropped; zero surviving observations → {valid:false}', () => {
    const parsed = parseAgentXml(`<observation>
  <type>discovery</type>
  <title></title>
  <facts></facts>
</observation>`, 'parser-test');
    expect(parsed).toEqual({ valid: false });
  });

  test('summary block parses; a tagless summary is rejected as a false positive', () => {
    const parsed = parseAgentXml(`<summary>
  <request>Fix the flaky test</request>
  <learned>The race was in the append path</learned>
</summary>`, 'parser-test');
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.summary?.request).toBe('Fix the flaky test');
      expect(parsed.summary?.learned).toBe('The race was in the append path');
      expect(parsed.observations).toEqual([]);
    }

    expect(parseAgentXml('<summary>just prose, no sub-tags</summary>', 'parser-test')).toEqual({ valid: false });
  });
});
