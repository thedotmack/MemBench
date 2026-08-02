/**
 * Smoke tests that the vendored files resolve through their import shims and
 * behave. Full parser behavior tests arrive in Phase 2 (tests/parser.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { buildInitPrompt, buildObservationPrompt } from '../src/vendor/prompts.ts';
import { parseAgentXml } from '../src/vendor/parser.ts';
import codeMode from '../src/vendor/modes/code.json';
import type { ModeConfig } from '../src/vendor/shims/types.ts';

const mode = codeMode as ModeConfig;

describe('vendored surfaces (shims resolve, logic intact)', () => {
  test('code mode carries the 8 observation types', () => {
    expect(mode.observation_types.map((t) => t.id)).toEqual([
      'bugfix',
      'feature',
      'refactor',
      'change',
      'discovery',
      'decision',
      'security_alert',
      'security_note',
    ]);
  });

  test('buildInitPrompt renders the observation skeleton from the mode', () => {
    const prompt = buildInitPrompt('membench', 'session-1', 'Fix the flaky test', mode);
    expect(prompt).toContain('<user_request>Fix the flaky test</user_request>');
    expect(prompt).toContain('bugfix | feature | refactor | change | discovery | decision');
    expect(prompt).toContain(mode.prompts.header_memory_start);
  });

  test('buildObservationPrompt truncates oversized fields with an elided marker (16k budget)', () => {
    const prompt = buildObservationPrompt({
      id: 0,
      tool_name: 'Read',
      tool_input: JSON.stringify({ file_path: '/tmp/big.txt' }),
      tool_output: 'x'.repeat(40_000),
      created_at_epoch: 1_753_000_000_000,
    });
    expect(prompt).toContain('<elided chars=');
    expect(prompt).toContain('reason="oversize"');
  });

  test('parseAgentXml parses a valid observation and rejects prose', () => {
    const xml = `<observation>
  <type>discovery</type>
  <title>Worker port is env-driven</title>
  <facts><fact>CLAUDE_MEM_WORKER_PORT beats settings</fact></facts>
  <narrative>Env overrides settings for the worker port.</narrative>
  <concepts><concept>how-it-works</concept></concepts>
</observation>`;
    const parsed = parseAgentXml(xml, 'vendor-smoke');
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.observations.length).toBe(1);
      expect(parsed.observations[0].type).toBe('discovery');
      expect(parsed.observations[0].concepts).toEqual(['how-it-works']);
    }
    expect(parseAgentXml('Skipping — nothing substantive.', 'vendor-smoke')).toEqual({ valid: false });
  });
});
