import { canonicalJson, compareText, deepFreeze, hashJson, type JsonValue } from "./canonical";
import {
  assertExperimentArtifacts,
  experimentArtifactCorpusItems,
  OBSERVER_PROTOCOL,
  type ExperimentArtifacts,
} from "./artifacts";
import type { CorpusEvent } from "./corpus";
import type { ReportedUsage, RequestedRoute, RouteProvenance, Sha256 } from "./domain";
import { validateMemoryBatch, validateMemoryRecordSchema, type MemoryBackend, type MemoryRecord } from "./memory";
import { promptHash, requireModelSampling, validateModelTransportResult, type ModelSampling, type ModelTransport } from "./model-transport";
import { jsonData, requireFixedRoute, RUNTIME_LIMITS } from "./runtime-validation";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import { requireSafeIdentifier } from "./identifiers";

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

export type ObservationParseState = "valid" | "invalid_json" | "invalid_schema" | "invalid_semantics" | "not_run_budget";

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

const issuedObservationRecords = new WeakMap<object, Sha256>();

export function assertObservationRecordIssued(record: ObservationRecord): void {
  const commitment = issuedObservationRecords.get(record);
  if (!commitment || commitment !== hashJson(record) || !Object.isFrozen(record)) {
    throw new TypeError("observation record must be issued by MemBench");
  }
}

export interface ObserverEventBatch {
  readonly itemId: string;
  readonly events: readonly CorpusEvent[];
}

export interface ObserverMemoryArtifact {
  readonly itemId: string;
  readonly memoryCount: number;
  readonly memoryHash: Sha256;
}

export interface ObservationBatch {
  readonly records: readonly ObservationRecord[];
  readonly memoryArtifacts: readonly ObserverMemoryArtifact[];
  readonly eventUniverseHash: Sha256;
  readonly promptUniverseHash: Sha256;
  readonly memoryUniverseHash: Sha256;
  readonly reportedCostUsd: number | null;
  readonly durationMs: number | null;
  readonly requestedRoute: RequestedRoute;
  readonly effectiveRoute: { readonly provider: string | null; readonly model: string | null; readonly routeReported: boolean };
  readonly budget: {
    readonly limitUsd: number;
    readonly measuredUsd: number | null;
    readonly status: "within" | "exhausted" | "exceeded" | "measurement_unknown";
    readonly skippedCalls: number;
  };
}

export interface IssuedObserverMemoryInput extends ObserverMemoryArtifact {
  readonly injectionText: string;
}

interface ObservationBatchBinding {
  readonly spec: ExperimentSpec;
  readonly artifacts: ExperimentArtifacts;
  readonly specIdentityHash: Sha256;
  readonly runHash: Sha256;
  readonly corpusHash: Sha256;
  readonly protocolPromptHash: Sha256;
  readonly routeHash: Sha256;
  readonly eventUniverseHash: Sha256;
  readonly promptUniverseHash: Sha256;
  readonly memoryUniverseHash: Sha256;
  readonly recordUniverseHash: Sha256;
  readonly memoryInputs: readonly IssuedObserverMemoryInput[];
  readonly batchHash: Sha256;
}

const issuedObservationBatches = new WeakMap<object, ObservationBatchBinding>();

export function assertObservationBatchForExperiment(batch: ObservationBatch, spec: ExperimentSpec): void {
  assertExperimentSpecIdentity(spec);
  const binding = issuedObservationBatches.get(batch);
  if (!binding || !Object.isFrozen(batch) || !Object.isFrozen(batch.records)) {
    throw new TypeError("observer evidence must be an issued experiment batch");
  }
  if (
    binding.spec !== spec || binding.specIdentityHash !== spec.identityHash ||
    binding.runHash !== binding.artifacts.runHash || binding.corpusHash !== binding.artifacts.corpusHash ||
    binding.protocolPromptHash !== binding.artifacts.promptHash ||
    binding.routeHash !== hashJson(spec.routes.observer) ||
    binding.eventUniverseHash !== binding.artifacts.observerEventUniverseHash ||
    binding.eventUniverseHash !== batch.eventUniverseHash || binding.promptUniverseHash !== batch.promptUniverseHash ||
    binding.memoryUniverseHash !== batch.memoryUniverseHash ||
    binding.memoryUniverseHash !== hashJson(batch.memoryArtifacts) ||
    binding.recordUniverseHash !== hashJson(batch.records) || binding.batchHash !== hashJson(batch)
  ) throw new TypeError("observer evidence belongs to a different experiment or event universe");
  assertExperimentArtifacts(binding.artifacts, spec);
  if (
    new Set(batch.records).size !== batch.records.length ||
    new Set(batch.records.map((record) => hashJson(record))).size !== batch.records.length
  ) throw new TypeError("observer evidence contains a duplicate record");
  for (const record of batch.records) {
    assertObservationRecordIssued(record);
    if (canonicalJson(record.requestedRoute) !== canonicalJson(spec.routes.observer)) {
      throw new TypeError("observer record route does not match the experiment");
    }
  }
}

