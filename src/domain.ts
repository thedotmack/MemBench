import { deepFreeze, hashJson } from "./canonical";
import { isSafeIdentifier, requireSafeIdentifier } from "./identifiers";
import { SCIENTIFIC_LIMITS } from "./limits";
import { requireUtcRfc3339Millis } from "./timestamps";

export type Outcome = "pass" | "fail" | "unknown";
export type Decision = "recommend" | "do_not_recommend" | "insufficient_evidence";
export type ControlKind = "none" | "shuffled" | "reference";
export type ArmKind = "candidate" | ControlKind;
export type LaneId = string & { readonly __laneId: unique symbol };
export type Sha256 = `sha256:${string}`;

export interface ReportedUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface RequestedRoute {
  readonly provider: string;
  readonly model: string;
  readonly allowFallbacks: boolean;
}

export interface EffectiveRoute {
  readonly provider: string | null;
  readonly model: string | null;
  readonly routeReported: boolean;
}

export interface RouteProvenance {
  readonly requested: RequestedRoute;
  readonly effective: EffectiveRoute;
}

export interface ExperimentIdentity {
  readonly corpusHash: Sha256;
  readonly promptHash: Sha256;
  readonly routeHash: Sha256;
  readonly harnessHash: Sha256;
  readonly configHash: Sha256;
  readonly judgeHash: Sha256;
  readonly combinedHash: Sha256;
}

export interface CalibrationEvidence {
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly floorOutcome: Outcome;
  readonly referenceOutcome: Outcome;
  readonly eligible: boolean;
  readonly reason: "calibrated" | "floor_did_not_fail" | "reference_did_not_pass" | "unknown";
}

interface AttemptBase {
  readonly attemptId: string;
  readonly sequence: number;
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly candidateId: string;
  readonly arm: ArmKind;
  readonly repetition: number;
  readonly recordedAt: string;
}

export interface ScheduledAttempt extends AttemptBase {
  readonly state: "scheduled";
}

export interface TerminalAttempt extends AttemptBase {
  readonly state: "terminal";
  readonly outcome: Outcome;
  readonly usage: ReportedUsage;
  readonly schemaValid: boolean;
}

export interface InterruptedAttempt extends AttemptBase {
  readonly state: "interrupted";
  readonly reason: string;
}

export type AttemptState = ScheduledAttempt | TerminalAttempt | InterruptedAttempt;

export function laneId(value: string): LaneId {
  return requireSafeIdentifier(value, "lane id") as LaneId;
}

export function missingUsage(): ReportedUsage {
  return deepFreeze({
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  });
}

export function assessCalibration(
  itemId: string,
  laneIdValue: LaneId,
  floorOutcome: Outcome,
  referenceOutcome: Outcome,
): CalibrationEvidence {
  if (
    !isSafeIdentifier(itemId) || !isSafeIdentifier(laneIdValue) ||
    !new Set<unknown>(["pass", "fail", "unknown"]).has(floorOutcome) ||
    !new Set<unknown>(["pass", "fail", "unknown"]).has(referenceOutcome)
  ) throw new TypeError("calibration input is invalid");
  const eligible = floorOutcome === "fail" && referenceOutcome === "pass";
  const reason: CalibrationEvidence["reason"] = eligible
    ? "calibrated"
    : floorOutcome === "unknown" || referenceOutcome === "unknown"
      ? "unknown"
      : floorOutcome !== "fail"
        ? "floor_did_not_fail"
        : "reference_did_not_pass";
  return deepFreeze({
    itemId,
    laneId: laneIdValue,
    floorOutcome,
    referenceOutcome,
    eligible,
    reason,
  });
}

export function createExperimentIdentity(input: Omit<ExperimentIdentity, "combinedHash">): ExperimentIdentity {
  const required = ["corpusHash", "promptHash", "routeHash", "harnessHash", "configHash", "judgeHash"];
  if (Object.keys(input).length !== required.length || required.some((key) => !Object.hasOwn(input, key))) {
    throw new TypeError("experiment identity components are invalid");
  }
  for (const value of Object.values(input)) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw new TypeError("invalid identity hash");
  }
  const combinedHash = hashJson(input);
  return deepFreeze({ ...input, combinedHash });
}

