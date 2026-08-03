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
    // A prose init acknowledgment is expected — no parse note for it.
    expect(outcome.parse_notes).toEqual([]);
    expect(outcome.usage_notes).toEqual([]);
    expect(outcome.obs_tokens_in).toBe(300);
    expect(outcome.obs_tokens_out).toBe(60);
    expect(outcome.obs_cost_usd).toBeCloseTo(0.003, 10);
  });

  test('records a parse note on invalid XML and continues', async () => {
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
  });

  test('an empty observe turn is a parse note and is NOT appended to history', async () => {
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
  });

  test('an item with no tool calls is init-only: no division by zero', async () => {
    const { query, calls } = scriptedQuery([
      reply('Ready.'),
    ]);

    const outcome = await runObserveItem(makeItem([]), 'test/model', { query });

    expect(calls).toHaveLength(1);
    expect(calls[0].messages).toHaveLength(1);
    expect(outcome.observations).toEqual([]);
    expect(outcome.parse_notes).toEqual([]);
    // Only the init turn's real usage is summed.
    expect(outcome.obs_tokens_in).toBe(100);
    expect(outcome.obs_tokens_out).toBe(20);
    expect(outcome.obs_cost_usd).toBeCloseTo(0.001, 10);
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
