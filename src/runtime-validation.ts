import { deepFreeze, type JsonValue } from "./canonical";
import { SCIENTIFIC_LIMITS } from "./limits";
import type { RequestedRoute } from "./domain";

export const RUNTIME_LIMITS = deepFreeze({
  maximumTextBytes: 250_000,
  maximumResponseBytes: 1_000_000,
  maximumMemoryRecords: 10_000,
  maximumFileBytes: 500_000,
  maximumFilesPerAttempt: 1_000,
  maximumCommandArguments: 128,
  maximumCommandDurationMs: 300_000,
  maximumErrorLength: 500,
  maximumAuditRows: 10_000,
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
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("requested route must be an object");
  const source = value as unknown as Record<string, unknown>;
  if (
    Object.keys(source).length !== 3 || !Object.hasOwn(source, "provider") || !Object.hasOwn(source, "model") ||
    !Object.hasOwn(source, "allowFallbacks") || source.allowFallbacks !== false
  ) throw new TypeError("scientific route must explicitly disable fallbacks");
  return deepFreeze({
    provider: nonemptyText(source.provider, "requested provider", 200),
    model: nonemptyText(source.model, "requested model", 500),
    allowFallbacks: false,
  });
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
