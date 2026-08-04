import { canonicalJson, compareText, deepFreeze, hashJson, sha256, type JsonValue } from "./canonical";
import {
  assertExperimentArtifacts,
  experimentArtifactCorpusItems,
  experimentArtifactReferences,
  experimentArtifactRunManifest,
  experimentArtifactSchedule,
  type ArtifactCorpusEntry,
  type ArtifactJudgeConfig,
  type ExperimentArtifacts,
} from "./artifacts";
import { createShuffledDonorMap } from "./controls";
import { assessCalibration, type CalibrationEvidence, type Outcome, type ReportedUsage, type RouteProvenance, type Sha256 } from "./domain";
import type { ScoredAttempt } from "./metrics";
import {
  assertObservationBatchForExperiment,
  issuedObserverMemoryInput,
  observationBatchArtifacts,
  type ObservationBatch,
} from "./observer";
import type { ScheduleEntry } from "./schedule";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import {
  boundedInteger,
  finiteNonnegative,
  runtimeTelemetryId,
  utf8Text,
  validateNullableDuration,
  validateReportedUsage,
  validateRouteProvenance,
} from "./runtime-validation";
import { requireUtcRfc3339Millis } from "./timestamps";
import { SCIENTIFIC_LIMITS } from "./limits";

export type ExecutionInputKind = "candidate" | "none" | "shuffled" | "reference";
export type BudgetStatus = "within" | "exhausted" | "exceeded" | "measurement_unknown";

export interface MoneyBudgetEvidence {
  readonly limitUsd: number;
  readonly measuredUsd: number | null;
  readonly status: BudgetStatus;
  readonly skippedCalls: number;
}

export interface StepBudgetEvidence {
  readonly limit: number;
  readonly measured: number;
  readonly status: "within" | "exhausted" | "exceeded";
  readonly skippedCalls: number;
}

export interface ExecutionInputArtifact {
  readonly kind: ExecutionInputKind;
  readonly itemId: string;
  readonly sourceItemId: string | null;
  readonly memoryCount: number;
  readonly memoryArtifactHash: Sha256 | null;
  readonly inputHash: Sha256;
  readonly commitmentHash: Sha256;
}

export interface AttemptCorpusCommitments {
  readonly itemHash: Sha256;
  readonly contentHash: Sha256;
  readonly taskHash: Sha256;
  readonly startingTreeHash: Sha256;
  readonly mechanicalCheckHash: Sha256;
  readonly rubricHash: Sha256 | null;
}

export interface ExperimentAttemptInput {
  readonly entry: ScheduleEntry;
  readonly injectedMemory: string;
  readonly input: ExecutionInputArtifact;
  readonly corpus: AttemptCorpusCommitments;
  readonly protocol: {
    readonly artifactUniverseHash: Sha256;
    readonly executorProtocolHash: Sha256;
    readonly harnessHash: Sha256;
    readonly executorRoute: ExperimentArtifacts["routes"]["executor"];
    readonly executorSampling: ExperimentArtifacts["executorSampling"];
  };
}

export interface RawExecutorResponseArtifact {
  readonly schemaVersion: 1;
  readonly completed: boolean;
  readonly responseText: string;
  readonly diffSummary: string;
  readonly downstreamEvidence: readonly string[];
}

export interface RawToolTraceEntry {
  readonly sequence: number;
  readonly tool: string;
  readonly state: "completed" | "failed";
  readonly summary: string;
}

export interface RawExecutionArtifacts {
  readonly executorResponse: RawExecutorResponseArtifact;
  readonly toolTrace: readonly RawToolTraceEntry[];
}

/** The executor adapter returns artifacts and executor telemetry only. It has no scoring fields. */
export interface ExperimentAttemptResult {
  readonly executionArtifacts: RawExecutionArtifacts;
  readonly reportedCostUsd: number | null;
  readonly durationMs: number | null;
  readonly route: RouteProvenance;
  readonly generationId: string | null;
  readonly tokenCount: number | null;
  readonly steps: number;
  readonly modelCalls: number;
}

export interface ExperimentAttemptRunner {
  run(input: ExperimentAttemptInput): Promise<ExperimentAttemptResult>;
}

export interface ExperimentCalibrationRunner {
  run(input: {
    readonly itemId: string;
    readonly laneId: string;
    readonly attemptId: string;
    readonly injectionText: string;
    readonly route: ExperimentArtifacts["routes"]["reference"];
    readonly sampling: ExperimentArtifacts["referenceSampling"];
  }): Promise<{
    readonly attemptId: string;
    readonly outcome: Outcome;
    readonly reportedCostUsd: number | null;
    readonly route: RouteProvenance;
  }>;
}

export type PrimaryJudgePurpose = "outcome" | "attribution" | "drift";

export interface PrimaryJudgeInput {
  readonly purpose: PrimaryJudgePurpose;
  readonly entry: ScheduleEntry;
  readonly executionArtifacts: RawExecutionArtifacts;
  readonly task: string;
  readonly blindRubric: string | null;
  readonly mechanicalCheck: JsonValue;
  readonly injectedFacts: readonly string[];
  readonly inputCommitment: Sha256;
  readonly config: ArtifactJudgeConfig;
}

