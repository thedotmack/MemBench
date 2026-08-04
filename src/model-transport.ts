import type { OpenRouter, PostModelCallPayload } from "@openrouter/agent";
import { stepCountIs } from "@openrouter/agent";

import { deepFreeze, hashJson } from "./canonical";
import type { EffectiveRoute, ReportedUsage, RequestedRoute, RouteProvenance } from "./domain";
import { boundedInteger, finiteNonnegative, reportedCost, reportedInteger, requireFixedRoute, RUNTIME_LIMITS, utf8Text } from "./runtime-validation";

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

function usage(value: unknown): ReportedUsage {
  const source = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  return deepFreeze({
    inputTokens: reportedInteger(source.inputTokens),
    outputTokens: reportedInteger(source.outputTokens),
    totalTokens: reportedInteger(source.totalTokens),
    costUsd: reportedCost(source.cost ?? source.costUsd),
  });
}

function routeReported(requested: RequestedRoute, provider: string | null, model: string | null): RouteProvenance {
  const effective: EffectiveRoute = { provider, model, routeReported: provider !== null || model !== null };
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
    return deepFreeze({
      text,
      generationId: typeof response.id === "string" && response.id !== "" ? response.id : last?.responseId ?? null,
      // The 0.8.0 public response/hook types report the effective model but
      // not the selected provider, so provider remains explicitly unknown.
      route: routeReported(route, null, typeof response.model === "string" && response.model !== "" ? response.model : last?.model ?? null),
      usage: usage(response.usage ?? last?.usage),
      durationMs: last && Number.isFinite(last.durationMs) && last.durationMs >= 0 ? last.durationMs : null,
      modelCalls: calls.length === 0 ? 1 : calls.length,
      steps: calls.length === 0 ? 1 : calls.length,
    });
  }
}

export function promptHash(request: ModelTransportRequest): `sha256:${string}` {
  return hashJson(request);
}
