import { canonicalJson, deepFreeze, type JsonValue } from "./canonical";
import type { CorpusEvent } from "./corpus";
import type { ReportedUsage, RequestedRoute, RouteProvenance, Sha256 } from "./domain";
import { validateMemoryBatch, validateMemoryRecordSchema, type MemoryBackend, type MemoryRecord } from "./memory";
import { promptHash, requireModelSampling, type ModelSampling, type ModelTransport } from "./model-transport";
import { jsonData, requireFixedRoute, RUNTIME_LIMITS } from "./runtime-validation";

export const OBSERVATION_JSON_SCHEMA = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://membench.invalid/schemas/observation.schema.json",
  title: "MemBench background observation",
  $comment: "This artifact validates structure. Cross-record id uniqueness and I-JSON Unicode scalar validity are enforced by the documented semantic layer.",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "memories"],
  properties: {
    schemaVersion: { const: 1 },
    memories: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "text", "metadata"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 80 },
          text: { type: "string", minLength: 1, maxLength: 250000, pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]*[\\p{L}\\p{N}][^\\u0000-\\u001F\\u007F-\\u009F]*$" },
          metadata: {
            type: "object",
            maxProperties: 64,
            propertyNames: { pattern: "^[A-Za-z][A-Za-z0-9_.-]{0,63}$" },
            additionalProperties: { type: "string", minLength: 1, maxLength: 2000, pattern: "^[^\\u0000-\\u001F\\u007F-\\u009F]*[\\p{L}\\p{N}][^\\u0000-\\u001F\\u007F-\\u009F]*$" },
          },
        },
      },
    },
  },
} satisfies JsonValue);

export type ObservationParseState = "valid" | "invalid_json" | "invalid_schema" | "invalid_semantics";

export interface Observation {
  readonly schemaVersion: 1;
  readonly memories: readonly MemoryRecord[];
}

export interface ObservationRecord {
  readonly observation: Observation | null;
  readonly parseState: ObservationParseState;
  readonly requestedRoute: RequestedRoute;
  readonly route: RouteProvenance;
  readonly generationId: string | null;
  readonly usage: ReportedUsage;
  readonly durationMs: number | null;
  readonly promptHash: Sha256;
  readonly persisted: number;
  readonly persistenceState: "complete" | "interrupted";
  readonly interruptionReason: string | null;
}

function parseObservationSchema(value: unknown): Observation {
  const source = jsonData(value, "observer output");
  if (source === null || typeof source !== "object" || Array.isArray(source)) throw new TypeError("observer output must be an object");
  const observationSource = source as Readonly<Record<string, JsonValue>>;
  if (Object.keys(observationSource).length !== 2 || observationSource.schemaVersion !== 1 || !Array.isArray(observationSource.memories) || observationSource.memories.length > 100) {
    throw new TypeError("observer output does not match the public schema");
  }
  const memories = observationSource.memories.map((entry): MemoryRecord => validateMemoryRecordSchema(entry));
  return deepFreeze({ schemaVersion: 1, memories });
}

function parseObservationSemantics(observation: Observation): Observation {
  return deepFreeze({ schemaVersion: 1, memories: validateMemoryBatch(observation.memories) });
}

function eventPrompt(events: readonly CorpusEvent[]): string {
  if (events.length > 10_000) throw new RangeError("observer input has too many events");
  const value = canonicalJson(events);
  if (Buffer.byteLength(value) > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("observer input is too large");
  return value;
}

export async function observeInBackground(input: {
  readonly events: readonly CorpusEvent[];
  readonly route: RequestedRoute;
  readonly transport: ModelTransport;
  readonly memory: MemoryBackend;
  readonly sampling: ModelSampling;
}): Promise<ObservationRecord> {
  const route = requireFixedRoute(input.route);
  const sampling = requireModelSampling(input.sampling);
  const request = {
    purpose: "observer" as const,
    route,
    instructions: "Extract only durable task-relevant facts. Return only JSON matching the supplied public schema. Do not infer facts absent from the events.",
    input: `Schema:\n${JSON.stringify(OBSERVATION_JSON_SCHEMA)}\nEvents:\n${eventPrompt(input.events)}`,
    maximumOutputTokens: 8_000,
    sampling,
  };
  const result = await input.transport.call(request);
  let parseState: ObservationParseState = "invalid_json";
  let observation: Observation | null = null;
  try {
    if (typeof result.text !== "string" || Buffer.byteLength(result.text, "utf8") > RUNTIME_LIMITS.maximumResponseBytes) throw new TypeError("observer model response exceeds transport bounds");
    const raw = result.text;
    const parsed = JSON.parse(raw) as unknown;
    let structural: Observation | null = null;
    try { structural = parseObservationSchema(parsed); }
    catch { parseState = "invalid_schema"; }
    if (structural !== null) {
      try { observation = parseObservationSemantics(structural); parseState = "valid"; }
      catch { parseState = "invalid_semantics"; }
    }
  } catch { /* invalid_json is explicit */ }
  let persisted = 0;
  let persistenceState: ObservationRecord["persistenceState"] = "complete";
  let interruptionReason: string | null = null;
  if (observation) {
    try {
      await input.memory.createBatch(observation.memories);
      persisted = observation.memories.length;
    } catch {
      persistenceState = "interrupted";
      interruptionReason = "atomic memory persistence failed";
    }
  }
  return deepFreeze({
    observation,
    parseState,
    requestedRoute: route,
    route: result.route,
    generationId: result.generationId,
    usage: result.usage,
    durationMs: result.durationMs,
    promptHash: promptHash(request),
    persisted,
    persistenceState,
    interruptionReason,
  });
}
