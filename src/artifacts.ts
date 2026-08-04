import { canonicalJson, compareText, deepFreeze, hashJson, type JsonValue } from "./canonical";
import { assertBoundCalibrationReference, type BoundCalibrationReference } from "./calibration";
import { assertCorpusItemIdentity, type CorpusItem } from "./corpus";
import type { RequestedRoute, Sha256 } from "./domain";
import { laneId } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { requireModelSampling, type ModelSampling } from "./model-transport";
import { ATTRIBUTION_JUDGE_PROTOCOL, AUDIT_JUDGE_PROTOCOL, DRIFT_JUDGE_PROTOCOL, OUTCOME_JUDGE_PROTOCOL } from "./judges";
import { createRunManifest, type RunManifest } from "./orchestrator";
import { buildSchedule, type PersistedSchedule } from "./schedule";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import { requireFixedRoute } from "./runtime-validation";

export const OBSERVER_PROTOCOL = deepFreeze({
  id: "membench-background-observer-v1",
  instructions: "Extract only durable task-relevant facts. Return only JSON matching the supplied public schema. Do not infer facts absent from the events.",
  responseSchema: "observation.schema.json#v1",
  maximumOutputTokens: 8_000,
});

export const EXECUTOR_PROTOCOL = deepFreeze({
  id: "membench-fixed-coding-executor-v1",
  promptSource: "corpus-item-task",
  injectedMemoryPlacement: "separate-immutable-field",
  tools: ["read_file", "write_file", "list_files", "search_text", "run_command"],
  completionRule: "mechanical-check-then-independent-judgments",
});

export const REFERENCE_PROTOCOL = deepFreeze({
  id: "membench-reference-control-v1",
  sourceRule: "exact-complete-event-string-leaf",
  injectionRule: "compiler-issued-verbatim-admitted-facts",
  calibration: "independent-k1-none-and-reference",
});

export const JUDGE_PROTOCOL = deepFreeze({
  id: "membench-judges-v1",
  evidenceEnvelope: "canonical-json-untrusted-data" as const,
  outcome: OUTCOME_JUDGE_PROTOCOL,
  attribution: ATTRIBUTION_JUDGE_PROTOCOL,
  drift: DRIFT_JUDGE_PROTOCOL,
  independentReassessment: AUDIT_JUDGE_PROTOCOL,
});

export const HARNESS_DESCRIPTOR = deepFreeze({
  name: "MemBench",
  version: "0.2.0",
  artifactSchema: 1,
  scheduleAlgorithm: "membench-round-robin-sha256-v1",
  bootstrapAlgorithm: "membench-item-bootstrap-v1",
  prngAlgorithm: "membench-mulberry32-sha256-v1",
  observationSchema: "observation.schema.json#v1",
  publicBundleManifestSchema: "public-bundle-manifest.schema.json#v1",
});

export interface ArtifactCorpusEntry {
  readonly itemId: string;
  readonly contentHash: Sha256;
  readonly eventHash: Sha256;
  readonly itemHash: Sha256;
  readonly taskHash: Sha256;
  readonly startingTreeHash: Sha256;
  readonly mechanicalCheckHash: Sha256;
  readonly rubricHash: Sha256 | null;
}

export interface ArtifactReferenceEntry {
  readonly itemId: string;
  readonly laneId: string;
  readonly sourceHash: Sha256;
  readonly controlHash: Sha256;
  readonly bindingHash: Sha256;
}

export interface ExperimentArtifactCommitments {
  readonly corpusHash: Sha256;
  readonly promptHash: Sha256;
  readonly harnessHash: Sha256;
  readonly judgeHash: Sha256;
  readonly observerEventUniverseHash: Sha256;
  readonly referenceControlUniverseHash: Sha256;
  readonly routeSamplingHash: Sha256;
  readonly referenceSourceUniverseHash: Sha256;
  readonly scheduleHash: Sha256;
  readonly runHash: Sha256;
  readonly artifactUniverseHash: Sha256;
}