const armKinds = new Set<unknown>(["candidate", "none", "shuffled", "reference"]);
const outcomes = new Set<unknown>(["pass", "fail", "unknown"]);

function boundedText(value: unknown, label: string, pattern?: RegExp, maximum = 500): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    (pattern && !pattern.test(value))
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function validRecordedAt(value: unknown): string {
  return requireUtcRfc3339Millis(value, "attempt timestamp");
}

function nonnegativeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new TypeError(`${label} must be a bounded non-negative integer`);
  }
  return value as number;
}

function usageNumber(value: unknown, label: string, integer: boolean): number | null {
  if (value === null) return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && (!Number.isSafeInteger(value) || value > SCIENTIFIC_LIMITS.maximumTokenCount)) ||
    (!integer && value > SCIENTIFIC_LIMITS.maximumBudgetUsd)
  ) throw new TypeError(`${label} must be a finite non-negative reported value or null`);
  return value;
}

function cloneUsage(value: unknown): ReportedUsage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("attempt usage must be an object");
  }
  const source = value as Record<string, unknown>;
  const required = ["inputTokens", "outputTokens", "totalTokens", "costUsd"];
  if (Object.keys(source).length !== required.length || required.some((key) => !Object.hasOwn(source, key))) {
    throw new TypeError("attempt usage has invalid fields");
  }
  const inputTokens = usageNumber(source.inputTokens, "input tokens", true);
  const outputTokens = usageNumber(source.outputTokens, "output tokens", true);
  const totalTokens = usageNumber(source.totalTokens, "total tokens", true);
  if (inputTokens !== null && outputTokens !== null) {
    const aggregate = inputTokens + outputTokens;
    if (
      !Number.isSafeInteger(aggregate) || aggregate > SCIENTIFIC_LIMITS.maximumTokenCount ||
      (totalTokens !== null && totalTokens !== aggregate)
    ) throw new TypeError("attempt usage token aggregate is invalid");
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd: usageNumber(source.costUsd, "reported cost", false),
  };
}

function cloneAttempt(value: unknown): AttemptState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("attempt row must be an object");
  }
  const row = value as Record<string, unknown>;
  const state = row.state;
  if (state !== "scheduled" && state !== "terminal" && state !== "interrupted") {
    throw new TypeError("attempt state is invalid");
  }
  if (!armKinds.has(row.arm)) throw new TypeError("attempt arm is invalid");
  const base: AttemptBase = {
    attemptId: requireSafeIdentifier(row.attemptId, "attempt id"),
    sequence: nonnegativeInteger(row.sequence, "attempt sequence", SCIENTIFIC_LIMITS.maximumScheduleEntries - 1),
    itemId: requireSafeIdentifier(row.itemId, "attempt item id"),
    laneId: laneId(requireSafeIdentifier(row.laneId, "attempt lane id")),
    candidateId: requireSafeIdentifier(row.candidateId, "attempt candidate id"),
    arm: row.arm as ArmKind,
    repetition: nonnegativeInteger(row.repetition, "attempt repetition", SCIENTIFIC_LIMITS.maximumRepetitions - 1),
    recordedAt: validRecordedAt(row.recordedAt),
  };
  const expectedKeys = state === "terminal"
    ? [...Object.keys(base), "state", "outcome", "usage", "schemaValid"]
    : state === "interrupted"
      ? [...Object.keys(base), "state", "reason"]
      : [...Object.keys(base), "state"];
  if (Object.keys(row).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(row, key))) {
    throw new TypeError("attempt row has invalid fields");
  }
  if (state === "scheduled") return { ...base, state };
  if (state === "interrupted") {
    return { ...base, state, reason: boundedText(row.reason, "interruption reason") };
  }
  if (!outcomes.has(row.outcome)) throw new TypeError("attempt outcome is invalid");
  if (typeof row.schemaValid !== "boolean") throw new TypeError("attempt schemaValid must be boolean");
  return {
    ...base,
    state,
    outcome: row.outcome as Outcome,
    usage: cloneUsage(row.usage),
    schemaValid: row.schemaValid,
  };
}

