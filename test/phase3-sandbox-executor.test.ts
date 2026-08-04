import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRouter } from "@openrouter/agent";

import {
  AgentSdkExecutorTransport,
  createAttemptWorkspace,
  createDeterministicTestSandbox,
  executorAttemptPolicyFromSpec,
  executeCodingAttempt,
  parseExperimentSpec,
  readWorkspaceFile,
  requireLiveSandbox,
  UnavailableLiveSandbox,
  type ExecutorTransport,
  type ExecutorTransportResult,
  type RequestedRoute,
  type SandboxBackend,
} from "../src";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "membench-synthetic-")); roots.push(value); return value; }
const route: RequestedRoute = { provider: "provider-a", model: "model-a", allowFallbacks: false };
const sampling = { temperature: 0, topP: 1, seed: "executor-seed" } as const;

function policy() {
  const corpusPath = root();
  const parsed = parseExperimentSpec(`
version = 1
[experiment]
id = "executor-study"
repetitions = 3
candidate_models = ["candidate-a"]
executor_lanes = ["lane-a"]
item_ids = ["item-a", "item-b", "item-c"]
corpus_path = "${corpusPath}"
[routes.observer]
provider = "provider-a"
model = "observer-a"
allow_fallbacks = false
[routes.executor]
provider = "provider-a"
model = "model-a"
allow_fallbacks = false
[routes.reference]
provider = "provider-a"
model = "reference-a"
allow_fallbacks = false
[routes.judge]
provider = "provider-a"
model = "judge-a"
allow_fallbacks = false
[seeds]
schedule = "schedule-seed"
bootstrap = "bootstrap-seed"
audit = "audit-seed"
[executor_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "executor-seed"
[decision]
alpha = 0.05
minimum_effect = 0.1
maximum_schema_failure_rate = 0.05
minimum_calibrated_items = 3
bootstrap_samples = 500
multiplicity = "bonferroni"
[budgets]
observer_usd = 1.0
executor_usd = 1.0
judge_usd = 1.0
maximum_steps = 3
`, { repositoryRoot: process.cwd() });
  return executorAttemptPolicyFromSpec(parsed);
}
const transportResult: ExecutorTransportResult = {
  completed: true,
  generationId: null,
  route: { requested: route, effective: { provider: null, model: null, routeReported: false } },
  usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
  durationMs: null,
  steps: 1,
  modelCalls: 1,
};