export interface ExperimentArtifacts extends ExperimentArtifactCommitments {
  readonly schemaVersion: 1;
  readonly corpusManifest: readonly ArtifactCorpusEntry[];
  readonly referenceManifest: readonly ArtifactReferenceEntry[];
  readonly observerSampling: ModelSampling;
  readonly executorSampling: ModelSampling;
  readonly referenceSampling: ModelSampling;
  readonly primaryJudgeSampling: {
    readonly outcome: ModelSampling;
    readonly attribution: ModelSampling;
    readonly drift: ModelSampling;
  };
  readonly auditJudgeSampling: ModelSampling;
  readonly judgeConfigs: {
    readonly outcome: ArtifactJudgeConfig;
    readonly attribution: ArtifactJudgeConfig;
    readonly drift: ArtifactJudgeConfig;
    readonly audit: ArtifactJudgeConfig;
  };
  readonly routes: {
    readonly observer: RequestedRoute;
    readonly executor: RequestedRoute;
    readonly reference: RequestedRoute;
    readonly judge: RequestedRoute;
  };
  readonly protocols: {
    readonly observer: typeof OBSERVER_PROTOCOL;
    readonly executor: typeof EXECUTOR_PROTOCOL;
    readonly reference: typeof REFERENCE_PROTOCOL;
    readonly judge: typeof JUDGE_PROTOCOL;
    readonly harness: typeof HARNESS_DESCRIPTOR;
  };
}

export interface ArtifactJudgeConfig {
  readonly purpose: "outcome" | "attribution" | "drift" | "audit";
  readonly route: RequestedRoute;
  readonly sampling: ModelSampling;
  readonly protocolHash: Sha256;
  readonly configHash: Sha256;
}

interface ArtifactBinding {
  readonly spec: ExperimentSpec;
  readonly specIdentityHash: Sha256;
  readonly corpusItems: readonly CorpusItem[];
  readonly references: readonly BoundCalibrationReference[];
  readonly schedule: PersistedSchedule;
  readonly manifest: RunManifest;
  readonly commitments: ExperimentArtifactCommitments;
  readonly artifactHash: Sha256;
}

