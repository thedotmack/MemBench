/**
 * Offline tests for the ported OpenRouter client. Mock pattern from
 * vancouver tests/gemini_agent.test.ts:126-206 — swap global.fetch in
 * beforeEach, restore in afterEach, assert call count/URL/outbound body.
 * No network; OPENROUTER_API_KEY is never required (every call passes an
 * explicit apiKey and fetch is always mocked).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { isClassified } from '../src/provider-errors.ts';
import { OPENROUTER_API_URL, queryModel } from '../src/openrouter.ts';

const MODEL = 'test/model-1';
const OPTS = { apiKey: 'test-api-key', baseDelayMs: 1 };
const MESSAGES = [{ role: 'user' as const, content: 'observe this' }];

function okResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    model: 'test/model-1-served',
    choices: [{ message: { role: 'assistant', content: '<observation><type>discovery</type><title>T</title><facts><fact>F</fact></facts></observation>' } }],
    usage: {
      prompt_tokens: 120,
      completion_tokens: 40,
      total_tokens: 160,
      cost: 0.001,
      cost_details: { upstream_inference_cost: 0.002 },
    },
    ...overrides,
  }), { status: 200 });
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = global.fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  mock.restore();
});

describe('queryModel — request shape', () => {
  test('POSTs the production body to the OpenRouter URL with usage:{include:true}', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(OPENROUTER_API_URL);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer test-api-key');
    expect(headers['HTTP-Referer']).toBe('https://github.com/thedotmack/MemBench');
    expect(headers['X-Title']).toBe('MemBench');

    const body = JSON.parse(init.body as string);
    expect(body.usage).toEqual({ include: true });
    expect(body.model).toBe(MODEL);
    expect(body.messages).toEqual(MESSAGES);
    expect(body.temperature).toBe(0.3);
    expect(body.max_tokens).toBe(4096);
    expect(body.response_format).toBeUndefined();

    expect(result.content).toContain('<observation>');
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(40);
    // usage.cost + cost_details.upstream_inference_cost (never estimated).
    expect(result.costUsd).toBeCloseTo(0.003, 10);
    expect(result.servedModel).toBe('test/model-1-served');
  });

  test('forwards response_format when a caller asks for JSON output', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await queryModel(MODEL, MESSAGES, { ...OPTS, response_format: { type: 'json_object' } });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  test('cacheControl:true adds the top-level cache_control field (billing-only, output-neutral)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await queryModel(MODEL, MESSAGES, { ...OPTS, cacheControl: true });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    // Output-neutral: caching must not perturb what the run measures.
    expect(body.messages).toEqual(MESSAGES);
    expect(body.temperature).toBe(0.3);
    expect(body.usage).toEqual({ include: true });
  });

  test('cache_control is ABSENT by default (opt-in only)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await queryModel(MODEL, MESSAGES, OPTS);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('cache_control' in body).toBe(false);
  });

  test('cacheControl:false stays absent (no falsy field emitted)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await queryModel(MODEL, MESSAGES, { ...OPTS, cacheControl: false });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect('cache_control' in body).toBe(false);
  });

  test('temperature/maxTokens are overridable (judge reuse) while defaults stay the observe shape', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    await queryModel(MODEL, MESSAGES, { ...OPTS, temperature: 0, maxTokens: 8192 });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(8192);
  });

  test('throws without touching the network when no API key is available', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse()));
    global.fetch = fetchMock as unknown as typeof fetch;

    // apiKey: '' is falsy and never falls back to the environment key.
    await expect(queryModel(MODEL, MESSAGES, { apiKey: '' })).rejects.toThrow('OPENROUTER_API_KEY not set');
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });
});

describe('queryModel — retry and classification', () => {
  test('429 then success: retried once, Retry-After honored over backoff', async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } }));
      }
      return Promise.resolve(okResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const started = Date.now();
    // baseDelayMs 5000: if the exponential backoff were used instead of the
    // Retry-After value (0s), this test would take >= 5s.
    const result = await queryModel(MODEL, MESSAGES, { apiKey: 'test-api-key', baseDelayMs: 5000 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.inputTokens).toBe(120);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('500 then success: retried as transient', async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response('upstream exploded', { status: 500 }));
      }
      return Promise.resolve(okResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('<observation>');
  });

  test('401 is NOT retried and classifies as auth_invalid', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('bad key', { status: 401 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      expect(thrown.kind).toBe('auth_invalid');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('400 is NOT retried and classifies as unrecoverable', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('bad request', { status: 400 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      expect(thrown.kind).toBe('unrecoverable');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('quota body marker beats status: "Insufficient credits" → quota_exhausted, no retry', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('Insufficient credits to complete request', { status: 402 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      expect(thrown.kind).toBe('quota_exhausted');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a rejected fetch (network error) retries as transient, then succeeds', async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls++;
      if (calls === 1) {
        return Promise.reject(new TypeError('fetch failed'));
      }
      return Promise.resolve(okResponse());
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.content).toContain('<observation>');
  });

  test('a fetch that always rejects exhausts retries with kind transient', async () => {
    const fetchMock = mock(() => Promise.reject(new TypeError('fetch failed')));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      expect(thrown.kind).toBe('transient');
      expect(thrown.message).toContain('fetch failed');
    }
    // Initial attempt + maxRetries (2 default) = 3 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('429 on every attempt exhausts retries: 3 fetch calls, rate_limit preserved', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      expect(thrown.kind).toBe('rate_limit');
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  test('200 response carrying an error body is re-thrown (OpenRouter spec)', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: { code: 'moderation', message: 'flagged input' },
    }), { status: 200 })));
    global.fetch = fetchMock as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await queryModel(MODEL, MESSAGES, OPTS);
    } catch (err) {
      thrown = err;
    }
    expect(isClassified(thrown)).toBe(true);
    if (isClassified(thrown)) {
      // status 200 + no quota marker → final unrecoverable branch.
      expect(thrown.kind).toBe('unrecoverable');
      expect(thrown.message).toContain('moderation');
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('queryModel — usage extraction (real values only)', () => {
  test('missing usage.cost → costUsd === undefined (never estimated)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse({
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(result.costUsd).toBeUndefined();
    expect(result.inputTokens).toBe(10);
    expect(result.outputTokens).toBe(5);
  });

  test('missing usage entirely → tokens and cost all undefined', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse({ usage: undefined })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect(result.content).toContain('<observation>');
  });

  test('upstream_inference_cost alone still yields a real costUsd (BYOK shape)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse({
      usage: { prompt_tokens: 10, completion_tokens: 5, cost_details: { upstream_inference_cost: 0.004 } },
    })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(result.costUsd).toBeCloseTo(0.004, 10);
  });

  test('empty choices → { content: "" } but reported usage is KEPT (real spend)', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse({ choices: [] })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(result.content).toBe('');
    // The empty reply still cost real money — its reported usage must not be
    // discarded (the caller records the empty content as a parse note).
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(40);
    expect(result.costUsd).toBeCloseTo(0.003, 10);
    expect(result.servedModel).toBe('test/model-1-served');
  });

  test('empty choices with no usage at all → everything undefined, nothing fabricated', async () => {
    const fetchMock = mock(() => Promise.resolve(okResponse({ choices: [], usage: undefined, model: undefined })));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await queryModel(MODEL, MESSAGES, OPTS);
    expect(result.content).toBe('');
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.costUsd).toBeUndefined();
    expect(result.servedModel).toBeUndefined();
  });
});