describe("workspace and sandbox boundary", () => {
  test("copies a validated tree and rejects traversal, absolute paths, and symlinks", () => {
    const runRoot = root();
    const workspace = createAttemptWorkspace({ runRoot, attemptId: "attempt-safe", startingTree: { "src/app.ts": "export const value = 1;\n" }, port: 20_001 });
    expect(readWorkspaceFile(workspace, "src/app.ts")).toContain("value");
    expect(() => readWorkspaceFile(workspace, "../outside.txt")).toThrow();
    expect(() => readWorkspaceFile(workspace, join(runRoot, "outside.txt"))).toThrow();
    expect(() => readWorkspaceFile(workspace, "bad\tname.txt")).toThrow();
    expect(() => readWorkspaceFile(workspace, "con.txt")).toThrow();
    writeFileSync(join(runRoot, "outside.txt"), "outside");
    symlinkSync(join(runRoot, "outside.txt"), join(workspace.work, "link.txt"));
    expect(() => readWorkspaceFile(workspace, "link.txt")).toThrow("symlinks");
  });

  test("factory identity and directory identity cannot be forged or replaced", () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-identity", startingTree: { "main.txt": "synthetic" }, port: 20_011 });
    expect(() => readWorkspaceFile({ ...workspace }, "main.txt")).toThrow("factory-issued");
    const outside = root();
    rmSync(workspace.work, { recursive: true });
    symlinkSync(outside, workspace.work);
    expect(() => readWorkspaceFile(workspace, "main.txt")).toThrow("non-symlink");
  });

  test("starting trees enforce cross-platform identities, Unicode validity, NUL, and UTF-8 bytes", () => {
    const runRoot = root();
    expect(() => createAttemptWorkspace({ runRoot, attemptId: "attempt-case", startingTree: { "A.txt": "one", "a.txt": "two" }, port: 20_012 })).toThrow("cross-platform");
    expect(() => createAttemptWorkspace({ runRoot, attemptId: "attempt-nul", startingTree: { "main.txt": "bad\0text" }, port: 20_013 })).toThrow("NUL");
    expect(() => createAttemptWorkspace({ runRoot, attemptId: "attempt-surrogate", startingTree: { "main.txt": "bad\ud800text" }, port: 20_014 })).toThrow("Unicode");
    expect(() => createAttemptWorkspace({ runRoot, attemptId: "attempt-bytes", startingTree: { "main.txt": "😀".repeat(125_001) }, port: 20_015 })).toThrow("byte");
  });

  test("binary workspace files fail closed", () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-binary", startingTree: { "main.txt": "synthetic" }, port: 20_016 });
    writeFileSync(join(workspace.work, "main.txt"), Buffer.from([0xff, 0xfe]));
    expect(() => readWorkspaceFile(workspace, "main.txt")).toThrow("UTF-8");
  });

  test("attempt ports and cross-platform file identities are unique within a run root", async () => {
    const runRoot = root();
    const workspace = createAttemptWorkspace({ runRoot, attemptId: "attempt-one", startingTree: { "Config.txt": "synthetic" }, port: 20_010 });
    expect(() => createAttemptWorkspace({ runRoot, attemptId: "attempt-two", startingTree: { "main.txt": "synthetic" }, port: 20_010 })).toThrow("port");
    const transport: ExecutorTransport = { run: async (request) => { request.tools.write("config.txt", "collision"); return transportResult; } };
    await expect(executeCodingAttempt({ workspace, sandbox: createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true })), transport, policy: policy(), prompt: "Update", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } })).rejects.toThrow("cross-platform");
  });

  test("unsupported live hosts fail closed before any model work", async () => {
    const sandbox = new UnavailableLiveSandbox();
    await expect(requireLiveSandbox(sandbox)).rejects.toThrow("verified live sandbox");
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-live", startingTree: { "main.txt": "synthetic" }, port: 20_002 });
    let called = false;
    const transport: ExecutorTransport = { run: async () => { called = true; return transportResult; } };
    await expect(executeCodingAttempt({ workspace, sandbox, transport, policy: policy(), prompt: "Update the file", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } })).rejects.toThrow("verified live sandbox");
    expect(called).toBe(false);
  });

  test("a backend cannot self-assert a verified live capability", async () => {
    let executed = false;
    const forged: SandboxBackend = {
      capability: () => ({ supported: true, verified: true, live: true, backend: "forged", reason: null }),
      execute: async () => { executed = true; return { exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }; },
      cleanup: async () => ({ processTreeCleaned: true }),
    };
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-forged", startingTree: { "main.txt": "synthetic" }, port: 20_017 });
    await expect(executeCodingAttempt({ workspace, sandbox: forged, transport: { run: async () => transportResult }, policy: policy(), prompt: "Update", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } })).rejects.toThrow("verified live sandbox");
    expect(executed).toBe(false);
  });

  test("timeout and process-tree cleanup are explicit", async () => {
    const sandbox = createDeterministicTestSandbox(async (_command, signal) => {
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(resolve, 1_000);
      });
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true };
    });
    const result = await sandbox.execute({ argv: ["synthetic"], cwd: root(), env: {}, timeoutMs: 5 });
    expect(result.timedOut).toBe(true);
    expect(result.processTreeCleaned).toBe(false);
  });

  test("deterministic timeout does not depend on a handler honoring AbortSignal", async () => {
    const sandbox = createDeterministicTestSandbox(async () => new Promise(() => {}));
    const startedAt = performance.now();
    const result = await sandbox.execute({ argv: ["synthetic"], cwd: root(), env: {}, timeoutMs: 5 });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "sandbox command timed out", timedOut: true, processTreeCleaned: false });
  });

  test("deterministic command results are exact, typed, and byte bounded", async () => {
    const command = { argv: ["synthetic"], cwd: root(), env: {}, timeoutMs: 100 } as const;
    const malformed = createDeterministicTestSandbox(async () => ({ exitCode: "0", stdout: "", stderr: "", timedOut: false, processTreeCleaned: true } as never));
    await expect(malformed.execute(command)).rejects.toThrow("exit code");
    const extra = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true, extra: true } as never));
    await expect(extra.execute(command)).rejects.toThrow("fields");
    const huge = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "x".repeat(1_000_001), stderr: "", timedOut: false, processTreeCleaned: true }));
    await expect(huge.execute(command)).rejects.toThrow("byte");
    const arrayOutput = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: [], stderr: "", timedOut: false, processTreeCleaned: true } as never));
    await expect(arrayOutput.execute(command)).rejects.toThrow();
    const customPrototype = createDeterministicTestSandbox(async () => Object.assign(Object.create({ inherited: true }) as object, { exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }) as never);
    await expect(customPrototype.execute(command)).rejects.toThrow("ordinary object");
  });
});