function coordinate(row: AttemptBase): string {
  return [row.itemId, row.laneId, row.candidateId, row.arm, row.repetition].join("\0");
}

function sameScheduledIdentity(scheduled: ScheduledAttempt, next: AttemptState): boolean {
  return scheduled.attemptId === next.attemptId &&
    scheduled.sequence === next.sequence &&
    scheduled.itemId === next.itemId &&
    scheduled.laneId === next.laneId &&
    scheduled.candidateId === next.candidateId &&
    scheduled.arm === next.arm &&
    scheduled.repetition === next.repetition;
}

interface JournalIndex {
  readonly scheduledById: Map<string, ScheduledAttempt>;
  readonly terminalIds: Set<string>;
  readonly coordinateOwners: Map<string, string>;
  readonly sequenceOwners: Map<number, string>;
}

function emptyJournalIndex(): JournalIndex {
  return {
    scheduledById: new Map<string, ScheduledAttempt>(),
    terminalIds: new Set<string>(),
    coordinateOwners: new Map<string, string>(),
    sequenceOwners: new Map<number, string>(),
  };
}

function appendIndexed(index: JournalIndex, row: AttemptState): void {
  if (row.state === "scheduled") {
    if (index.scheduledById.has(row.attemptId) || index.terminalIds.has(row.attemptId)) {
      throw new Error("attempt id is duplicated in the journal");
    }
    if (row.sequence !== index.scheduledById.size || index.sequenceOwners.has(row.sequence)) {
      throw new Error("scheduled attempt sequence must be unique, contiguous, and monotonic");
    }
    const key = coordinate(row);
    if (index.coordinateOwners.has(key)) throw new Error("attempt scientific coordinate is duplicated");
    index.coordinateOwners.set(key, row.attemptId);
    index.sequenceOwners.set(row.sequence, row.attemptId);
    index.scheduledById.set(row.attemptId, row);
    return;
  }
  const scheduled = index.scheduledById.get(row.attemptId);
  if (!scheduled) throw new Error("an attempt must be scheduled before it reaches a terminal state");
  if (index.terminalIds.has(row.attemptId)) {
    throw new Error("attempt history is append-only and terminal states are final");
  }
  if (!sameScheduledIdentity(scheduled, row)) {
    throw new Error("terminal attempt identity differs from its scheduled row");
  }
  if (Date.parse(row.recordedAt) < Date.parse(scheduled.recordedAt)) {
    throw new Error("terminal attempt timestamp cannot predate its scheduled row");
  }
  index.terminalIds.add(row.attemptId);
}

export class AttemptJournalBuilder {
  readonly #rows: AttemptState[] = [];
  readonly #index: JournalIndex = emptyJournalIndex();

  constructor(initial: readonly AttemptState[] = []) {
    for (const value of initial) this.append(value);
  }

  get size(): number {
    return this.#rows.length;
  }

  append(value: AttemptState): void {
    if (this.#rows.length >= SCIENTIFIC_LIMITS.maximumScheduleEntries * 2) {
      throw new RangeError("attempt journal exceeds its bounded allocation");
    }
    const row = deepFreeze(cloneAttempt(value)) as AttemptState;
    appendIndexed(this.#index, row);
    this.#rows.push(row);
  }

  snapshot(): readonly AttemptState[] {
    return deepFreeze([...this.#rows]);
  }
}

/** Immutable compatibility helper. Use AttemptJournalBuilder for lifecycle-scale appends. */
export function appendAttempt(
  journal: readonly AttemptState[],
  next: AttemptState,
): readonly AttemptState[] {
  if (journal.length >= SCIENTIFIC_LIMITS.maximumScheduleEntries * 2) {
    throw new RangeError("attempt journal exceeds its bounded allocation");
  }
  const builder = new AttemptJournalBuilder(journal);
  builder.append(next);
  return builder.snapshot();
}
