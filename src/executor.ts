import type { OpenRouter, PostModelCallPayload } from "@openrouter/agent";
import { maxCost, stepCountIs, tool } from "@openrouter/agent";
import { z } from "zod";

import { deepFreeze, hashJson } from "./canonical";
import type { MechanicalCheck } from "./corpus";
import type { ReportedUsage, RequestedRoute, RouteProvenance, Sha256 } from "./domain";
import { requireModelSampling, type ModelSampling } from "./model-transport";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import {
  captureWorkspaceDiff,
  listWorkspaceFiles,
  readWorkspaceFile,
  requireExecutionSandbox,
  type AttemptWorkspace,
  type SandboxBackend,
  type SandboxCommandResult,
  type WorkspaceDiff,
  writeWorkspaceFile,
} from "./sandbox";
import {
  boundedInteger,
  finiteNonnegative,
  nonemptyText,
  reportedCost,
  reportedInteger,
  requireFixedRoute,
  RUNTIME_LIMITS,
  runtimeTelemetryId,
  validateNullableDuration,
  validateReportedUsage,
  validateRouteProvenance,
} from "./runtime-validation";

export interface ExecutorToolbox {
  read(path: string): string;
  write(path: string, content: string): void;
  list(): readonly string[];
  search(query: string): readonly { readonly path: string; readonly line: number; readonly text: string }[];
  command(argv: readonly string[]): Promise<SandboxCommandResult>;
}

export interface ExecutorTransportRequest {
  readonly route: RequestedRoute;
  readonly prompt: string;
  readonly injectedMemory: string;
  readonly maximumSteps: number;
  readonly maximumCostUsd: number;
  readonly sampling: ModelSampling;
  readonly tools: ExecutorToolbox;
}

export interface ExecutorTransportResult {
  readonly completed: boolean;
  readonly generationId: string | null;
  readonly route: RouteProvenance;
  readonly usage: ReportedUsage;
  readonly durationMs: number | null;
  readonly steps: number;
  readonly modelCalls: number;
}

export interface ExecutorTransport {
  run(request: ExecutorTransportRequest): Promise<ExecutorTransportResult>;
}

export function validateExecutorTransportResult(value: unknown, expectedRoute: RequestedRoute): ExecutorTransportResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("executor transport result must be an object");
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("executor transport result must be an ordinary object");
  const source = value as Record<string, unknown>;
  const keys = ["completed", "generationId", "route", "usage", "durationMs", "steps", "modelCalls"] as const;
  if (
    Reflect.ownKeys(source).length !== keys.length || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return !descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined;
    }) ||
    Reflect.ownKeys(source).some((key) => typeof key !== "string" || !keys.includes(key as typeof keys[number]))
  ) throw new TypeError("executor transport result has invalid or missing fields");
  if (typeof source.completed !== "boolean") throw new TypeError("executor completion must be boolean");
  return deepFreeze({
    completed: source.completed,
    generationId: source.generationId === null ? null : runtimeTelemetryId(source.generationId, "executor generation id"),
    route: validateRouteProvenance(source.route, expectedRoute),
    usage: validateReportedUsage(source.usage, "executor transport usage"),
    durationMs: validateNullableDuration(source.durationMs, "executor transport duration"),
    steps: boundedInteger(source.steps, "executor step count", Number.MAX_SAFE_INTEGER),
    modelCalls: boundedInteger(source.modelCalls, "executor model call count", Number.MAX_SAFE_INTEGER),
  });
}

export interface ExecutorAttemptPolicy {
  readonly route: RequestedRoute;
  readonly maximumSteps: number;
  readonly maximumCostUsd: number;
  readonly sampling: ModelSampling;
  readonly policyHash: Sha256;
}

const issuedExecutorPolicies = new WeakSet<object>();

export function executorAttemptPolicyFromSpec(spec: ExperimentSpec): ExecutorAttemptPolicy {
  assertExperimentSpecIdentity(spec);
  const payload = {
    route: requireFixedRoute(spec.routes.executor),
    maximumSteps: spec.budgets.maximumSteps,
    maximumCostUsd: spec.budgets.executorUsd,
    sampling: requireModelSampling({ temperature: spec.executorSampling.temperature, topP: spec.executorSampling.topP, seed: spec.executorSampling.seedIdentity }),
  };
  const policy = deepFreeze({ ...payload, policyHash: hashJson(payload) });
  issuedExecutorPolicies.add(policy);
  return policy;
}