const issuedArtifacts = new WeakMap<object, ArtifactBinding>();

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be an ordinary object`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw new TypeError(`${label} has invalid fields`);
  }
  return value as Record<string, unknown>;
}

function derive(input: {
  readonly spec: ExperimentSpec;
  readonly corpusItems: readonly CorpusItem[];
  readonly references: readonly BoundCalibrationReference[];
  readonly createdAt: string;
}): { readonly publicArtifacts: ExperimentArtifacts; readonly binding: Omit<ArtifactBinding, "artifactHash"> } {
  exactObject(input, ["spec", "corpusItems", "references", "createdAt"], "experiment artifact request");
  assertExperimentSpecIdentity(input.spec);
  if (!Array.isArray(input.corpusItems) || input.corpusItems.length !== input.spec.experiment.itemIds.length) {
    throw new TypeError("artifact corpus must exactly cover the prespecified item universe");
  }
  const byId = new Map<string, CorpusItem>();
  for (const item of input.corpusItems) {
    assertCorpusItemIdentity(item);
    const itemId = requireSafeIdentifier(item.id, "artifact corpus item id");
    if (!input.spec.experiment.itemIds.includes(itemId) || byId.has(itemId)) {
      throw new TypeError("artifact corpus does not exactly cover unique prespecified items");
    }
    byId.set(itemId, item);
  }
  const corpusItems = input.spec.experiment.itemIds
    .map((itemId) => byId.get(itemId) as CorpusItem)
    .sort((left, right) => compareText(left.id, right.id));
  const corpusManifest = corpusItems.map((item) => deepFreeze({
    itemId: item.id,
    contentHash: item.contentHash,
    eventHash: hashJson(item.events),
    itemHash: hashJson(item),
    taskHash: hashJson(item.task),
    startingTreeHash: hashJson(item.startingTree),
    mechanicalCheckHash: hashJson(item.mechanicalCheck),
    rubricHash: item.blindSuccessRubric === undefined ? null : hashJson(item.blindSuccessRubric),
  }));
  if (!Array.isArray(input.references)) throw new TypeError("artifact references must be an array");
  const expectedReferenceCoordinates = input.spec.experiment.itemIds.flatMap((itemId) =>
    input.spec.experiment.executorLanes.map((lane) => `${itemId}\0${lane}`)
  ).sort(compareText);
  const referencesByCoordinate = new Map<string, BoundCalibrationReference>();
  for (const reference of input.references) {
    assertBoundCalibrationReference(reference);
    const coordinate = `${reference.itemId}\0${reference.laneId}`;
    const item = byId.get(reference.itemId);
    if (
      !item || reference.sourceHash !== item.contentHash || reference.control.sourceHash !== item.contentHash ||
      !input.spec.experiment.executorLanes.includes(reference.laneId) || referencesByCoordinate.has(coordinate)
    ) throw new TypeError("artifact references must exactly bind the corpus item and lane universe");
    referencesByCoordinate.set(coordinate, reference);
  }
  if (
    referencesByCoordinate.size !== expectedReferenceCoordinates.length ||
    expectedReferenceCoordinates.some((coordinate) => !referencesByCoordinate.has(coordinate))
  ) throw new TypeError("artifact references must exactly cover the corpus item and lane universe");
  const references = expectedReferenceCoordinates.map((coordinate) => referencesByCoordinate.get(coordinate) as BoundCalibrationReference);
  const referenceManifest = references.map((reference) => deepFreeze({
    itemId: reference.itemId,
    laneId: reference.laneId,
    sourceHash: reference.sourceHash,
    controlHash: hashJson(reference.control),
    bindingHash: reference.bindingHash,
  }));
  const eventBatches = corpusItems.map((item) => ({ itemId: item.id, events: item.events }));
  const observerSampling = requireModelSampling({
    temperature: input.spec.observerSampling.temperature,
    topP: input.spec.observerSampling.topP,
    seed: input.spec.observerSampling.seedIdentity,
  });
  const executorSampling = requireModelSampling({
    temperature: input.spec.executorSampling.temperature,
    topP: input.spec.executorSampling.topP,
    seed: input.spec.executorSampling.seedIdentity,
  });
  const referenceSampling = executorSampling;
  const primaryJudgeSampling = deepFreeze({
    outcome: requireModelSampling({ temperature: 0, topP: 1, seed: hashJson({ purpose: "outcome-judge-sampling", seed: input.spec.seeds.schedule }) }),
    attribution: requireModelSampling({ temperature: 0, topP: 1, seed: hashJson({ purpose: "attribution-judge-sampling", seed: input.spec.seeds.schedule }) }),
    drift: requireModelSampling({ temperature: 0, topP: 1, seed: hashJson({ purpose: "drift-judge-sampling", seed: input.spec.seeds.schedule }) }),
  });
  const auditJudgeSampling = requireModelSampling({
    temperature: 0,
    topP: 1,
    seed: hashJson({ purpose: "audit-judge-sampling", seed: input.spec.seeds.audit }),
  });
  const routes = deepFreeze({
    observer: requireFixedRoute(input.spec.routes.observer),
    executor: requireFixedRoute(input.spec.routes.executor),
    reference: requireFixedRoute(input.spec.routes.reference),
    judge: requireFixedRoute(input.spec.routes.judge),
  });
  const protocols = deepFreeze({
    observer: OBSERVER_PROTOCOL,
    executor: EXECUTOR_PROTOCOL,
    reference: REFERENCE_PROTOCOL,
    judge: JUDGE_PROTOCOL,
    harness: HARNESS_DESCRIPTOR,
  });
  const judgeConfig = (
    purpose: ArtifactJudgeConfig["purpose"],
    sampling: ModelSampling,
    protocol: unknown,
  ): ArtifactJudgeConfig => {
    const payload = { purpose, route: routes.judge, sampling, protocolHash: hashJson(protocol) };
    return deepFreeze({ ...payload, configHash: hashJson(payload) });
  };
  const judgeConfigs = deepFreeze({
    outcome: judgeConfig("outcome", primaryJudgeSampling.outcome, protocols.judge.outcome),
    attribution: judgeConfig("attribution", primaryJudgeSampling.attribution, protocols.judge.attribution),
    drift: judgeConfig("drift", primaryJudgeSampling.drift, protocols.judge.drift),
    audit: judgeConfig("audit", auditJudgeSampling, protocols.judge.independentReassessment),
  });
  const conditions = input.spec.experiment.candidateModels.flatMap((candidateId) =>
    (["candidate", "none", "shuffled", "reference"] as const).map((arm) => ({ candidateId, arm }))
  );
  const schedule = buildSchedule({
    itemIds: input.spec.experiment.itemIds,
    laneIds: input.spec.experiment.executorLanes.map(laneId),
    conditions,
    repetitions: input.spec.experiment.repetitions,
    seed: input.spec.seeds.schedule,
  });
  const manifest = createRunManifest({
    experimentId: input.spec.experiment.id,
    experimentIdentityHash: input.spec.identityHash,
    schedule,
    createdAt: input.createdAt,
  });
  const corpusHash = hashJson(corpusManifest);
  const observerEventUniverseHash = hashJson(eventBatches);
  const promptHash = hashJson({
    observer: protocols.observer,
    executor: protocols.executor,
    reference: protocols.reference,
    itemPrompts: corpusItems.map((item) => ({ itemId: item.id, task: item.task, blindSuccessRubric: item.blindSuccessRubric ?? null })),
  });
  const harnessHash = hashJson(protocols.harness);
  const judgeHash = hashJson(protocols.judge);
  const routeSamplingHash = hashJson({ routes, observerSampling, executorSampling, referenceSampling, primaryJudgeSampling, auditJudgeSampling, judgeConfigs });
  const referenceSourceUniverseHash = hashJson(corpusItems.map((item) => ({
    itemId: item.id,
    contentHash: item.contentHash,
    eventHash: hashJson(item.events),
  })));
  const referenceControlUniverseHash = hashJson(referenceManifest);
  const commitmentBase = {
    corpusHash,
    promptHash,
    harnessHash,
    judgeHash,
    observerEventUniverseHash,
    referenceControlUniverseHash,
    routeSamplingHash,
    referenceSourceUniverseHash,
    scheduleHash: schedule.contentHash,
    runHash: manifest.contentHash,
  };
  const artifactUniverseHash = hashJson(commitmentBase);
  const commitments = deepFreeze({ ...commitmentBase, artifactUniverseHash });
  const publicArtifacts = deepFreeze({
    schemaVersion: 1 as const,
    corpusManifest,
    referenceManifest,
    observerSampling,
    executorSampling,
    referenceSampling,
    primaryJudgeSampling,
    auditJudgeSampling,
    judgeConfigs,
    routes,
    protocols,
    ...commitments,
  });
  canonicalJson(publicArtifacts as unknown as JsonValue);
  return { publicArtifacts, binding: { spec: input.spec, specIdentityHash: input.spec.identityHash, corpusItems, references, schedule, manifest, commitments } };
}

/** Pure pre-registration helper. Values become authoritative only after issueExperimentArtifacts verifies them. */
export function deriveExperimentArtifactCommitments(input: {
  readonly spec: ExperimentSpec;
  readonly corpusItems: readonly CorpusItem[];
  readonly references: readonly BoundCalibrationReference[];
  readonly createdAt: string;
}): ExperimentArtifactCommitments {
  return derive(input).publicArtifacts;
}

export function issueExperimentArtifacts(input: {
  readonly spec: ExperimentSpec;
  readonly corpusItems: readonly CorpusItem[];
  readonly references: readonly BoundCalibrationReference[];
  readonly createdAt: string;
}): ExperimentArtifacts {
  const derived = derive(input);
  const expected = input.spec.commitments;
  if (
    expected.corpusHash !== derived.publicArtifacts.corpusHash ||
    expected.promptHash !== derived.publicArtifacts.promptHash ||
    expected.harnessHash !== derived.publicArtifacts.harnessHash ||
    expected.judgeHash !== derived.publicArtifacts.judgeHash ||
    expected.observerEventUniverseHash !== derived.publicArtifacts.observerEventUniverseHash ||
    expected.referenceControlUniverseHash !== derived.publicArtifacts.referenceControlUniverseHash ||
    expected.runHash !== derived.publicArtifacts.runHash
  ) throw new TypeError("prespecified expected artifact commitments do not match resolved experiment artifacts");
  const artifactHash = hashJson(derived.publicArtifacts);
  issuedArtifacts.set(derived.publicArtifacts, deepFreeze({ ...derived.binding, artifactHash }));
  return derived.publicArtifacts;
}

export function assertExperimentArtifacts(artifacts: ExperimentArtifacts, spec: ExperimentSpec): void {
  assertExperimentSpecIdentity(spec);
  const binding = issuedArtifacts.get(artifacts);
  if (
    !binding || binding.spec !== spec || binding.specIdentityHash !== spec.identityHash ||
    !Object.isFrozen(artifacts) || binding.artifactHash !== hashJson(artifacts) ||
    binding.commitments.artifactUniverseHash !== artifacts.artifactUniverseHash
  ) throw new TypeError("experiment artifacts must be issued for the exact parsed specification");
}

export function experimentArtifactCorpusItems(artifacts: ExperimentArtifacts, spec: ExperimentSpec): readonly CorpusItem[] {
  assertExperimentArtifacts(artifacts, spec);
  return (issuedArtifacts.get(artifacts) as ArtifactBinding).corpusItems;
}

export function experimentArtifactSchedule(artifacts: ExperimentArtifacts, spec: ExperimentSpec): PersistedSchedule {
  assertExperimentArtifacts(artifacts, spec);
  return (issuedArtifacts.get(artifacts) as ArtifactBinding).schedule;
}

export function experimentArtifactReferences(artifacts: ExperimentArtifacts, spec: ExperimentSpec): readonly BoundCalibrationReference[] {
  assertExperimentArtifacts(artifacts, spec);
  return (issuedArtifacts.get(artifacts) as ArtifactBinding).references;
}

export function experimentArtifactRunManifest(artifacts: ExperimentArtifacts, spec: ExperimentSpec): RunManifest {
  assertExperimentArtifacts(artifacts, spec);
  return (issuedArtifacts.get(artifacts) as ArtifactBinding).manifest;
}
