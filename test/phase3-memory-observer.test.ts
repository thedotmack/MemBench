import { describe, expect, test } from "bun:test";

import {
  AgentSdkModelTransport,
  HttpMemoryBackend,
  InMemoryBackend,
  observeInBackground,
  promptHash,
  type ModelTransport,
  type ModelTransportRequest,
  type ModelTransportResult,
  type RequestedRoute,
} from "../src";
import type { OpenRouter } from "@openrouter/agent";

const route: RequestedRoute = { provider: "provider-a", model: "model-a", allowFallbacks: false };
const sampling = { temperature: 0, topP: 1, seed: "synthetic-seed" } as const;

function result(text: string, overrides: Partial<ModelTransportResult> = {}): ModelTransportResult {
  return {
    text,
    generationId: null,
    route: { requested: route, effective: { provider: null, model: null, routeReported: false } },
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
    durationMs: null,
    modelCalls: 1,
    steps: 1,
    ...overrides,
  };
}

describe("memory backends", () => {
  test("in-memory CRUD is deterministic and validates ids", async () => {
    const backend = new InMemoryBackend();
    await backend.create({ id: "fact-b", text: "Beta fact", metadata: {} });
    await backend.create({ id: "fact-a", text: "Alpha fact", metadata: { source: "synthetic" } });
    expect((await backend.list()).map((record) => record.id)).toEqual(["fact-a", "fact-b"]);
    await backend.update("fact-a", { id: "fact-a", text: "Updated", metadata: {} });
    expect((await backend.get("fact-a"))?.text).toBe("Updated");
    expect(await backend.delete("fact-a")).toBe(true);
    expect(await backend.get("fact-a")).toBeNull();
    expect(() => backend.get("../escape")).toThrow();
  });

  test("atomic batches validate all collisions before committing", async () => {
    const backend = new InMemoryBackend();
    await backend.create({ id: "existing", text: "Existing fact", metadata: {} });
    await expect(backend.createBatch([
      { id: "new-fact", text: "New fact", metadata: {} },
      { id: "existing", text: "Collision fact", metadata: {} },
    ])).rejects.toThrow("exists");
    expect(await backend.get("new-fact")).toBeNull();
    await expect(backend.createBatch([
      { id: "duplicate", text: "First fact", metadata: {} },
      { id: "duplicate", text: "Second fact", metadata: {} },
    ])).rejects.toThrow("unique");
    expect(await backend.get("duplicate")).toBeNull();
  });

  test("HTTP adapter uses only the documented injected CRUD contract", async () => {
    const calls: { method: string; path: string }[] = [];
    const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (init?.method === "GET" && url.pathname.endsWith("records")) return Response.json([]);
      return Response.json({ id: "fact-a", text: "Synthetic", metadata: {} });
    };
    const backend = new HttpMemoryBackend({ baseUrl: "https://memory.invalid/v1", fetch });
    await backend.create({ id: "fact-a", text: "Synthetic", metadata: {} });
    await backend.get("fact-a");
    await backend.list();
    await backend.update("fact-a", { id: "fact-a", text: "Synthetic", metadata: {} });
    await backend.delete("fact-a");
    expect(calls).toEqual([
      { method: "POST", path: "/v1/records" },
      { method: "GET", path: "/v1/records/fact-a" },
      { method: "GET", path: "/v1/records" },
      { method: "PUT", path: "/v1/records/fact-a" },
      { method: "DELETE", path: "/v1/records/fact-a" },
    ]);
  });

  test("HTTP policy rejects unsafe origins, redirects, and oversized streams", async () => {
    const never = async () => { throw new Error("must not fetch"); };
    expect(() => new HttpMemoryBackend({ baseUrl: "http://memory.invalid", fetch: never })).toThrow("HTTPS");
    expect(() => new HttpMemoryBackend({ baseUrl: "https://127.0.0.1", fetch: never })).toThrow("forbidden");
    for (const baseUrl of [
      "https://[::ffff:127.0.0.1]",
      "https://[::ffff:10.0.0.1]",
      "https://[::ffff:169.254.1.2]",
      "https://[::ffff:7f00:1]",
      "https://[::ffff:a00:1]",
      "https://[::ffff:a9fe:102]",
    ]) expect(() => new HttpMemoryBackend({ baseUrl, fetch: never, allowLoopbackHttp: true })).toThrow("forbidden");
    const credentialed = new URL("https://memory.invalid");
    credentialed.username = "user";
    credentialed.password = "pass";
    expect(() => new HttpMemoryBackend({ baseUrl: credentialed.href, fetch: never })).toThrow("credentials");
    expect(() => new HttpMemoryBackend({ baseUrl: "https://memory.invalid?unsafe=1", fetch: never })).toThrow("query");
    expect(() => new HttpMemoryBackend({ baseUrl: "http://localhost", fetch: never, allowLoopbackHttp: true })).not.toThrow();

    let redirectMode: RequestRedirect | undefined;
    const redirecting = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async (_url, init) => { redirectMode = init?.redirect; return new Response(null, { status: 302 }); } });
    await expect(redirecting.list()).rejects.toThrow("status 302");
    expect(redirectMode).toBe("error");

    const oversized = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async () => new Response("x".repeat(1_000_001), { status: 200, headers: { "content-type": "application/json" } }) });
    await expect(oversized.list()).rejects.toThrow("too large");
  });

  test("HTTP timeout does not depend on the injected fetch honoring AbortSignal", async () => {
    const backend = new HttpMemoryBackend({
      baseUrl: "https://memory.invalid",
      timeoutMs: 5,
      fetch: async () => new Promise<Response>(() => {}),
    });
    await expect(backend.list()).rejects.toThrow("timed out");
  });

  test("HTTP responses enforce status, content type, declared length, and UTF-8", async () => {
    const invalidType = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async () => new Response("[]", { status: 200, headers: { "content-type": "text/plain" } }) });
    await expect(invalidType.list()).rejects.toThrow("content type");
    const wrongLength = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json", "content-length": "9" } }) });
    await expect(wrongLength.list()).rejects.toThrow("length");
    const invalidUtf8 = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async () => new Response(new Uint8Array([0xff]), { status: 200, headers: { "content-type": "application/json" } }) });
    await expect(invalidUtf8.list()).rejects.toThrow("UTF-8");
    const wrongStatus = new HttpMemoryBackend({ baseUrl: "https://memory.invalid", fetch: async () => Response.json([], { status: 201 }) });
    await expect(wrongStatus.list()).rejects.toThrow("status 201");
  });
});

