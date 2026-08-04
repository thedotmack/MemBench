import { createHash } from "node:crypto";
import { SCIENTIFIC_LIMITS } from "./limits";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

interface CanonicalState {
  readonly ancestors: Set<object>;
  nodes: number;
}

function normalized(value: unknown, state: CanonicalState, depth: number): JsonValue {
  state.nodes += 1;
  if (
    state.nodes > SCIENTIFIC_LIMITS.maximumCanonicalNodes ||
    depth > SCIENTIFIC_LIMITS.maximumStructuredDepth
  ) throw new RangeError("canonical JSON exceeds structural limits");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON does not support non-finite numbers");
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError("canonical JSON accepts only JSON-compatible values");
  }
  if (state.ancestors.has(value)) throw new TypeError("canonical JSON does not support cycles");
  state.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError("canonical JSON accepts only ordinary arrays");
      }
      const arrayKeys = Reflect.ownKeys(value);
      if (arrayKeys.some((key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key))
      )) throw new TypeError("canonical JSON arrays cannot have extra properties");
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new TypeError("canonical JSON does not support sparse arrays");
      }
      return value.map((nested) => normalized(nested, state, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("canonical JSON accepts only plain objects");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string")) {
      throw new TypeError("canonical JSON does not support symbol keys");
    }
    const entries = (ownKeys as string[]).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError("canonical JSON accepts enumerable data properties only");
      }
      return [key, normalized(descriptor.value, state, depth + 1)] as const;
    });
    return Object.fromEntries(entries.sort(([left], [right]) => compareText(left, right)));
  } finally {
    state.ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalized(value, { ancestors: new Set<object>(), nodes: 0 }, 0));
}

export function sha256(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function hashJson(value: unknown): `sha256:${string}` {
  return sha256(canonicalJson(value));
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
