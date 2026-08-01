/**
 * Offline tests for the observe-runner conversation replay. The transport is
 * a scripted mock of queryModel — no network, no OPENROUTER_API_KEY.
 * Conversation-shape expectations follow claude-mem
 * OpenAICompatibleProvider.ts:99-119,205-218 @ 132b46343.
 */
import { describe, expect, test } from 'bun:test';
import codeMode from '../src/vendor/modes/code.json';
import type { ModeConfig } from '../src/vendor/shims/types.ts';
import type { ChatMessage, QueryModelOptions, QueryModelResult } from '../src/openrouter.ts';
import {
  JSON_ACCOMMODATION_INSTRUCTION,
  mapJsonToObservations,
  runObserveItem,
  type ObserveItemInput,
  type ObserveToolCall,
  type QueryModelFn,
} from '../src/observe-runner.ts';

const mode = codeMode as ModeConfig;

const CALL_READ: ObserveToolCall = {
  tool_name: 'Read',
  tool_input: { file_path: '/tmp/a.ts' },
  tool_output: 'file contents',
  created_at_epoch: 1_753_000_000_000,
  cwd: '/tmp',
};
const CALL_EDIT: ObserveToolCall = {
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/a.ts', old_string: 'x', new_string: 'y' },
  tool_output: { ok: true },
  created_at_epoch: 1_753_000_060_000,
};
const CALL_BASH: ObserveToolCall = {
  tool_name: 'Bash',
  tool_input: { command: 'bun test' },
  tool_output: '30 pass',
  created_at_epoch: 1_753_000_120_000,
};

function makeItem(toolCalls: ObserveToolCall[]): ObserveItemInput {
  return {
    project: 'membench',
    sessionId: 'sess-1',
    userPrompt: 'Fix the flaky test',
    mode,
    toolCalls,
  };
}

function obsXml(title: string): string {
  return `<observation><type>discovery</type><title>${title}</title><facts><fact>a fact</fact></facts></observation>`;
}

/** A reply with fully reported usage (100 in / 20 out / $0.001 per turn). */
function reply(content: string, overrides: Partial<QueryModelResult> = {}): QueryModelResult {
  return { content, inputTokens: 100, outputTokens: 20, costUsd: 0.001, ...overrides };
}

interface RecordedCall {
  model: string;
  messages: ChatMessage[];
  opts: QueryModelOptions | undefined;
}

function scriptedQuery(replies: QueryModelResult[]): { query: QueryModelFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const query: QueryModelFn = async (model, messages, opts) => {
    calls.push({ model, messages: messages.map((m) => ({ ...m })), opts });
    const scripted = replies[calls.length - 1];
    if (!scripted) throw new Error(`unexpected query call #${calls.length}`);
    return scripted;
  };
  return { query, calls };
}