export interface PrimaryJudgeResult {
  readonly purpose: PrimaryJudgePurpose;
  readonly outcome: Outcome;
  readonly schemaValid: boolean;
  readonly attributedInputCommitment: Sha256 | null;
  readonly route: RouteProvenance;
  readonly generationId: string | null;
  readonly usage: ReportedUsage;
  readonly durationMs: number | null;
  readonly protocolHash: Sha256;
  readonly configHash: Sha256;
}

export interface PrimaryJudgeAdapter {
  run(input: PrimaryJudgeInput): Promise<PrimaryJudgeResult>;
}

export interface ExperimentPrimaryJudges {
  readonly outcome: PrimaryJudgeAdapter;
  readonly attribution: PrimaryJudgeAdapter;
  readonly drift: PrimaryJudgeAdapter;
}

export interface JudgePurposeProvenance {
  readonly purpose: PrimaryJudgePurpose;
  readonly route: ExperimentArtifacts["routes"]["judge"];
  readonly sampling: ExperimentArtifacts["primaryJudgeSampling"][PrimaryJudgePurpose];
  readonly protocolHash: Sha256;
  readonly configHash: Sha256;
  readonly dispatched: number;
  readonly skipped: number;
  readonly unknown: number;
  readonly effectiveProvider: string | null;
  readonly effectiveModel: string | null;
}

export interface LaneJudgeProvenance {
  readonly candidateId: string;
  readonly laneId: string;
  readonly outcome: JudgePurposeProvenance;
  readonly attribution: JudgePurposeProvenance;
  readonly drift: JudgePurposeProvenance;
}

export interface ExperimentBudgetEvidence {
  readonly observer: ObservationBatch["budget"];
  readonly executor: MoneyBudgetEvidence;
  readonly judgeBeforeAudit: MoneyBudgetEvidence;
  readonly steps: StepBudgetEvidence;
}

export interface ExperimentExecutionBatch {
  readonly attempts: readonly ScoredAttempt[];
  readonly calibration: readonly CalibrationEvidence[];
  readonly scheduleHash: Sha256;
  readonly manifestHash: Sha256;
  readonly inputUniverseHash: Sha256;
  readonly attemptUniverseHash: Sha256;
  readonly calibrationUniverseHash: Sha256;
  readonly executionResultUniverseHash: Sha256;
  /** Hashes raw reassessment artifacts and coordinates only; never primary labels. */
  readonly primaryReassessmentEvidenceUniverseHash: Sha256;
  readonly judgeProvenanceUniverseHash: Sha256;
  readonly evidenceUniverseHash: Sha256;
  readonly observerEventUniverseHash: Sha256;
  readonly observerMemoryUniverseHash: Sha256;
  readonly artifactUniverseHash: Sha256;
  readonly corpusArtifactHash: Sha256;
  readonly promptArtifactHash: Sha256;
  readonly harnessArtifactHash: Sha256;
  readonly judgeArtifactHash: Sha256;
  readonly routeSamplingArtifactHash: Sha256;
  readonly referenceSourceUniverseHash: Sha256;
  readonly referenceControlUniverseHash: Sha256;
  readonly runHash: Sha256;
  readonly budgets: ExperimentBudgetEvidence;
  readonly judgeProvenance: readonly LaneJudgeProvenance[];
}

export interface ExperimentReassessmentRow {
  readonly candidateId: string;
  readonly laneId: string;
  readonly itemId: string;
  readonly repetition: number;
  readonly reassessmentEvidence: {
    readonly dispatchStatus: "completed" | "executor_error" | "budget_skipped";
    readonly executionArtifacts: RawExecutionArtifacts | null;
  };
}

interface PrivateReassessmentRow extends ExperimentReassessmentRow {
  readonly primaryOutcome: Outcome;
}

interface ExecutionBatchBinding {
  readonly spec: ExperimentSpec;
  readonly artifacts: ExperimentArtifacts;
  readonly observerBatch: ObservationBatch;
  readonly specIdentityHash: Sha256;
  readonly publicRows: readonly ExperimentReassessmentRow[];
  readonly privateRows: readonly PrivateReassessmentRow[];
  readonly batchHash: Sha256;
}

