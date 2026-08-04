import type { OpenRouter, PostModelCallPayload } from "@openrouter/agent";
import { stepCountIs } from "@openrouter/agent";

import { deepFreeze, hashJson } from "./canonical";
import type { EffectiveRoute, ReportedUsage, RequestedRoute, RouteProvenance } from "./domain";
import {
  boundedInteger,
  finiteNonnegative,
  reportedCost,
  reportedInteger,
  requireFixedRoute,
  RUNTIME_LIMITS,
  runtimeTelemetryId,
  utf8Text,
  validateNullableDuration,
  validateReportedUsage,
  validateRouteProvenance,
} from "./runtime-validation";

export type ModelPurpose = "observer" | "executor" | "outcome_judge" | "drift_judge" | "attribution_judge" | "audit_judge";

export interface ModelSampling {
  readonly temperature: number;
  readonly topP: number;
  /** Bound into identity. ResponsesRequest in Agent SDK 0.8.0 has no seed field. */
  readonly seed: string;
}

export function requireModelSampling(value: ModelSampling): ModelSampling {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("model sampling must be an object");
  const source = value as unknown as Record<string, unknown>;
  if (Object.keys(source).length !== 3 || !Object.hasOwn(source, "temperature") || !Object.hasOwn(source, "topP") || !Object.hasOwn(source, "seed")) {
    throw new TypeError("model sampling has invalid fields");
  }
  return deepFreeze({
    temperature: finiteNonnegative(source.temperature, "sampling temperature", 2),
    topP: finiteNonnegative(source.topP, "sampling top-p", 1),
    seed: utf8Text(source.seed, "sampling seed", 256, true),
  });
}

export interface ModelTransportRequest {
  readonly purpose: ModelPurpose;
  readonly route: RequestedRoute;
  readonly instructions: string;
  readonly input: string;
  readonly maximumOutputTokens: number;
  readonly sampling: ModelSampling;
}

export interface ModelTransportResult {
  readonly text: string;
  readonly generationId: string | null;
  readonly route: RouteProvenance;
  readonly usage: ReportedUsage;
  readonly durationMs: number | null;
  readonly modelCalls: number;
  readonly steps: number;
}

export interface ModelTransport {
  call(request: ModelTransportRequest): Promise<ModelTransportResult>;
}

export function validateModelTransportResult(value: unknown, expectedRoute: RequestedRoute): ModelTransportResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("model transport result must be an object");
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("model transport result must be an ordinary object");
  const source = value as Record<string, unknown>;
  const keys = ["text", "generationId", "route", "usage", "durationMs", "modelCalls", "steps"] as const;
  if (
    Reflect.ownKeys(source).length !== keys.length || keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      return !descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined;
    }) ||
    Reflect.ownKeys(source).some((key) => typeof key !== "string" || !keys.includes(key as typeof keys[number]))
  ) throw new TypeError("model transport result has invalid or missing fields");
  const generationId = source.generationId === null ? null : runtimeTelemetryId(source.generationId, "generation id");
  const modelCalls = boundedInteger(source.modelCalls, "model call count", Number.MAX_SAFE_INTEGER);
  const steps = boundedInteger(source.steps, "model step count", Number.MAX_SAFE_INTEGER);
  return deepFreeze({
    // Purpose-specific consumers enforce their smaller parsing envelope. The
    // transport boundary still rejects non-text, NUL, invalid Unicode, and an
    // allocation large enough to be incompatible with the configured token cap.
    text: utf8Text(source.text, "model transport text", RUNTIME_LIMITS.maximumResponseBytes * 8),
    generationId,
    route: validateRouteProvenance(source.route, expectedRoute),
    usage: validateReportedUsage(source.usage),
    durationMs: validateNullableDuration(source.durationMs),
    modelCalls,
    steps,
  });
}

function usage(value: unknown): ReportedUsage {
  if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) {
    throw new TypeError("SDK usage must be an object or missing");
  }
  const source = value === undefined || value === null ? {} : value as Record<string, unknown>;
  const integer = (reported: unknown, label: string): number | null => {
    if (reported === undefined || reported === null) return null;
    const validated = reportedInteger(reported);
    if (validated === null) throw new TypeError(`${label} must be a safe non-negative integer or missing`);
    return validated;
  };
  const cost = Object.hasOwn(source, "cost") ? source.cost : source.costUsd;
  let costUsd: number | null = null;
  if (cost !== undefined && cost !== null) {
    costUsd = reportedCost(cost);
    if (costUsd === null) throw new TypeError("SDK cost must be finite and non-negative or missing");
  }
  return validateReportedUsage({
    inputTokens: integer(source.inputTokens, "SDK input tokens"),
    outputTokens: integer(source.outputTokens, "SDK output tokens"),
    totalTokens: integer(source.totalTokens, "SDK total tokens"),
    costUsd,
  }, "SDK usage");
}

function routeReported(requested: RequestedRoute, provider: string | null, model: string | null): RouteProvenance {
  // The SDK reports only the model in this integration. A partial route is not
  // provenance, so keep the effective pair explicitly unknown unless both
  // independently reported fields are available.
  const effective: EffectiveRoute = provider === null || model === null
    ? { provider: null, model: null, routeReported: false }
    : { provider, model, routeReported: true };
  return deepFreeze({ requested: { ...requested }, effective });
}

export class AgentSdkModelTransport implements ModelTransport {
  readonly #client: OpenRouter;

  constructor(client: OpenRouter) {
    this.#client = client;
  }

  async call(request: ModelTransportRequest): Promise<ModelTransportResult> {
    const route = requireFixedRoute(request.route);
    boundedInteger(request.maximumOutputTokens, "maximum output tokens", 1_000_000);
    if (request.maximumOutputTokens === 0) throw new TypeError("maximum output tokens must be positive");
    const sampling = requireModelSampling(request.sampling);
    utf8Text(request.instructions, "model instructions", RUNTIME_LIMITS.maximumTextBytes, true);
    utf8Text(request.input, "model input", RUNTIME_LIMITS.maximumResponseBytes);
    const calls: PostModelCallPayload[] = [];
    const result = this.#client.callModel({
      model: route.model,
      provider: {
        only: [route.provider],
        order: [route.provider],
        allowFallbacks: false,
      },
      instructions: request.instructions,
      input: request.input,
      maxOutputTokens: request.maximumOutputTokens,
      temperature: sampling.temperature,
      topP: sampling.topP,
      tools: [] as const,
      stopWhen: stepCountIs(1),
      allowFinalResponse: false,
      hooks: {
        PostModelCall: [{ handler: (payload) => { calls.push(payload); } }],
      },
    });
    const response = await result.getResponse();
    const text = await result.getText();
    const last = calls.at(-1);
    return validateModelTransportResult({
      text,
      generationId: response.id ?? last?.responseId ?? null,
      // The 0.8.0 public response/hook types report the effective model but
      // not the selected provider, so provider remains explicitly unknown.
      route: routeReported(route, null, typeof response.model === "string" && response.model !== "" ? response.model : last?.model ?? null),
      usage: usage(response.usage ?? last?.usage),
      durationMs: last ? validateNullableDuration(last.durationMs, "SDK model duration") : null,
      modelCalls: calls.length === 0 ? 1 : calls.length,
      steps: calls.length === 0 ? 1 : calls.length,
    }, route);
  }
}

export function promptHash(request: ModelTransportRequest): `sha256:${string}` {
  return hashJson(request);
}