describe('runObserveItem — conversation replay shape', () => {
  test('grows the history init(user) → reply(assistant) → obs(user) → reply → obs …', async () => {
    const { query, calls } = scriptedQuery([
      reply('Acknowledged. Ready to observe.'),
      reply(obsXml('First observation')),
      reply(obsXml('Second observation')),
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ, CALL_EDIT]), 'test/model', { query });

    expect(calls).toHaveLength(3);
    expect(calls[0].model).toBe('test/model');

    // Turn 1: init prompt alone, role user.
    expect(calls[0].messages).toHaveLength(1);
    expect(calls[0].messages[0].role).toBe('user');
    expect(calls[0].messages[0].content).toContain('Fix the flaky test');

    // Turn 2: init, assistant reply, first observation prompt.
    expect(calls[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(calls[1].messages[1].content).toBe('Acknowledged. Ready to observe.');
    expect(calls[1].messages[2].content).toContain('<what_happened>Read</what_happened>');
    expect(calls[1].messages[2].content).toContain('<working_directory>/tmp</working_directory>');

    // Turn 3: prior reply appended before the second observation prompt.
    expect(calls[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(calls[2].messages[3].content).toBe(obsXml('First observation'));
    expect(calls[2].messages[4].content).toContain('<what_happened>Edit</what_happened>');

    expect(outcome.observations.map((o) => o.title)).toEqual(['First observation', 'Second observation']);
    expect(outcome.accommodation).toBeUndefined();
    // A prose init acknowledgment is expected — no parse note for it.
    expect(outcome.parse_notes).toEqual([]);
    expect(outcome.usage_notes).toEqual([]);
    expect(outcome.obs_tokens_in).toBe(300);
    expect(outcome.obs_tokens_out).toBe(60);
    expect(outcome.obs_cost_usd).toBeCloseTo(0.003, 10);
  });

  test('records a parse note on invalid XML and continues (1/3 fail: no accommodation)', async () => {
    const { query, calls } = scriptedQuery([
      reply('Ready.'),
      reply(obsXml('Kept one')),
      reply('Sorry, I cannot produce XML for this.'),
      reply(obsXml('Kept two')),
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ, CALL_EDIT, CALL_BASH]), 'test/model', { query });

    expect(calls).toHaveLength(4);
    expect(outcome.observations.map((o) => o.title)).toEqual(['Kept one', 'Kept two']);
    expect(outcome.parse_notes).toHaveLength(1);
    expect(outcome.parse_notes[0]).toContain('observation turn 2 (Edit)');
    expect(outcome.parse_notes[0]).toContain('failed to parse');
    expect(outcome.accommodation).toBeUndefined();
  });

  test('an empty observe turn is a parse note, is NOT appended to history, and 1/2 (=50%) does not trigger accommodation', async () => {
    const { query, calls } = scriptedQuery([
      reply('Ready.'),
      reply('', { inputTokens: 50, outputTokens: 0, costUsd: 0.0005 }),
      reply(obsXml('Survivor')),
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ, CALL_EDIT]), 'test/model', { query });

    expect(calls).toHaveLength(3);
    // Empty reply not appended: third query sees [init, ack, obs1, obs2].
    expect(calls[2].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);

    expect(outcome.observations.map((o) => o.title)).toEqual(['Survivor']);
    expect(outcome.parse_notes).toHaveLength(1);
    expect(outcome.parse_notes[0]).toContain('observation turn 1 (Read)');
    expect(outcome.parse_notes[0]).toContain('empty response');
    // Exactly 50% fail rate is not > 50% — no accommodation re-run.
    expect(outcome.accommodation).toBeUndefined();
  });

  test('an item with no tool calls is init-only: no accommodation, no division by zero', async () => {
    const { query, calls } = scriptedQuery([
      reply('Ready.'),
    ]);

    const outcome = await runObserveItem(makeItem([]), 'test/model', { query });

    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toHaveLength(1);
    expect(outcome.observations).toEqual([]);
    expect(outcome.parse_notes).toEqual([]);
    expect(outcome.accommodation).toBeUndefined();
    // Only the init turn's real usage is summed.
    expect(outcome.obs_tokens_in).toBe(100);
    expect(outcome.obs_tokens_out).toBe(20);
    expect(outcome.obs_cost_usd).toBeCloseTo(0.001, 10);
    expect(outcome.usage_notes).toEqual([]);
  });
});

describe('runObserveItem — JSON accommodation', () => {
  test('>50% XML parse-fail re-runs with response_format json_object and maps JSON to observations', async () => {
    const { query, calls } = scriptedQuery([
      // XML pass: init ack, then both observation turns fail to parse.
      reply('Ready.'),
      reply('No XML from me, ever.'),
      reply('Still refusing to emit tags.'),
      // JSON pass: init reply, then two JSON observation replies.
      reply('{"observations": []}'),
      reply(JSON.stringify({
        observations: [{
          type: 'discovery',
          title: 'From JSON one',
          facts: ['fact one'],
          concepts: ['gotcha: WASM quirk', 'discovery'],
        }],
      })),
      reply(JSON.stringify({
        observations: [{ type: 'bugfix', title: 'From JSON two', facts: ['fact two'] }],
      })),
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ, CALL_EDIT]), 'test/model', { query });

    expect(calls).toHaveLength(6);
    // XML pass sends no response_format.
    expect(calls[0].opts?.response_format).toBeUndefined();
    expect(calls[2].opts?.response_format).toBeUndefined();
    // JSON pass: response_format on every turn, JSON instruction on the init prompt.
    expect(calls[3].opts?.response_format).toEqual({ type: 'json_object' });
    expect(calls[5].opts?.response_format).toEqual({ type: 'json_object' });
    expect(calls[3].messages[0].content).toContain(JSON_ACCOMMODATION_INSTRUCTION);
    expect(calls[3].messages[0].content).toContain('Fix the flaky test');

    expect(outcome.accommodation).toBe('json');
    expect(outcome.observations.map((o) => o.title)).toEqual(['From JSON one', 'From JSON two']);
    expect(outcome.observations[0].type).toBe('discovery');
    // Parser-parity concept cleanup: colon-truncated, observation type dropped.
    expect(outcome.observations[0].concepts).toEqual(['gotcha']);
    expect(outcome.parse_notes[0]).toContain('re-ran with JSON accommodation');
    expect(outcome.parse_notes.some((n) => n.includes('xml pass: observation turn 1'))).toBe(true);

    // Real spend covers BOTH passes: 6 turns at 100/20/$0.001.
    expect(outcome.obs_tokens_in).toBe(600);
    expect(outcome.obs_tokens_out).toBe(120);
    expect(outcome.obs_cost_usd).toBeCloseTo(0.006, 10);
    expect(outcome.usage_notes).toEqual([]);
  });
});