function requireExecutorPolicy(policy: ExecutorAttemptPolicy): ExecutorAttemptPolicy {
  if (!issuedExecutorPolicies.has(policy) || policy === null || typeof policy !== "object" || Object.keys(policy).length !== 5) {
    throw new TypeError("executor policy must derive from a parsed experiment specification");
  }
  const payload = { route: requireFixedRoute(policy.route), maximumSteps: policy.maximumSteps, maximumCostUsd: policy.maximumCostUsd, sampling: requireModelSampling(policy.sampling) };
  if (policy.policyHash !== hashJson(payload)) throw new TypeError("executor policy identity mismatch");
  return policy;
}

function addReportedUsage(total: ReportedUsage, usage: unknown): ReportedUsage {
  if (usage === undefined || usage === null) return { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  if (typeof usage !== "object" || Array.isArray(usage)) throw new TypeError("SDK usage must be an object or missing");
  const source = usage as Record<string, unknown>;
  const sum = (left: number | null, right: unknown, integer: boolean): number | null => {
    if (left === null) return null;
    if (right === undefined || right === null) return null;
    const valid = integer ? reportedInteger(right) : reportedCost(right);
    if (valid === null) throw new TypeError("SDK usage contains an invalid reported measurement");
    const combined = left + valid;
    const validated = integer ? reportedInteger(combined) : reportedCost(combined);
    if (validated === null) throw new RangeError("SDK usage aggregate exceeds scientific limits");
    return validated;
  };
  return {
    inputTokens: sum(total.inputTokens, source.inputTokens, true),
    outputTokens: sum(total.outputTokens, source.outputTokens, true),
    totalTokens: sum(total.totalTokens, source.totalTokens, true),
    costUsd: sum(total.costUsd, source.cost, false),
  };
}

export class AgentSdkExecutorTransport implements ExecutorTransport {
  readonly #client: OpenRouter;

  constructor(client: OpenRouter) { this.#client = client; }

  async run(request: ExecutorTransportRequest): Promise<ExecutorTransportResult> {
    const route = requireFixedRoute(request.route);
    boundedInteger(request.maximumSteps, "maximum steps", 10_000);
    if (request.maximumSteps === 0) throw new TypeError("maximum steps must be positive");
    finiteNonnegative(request.maximumCostUsd, "maximum cost", 1_000_000);
    if (request.maximumCostUsd === 0) throw new TypeError("maximum cost must be positive");
    const sampling = requireModelSampling(request.sampling);
    nonemptyText(request.prompt, "executor prompt");
    const pathSchema = z.object({ path: z.string().max(1_000) }).strict();
    const readFile = tool({
      name: "read_file",
      description: "Read one UTF-8 file from the isolated attempt workspace.",
      inputSchema: pathSchema,
      execute: ({ path }) => ({ content: request.tools.read(path) }),
    });
    const writeFile = tool({
      name: "write_file",
      description: "Replace one UTF-8 file inside the isolated attempt workspace.",
      inputSchema: z.object({ path: z.string().max(1_000), content: z.string().max(RUNTIME_LIMITS.maximumFileBytes) }).strict(),
      execute: ({ path, content }) => { request.tools.write(path, content); return { written: true }; },
    });
    const listFiles = tool({
      name: "list_files",
      description: "List files in the isolated attempt workspace.",
      inputSchema: z.object({}).strict(),
      execute: () => ({ paths: request.tools.list() }),
    });
    const searchText = tool({
      name: "search_text",
      description: "Search bounded UTF-8 workspace files for a literal string.",
      inputSchema: z.object({ query: z.string().min(1).max(1_000) }).strict(),
      execute: ({ query }) => ({ matches: request.tools.search(query) }),
    });
    const runCommand = tool({
      name: "run_command",
      description: "Run an argv command only through the configured isolated sandbox.",
      inputSchema: z.object({ argv: z.array(z.string().max(10_000)).min(1).max(RUNTIME_LIMITS.maximumCommandArguments) }).strict(),
      execute: ({ argv }) => request.tools.command(argv),
    });
    const tools = [readFile, writeFile, listFiles, searchText, runCommand] as const;
    const calls: PostModelCallPayload[] = [];
    const result = this.#client.callModel({
      model: route.model,
      provider: { only: [route.provider], order: [route.provider], allowFallbacks: false },
      instructions: "Work only inside the provided isolated workspace using the fixed tools. Do not claim success; the harness runs independent checks.",
      input: `${request.injectedMemory === "" ? "No memory was injected." : `Injected memory:\n${request.injectedMemory}`}\n\nTask:\n${request.prompt}`,
      tools,
      stopWhen: [stepCountIs(request.maximumSteps), maxCost(request.maximumCostUsd)],
      allowFinalResponse: false,
      temperature: sampling.temperature,
      topP: sampling.topP,
      hooks: { PostModelCall: [{ handler: (payload) => { calls.push(payload); } }] },
    });
    const response = await result.getResponse();
    let aggregate: ReportedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 };
    for (const call of calls) aggregate = addReportedUsage(aggregate, call.usage);
    if (calls.length === 0) {
      aggregate = addReportedUsage(aggregate, response.usage);
    }
    const durationValues = calls.map((call) => call.durationMs);
    const durationMs = durationValues.length === 0 || durationValues.some((value) => value === undefined || value === null)
      ? null
      : durationValues.reduce((sum, value) => sum + (validateNullableDuration(value, "SDK executor duration") as number), 0);
    return validateExecutorTransportResult({
      completed: response.status === "completed",
      generationId: response.id ?? calls.at(-1)?.responseId ?? null,
      route: {
        requested: route,
        // The SDK does not expose the selected provider. Do not publish a
        // scientifically ambiguous half-route from model-only telemetry.
        effective: { provider: null, model: null, routeReported: false },
      },
      usage: aggregate,
      durationMs,
      steps: Math.max(1, calls.length),
      modelCalls: Math.max(1, calls.length),
    }, route);
  }
}