describe("background observer", () => {
  test("valid strict output persists and missing route/usage remains visible", async () => {
    const memory = new InMemoryBackend();
    const transport: ModelTransport = { call: async () => result(JSON.stringify({ schemaVersion: 1, memories: [{ id: "stable-fact", text: "Use amber mode", metadata: { source: "synthetic" } }] })) };
    const observed = await observeInBackground({
      events: [{ eventIndex: 0, kind: "message", role: "user", text: "Use amber mode" }],
      route,
      transport,
      memory,
      sampling,
    });
    expect(observed.parseState).toBe("valid");
    expect(observed.persisted).toBe(1);
    expect(observed.route.effective).toEqual({ provider: null, model: null, routeReported: false });
    expect(observed.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  });

  test("unknown fields fail schema and never write memory", async () => {
    const memory = new InMemoryBackend();
    const transport: ModelTransport = { call: async () => result(JSON.stringify({ schemaVersion: 1, memories: [], extra: true })) };
    const observed = await observeInBackground({ events: [], route, transport, memory, sampling });
    expect(observed.parseState).toBe("invalid_schema");
    expect(await memory.list()).toHaveLength(0);
  });

  test("duplicate observations and atomic backend failures never partially persist", async () => {
    const duplicateMemory = new InMemoryBackend();
    const duplicateTransport: ModelTransport = { call: async () => result(JSON.stringify({ schemaVersion: 1, memories: [
      { id: "same-fact", text: "First fact", metadata: {} },
      { id: "same-fact", text: "Second fact", metadata: {} },
    ] })) };
    const duplicate = await observeInBackground({ events: [], route, transport: duplicateTransport, memory: duplicateMemory, sampling });
    expect(duplicate.parseState).toBe("invalid_semantics");
    expect(await duplicateMemory.list()).toHaveLength(0);

    class FailingAtomicBackend extends InMemoryBackend { override async createBatch(): Promise<readonly never[]> { throw new Error("synthetic atomic failure"); } }
    const failedMemory = new FailingAtomicBackend();
    const validTransport: ModelTransport = { call: async () => result(JSON.stringify({ schemaVersion: 1, memories: [{ id: "one-fact", text: "One fact", metadata: {} }] })) };
    const interrupted = await observeInBackground({ events: [], route, transport: validTransport, memory: failedMemory, sampling });
    expect(interrupted.persistenceState).toBe("interrupted");
    expect(interrupted.persisted).toBe(0);
    expect(await failedMemory.list()).toHaveLength(0);
  });

  test("schema-valid lone surrogates are explicit semantic failures", async () => {
    const memory = new InMemoryBackend();
    const lone = `valid${String.fromCharCode(0xd800)}`;
    const transport: ModelTransport = { call: async () => result(JSON.stringify({ schemaVersion: 1, memories: [{ id: "lone-fact", text: lone, metadata: {} }] })) };
    const observed = await observeInBackground({ events: [], route, transport, memory, sampling });
    expect(observed.parseState).toBe("invalid_semantics");
    expect(observed.persistenceState).toBe("complete");
    expect(await memory.list()).toHaveLength(0);
  });

  test("oversized raw model output is rejected before JSON parsing", async () => {
    const memory = new InMemoryBackend();
    const transport: ModelTransport = { call: async () => result("x".repeat(1_000_001)) };
    const observed = await observeInBackground({ events: [], route, transport, memory, sampling });
    expect(observed.parseState).toBe("invalid_json");
    expect(await memory.list()).toHaveLength(0);
  });

  test("Agent SDK transport pins provider and disables fallbacks without network", async () => {
    let captured: Record<string, unknown> | null = null;
    const fake = {
      callModel(request: Record<string, unknown>) {
        captured = request;
        return {
          getResponse: async () => ({ id: "synthetic-response", model: "effective-model", usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.01 } }),
          getText: async () => "{}",
        };
      },
    } as unknown as OpenRouter;
    const transport = new AgentSdkModelTransport(fake);
    const output = await transport.call({ purpose: "observer", route, instructions: "Synthetic instruction", input: "Synthetic input", maximumOutputTokens: 50, sampling });
    expect((captured! as { provider: unknown }).provider).toEqual({ only: ["provider-a"], order: ["provider-a"], allowFallbacks: false });
    expect((captured! as { allowFinalResponse: unknown }).allowFinalResponse).toBe(false);
    expect((captured! as { temperature: unknown }).temperature).toBe(0);
    expect((captured! as { topP: unknown }).topP).toBe(1);
    expect(Object.hasOwn(captured!, "seed")).toBe(false);
    expect(output.usage.costUsd).toBe(0.01);
    expect(output.route.effective.provider).toBeNull();
  });

  test("model dispatch validates route and sampling while seed remains bound to identity", async () => {
    let calls = 0;
    const transport = new AgentSdkModelTransport({ callModel() { calls += 1; throw new Error("must not dispatch"); } } as unknown as OpenRouter);
    const request: ModelTransportRequest = { purpose: "observer", route, instructions: "Instruction", input: "Input", maximumOutputTokens: 50, sampling };
    expect(promptHash(request)).not.toBe(promptHash({ ...request, sampling: { ...sampling, seed: "different-seed" } }));
    await expect(transport.call({ ...request, route: { provider: "", model: "model-a", allowFallbacks: false } })).rejects.toThrow();
    await expect(transport.call({ ...request, sampling: { ...sampling, temperature: Number.NaN } })).rejects.toThrow();
    await expect(transport.call({ ...request, sampling: { ...sampling, topP: 2 } })).rejects.toThrow();
    await expect(transport.call({ ...request, sampling: { ...sampling, seed: "" } })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