export function issuedObserverMemoryInput(
  batch: ObservationBatch,
  spec: ExperimentSpec,
  itemIdValue: string,
): IssuedObserverMemoryInput {
  assertObservationBatchForExperiment(batch, spec);
  const itemId = requireSafeIdentifier(itemIdValue, "observer memory item id");
  const binding = issuedObservationBatches.get(batch) as ObservationBatchBinding;
  const memory = binding.memoryInputs.find((entry) => entry.itemId === itemId);
  if (!memory) throw new TypeError("observer memory item is outside the experiment universe");
  return memory;
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
    instructions: OBSERVER_PROTOCOL.instructions,
    input: `Schema:\n${JSON.stringify(OBSERVATION_JSON_SCHEMA)}\nEvents:\n${eventPrompt(input.events)}`,
    maximumOutputTokens: OBSERVER_PROTOCOL.maximumOutputTokens,
    sampling,
  };
  const result = validateModelTransportResult(await input.transport.call(request), route);
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
  const record = deepFreeze({
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
  issuedObservationRecords.set(record, hashJson(record));
  return record;
}

export async function observeExperimentInBackground(input: {
  readonly spec: ExperimentSpec;
  readonly artifacts: ExperimentArtifacts;
  readonly eventBatches: readonly ObserverEventBatch[];
  readonly transport: ModelTransport;
  readonly memory: MemoryBackend;
}): Promise<ObservationBatch> {
  assertExperimentSpecIdentity(input.spec);
  assertExperimentArtifacts(input.artifacts, input.spec);
  if (!Array.isArray(input.eventBatches) || input.eventBatches.length !== input.spec.experiment.itemIds.length) {
    throw new TypeError("observer event batches must exactly cover the prespecified item universe");
  }
  const ordered = input.eventBatches.map((batch) => {
    const itemId = requireSafeIdentifier(batch.itemId, "observer item id");
    if (!input.spec.experiment.itemIds.includes(itemId) || !Array.isArray(batch.events) || batch.events.length === 0) {
      throw new TypeError("observer event batch is outside the prespecified universe");
    }
    for (let index = 0; index < batch.events.length; index += 1) {
      if (batch.events[index]?.eventIndex !== index) throw new TypeError("observer event indexes must be contiguous");
    }
    canonicalJson(batch.events);
    return deepFreeze({ itemId, events: [...batch.events] });
  }).sort((left, right) => compareText(left.itemId, right.itemId));
  if (new Set(ordered.map((batch) => batch.itemId)).size !== ordered.length) {
    throw new TypeError("observer event item coordinate is duplicated");
  }
  const eventUniverseHash = hashJson(ordered);
  const artifactEvents = experimentArtifactCorpusItems(input.artifacts, input.spec)
    .map((item) => ({ itemId: item.id, events: item.events }))
    .sort((left, right) => compareText(left.itemId, right.itemId));
  if (
    eventUniverseHash !== input.artifacts.observerEventUniverseHash ||
    canonicalJson(ordered) !== canonicalJson(artifactEvents)
  ) {
    throw new TypeError("observer events do not exactly match the issued corpus artifacts");
  }
  const records: ObservationRecord[] = [];
  let observerSpend = 0;
  let budgetStatus: ObservationBatch["budget"]["status"] = "within";
  let skippedCalls = 0;
  for (const batch of ordered) {
    if (budgetStatus !== "within" || observerSpend >= input.spec.budgets.observerUsd) {
      if (budgetStatus === "within") budgetStatus = "exhausted";
      skippedCalls += 1;
      const request = {
        purpose: "observer" as const,
        route: input.spec.routes.observer,
        instructions: OBSERVER_PROTOCOL.instructions,
        input: `Schema:\n${JSON.stringify(OBSERVATION_JSON_SCHEMA)}\nEvents:\n${eventPrompt(batch.events)}`,
        maximumOutputTokens: OBSERVER_PROTOCOL.maximumOutputTokens,
        sampling: input.artifacts.observerSampling,
      };
      const skipped = deepFreeze({
        observation: null,
        parseState: "not_run_budget" as const,
        requestedRoute: input.spec.routes.observer,
        route: { requested: input.spec.routes.observer, effective: { provider: null, model: null, routeReported: false } },
        generationId: null,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
        durationMs: null,
        promptHash: promptHash(request),
        persisted: 0,
        persistenceState: "complete" as const,
        interruptionReason: "observer budget prevented dispatch",
      });
      issuedObservationRecords.set(skipped, hashJson(skipped));
      records.push(skipped);
      continue;
    }
    const record = await observeInBackground({
      events: batch.events,
      route: input.spec.routes.observer,
      transport: input.transport,
      memory: input.memory,
      sampling: input.artifacts.observerSampling,
    });
    if (
      !record.route.effective.routeReported ||
      record.route.effective.provider !== input.spec.routes.observer.provider ||
      record.route.effective.model !== input.spec.routes.observer.model
    ) throw new TypeError("observer effective route must equal the requested no-fallback route");
    records.push(record);
    if (record.usage.costUsd === null) budgetStatus = "measurement_unknown";
    else {
      observerSpend += record.usage.costUsd;
      if (!Number.isFinite(observerSpend)) throw new RangeError("observer spend exceeds safe bounds");
      if (observerSpend > input.spec.budgets.observerUsd) budgetStatus = "exceeded";
    }
  }
  if (new Set(records.map((record) => hashJson(record))).size !== records.length) {
    throw new TypeError("observer produced duplicate experiment records");
  }
  const measurement = (field: "durationMs" | "costUsd"): number | null => {
    const values = records.map((record) => field === "costUsd" ? record.usage.costUsd : record.durationMs);
    if (values.some((value) => value === null)) return null;
    const total = (values as number[]).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new RangeError("observer measurement exceeds safe bounds");
    return total;
  };
  const promptUniverseHash = hashJson(records.map((record) => record.promptHash));
  const memoryInputs = ordered.map((batch, index): IssuedObserverMemoryInput => {
    const record = records[index];
    if (!record) throw new Error("observer record and item universes diverged");
    const memories = record.parseState === "valid" && record.persistenceState === "complete"
      ? [...(record.observation?.memories ?? [])].sort((left, right) => compareText(left.id, right.id))
      : [];
    const injectionText = memories.map((memory) => memory.text).join("\n");
    return deepFreeze({
      itemId: batch.itemId,
      memoryCount: memories.length,
      memoryHash: hashJson({ itemId: batch.itemId, memories, injectionText }),
      injectionText,
    });
  });
  const memoryArtifacts = memoryInputs.map(({ itemId, memoryCount, memoryHash }) =>
    deepFreeze({ itemId, memoryCount, memoryHash })
  );
  const memoryUniverseHash = hashJson(memoryArtifacts);
  const measuredObserverCost = budgetStatus === "measurement_unknown" ? null : observerSpend;
  const allRoutesMeasured = records.every((record) => record.route.effective.routeReported);
  const result = deepFreeze({
    records,
    memoryArtifacts,
    eventUniverseHash,
    promptUniverseHash,
    memoryUniverseHash,
    reportedCostUsd: measuredObserverCost,
    durationMs: measurement("durationMs"),
    requestedRoute: input.spec.routes.observer,
    effectiveRoute: allRoutesMeasured
      ? { provider: input.spec.routes.observer.provider, model: input.spec.routes.observer.model, routeReported: true }
      : { provider: null, model: null, routeReported: false },
    budget: { limitUsd: input.spec.budgets.observerUsd, measuredUsd: measuredObserverCost, status: budgetStatus, skippedCalls },
  });
  issuedObservationBatches.set(result, deepFreeze({
    spec: input.spec,
    artifacts: input.artifacts,
    specIdentityHash: input.spec.identityHash,
    runHash: input.artifacts.runHash,
    corpusHash: input.artifacts.corpusHash,
    protocolPromptHash: input.artifacts.promptHash,
    routeHash: hashJson(input.spec.routes.observer),
    eventUniverseHash,
    promptUniverseHash,
    memoryUniverseHash,
    recordUniverseHash: hashJson(records),
    memoryInputs,
    batchHash: hashJson(result),
  }));
  return result;
}

export function observationBatchArtifacts(batch: ObservationBatch, spec: ExperimentSpec): ExperimentArtifacts {
  assertObservationBatchForExperiment(batch, spec);
  return (issuedObservationBatches.get(batch) as ObservationBatchBinding).artifacts;
}
