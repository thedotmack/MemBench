import { deepFreeze, type JsonValue } from "./canonical";
import { SCIENTIFIC_LIMITS } from "./limits";
import type { ReportedUsage, RequestedRoute, RouteProvenance } from "./domain";

export const RUNTIME_LIMITS = deepFreeze({
  maximumTextBytes: 250_000,
  maximumResponseBytes: 1_000_000,
  maximumMemoryRecords: 10_000,
  maximumFileBytes: 500_000,
  maximumFilesPerAttempt: 1_000,
  maximumCommandArguments: 128,
  maximumCommandDurationMs: 300_000,
  maximumErrorLength: 500,
  maximumAuditRows: SCIENTIFIC_LIMITS.maximumAuditRows,
});

export function boundedText(value: unknown, label: string, maximum = RUNTIME_LIMITS.maximumTextBytes): string {
  if (
    typeof value !== "string" || value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError(`${label} must be bounded text`);
  return value;
}

export function nonemptyText(value: unknown, label: string, maximum = RUNTIME_LIMITS.maximumTextBytes): string {
  const result = boundedText(value, label, maximum);
  if (result.trim() === "") throw new TypeError(`${label} must be non-empty text`);
  return result;
}

export function utf8Text(value: unknown, label: string, maximumBytes: number, meaningful = false): string {
  if (typeof value !== "string" || /\0/u.test(value)) throw new TypeError(`${label} must be UTF-8 text without NUL`);
  for (const character of value) {
    const point = character.codePointAt(0) as number;
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError(`${label} must contain valid Unicode scalar values`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) throw new RangeError(`${label} exceeds its UTF-8 byte limit`);
  if (meaningful && (!/[\p{L}\p{N}]/u.test(value) || /[\u0000-\u001f\u007f-\u009f]/u.test(value))) {
    throw new TypeError(`${label} must be meaningful text without controls`);
  }
  return value;
}

export function unicodeLength(value: string): number {
  return Array.from(value).length;
}

export function requireFixedRoute(value: RequestedRoute): RequestedRoute {
  const source = exactRuntimeObject(value, ["provider", "model", "allowFallbacks"], "requested route");
  if (source.allowFallbacks !== false) throw new TypeError("scientific route must explicitly disable fallbacks");
  return deepFreeze({
    provider: runtimeRouteLabel(source.provider, "requested provider", false),
    model: runtimeRouteLabel(source.model, "requested model", true),
    allowFallbacks: false,
  });
}

function exactRuntimeObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be an ordinary object`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined;
    })
  ) throw new TypeError(`${label} has invalid or missing fields`);
  return value as Record<string, unknown>;
}

/** Strict, display-safe route labels: provider, or a model with at most one owner separator. */
export function runtimeRouteLabel(value: unknown, label: string, allowOwnerSeparator: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new TypeError(`${label} is invalid`);
  const parts = value.split("/");
  if ((!allowOwnerSeparator && parts.length !== 1) || (allowOwnerSeparator && (parts.length < 1 || parts.length > 2))) {
    throw new TypeError(`${label} is invalid`);
  }
  if (parts.some((part) => !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,249}$/u.test(part) || part.includes(".."))) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

/** IDs originating in an SDK response or hook are telemetry, never arbitrary prose or paths. */
export function runtimeTelemetryId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,511}$/u.test(value) || value.includes("..")) {
    throw new TypeError(`${label} must be a safe telemetry identifier`);
  }
  return value;
}

function nullableReportedNumber(value: unknown, label: string, integer: boolean, maximum: number): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum ||
    (integer && !Number.isSafeInteger(value))
  ) throw new TypeError(`${label} must be a finite non-negative reported value or null`);
  return value;
}

export function validateReportedUsage(value: unknown, label = "transport usage"): ReportedUsage {
  const source = exactRuntimeObject(value, ["inputTokens", "outputTokens", "totalTokens", "costUsd"], label);
  const inputTokens = nullableReportedNumber(source.inputTokens, `${label} input tokens`, true, SCIENTIFIC_LIMITS.maximumTokenCount);
  const outputTokens = nullableReportedNumber(source.outputTokens, `${label} output tokens`, true, SCIENTIFIC_LIMITS.maximumTokenCount);
  const totalTokens = nullableReportedNumber(source.totalTokens, `${label} total tokens`, true, SCIENTIFIC_LIMITS.maximumTokenCount);
  if (inputTokens !== null && outputTokens !== null) {
    const total = inputTokens + outputTokens;
    if (!Number.isSafeInteger(total) || total > SCIENTIFIC_LIMITS.maximumTokenCount || (totalTokens !== null && totalTokens !== total)) {
      throw new TypeError(`${label} token aggregate is inconsistent`);
    }
  }
  return deepFreeze({
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: nullableReportedNumber(source.costUsd, `${label} cost`, false, SCIENTIFIC_LIMITS.maximumBudgetUsd),
  });
}

export function validateRouteProvenance(value: unknown, expectedRequested: RequestedRoute): RouteProvenance {
  const source = exactRuntimeObject(value, ["requested", "effective"], "transport route provenance");
  const requested = requireFixedRoute(source.requested as RequestedRoute);
  const expected = requireFixedRoute(expectedRequested);
  if (requested.provider !== expected.provider || requested.model !== expected.model || requested.allowFallbacks !== expected.allowFallbacks) {
    throw new TypeError("transport requested route does not match the dispatched route");
  }
  const effectiveSource = exactRuntimeObject(source.effective, ["provider", "model", "routeReported"], "transport effective route");
  const provider = effectiveSource.provider === null ? null : runtimeRouteLabel(effectiveSource.provider, "effective provider", false);
  const model = effectiveSource.model === null ? null : runtimeRouteLabel(effectiveSource.model, "effective model", true);
  if (
    (provider === null) !== (model === null) || typeof effectiveSource.routeReported !== "boolean" ||
    effectiveSource.routeReported !== (provider !== null && model !== null)
  ) {
    throw new TypeError("transport effective route reporting is inconsistent");
  }
  return deepFreeze({ requested, effective: { provider, model, routeReported: effectiveSource.routeReported } });
}

export function validateNullableDuration(value: unknown, label = "transport duration"): number | null {
  return nullableReportedNumber(value, label, false, Number.MAX_SAFE_INTEGER);
}

export function finiteNonnegative(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export function boundedInteger(value: unknown, label: string, maximum: number): number {
  const result = finiteNonnegative(value, label, maximum);
  if (!Number.isSafeInteger(result)) throw new TypeError(`${label} must be an integer`);
  return result;
}

export function reportedInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= SCIENTIFIC_LIMITS.maximumTokenCount
    ? value as number
    : null;
}

export function reportedCost(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= SCIENTIFIC_LIMITS.maximumBudgetUsd
    ? value
    : null;
}

export function jsonData(value: unknown, label: string, depth = 0, state = { nodes: 0 }): JsonValue {
  state.nodes += 1;
  if (depth > SCIENTIFIC_LIMITS.maximumStructuredDepth || state.nodes > SCIENTIFIC_LIMITS.maximumStructuredNodes) {
    throw new RangeError(`${label} exceeds structural limits`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => jsonData(entry, label, depth + 1, state));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be JSON data`);
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonData(nested, label, depth + 1, state)]));
  }
  throw new TypeError(`${label} must be JSON data`);
}

const secretPatterns = [
  /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\bBearer\s+[A-Za-z0-9._~-]{8,}\b/giu,
  /(?:api[_-]?key|authorization|password|secret)\s*[:=]\s*[^\s,;]+/giu,
];

export function redactError(error: unknown): string {
  let value = error instanceof Error ? `${error.name}: ${error.message}` : "runtime operation failed";
  value = value.replace(/\/(?:Users|home)\/[^\s:]+/gu, "<redacted-path>");
  for (const pattern of secretPatterns) value = value.replace(pattern, "<redacted-secret>");
  value = value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/[\ud800-\udfff]/gu, "�").trim();
  if (!/[\p{L}\p{N}]/u.test(value)) value = "runtime operation failed";
  const characters = Array.from(value);
  while (Buffer.byteLength(characters.join(""), "utf8") > RUNTIME_LIMITS.maximumErrorLength) characters.pop();
  return characters.join("");
}