const issuedExecutionBatches = new WeakMap<object, ExecutionBatchBinding>();
const consumedAttemptResults = new WeakSet<object>();
const consumedCalibrationResults = new WeakSet<object>();
const consumedJudgeResults = new WeakSet<object>();

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be an ordinary object`);
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    keys.some((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined;
    })) throw new TypeError(`${label} has invalid or missing fields`);
  return value as Record<string, unknown>;
}

function sha(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError(`${label} must be a SHA-256 commitment`);
  return value as Sha256;
}

function outcome(value: unknown, label: string): Outcome {
  if (value !== "pass" && value !== "fail" && value !== "unknown") throw new TypeError(`${label} is invalid`);
  return value;
}

function cost(value: unknown, label: string): number | null {
  return value === null ? null : finiteNonnegative(value, label, SCIENTIFIC_LIMITS.maximumBudgetUsd);
}

class MoneyLedger {
  readonly limitUsd: number;
  #measured: number | null;
  #status: BudgetStatus;
  #skipped = 0;

  constructor(limitUsd: number, measured = 0, status: BudgetStatus = "within") {
    this.limitUsd = limitUsd;
    this.#measured = measured;
    this.#status = status;
  }

  dispatchAllowed(): boolean {
    if (this.#status !== "within") { this.#skipped += 1; return false; }
    if (this.#measured !== null && this.#measured >= this.limitUsd) {
      this.#status = "exhausted";
      this.#skipped += 1;
      return false;
    }
    return true;
  }

  record(value: number | null): void {
    if (value === null || this.#measured === null) {
      this.#measured = null;
      this.#status = "measurement_unknown";
      return;
    }
    this.#measured += value;
    if (!Number.isFinite(this.#measured) || this.#measured > Number.MAX_SAFE_INTEGER) throw new RangeError("budget ledger exceeds safe bounds");
    if (this.#measured > this.limitUsd) this.#status = "exceeded";
  }

  snapshot(): MoneyBudgetEvidence {
    return deepFreeze({ limitUsd: this.limitUsd, measuredUsd: this.#measured, status: this.#status, skippedCalls: this.#skipped });
  }
}

class StepLedger {
  readonly limit: number;
  #measured = 0;
  #status: StepBudgetEvidence["status"] = "within";
  #skipped = 0;

  constructor(limit: number) { this.limit = limit; }

  dispatchAllowed(): boolean {
    if (this.#status !== "within") { this.#skipped += 1; return false; }
    if (this.#measured >= this.limit) {
      this.#status = "exhausted";
      this.#skipped += 1;
      return false;
    }
    return true;
  }

  record(value: number): void {
    this.#measured += value;
    if (!Number.isSafeInteger(this.#measured)) throw new RangeError("step ledger exceeds safe bounds");
    if (this.#measured > this.limit) this.#status = "exceeded";
  }

  snapshot(): StepBudgetEvidence {
    return deepFreeze({ limit: this.limit, measured: this.#measured, status: this.#status, skippedCalls: this.#skipped });
  }
}

function rawArtifacts(value: unknown): RawExecutionArtifacts {
  const source = exactObject(value, ["executorResponse", "toolTrace"], "raw execution artifacts");
  const response = exactObject(source.executorResponse, ["schemaVersion", "completed", "responseText", "diffSummary", "downstreamEvidence"], "raw executor response artifact");
  if (response.schemaVersion !== 1 || typeof response.completed !== "boolean" || !Array.isArray(response.downstreamEvidence)) {
    throw new TypeError("raw executor response artifact is invalid");
  }
  const executorResponse = deepFreeze({
    schemaVersion: 1 as const,
    completed: response.completed,
    responseText: utf8Text(response.responseText, "executor response text", 100_000),
    diffSummary: utf8Text(response.diffSummary, "executor diff summary", 250_000),
    downstreamEvidence: response.downstreamEvidence.map((entry) => utf8Text(entry, "executor downstream evidence", 10_000, true)),
  });
  if (new Set(executorResponse.downstreamEvidence).size !== executorResponse.downstreamEvidence.length) {
    throw new TypeError("executor downstream evidence must be unique");
  }
  if (!Array.isArray(source.toolTrace) || source.toolTrace.length > SCIENTIFIC_LIMITS.maximumSteps) {
    throw new TypeError("raw executor tool trace is invalid");
  }
  const toolTrace = source.toolTrace.map((entry, sequence): RawToolTraceEntry => {
    const row = exactObject(entry, ["sequence", "tool", "state", "summary"], "raw executor tool trace entry");
    if (row.sequence !== sequence || (row.state !== "completed" && row.state !== "failed")) throw new TypeError("raw executor tool trace sequence or state is invalid");
    return deepFreeze({
      sequence,
      tool: utf8Text(row.tool, "raw executor tool name", 80, true),
      state: row.state,
      summary: utf8Text(row.summary, "raw executor tool summary", 10_000, true),
    });
  });
  const result = deepFreeze({ executorResponse, toolTrace });
  if (Buffer.byteLength(canonicalJson(result), "utf8") > 1_000_000) throw new RangeError("raw execution artifacts exceed their byte limit");
  return result;
}

function validateAttemptResult(value: ExperimentAttemptResult, input: ExperimentAttemptInput, spec: ExperimentSpec): ExperimentAttemptResult {
  if (value !== null && typeof value === "object") {
    if (consumedAttemptResults.has(value)) throw new TypeError("attempt runner result objects cannot be reused");
    consumedAttemptResults.add(value);
  }
  const source = exactObject(value, ["executionArtifacts", "reportedCostUsd", "durationMs", "route", "generationId", "tokenCount", "steps", "modelCalls"], "attempt runner result");
  const route = validateRouteProvenance(source.route, spec.routes.executor);
  if (!route.effective.routeReported || route.effective.provider !== spec.routes.executor.provider || route.effective.model !== spec.routes.executor.model) {
    throw new TypeError("executor effective route must equal its requested no-fallback route");
  }
  return deepFreeze({
    executionArtifacts: rawArtifacts(source.executionArtifacts),
    reportedCostUsd: cost(source.reportedCostUsd, "executor cost"),
    durationMs: validateNullableDuration(source.durationMs, "executor duration"),
    route,
    generationId: source.generationId === null ? null : runtimeTelemetryId(source.generationId, "executor generation id"),
    tokenCount: source.tokenCount === null ? null : boundedInteger(source.tokenCount, "executor token count", SCIENTIFIC_LIMITS.maximumTokenCount),
    steps: boundedInteger(source.steps, "executor steps", spec.budgets.maximumSteps * 2),
    modelCalls: boundedInteger(source.modelCalls, "executor model calls", SCIENTIFIC_LIMITS.maximumSteps),
  });
}

function validateJudgeResult(value: PrimaryJudgeResult, purpose: PrimaryJudgePurpose, config: ArtifactJudgeConfig): PrimaryJudgeResult {
  if (value !== null && typeof value === "object") {
    if (consumedJudgeResults.has(value)) throw new TypeError("primary judge result objects cannot be reused");
    consumedJudgeResults.add(value);
  }
  const source = exactObject(value, ["purpose", "outcome", "schemaValid", "attributedInputCommitment", "route", "generationId", "usage", "durationMs", "protocolHash", "configHash"], `${purpose} judge result`);
  if (source.purpose !== purpose || typeof source.schemaValid !== "boolean" || source.protocolHash !== config.protocolHash || source.configHash !== config.configHash) {
    throw new TypeError("primary judge purpose, schema, protocol, or configuration is invalid");
  }
  const route = validateRouteProvenance(source.route, config.route);
  if (!route.effective.routeReported || route.effective.provider !== config.route.provider || route.effective.model !== config.route.model) {
    throw new TypeError("primary judge effective route must equal its requested no-fallback route");
  }
  const usage = validateReportedUsage(source.usage, `${purpose} judge usage`);
  const attributedInputCommitment = source.attributedInputCommitment === null ? null : sha(source.attributedInputCommitment, "attributed input commitment");
  if (purpose !== "attribution" && attributedInputCommitment !== null) throw new TypeError("only attribution judgment can bind an input commitment");
  return deepFreeze({
    purpose,
    outcome: outcome(source.outcome, `${purpose} judge outcome`),
    schemaValid: source.schemaValid,
    attributedInputCommitment,
    route,
    generationId: source.generationId === null ? null : runtimeTelemetryId(source.generationId, `${purpose} judge generation id`),
    usage,
    durationMs: validateNullableDuration(source.durationMs, `${purpose} judge duration`),
    protocolHash: config.protocolHash,
    configHash: config.configHash,
  });
}

function itemCommitments(entry: ArtifactCorpusEntry): AttemptCorpusCommitments {
  return deepFreeze({
    itemHash: entry.itemHash,
    contentHash: entry.contentHash,
    taskHash: entry.taskHash,
    startingTreeHash: entry.startingTreeHash,
    mechanicalCheckHash: entry.mechanicalCheckHash,
    rubricHash: entry.rubricHash,
  });
}

function attemptInput(
  entry: ScheduleEntry,
  observerBatch: ObservationBatch,
  spec: ExperimentSpec,
  artifacts: ExperimentArtifacts,
  donors: Readonly<Record<string, string>>,
): ExperimentAttemptInput {
  let sourceItemId: string | null = entry.itemId;
  let memoryCount = 0;
  let memoryArtifactHash: Sha256 | null = null;
  let injectedMemory = "";
  if (entry.arm === "candidate" || entry.arm === "shuffled") {
    sourceItemId = entry.arm === "candidate" ? entry.itemId : donors[entry.itemId] as string;
    const memory = issuedObserverMemoryInput(observerBatch, spec, sourceItemId);
    memoryCount = memory.memoryCount;
    memoryArtifactHash = memory.memoryHash;
    injectedMemory = memory.injectionText;
  } else if (entry.arm === "reference") {
    const reference = experimentArtifactReferences(artifacts, spec).find((candidate) => candidate.itemId === entry.itemId && candidate.laneId === entry.laneId);
    if (!reference) throw new Error("artifact-issued reference is missing");
    injectedMemory = reference.control.injectionText;
    memoryCount = reference.control.factTexts.length;
    memoryArtifactHash = hashJson(reference.control);
  } else sourceItemId = null;
  const payload = { kind: entry.arm, itemId: entry.itemId, sourceItemId, memoryCount, memoryArtifactHash, inputHash: sha256(injectedMemory) };
  const input = deepFreeze({ ...payload, commitmentHash: hashJson(payload) });
  const corpus = artifacts.corpusManifest.find((candidate) => candidate.itemId === entry.itemId);
  if (!corpus) throw new Error("artifact corpus commitment is missing");
  return deepFreeze({
    entry,
    injectedMemory,
    input,
    corpus: itemCommitments(corpus),
    protocol: {
      artifactUniverseHash: artifacts.artifactUniverseHash,
      executorProtocolHash: hashJson(artifacts.protocols.executor),
      harnessHash: artifacts.harnessHash,
      executorRoute: artifacts.routes.executor,
      executorSampling: artifacts.executorSampling,
    },
  });
}

function budgetSkippedJudge(purpose: PrimaryJudgePurpose, config: ArtifactJudgeConfig): PrimaryJudgeResult {
  return deepFreeze({
    purpose,
    outcome: "unknown" as const,
    schemaValid: false,
    attributedInputCommitment: null,
    route: { requested: config.route, effective: { provider: null, model: null, routeReported: false } },
    generationId: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    durationMs: 0,
    protocolHash: config.protocolHash,
    configHash: config.configHash,
  });
}

function erroredJudge(purpose: PrimaryJudgePurpose, config: ArtifactJudgeConfig): PrimaryJudgeResult {
  return deepFreeze({ ...budgetSkippedJudge(purpose, config), usage: { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null }, durationMs: null });
}

async function invokeJudge(input: {
  readonly purpose: PrimaryJudgePurpose;
  readonly adapter: PrimaryJudgeAdapter;
  readonly request: Omit<PrimaryJudgeInput, "purpose" | "config">;
  readonly config: ArtifactJudgeConfig;
  readonly ledger: MoneyLedger;
}): Promise<{ readonly result: PrimaryJudgeResult; readonly dispatched: boolean }> {
  if (!input.ledger.dispatchAllowed()) return { result: budgetSkippedJudge(input.purpose, input.config), dispatched: false };
  let value: PrimaryJudgeResult;
  try {
    value = await input.adapter.run(deepFreeze({ ...input.request, purpose: input.purpose, config: input.config }));
  } catch {
    const result = erroredJudge(input.purpose, input.config);
    input.ledger.record(null);
    return { result, dispatched: true };
  }
  const result = validateJudgeResult(value, input.purpose, input.config);
  input.ledger.record(result.usage.costUsd);
  return { result, dispatched: true };
}

function calibrationAttemptId(bindingHash: Sha256, arm: "none" | "reference"): string {
  return `cal-${hashJson({ bindingHash, arm, k: 1 }).slice(7, 31)}`;
}

function validateCalibrationResult(value: unknown, attemptId: string, artifacts: ExperimentArtifacts): { readonly outcome: Outcome; readonly reportedCostUsd: number | null } {
  if (value !== null && typeof value === "object") {
    if (consumedCalibrationResults.has(value)) throw new TypeError("calibration result objects cannot be reused");
    consumedCalibrationResults.add(value);
  }
  const source = exactObject(value, ["attemptId", "outcome", "reportedCostUsd", "route"], "calibration runner result");
  if (source.attemptId !== attemptId) throw new TypeError("calibration attempt id mismatch");
  const route = validateRouteProvenance(source.route, artifacts.routes.reference);
  if (!route.effective.routeReported || route.effective.provider !== artifacts.routes.reference.provider || route.effective.model !== artifacts.routes.reference.model) {
    throw new TypeError("reference calibration effective route must equal its requested no-fallback route");
  }
  return deepFreeze({ outcome: outcome(source.outcome, "calibration outcome"), reportedCostUsd: cost(source.reportedCostUsd, "calibration cost") });
}

function sumContagious(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  const sum = (values as number[]).reduce((total, value) => total + value, 0);
  if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw new RangeError("measurement aggregate exceeds safe bounds");
  return sum;
}

function provenanceFor(
  spec: ExperimentSpec,
  artifacts: ExperimentArtifacts,
  records: readonly { readonly entry: ScheduleEntry; readonly purpose: PrimaryJudgePurpose; readonly result: PrimaryJudgeResult; readonly dispatched: boolean }[],
): readonly LaneJudgeProvenance[] {
  const purpose = (candidateId: string, lane: string, name: PrimaryJudgePurpose): JudgePurposeProvenance => {
    const config = artifacts.judgeConfigs[name];
    const selected = records.filter((record) => record.entry.candidateId === candidateId && record.entry.laneId === lane && record.purpose === name);
    const measuredRoutes = selected.filter((record) => record.result.route.effective.routeReported);
    return deepFreeze({
      purpose: name,
      route: config.route,
      sampling: config.sampling,
      protocolHash: config.protocolHash,
      configHash: config.configHash,
      dispatched: selected.filter((record) => record.dispatched).length,
      skipped: selected.filter((record) => !record.dispatched).length,
      unknown: selected.filter((record) => record.result.outcome === "unknown").length,
      effectiveProvider: measuredRoutes.length === selected.length && selected.length > 0 ? config.route.provider : null,
      effectiveModel: measuredRoutes.length === selected.length && selected.length > 0 ? config.route.model : null,
    });
  };
  return deepFreeze(spec.experiment.candidateModels.flatMap((candidateId) => spec.experiment.executorLanes.map((lane) => deepFreeze({
    candidateId,
    laneId: lane,
    outcome: purpose(candidateId, lane, "outcome"),
    attribution: purpose(candidateId, lane, "attribution"),
    drift: purpose(candidateId, lane, "drift"),
  }))));
}

export async function runExperimentEvidence(input: {
  readonly spec: ExperimentSpec;
  readonly artifacts: ExperimentArtifacts;
  readonly observerBatch: ObservationBatch;
  readonly calibrationRunner: ExperimentCalibrationRunner;
  readonly attemptRunner: ExperimentAttemptRunner;
  readonly primaryJudges: ExperimentPrimaryJudges;
  readonly now: () => string;
}): Promise<ExperimentExecutionBatch> {
  exactObject(input, ["spec", "artifacts", "observerBatch", "calibrationRunner", "attemptRunner", "primaryJudges", "now"], "experiment evidence request");
  assertExperimentSpecIdentity(input.spec);
  assertExperimentArtifacts(input.artifacts, input.spec);
  assertObservationBatchForExperiment(input.observerBatch, input.spec);
  if (observationBatchArtifacts(input.observerBatch, input.spec) !== input.artifacts) throw new TypeError("observer and execution must use the exact same issued experiment artifacts");
  if (typeof input.now !== "function") throw new TypeError("experiment clock must be callable");
  requireUtcRfc3339Millis(input.now(), "experiment evidence timestamp");
  if (input.calibrationRunner === null || typeof input.calibrationRunner !== "object" || typeof input.calibrationRunner.run !== "function" ||
    input.attemptRunner === null || typeof input.attemptRunner !== "object" || typeof input.attemptRunner.run !== "function") {
    throw new TypeError("experiment runners must provide run");
  }
  const judges = exactObject(input.primaryJudges, ["outcome", "attribution", "drift"], "primary judges");
  for (const name of ["outcome", "attribution", "drift"] as const) {
    const adapter = judges[name];
    if (adapter === null || typeof adapter !== "object" || typeof (adapter as PrimaryJudgeAdapter).run !== "function") throw new TypeError("primary judge adapter must provide run");
  }

  const executorLedger = new MoneyLedger(input.spec.budgets.executorUsd);
  const judgeLedger = new MoneyLedger(input.spec.budgets.judgeUsd);
  const stepLedger = new StepLedger(input.spec.budgets.maximumSteps);
  const references = experimentArtifactReferences(input.artifacts, input.spec);
  const calibration: CalibrationEvidence[] = [];
  for (const reference of references) {
    const results: { arm: "none" | "reference"; outcome: Outcome; cost: number | null }[] = [];
    for (const arm of ["none", "reference"] as const) {
      const attemptId = calibrationAttemptId(reference.bindingHash, arm);
      if (!executorLedger.dispatchAllowed()) {
        results.push({ arm, outcome: "unknown", cost: 0 });
        continue;
      }
      let returned: Awaited<ReturnType<ExperimentCalibrationRunner["run"]>>;
      try {
        returned = await input.calibrationRunner.run({
          itemId: reference.itemId,
          laneId: reference.laneId,
          attemptId,
          injectionText: arm === "none" ? "" : reference.control.injectionText,
          route: input.artifacts.routes.reference,
          sampling: input.artifacts.referenceSampling,
        });
      } catch {
        executorLedger.record(null);
        results.push({ arm, outcome: "unknown", cost: null });
        continue;
      }
      const result = validateCalibrationResult(returned, attemptId, input.artifacts);
      executorLedger.record(result.reportedCostUsd);
      results.push({ arm, outcome: result.outcome, cost: result.reportedCostUsd });
    }
    const floor = results.find((entry) => entry.arm === "none") as typeof results[number];
    const referenceResult = results.find((entry) => entry.arm === "reference") as typeof results[number];
    calibration.push(assessCalibration(reference.itemId, reference.laneId, floor.outcome, referenceResult.outcome, sumContagious([floor.cost, referenceResult.cost])));
  }

  const corpusById = new Map(experimentArtifactCorpusItems(input.artifacts, input.spec).map((item) => [item.id, item]));
  const schedule = experimentArtifactSchedule(input.artifacts, input.spec);
  const manifest = experimentArtifactRunManifest(input.artifacts, input.spec);
  const donors = createShuffledDonorMap(input.spec.experiment.itemIds, input.spec.seeds.schedule);
  const attempts: ScoredAttempt[] = [];
  const inputArtifacts: { readonly attemptId: string; readonly input: ExecutionInputArtifact; readonly corpus: AttemptCorpusCommitments }[] = [];
  const executionResults: JsonValue[] = [];
  const publicRows: ExperimentReassessmentRow[] = [];
  const privateRows: PrivateReassessmentRow[] = [];
  const judgeRecords: { readonly entry: ScheduleEntry; readonly purpose: PrimaryJudgePurpose; readonly result: PrimaryJudgeResult; readonly dispatched: boolean }[] = [];

  for (const entry of schedule.entries) {
    const scheduledInput = attemptInput(entry, input.observerBatch, input.spec, input.artifacts, donors);
    inputArtifacts.push({ attemptId: entry.attemptId, input: scheduledInput.input, corpus: scheduledInput.corpus });
    let executor: ExperimentAttemptResult | null = null;
    let dispatchStatus: ExperimentReassessmentRow["reassessmentEvidence"]["dispatchStatus"] = "completed";
    const executorAllowed = executorLedger.dispatchAllowed();
    const stepsAllowed = stepLedger.dispatchAllowed();
    if (executorAllowed && stepsAllowed) {
      let returned: ExperimentAttemptResult;
      try { returned = await input.attemptRunner.run(scheduledInput); }
      catch {
        executorLedger.record(null);
        dispatchStatus = "executor_error";
        returned = null as unknown as ExperimentAttemptResult;
      }
      if (dispatchStatus === "completed") {
        executor = validateAttemptResult(returned, scheduledInput, input.spec);
        executorLedger.record(executor.reportedCostUsd);
        stepLedger.record(executor.steps);
      }
    } else dispatchStatus = "budget_skipped";

    const item = corpusById.get(entry.itemId);
    if (!item) throw new Error("scheduled corpus item is missing");
    const baseJudgeRequest = executor === null ? null : {
      entry,
      executionArtifacts: executor.executionArtifacts,
      task: item.task,
      blindRubric: item.blindSuccessRubric ?? null,
      mechanicalCheck: item.mechanicalCheck as unknown as JsonValue,
      injectedFacts: scheduledInput.injectedMemory === "" ? [] : scheduledInput.injectedMemory.split("\n"),
      inputCommitment: scheduledInput.input.commitmentHash,
    };
    const judge = async (purpose: PrimaryJudgePurpose): Promise<PrimaryJudgeResult> => {
      const config = input.artifacts.judgeConfigs[purpose];
      if (baseJudgeRequest === null) {
        const result = budgetSkippedJudge(purpose, config);
        judgeRecords.push({ entry, purpose, result, dispatched: false });
        return result;
      }
      const invoked = await invokeJudge({ purpose, adapter: input.primaryJudges[purpose], request: baseJudgeRequest, config, ledger: judgeLedger });
      judgeRecords.push({ entry, purpose, ...invoked });
      return invoked.result;
    };
    const outcomeJudge = await judge("outcome");
    let attributionJudge: PrimaryJudgeResult | null = null;
    let driftJudge: PrimaryJudgeResult | null = null;
    if (entry.arm === "candidate") {
      attributionJudge = await judge("attribution");
      driftJudge = await judge("drift");
      if (attributionJudge.outcome === "pass" && (
        scheduledInput.input.memoryCount === 0 || attributionJudge.attributedInputCommitment !== scheduledInput.input.commitmentHash
      )) throw new TypeError("favorable attribution must bind the exact non-empty issued input");
      if (attributionJudge.outcome !== "pass" && attributionJudge.attributedInputCommitment !== null) {
        throw new TypeError("non-favorable attribution cannot claim an input commitment");
      }
    }
    const scored: ScoredAttempt = deepFreeze({
      calibration: false as const,
      itemId: entry.itemId,
      laneId: entry.laneId,
      candidateId: entry.candidateId,
      arm: entry.arm,
      repetition: entry.repetition,
      outcome: outcomeJudge.outcome,
      tokensToDone: outcomeJudge.outcome === "pass" ? executor?.tokenCount ?? null : null,
      schemaValid: outcomeJudge.schemaValid && (attributionJudge?.schemaValid ?? true) && (driftJudge?.schemaValid ?? true),
      ...(entry.arm === "candidate" ? {
        attributionOutcome: attributionJudge?.outcome ?? "unknown",
        driftAvoidanceOutcome: driftJudge?.outcome ?? "unknown",
      } : {}),
      reportedCosts: {
        executorUsd: executor === null ? (dispatchStatus === "executor_error" ? null : 0) : executor.reportedCostUsd,
        outcomeJudgeUsd: outcomeJudge.usage.costUsd,
        attributionJudgeUsd: attributionJudge?.usage.costUsd ?? 0,
        driftJudgeUsd: driftJudge?.usage.costUsd ?? 0,
      },
      durationMs: sumContagious([
        executor === null ? (dispatchStatus === "executor_error" ? null : 0) : executor.durationMs,
        outcomeJudge.durationMs,
        attributionJudge?.durationMs ?? 0,
        driftJudge?.durationMs ?? 0,
      ]),
      effectiveProvider: executor?.route.effective.provider ?? null,
      effectiveModel: executor?.route.effective.model ?? null,
    });
    attempts.push(scored);
    executionResults.push({
      attemptId: entry.attemptId,
      dispatchStatus,
      executorArtifactHash: executor === null ? null : hashJson(executor.executionArtifacts),
      executorGenerationId: executor?.generationId ?? null,
      outcomeJudge: { outcome: outcomeJudge.outcome, schemaValid: outcomeJudge.schemaValid, configHash: outcomeJudge.configHash, generationId: outcomeJudge.generationId },
      attributionJudge: attributionJudge === null ? null : { outcome: attributionJudge.outcome, schemaValid: attributionJudge.schemaValid, configHash: attributionJudge.configHash, generationId: attributionJudge.generationId },
      driftJudge: driftJudge === null ? null : { outcome: driftJudge.outcome, schemaValid: driftJudge.schemaValid, configHash: driftJudge.configHash, generationId: driftJudge.generationId },
    });
    if (entry.arm === "candidate") {
      const publicRow = deepFreeze({
        candidateId: entry.candidateId,
        laneId: entry.laneId,
        itemId: entry.itemId,
        repetition: entry.repetition,
        reassessmentEvidence: deepFreeze({ dispatchStatus, executionArtifacts: executor?.executionArtifacts ?? null }),
      });
      publicRows.push(publicRow);
      privateRows.push(deepFreeze({ ...publicRow, primaryOutcome: scored.outcome }));
    }
  }

  const reconciledCalibration = calibration.map((evidence) => {
    const controls = attempts.filter((attempt) => attempt.itemId === evidence.itemId && attempt.laneId === evidence.laneId && (attempt.arm === "none" || attempt.arm === "reference"));
    const contradiction = controls.some((attempt) => {
      if (attempt.outcome === "unknown") return false;
      return attempt.arm === "none" ? attempt.outcome !== evidence.floorOutcome : attempt.outcome !== evidence.referenceOutcome;
    });
    return contradiction ? deepFreeze({ ...evidence, eligible: false, reason: "calibration_instability" as const }) : evidence;
  });
  const judgeProvenance = provenanceFor(input.spec, input.artifacts, judgeRecords);
  const inputUniverseHash = hashJson(inputArtifacts);
  const attemptUniverseHash = hashJson(attempts);
  const calibrationUniverseHash = hashJson(reconciledCalibration);
  const executionResultUniverseHash = hashJson(executionResults);
  const primaryReassessmentEvidenceUniverseHash = hashJson(publicRows);
  const judgeProvenanceUniverseHash = hashJson(judgeProvenance);
  const budgets: ExperimentBudgetEvidence = deepFreeze({
    observer: input.observerBatch.budget,
    executor: executorLedger.snapshot(),
    judgeBeforeAudit: judgeLedger.snapshot(),
    steps: stepLedger.snapshot(),
  });
  const evidenceUniverseHash = hashJson({
    specIdentityHash: input.spec.identityHash,
    scheduleHash: schedule.contentHash,
    manifestHash: manifest.contentHash,
    inputUniverseHash,
    attemptUniverseHash,
    calibrationUniverseHash,
    executionResultUniverseHash,
    primaryReassessmentEvidenceUniverseHash,
    judgeProvenanceUniverseHash,
    observerEventUniverseHash: input.observerBatch.eventUniverseHash,
    observerMemoryUniverseHash: input.observerBatch.memoryUniverseHash,
    artifactUniverseHash: input.artifacts.artifactUniverseHash,
    referenceControlUniverseHash: input.artifacts.referenceControlUniverseHash,
    budgets,
  });
  const result = deepFreeze({
    attempts,
    calibration: reconciledCalibration,
    scheduleHash: schedule.contentHash,
    manifestHash: manifest.contentHash,
    inputUniverseHash,
    attemptUniverseHash,
    calibrationUniverseHash,
    executionResultUniverseHash,
    primaryReassessmentEvidenceUniverseHash,
    judgeProvenanceUniverseHash,
    evidenceUniverseHash,
    observerEventUniverseHash: input.observerBatch.eventUniverseHash,
    observerMemoryUniverseHash: input.observerBatch.memoryUniverseHash,
    artifactUniverseHash: input.artifacts.artifactUniverseHash,
    corpusArtifactHash: input.artifacts.corpusHash,
    promptArtifactHash: input.artifacts.promptHash,
    harnessArtifactHash: input.artifacts.harnessHash,
    judgeArtifactHash: input.artifacts.judgeHash,
    routeSamplingArtifactHash: input.artifacts.routeSamplingHash,
    referenceSourceUniverseHash: input.artifacts.referenceSourceUniverseHash,
    referenceControlUniverseHash: input.artifacts.referenceControlUniverseHash,
    runHash: input.artifacts.runHash,
    budgets,
    judgeProvenance,
  });
  const binding = deepFreeze({
    spec: input.spec,
    artifacts: input.artifacts,
    observerBatch: input.observerBatch,
    specIdentityHash: input.spec.identityHash,
    publicRows,
    privateRows,
    batchHash: hashJson({ result, publicRows }),
  });
  issuedExecutionBatches.set(result, binding);
  return result;
}

export function assertExperimentExecutionBatch(batch: ExperimentExecutionBatch, spec: ExperimentSpec): void {
  assertExperimentSpecIdentity(spec);
  const binding = issuedExecutionBatches.get(batch);
  if (!binding || binding.spec !== spec || binding.specIdentityHash !== spec.identityHash || !Object.isFrozen(batch)) {
    throw new TypeError("experiment evidence must be issued for the exact experiment");
  }
  assertExperimentArtifacts(binding.artifacts, spec);
  assertObservationBatchForExperiment(binding.observerBatch, spec);
  if (
    batch.runHash !== binding.artifacts.runHash || batch.artifactUniverseHash !== binding.artifacts.artifactUniverseHash ||
    batch.referenceControlUniverseHash !== binding.artifacts.referenceControlUniverseHash ||
    batch.attemptUniverseHash !== hashJson(batch.attempts) || batch.calibrationUniverseHash !== hashJson(batch.calibration) ||
    batch.primaryReassessmentEvidenceUniverseHash !== hashJson(binding.publicRows) ||
    batch.judgeProvenanceUniverseHash !== hashJson(batch.judgeProvenance) ||
    binding.batchHash !== hashJson({ result: batch, publicRows: binding.publicRows })
  ) throw new TypeError("experiment execution evidence binding changed");
}

export function executionBatchObserver(batch: ExperimentExecutionBatch, spec: ExperimentSpec): ObservationBatch {
  assertExperimentExecutionBatch(batch, spec);
  return (issuedExecutionBatches.get(batch) as ExecutionBatchBinding).observerBatch;
}

export function executionBatchArtifacts(batch: ExperimentExecutionBatch, spec: ExperimentSpec): ExperimentArtifacts {
  assertExperimentExecutionBatch(batch, spec);
  return (issuedExecutionBatches.get(batch) as ExecutionBatchBinding).artifacts;
}

export function executionBatchBindingCommitment(batch: ExperimentExecutionBatch, spec: ExperimentSpec): Sha256 {
  assertExperimentExecutionBatch(batch, spec);
  return (issuedExecutionBatches.get(batch) as ExecutionBatchBinding).batchHash;
}

export function executionBatchLaneJudgeProvenance(batch: ExperimentExecutionBatch, spec: ExperimentSpec): readonly LaneJudgeProvenance[] {
  assertExperimentExecutionBatch(batch, spec);
  return batch.judgeProvenance;
}

/** @internal Direct-module bridge; intentionally omitted from the package index. */
export function internalExecutionBatchPrimaryReassessmentRows(batch: ExperimentExecutionBatch, spec: ExperimentSpec): readonly PrivateReassessmentRow[] {
  assertExperimentExecutionBatch(batch, spec);
  return (issuedExecutionBatches.get(batch) as ExecutionBatchBinding).privateRows;
}