export interface CodingAttemptResult extends ExecutorTransportResult {
  readonly diff: WorkspaceDiff;
  readonly mechanical: SandboxCommandResult;
  readonly mechanicalPassed: boolean;
  readonly processTreeCleaned: boolean;
  readonly isolationPassed: boolean;
}

function toolbox(workspace: AttemptWorkspace, sandbox: SandboxBackend): { readonly tools: ExecutorToolbox; readonly cleanupState: { clean: boolean } } {
  const cleanupState = { clean: true };
  return { tools: {
    read: (path) => readWorkspaceFile(workspace, path),
    write: (path, content) => writeWorkspaceFile(workspace, path, content),
    list: () => listWorkspaceFiles(workspace),
    search: (query) => {
      nonemptyText(query, "search query", 1_000);
      const matches: { path: string; line: number; text: string }[] = [];
      for (const path of listWorkspaceFiles(workspace)) {
        const lines = readWorkspaceFile(workspace, path).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] as string;
          if (line.includes(query)) matches.push({ path, line: index + 1, text: line.slice(0, 2_000) });
          if (matches.length >= 1_000) return deepFreeze(matches);
        }
      }
      return deepFreeze(matches);
    },
    command: async (argv) => {
      const result = await sandbox.execute({ argv, cwd: workspace.work, env: { HOME: workspace.home, MEMBENCH_DATA: workspace.data, PORT: String(workspace.port) }, timeoutMs: 30_000 });
      if (!result.processTreeCleaned) cleanupState.clean = false;
      return result;
    },
  }, cleanupState };
}

export async function executeCodingAttempt(input: {
  readonly workspace: AttemptWorkspace;
  readonly sandbox: SandboxBackend;
  readonly transport: ExecutorTransport;
  readonly policy: ExecutorAttemptPolicy;
  readonly prompt: string;
  readonly injectedMemory: string;
  readonly mechanicalCheck: MechanicalCheck;
}): Promise<CodingAttemptResult> {
  nonemptyText(input.prompt, "coding prompt");
  const policy = requireExecutorPolicy(input.policy);
  listWorkspaceFiles(input.workspace);
  await requireExecutionSandbox(input.sandbox);
  const { tools, cleanupState } = toolbox(input.workspace, input.sandbox);
  let cleanup = false;
  try {
    const execution = validateExecutorTransportResult(await input.transport.run({
      route: policy.route,
      prompt: input.prompt,
      injectedMemory: input.injectedMemory,
      maximumSteps: policy.maximumSteps,
      maximumCostUsd: policy.maximumCostUsd,
      sampling: policy.sampling,
      tools,
    }), policy.route);
    const mechanical = await input.sandbox.execute({
      argv: input.mechanicalCheck.argv,
      cwd: input.workspace.work,
      env: { HOME: input.workspace.home, MEMBENCH_DATA: input.workspace.data, PORT: String(input.workspace.port) },
      timeoutMs: 30_000,
    });
    if (!mechanical.processTreeCleaned) cleanupState.clean = false;
    const cleaned = await input.sandbox.cleanup(input.workspace.attemptId);
    cleanup = cleaned.processTreeCleaned;
    const processTreeCleaned = cleanup && cleanupState.clean;
    return deepFreeze({
      ...execution,
      diff: captureWorkspaceDiff(input.workspace),
      mechanical,
      mechanicalPassed: processTreeCleaned && !mechanical.timedOut && mechanical.exitCode === input.mechanicalCheck.expectedExitCode,
      processTreeCleaned,
      isolationPassed: processTreeCleaned,
    });
  } finally {
    if (!cleanup) await input.sandbox.cleanup(input.workspace.attemptId);
  }
}