describe('runObserveItem — usage accounting (real values only)', () => {
  test('a turn with missing cost nulls obs_cost_usd and flags it — never guessed', async () => {
    const noCost: QueryModelResult = { content: obsXml('Costless'), inputTokens: 100, outputTokens: 20 };
    const { query } = scriptedQuery([
      reply('Ready.'),
      noCost,
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ]), 'test/model', { query });

    expect(outcome.observations.map((o) => o.title)).toEqual(['Costless']);
    // Tokens were reported on every turn → summed for real.
    expect(outcome.obs_tokens_in).toBe(200);
    expect(outcome.obs_tokens_out).toBe(40);
    // Cost missing on one turn → null + flagged, not estimated.
    expect(outcome.obs_cost_usd).toBeNull();
    expect(outcome.usage_notes).toHaveLength(1);
    expect(outcome.usage_notes[0]).toContain('observation turn 1 (Read)');
    expect(outcome.usage_notes[0]).toContain('not estimated');
  });

  test('a turn with no usage at all nulls all three sums with one flag each', async () => {
    const { query } = scriptedQuery([
      { content: 'Ready.' },
      reply(obsXml('Fine')),
    ]);

    const outcome = await runObserveItem(makeItem([CALL_READ]), 'test/model', { query });

    expect(outcome.obs_tokens_in).toBeNull();
    expect(outcome.obs_tokens_out).toBeNull();
    expect(outcome.obs_cost_usd).toBeNull();
    expect(outcome.usage_notes).toHaveLength(3);
    expect(outcome.usage_notes.every((n) => n.startsWith('init turn:'))).toBe(true);
  });
});

describe('mapJsonToObservations', () => {
  test('rejects non-JSON and shapes without an observations array', () => {
    expect(mapJsonToObservations('plain prose', mode)).toEqual({ valid: false });
    expect(mapJsonToObservations('{"foo": 1}', mode)).toEqual({ valid: false });
  });

  test('{"observations": []} is the valid JSON skip', () => {
    const mapped = mapJsonToObservations('{"observations": []}', mode);
    expect(mapped.valid).toBe(true);
    if (mapped.valid) expect(mapped.observations).toEqual([]);
  });

  test('missing type falls back to the mode\'s first observation type; empty entries are dropped', () => {
    const mapped = mapJsonToObservations(JSON.stringify({
      observations: [
        { title: 'No type given', facts: ['f'] },
        { type: 'discovery' }, // no content fields → dropped, like parser.ts:140-146
      ],
    }), mode);
    expect(mapped.valid).toBe(true);
    if (mapped.valid) {
      expect(mapped.observations).toHaveLength(1);
      expect(mapped.observations[0].type).toBe(mode.observation_types[0].id);
      expect(mapped.observations[0].title).toBe('No type given');
    }
  });
});