describe("fixed coding executor", () => {
  test("completion is not task success and cleanup happens after a failed check", async () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-check", startingTree: { "main.txt": "before" }, port: 20_003 });
    const sandbox = createDeterministicTestSandbox(async () => ({ exitCode: 2, stdout: "", stderr: "synthetic failure", timedOut: false, processTreeCleaned: true }));
    const transport: ExecutorTransport = {
      run: async (request) => { request.tools.write("main.txt", "after"); return transportResult; },
    };
    const result = await executeCodingAttempt({
      workspace,
      sandbox,
      transport,
      policy: policy(),
      prompt: "Update the file",
      injectedMemory: "Use a synthetic value",
      mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 },
    });
    expect(result.completed).toBe(true);
    expect(result.mechanicalPassed).toBe(false);
    expect(result.diff.modified).toEqual(["main.txt"]);
    expect(result.processTreeCleaned).toBe(true);
    expect(sandbox.wasCleaned("attempt-check")).toBe(true);
  });

  test("transport failures still clean the process tree", async () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-error", startingTree: { "main.txt": "before" }, port: 20_004 });
    const sandbox = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }));
    const transport: ExecutorTransport = { run: async () => { throw new Error("synthetic transport failure"); } };
    await expect(executeCodingAttempt({ workspace, sandbox, transport, policy: policy(), prompt: "Update", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } })).rejects.toThrow();
    expect(sandbox.wasCleaned("attempt-error")).toBe(true);
  });

  test("one unclean command makes aggregate cleanup false", async () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-unclean", startingTree: { "main.txt": "before" }, port: 20_018 });
    const sandbox = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: false }));
    const transport: ExecutorTransport = { run: async (request) => { await request.tools.command(["synthetic"]); return transportResult; } };
    const output = await executeCodingAttempt({ workspace, sandbox, transport, policy: policy(), prompt: "Update", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } });
    expect(output.processTreeCleaned).toBe(false);
    expect(output.isolationPassed).toBe(false);
    expect(output.mechanicalPassed).toBe(false);
  });

  test("executor rejects structurally forged parser policies", async () => {
    const workspace = createAttemptWorkspace({ runRoot: root(), attemptId: "attempt-policy", startingTree: { "main.txt": "before" }, port: 20_019 });
    const sandbox = createDeterministicTestSandbox(async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }));
    const issued = policy();
    await expect(executeCodingAttempt({ workspace, sandbox, transport: { run: async () => transportResult }, policy: { ...issued }, prompt: "Update", injectedMemory: "", mechanicalCheck: { kind: "command", argv: ["check"], expectedExitCode: 0 } })).rejects.toThrow("parsed experiment");
  });

  test("invalid route and budgets fail before SDK dispatch", async () => {
    let calls = 0;
    const fake = { callModel() { calls += 1; throw new Error("must not dispatch"); } } as unknown as OpenRouter;
    const adapter = new AgentSdkExecutorTransport(fake);
    const base = { route, prompt: "Synthetic", injectedMemory: "", maximumSteps: 1, maximumCostUsd: 1, sampling, tools: { read: () => "", write: () => {}, list: () => [], search: () => [], command: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }) } };
    await expect(adapter.run({ ...base, route: { provider: "", model: "model-a", allowFallbacks: false } })).rejects.toThrow();
    await expect(adapter.run({ ...base, maximumCostUsd: Number.NaN })).rejects.toThrow();
    await expect(adapter.run({ ...base, maximumCostUsd: Number.POSITIVE_INFINITY })).rejects.toThrow();
    await expect(adapter.run({ ...base, maximumCostUsd: 0 })).rejects.toThrow();
    await expect(adapter.run({ ...base, maximumSteps: -1 })).rejects.toThrow();
    await expect(adapter.run({ ...base, sampling: { ...sampling, seed: "" } })).rejects.toThrow();
    await expect(adapter.run({ ...base, sampling: { ...sampling, temperature: Number.NaN } })).rejects.toThrow();
    expect(calls).toBe(0);
  });

  test("hook usage is field-wise contagious when a later model call omits spend", async () => {
    const fake = {
      callModel(request: Record<string, unknown>) {
        const hook = ((request.hooks as { PostModelCall: { handler: (value: unknown) => void }[] }).PostModelCall[0] as { handler: (value: unknown) => void }).handler;
        hook({ usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cost: 0.01 }, durationMs: 4, model: "effective-model" });
        hook({ usage: { inputTokens: 7, outputTokens: 11, totalTokens: 18 }, durationMs: 6, model: "effective-model" });
        return { getResponse: async () => ({ id: "synthetic-response", model: "effective-model", status: "completed", usage: { inputTokens: 999, outputTokens: 999, totalTokens: 999, cost: 999 } }) };
      },
    } as unknown as OpenRouter;
    const output = await new AgentSdkExecutorTransport(fake).run({
      route,
      prompt: "Synthetic",
      injectedMemory: "",
      maximumSteps: 3,
      maximumCostUsd: 1,
      sampling,
      tools: { read: () => "", write: () => {}, list: () => [], search: () => [], command: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }) },
    });
    expect(output.usage).toEqual({ inputTokens: 9, outputTokens: 14, totalTokens: 23, costUsd: null });
    expect(output.durationMs).toBe(10);
    expect(output.modelCalls).toBe(2);
  });

  test("Agent SDK adapter exposes only fixed tools and pinned routing without network", async () => {
    let captured: Record<string, unknown> | null = null;
    const fake = { callModel(request: Record<string, unknown>) { captured = request; return { getResponse: async () => ({ id: "synthetic-response", model: "effective-model", status: "completed", usage: null }) }; } } as unknown as OpenRouter;
    const adapter = new AgentSdkExecutorTransport(fake);
    const output = await adapter.run({
      route,
      prompt: "Synthetic task",
      injectedMemory: "",
      maximumSteps: 3,
      maximumCostUsd: 0.5,
      sampling,
      tools: { read: () => "", write: () => {}, list: () => [], search: () => [], command: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true }) },
    });
    const tools = (captured! as { tools: { function: { name: string } }[] }).tools;
    expect(tools.map((entry) => entry.function.name)).toEqual(["read_file", "write_file", "list_files", "search_text", "run_command"]);
    expect((captured! as { provider: unknown }).provider).toEqual({ only: ["provider-a"], order: ["provider-a"], allowFallbacks: false });
    expect((captured! as { allowFinalResponse: unknown }).allowFinalResponse).toBe(false);
    expect((captured! as { temperature: unknown }).temperature).toBe(0);
    expect((captured! as { topP: unknown }).topP).toBe(1);
    expect(Object.hasOwn(captured!, "seed")).toBe(false);
    expect(output.completed).toBe(true);
    expect(output.usage.costUsd).toBeNull();
  });
});
