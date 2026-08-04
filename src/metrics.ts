import { canonicalJson, compareText, deepFreeze, hashJson } from "./canonical";
import type {
  ArmKind,
  CalibrationEvidence,
  Decision,
  LaneId,
  Outcome,
  Sha256,
} from "./domain";
import { laneId } from "./domain";
import { SeededRandom } from "./prng";
import { isSafeIdentifier } from "./identifiers";
import { checkedProductWithin, SCIENTIFIC_LIMITS } from "./limits";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import {
  assertExperimentExecutionBatch,
  executionBatchArtifacts,
  executionBatchBindingCommitment,
  executionBatchObserver,
  type ExperimentExecutionBatch,
} from "./evidence";
import type { ObservationBatch } from "./observer";

export interface ScoredAttempt {
  readonly calibration: false;
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly candidateId: string;
  readonly arm: ArmKind;
  readonly repetition: number;
  readonly outcome: Outcome;
  readonly tokensToDone: number | null;
  readonly schemaValid: boolean;
  readonly attributionOutcome?: Outcome;
  readonly driftAvoidanceOutcome?: Outcome;
  readonly reportedCosts?: {
    readonly executorUsd: number | null;
    readonly outcomeJudgeUsd: number | null;
    readonly attributionJudgeUsd: number | null;
    readonly driftJudgeUsd: number | null;
  };
  readonly durationMs?: number | null;
  readonly effectiveProvider?: string | null;
  readonly effectiveModel?: string | null;
}

export interface ItemArmSummary {
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly candidateId: string;
  readonly arm: ArmKind;
  readonly attemptCount: number;
  readonly knownOutcomeCount: number;
  readonly unknownOutcomeCount: number;
  readonly knownFailureCount: number;
  readonly passRate: number | null;
  readonly tokensToDone: number | null;
  readonly schemaFailureRate: number;
  readonly attributionRate: number | null;
  readonly driftAvoidanceRate: number | null;
  readonly attributionFailureCount: number;
  readonly unknownAttributionCount: number;
  readonly driftFailureCount: number;
  readonly unknownDriftCount: number;
  readonly reportedCosts: {
    readonly executorUsd: number | null;
    readonly outcomeJudgeUsd: number | null;
    readonly attributionJudgeUsd: number | null;
    readonly driftJudgeUsd: number | null;
    readonly totalUsd: number | null;
  };
  readonly durationMs: number | null;
  readonly effectiveProvider: string | null;
  readonly effectiveModel: string | null;
}

export interface ItemEffect {
  readonly itemId: string;
  readonly value: number;
}

export interface BootstrapInterval {
  readonly estimate: number;
  readonly lower: number;
  readonly upper: number;
  readonly nominalAlpha: number;
  readonly adjustedAlpha: number;
  readonly comparisonFamilySize: number;
  readonly samples: number;
  readonly sampleHash: `sha256:${string}`;
  readonly itemCount: number;
  readonly inferentialUnit: "item";
}

export interface CandidateComparison {
  readonly candidateId: string;
  readonly laneId: LaneId;
  readonly calibratedItemCount: number;
  readonly calibrationExclusions: {
    readonly floorDidNotFail: number;
    readonly referenceDidNotPass: number;
    readonly unknown: number;
    readonly instability: number;
  };
  readonly pairedFloorItemCount: number;
  readonly pairedReferenceItemCount: number;
  readonly pairedShuffledItemCount: number;
  readonly floorDelta: BootstrapInterval | null;
  readonly referenceGap: BootstrapInterval | null;
  readonly referenceGapRole: "descriptive_not_decision_bearing";
  readonly shuffledDelta: BootstrapInterval | null;
  readonly shuffledDeltaRole: "diagnostic_not_decision_bearing";
  readonly candidateTaskSuccessRate: number | null;
  readonly candidateUnknownOutcomeRate: number;
  readonly candidateAttributionRate: number | null;
  readonly candidateDriftAvoidanceRate: number | null;
  readonly candidateSchemaFailureRate: number | null;
  readonly candidateTokensToDone: number | null;
  readonly candidateFailures: {
    readonly taskFailure: number;
    readonly schemaFailure: number;
    readonly attributionFailure: number;
    readonly driftFailure: number;
    readonly unknownOutcome: number;
    readonly unknownAttribution: number;
    readonly unknownDrift: number;
  };
  readonly reportedCost: {
    readonly candidateArmUsd: number | null;
    readonly controlArmsUsd: number | null;
    readonly allAttemptsUsd: number | null;
    readonly executorUsd: number | null;
    readonly outcomeJudgeUsd: number | null;
    readonly attributionJudgeUsd: number | null;
    readonly driftJudgeUsd: number | null;
  };
  readonly durationMs: number | null;
  readonly effectiveProvider: string | null;
  readonly effectiveModel: string | null;
  readonly decision: Decision;
  readonly decisionReasons: readonly string[];
}

export interface BootstrapSettings {
  readonly seed: string;
  readonly samples: number;
  readonly alpha: number;
  readonly comparisonFamilySize: number;
}

interface DerivedDecisionSettings extends BootstrapSettings {
  readonly minimumEffect: number;
  readonly maximumSchemaFailureRate: number;
  readonly maximumUnknownOutcomeRate: 0;
  readonly minimumCalibratedItems: number;
  readonly minimumAttributionRate: number;
  readonly minimumDriftAvoidanceRate: number;
}

const scheduledArms = ["candidate", "none", "shuffled", "reference"] as const;
interface ComparisonFamilyBinding {
  readonly spec: ExperimentSpec;
  readonly specIdentityHash: Sha256;
  readonly coordinateHash: Sha256;
  readonly routeHash: Sha256;
  readonly corpusHash: Sha256;
  readonly promptHash: Sha256;
  readonly harnessHash: Sha256;
  readonly judgeHash: Sha256;
  readonly runHash: Sha256;
  readonly attemptUniverseHash: Sha256;
  readonly calibrationUniverseHash: Sha256;
  readonly evidenceUniverseHash: Sha256;
  readonly executionBatch: ExperimentExecutionBatch | null;
  readonly executionBatchBindingHash: Sha256 | null;
  readonly observerBatch: ObservationBatch | null;
  readonly observerEventUniverseHash: Sha256 | null;
  readonly observerMemoryUniverseHash: Sha256 | null;
  readonly calibrationCostUsd: number | null;
  readonly familyHash: Sha256;
}
const issuedComparisons = new WeakMap<object, { readonly familyHash: Sha256; readonly coordinate: string }>();
const issuedComparisonFamilies = new WeakMap<object, ComparisonFamilyBinding>();

const publicRouteLabel = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,79}(?:\/[A-Za-z0-9][A-Za-z0-9._@+-]{0,79})?$/u;

function isPublicRouteLabel(value: unknown): value is string {
  return typeof value === "string" && publicRouteLabel.test(value) &&
    !/^[A-Za-z]:\//u.test(value) && !value.includes("..");
}

function mean(values: readonly number[]): number {
  if (values.length === 0) throw new TypeError("mean requires at least one value");
  let sum = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) throw new TypeError("mean requires finite values");
    sum += value;
    if (!Number.isFinite(sum) || Math.abs(sum) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("metric aggregate exceeds safe numeric bounds");
    }
  }
  const result = sum / values.length;
  if (!Number.isFinite(result)) throw new RangeError("metric mean is not finite");
  return result;
}

export function summarizeItemArms(attempts: readonly ScoredAttempt[]): readonly ItemArmSummary[] {
  if (attempts.length > SCIENTIFIC_LIMITS.maximumScheduleEntries) {
    throw new RangeError("scored attempts exceed the bounded allocation");
  }
  const groups = new Map<string, ScoredAttempt[]>();
  const coordinates = new Set<string>();
  const arms = new Set<unknown>(scheduledArms);
  const validOutcomes = new Set<unknown>(["pass", "fail", "unknown"]);
  for (const attempt of attempts) {
    if ((attempt as { calibration?: unknown }).calibration !== false) {
      throw new TypeError("calibration attempts cannot enter scored metrics");
    }
    const optionalOutcome = (value: unknown): boolean => value === undefined || validOutcomes.has(value);
    const optionalMeasurement = (value: unknown, maximum: number): boolean =>
      value === undefined || value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum);
    const routeLabel = (value: unknown): boolean => value === undefined || value === null || (
      isPublicRouteLabel(value)
    );
    if (
      !isSafeIdentifier(attempt.itemId) || !isSafeIdentifier(attempt.laneId) ||
      !isSafeIdentifier(attempt.candidateId) || !arms.has(attempt.arm) ||
      !Number.isSafeInteger(attempt.repetition) || attempt.repetition < 0 ||
      attempt.repetition >= SCIENTIFIC_LIMITS.maximumRepetitions ||
      !validOutcomes.has(attempt.outcome) || typeof attempt.schemaValid !== "boolean" ||
      !optionalOutcome(attempt.attributionOutcome) || !optionalOutcome(attempt.driftAvoidanceOutcome) ||
      (attempt.reportedCosts !== undefined && (
        attempt.reportedCosts === null || typeof attempt.reportedCosts !== "object" ||
        Array.isArray(attempt.reportedCosts) ||
        canonicalJson(Object.keys(attempt.reportedCosts).sort(compareText)) !== canonicalJson([
          "attributionJudgeUsd", "driftJudgeUsd", "executorUsd", "outcomeJudgeUsd",
        ]) ||
        Object.values(attempt.reportedCosts).some((value) =>
          value === undefined || !optionalMeasurement(value, SCIENTIFIC_LIMITS.maximumBudgetUsd)
        )
      )) ||
      !optionalMeasurement(attempt.durationMs, Number.MAX_SAFE_INTEGER) ||
      !routeLabel(attempt.effectiveProvider) || !routeLabel(attempt.effectiveModel) ||
      ((attempt.effectiveProvider === null) !== (attempt.effectiveModel === null)) ||
      ((attempt.effectiveProvider === undefined) !== (attempt.effectiveModel === undefined))
    ) throw new TypeError("scored attempt has invalid runtime fields");
    if (
      attempt.tokensToDone !== null &&
      (!Number.isSafeInteger(attempt.tokensToDone) || attempt.tokensToDone < 0 ||
        attempt.tokensToDone > SCIENTIFIC_LIMITS.maximumTokenCount)
    ) {
      throw new TypeError("reported tokens-to-done must be a bounded non-negative integer or missing");
    }
    if (attempt.outcome !== "pass" && attempt.tokensToDone !== null) {
      throw new TypeError("tokens-to-done must be missing when an attempt did not pass");
    }
    const key = [attempt.itemId, attempt.laneId, attempt.candidateId, attempt.arm].join("\0");
    const coordinate = `${key}\0${attempt.repetition}`;
    if (coordinates.has(coordinate)) throw new TypeError("scored attempt scientific coordinate is duplicated");
    coordinates.add(coordinate);
    const group = groups.get(key) ?? [];
    group.push(attempt);
    groups.set(key, group);
  }
  return deepFreeze(
    [...groups.values()].map((group) => {
      const first = group[0];
      if (!first) throw new Error("empty metric group");
      const known = group.filter((attempt) => attempt.outcome !== "unknown");
      const passed = known.filter((attempt) => attempt.outcome === "pass");
      const knownFailures = known.filter((attempt) => attempt.outcome === "fail");
      const passTokens = passed.map((attempt) => attempt.tokensToDone);
      const derivedRate = (field: "attributionOutcome" | "driftAvoidanceOutcome"): number | null => {
        const values = group.map((attempt) => attempt[field]);
        return values.some((value) => value === undefined || value === "unknown")
          ? null
          : values.filter((value) => value === "pass").length / values.length;
      };
      const summedMeasurement = (field: "durationMs"): number | null => {
        const values = group.map((attempt) => attempt[field]);
        if (values.some((value) => value === undefined || value === null)) return null;
        const sum = (values as number[]).reduce((total, value) => total + value, 0);
        if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw new RangeError("reported measurement aggregate exceeds safe bounds");
        return sum;
      };
      const summedCost = (field: keyof NonNullable<ScoredAttempt["reportedCosts"]>): number | null => {
        const values = group.map((attempt) => attempt.reportedCosts?.[field]);
        if (values.some((value) => value === undefined || value === null)) return null;
        const sum = (values as number[]).reduce((total, value) => total + value, 0);
        if (!Number.isFinite(sum) || sum > Number.MAX_SAFE_INTEGER) throw new RangeError("reported cost aggregate exceeds safe bounds");
        return sum;
      };
      const reportedCosts = {
        executorUsd: summedCost("executorUsd"),
        outcomeJudgeUsd: summedCost("outcomeJudgeUsd"),
        attributionJudgeUsd: summedCost("attributionJudgeUsd"),
        driftJudgeUsd: summedCost("driftJudgeUsd"),
      };
      const totalCost = Object.values(reportedCosts).some((value) => value === null)
        ? null
        : (Object.values(reportedCosts) as number[]).reduce((sum, value) => sum + value, 0);
      const route = (field: "effectiveProvider" | "effectiveModel"): string | null => {
        const values = group.map((attempt) => attempt[field]);
        if (values.some((value) => value === undefined || value === null)) return null;
        const unique = new Set(values as string[]);
        if (unique.size !== 1) throw new TypeError("effective route changed within an item arm");
        return values[0] as string;
      };
      return {
        itemId: first.itemId,
        laneId: first.laneId,
        candidateId: first.candidateId,
        arm: first.arm,
        attemptCount: group.length,
        knownOutcomeCount: known.length,
        unknownOutcomeCount: group.length - known.length,
        knownFailureCount: knownFailures.length,
        passRate: known.length === 0 || known.length !== group.length ? null : passed.length / known.length,
        tokensToDone: passed.length !== group.length || passTokens.some((value) => value === null)
          ? null
          : mean(passTokens as number[]),
        schemaFailureRate: group.filter((attempt) => !attempt.schemaValid).length / group.length,
        attributionRate: derivedRate("attributionOutcome"),
        driftAvoidanceRate: derivedRate("driftAvoidanceOutcome"),
        attributionFailureCount: group.filter((attempt) => attempt.attributionOutcome === "fail").length,
        unknownAttributionCount: group.filter((attempt) =>
          attempt.attributionOutcome === undefined || attempt.attributionOutcome === "unknown"
        ).length,
        driftFailureCount: group.filter((attempt) => attempt.driftAvoidanceOutcome === "fail").length,
        unknownDriftCount: group.filter((attempt) =>
          attempt.driftAvoidanceOutcome === undefined || attempt.driftAvoidanceOutcome === "unknown"
        ).length,
        reportedCosts: { ...reportedCosts, totalUsd: totalCost },
        durationMs: summedMeasurement("durationMs"),
        effectiveProvider: route("effectiveProvider"),
        effectiveModel: route("effectiveModel"),
      };
    }).sort((left, right) =>
      compareText(
        [left.laneId, left.candidateId, left.itemId, left.arm].join("\0"),
        [right.laneId, right.candidateId, right.itemId, right.arm].join("\0"),
      )
    ),
  );
}

export function equalItemMean(
  summaries: readonly ItemArmSummary[],
  metric: "passRate" | "schemaFailureRate" | "tokensToDone" | "attributionRate" | "driftAvoidanceRate",
): number | null {
  if (summaries.length === 0) return null;
  const values = summaries.map((summary) => summary[metric]);
  if (values.some((value) => value === null)) return null;
  if (values.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
    throw new TypeError("item metric must be finite or missing");
  }
  return mean(values as number[]);
}

function percentile(sorted: readonly number[], probability: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(probability * sorted.length)));
  const value = sorted[index];
  if (value === undefined) throw new Error("bootstrap produced no values");
  return value;
}

export function bootstrapPairedItemEffects(
  effects: readonly ItemEffect[],
  options: BootstrapSettings,
): BootstrapInterval {
  if (effects.length === 0 || new Set(effects.map((effect) => effect.itemId)).size !== effects.length) {
    throw new TypeError("bootstrap input must contain one paired effect per unique item");
  }
  if (
    effects.length > SCIENTIFIC_LIMITS.maximumItems ||
    effects.some((effect) =>
      !isSafeIdentifier(effect.itemId) ||
      typeof effect.value !== "number" || !Number.isFinite(effect.value) ||
      effect.value < -1 || effect.value > 1
    )
  ) throw new TypeError("bootstrap item effects must be finite and bounded between minus one and one");
  if (
    !Number.isSafeInteger(options.samples) ||
    options.samples < SCIENTIFIC_LIMITS.minimumBootstrapSamples ||
    options.samples > SCIENTIFIC_LIMITS.maximumBootstrapSamples
  ) {
    throw new TypeError("bootstrap sample count is outside scientific limits");
  }
  if (
    typeof options.alpha !== "number" || !Number.isFinite(options.alpha) ||
    options.alpha < SCIENTIFIC_LIMITS.minimumAlpha || options.alpha > SCIENTIFIC_LIMITS.maximumAlpha
  ) throw new TypeError("alpha is outside scientific limits");
  const maximumFamilySize = SCIENTIFIC_LIMITS.maximumCandidates * SCIENTIFIC_LIMITS.maximumLanes;
  if (
    !Number.isSafeInteger(options.comparisonFamilySize) ||
    options.comparisonFamilySize < 1 || options.comparisonFamilySize > maximumFamilySize
  ) {
    throw new TypeError("comparison family size must be a positive integer");
  }
  if (
    typeof options.seed !== "string" || options.seed.length === 0 ||
    options.seed.length > SCIENTIFIC_LIMITS.maximumSeedLength
  ) throw new TypeError("bootstrap seed is invalid");
  checkedProductWithin(
    [options.samples, effects.length],
    SCIENTIFIC_LIMITS.maximumBootstrapDraws,
    "bootstrap draw",
  );
  const orderedEffects = [...effects].sort((left, right) => compareText(left.itemId, right.itemId));
  const adjustedAlpha = options.alpha / options.comparisonFamilySize;
  const random = new SeededRandom(options.seed);
  const estimates: number[] = [];
  for (let sample = 0; sample < options.samples; sample += 1) {
    const draw: number[] = [];
    for (let item = 0; item < orderedEffects.length; item += 1) {
      draw.push(orderedEffects[random.integer(orderedEffects.length)]?.value as number);
    }
    estimates.push(mean(draw));
  }
  const sampleHash = hashJson(estimates);
  estimates.sort((left, right) => left - right);
  return deepFreeze({
    estimate: mean(orderedEffects.map((effect) => effect.value)),
    lower: percentile(estimates, adjustedAlpha / 2),
    upper: percentile(estimates, 1 - adjustedAlpha / 2),
    nominalAlpha: options.alpha,
    adjustedAlpha,
    comparisonFamilySize: options.comparisonFamilySize,
    samples: options.samples,
    sampleHash,
    itemCount: effects.length,
    inferentialUnit: "item",
  });
}

function summaryMap(
  summaries: readonly ItemArmSummary[],
  candidateId: string,
  laneId: LaneId,
  arm: ArmKind,
): Map<string, ItemArmSummary> {
  return new Map(
    summaries
      .filter((summary) => summary.candidateId === candidateId && summary.laneId === laneId && summary.arm === arm)
      .map((summary) => [summary.itemId, summary]),
  );
}

function pairedEffects(
  left: Map<string, ItemArmSummary>,
  right: Map<string, ItemArmSummary>,
  eligibleItems: ReadonlySet<string>,
  direction: "left_minus_right" | "right_minus_left",
): readonly ItemEffect[] {
  const result: ItemEffect[] = [];
  for (const itemId of [...eligibleItems].sort(compareText)) {
    const leftRate = left.get(itemId)?.passRate;
    const rightRate = right.get(itemId)?.passRate;
    if (leftRate === undefined || leftRate === null || rightRate === undefined || rightRate === null) continue;
    result.push({
      itemId,
      value: direction === "left_minus_right" ? leftRate - rightRate : rightRate - leftRate,
    });
  }
  return result;
}

function validateSummariesForSpec(
  summaries: readonly ItemArmSummary[],
  spec: ExperimentSpec,
): void {
  if (summaries.length > SCIENTIFIC_LIMITS.maximumScheduleEntries) {
    throw new RangeError("item summaries exceed the bounded allocation");
  }
  const keys = new Set<string>();
  const arms = new Set<unknown>(scheduledArms);
  for (const summary of summaries) {
    const key = [summary.itemId, summary.laneId, summary.candidateId, summary.arm].join("\0");
    if (keys.has(key)) throw new TypeError("item summary coordinate is duplicated");
    keys.add(key);
    const validRate = (value: unknown): value is number | null =>
      value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1);
    if (
      !spec.experiment.itemIds.includes(summary.itemId) ||
      !spec.experiment.executorLanes.includes(summary.laneId) ||
      !spec.experiment.candidateModels.includes(summary.candidateId) ||
      !arms.has(summary.arm) ||
      !Number.isSafeInteger(summary.attemptCount) || summary.attemptCount < 1 ||
      summary.attemptCount > spec.experiment.repetitions ||
      !Number.isSafeInteger(summary.knownOutcomeCount) || summary.knownOutcomeCount < 0 ||
      !Number.isSafeInteger(summary.unknownOutcomeCount) || summary.unknownOutcomeCount < 0 ||
      summary.knownOutcomeCount + summary.unknownOutcomeCount !== summary.attemptCount ||
      !Number.isSafeInteger(summary.knownFailureCount) || summary.knownFailureCount < 0 ||
      summary.knownFailureCount > summary.knownOutcomeCount ||
      !Number.isSafeInteger(summary.attributionFailureCount) || summary.attributionFailureCount < 0 ||
      !Number.isSafeInteger(summary.unknownAttributionCount) || summary.unknownAttributionCount < 0 ||
      summary.attributionFailureCount + summary.unknownAttributionCount > summary.attemptCount ||
      !Number.isSafeInteger(summary.driftFailureCount) || summary.driftFailureCount < 0 ||
      !Number.isSafeInteger(summary.unknownDriftCount) || summary.unknownDriftCount < 0 ||
      summary.driftFailureCount + summary.unknownDriftCount > summary.attemptCount ||
      !validRate(summary.passRate) ||
      (summary.unknownOutcomeCount > 0 ? summary.passRate !== null : summary.passRate === null) ||
      typeof summary.schemaFailureRate !== "number" || !Number.isFinite(summary.schemaFailureRate) ||
      summary.schemaFailureRate < 0 || summary.schemaFailureRate > 1 ||
      (summary.tokensToDone !== null && (
        typeof summary.tokensToDone !== "number" || !Number.isFinite(summary.tokensToDone) ||
        summary.tokensToDone < 0
      ))
    ) throw new TypeError("item summary has invalid runtime fields");
  }
}

function compareCandidate(
  summaries: readonly ItemArmSummary[],
  calibration: readonly CalibrationEvidence[],
  candidateId: string,
  laneId: LaneId,
  settings: DerivedDecisionSettings,
): CandidateComparison {
  const eligibleItems = new Set(
    calibration
      .filter((entry) => entry.laneId === laneId && entry.eligible)
      .map((entry) => entry.itemId),
  );
  const candidate = summaryMap(summaries, candidateId, laneId, "candidate");
  const laneCalibration = calibration.filter((entry) => entry.laneId === laneId);
  const calibrationExclusions = {
    floorDidNotFail: laneCalibration.filter((entry) => entry.reason === "floor_did_not_fail").length,
    referenceDidNotPass: laneCalibration.filter((entry) => entry.reason === "reference_did_not_pass").length,
    unknown: laneCalibration.filter((entry) => entry.reason === "unknown").length + Math.max(0, candidate.size - laneCalibration.length),
    instability: laneCalibration.filter((entry) => entry.reason === "calibration_instability").length,
  };
  const floor = summaryMap(summaries, candidateId, laneId, "none");
  const shuffled = summaryMap(summaries, candidateId, laneId, "shuffled");
  const reference = summaryMap(summaries, candidateId, laneId, "reference");
  const floorEffects = pairedEffects(candidate, floor, eligibleItems, "left_minus_right");
  const shuffledEffects = pairedEffects(candidate, shuffled, eligibleItems, "left_minus_right");
  const referenceEffects = pairedEffects(candidate, reference, eligibleItems, "right_minus_left");
  const floorDelta = floorEffects.length === 0 ? null : bootstrapPairedItemEffects(floorEffects, {
    ...settings,
    seed: `${settings.seed}\0${candidateId}\0${laneId}\0floor`,
  });
  const referenceGap = referenceEffects.length === 0 ? null : bootstrapPairedItemEffects(referenceEffects, {
    ...settings,
    seed: `${settings.seed}\0${candidateId}\0${laneId}\0reference`,
  });
  const shuffledDelta = shuffledEffects.length === 0 ? null : bootstrapPairedItemEffects(shuffledEffects, {
    ...settings,
    seed: `${settings.seed}\0${candidateId}\0${laneId}\0shuffled`,
  });
  const candidateItems = [...candidate.values()].filter((summary) => eligibleItems.has(summary.itemId));
  const candidateTaskSuccessRate = equalItemMean(candidateItems, "passRate");
  const candidateUnknownOutcomeRate = candidateItems.length === 0
    ? 1
    : mean(candidateItems.map((summary) => summary.unknownOutcomeCount / summary.attemptCount));
  const candidateAttributionRate = equalItemMean(candidateItems, "attributionRate");
  const candidateDriftAvoidanceRate = equalItemMean(candidateItems, "driftAvoidanceRate");
  const candidateSchemaFailureRate = equalItemMean(candidateItems, "schemaFailureRate");
  const candidateTokensToDone = equalItemMean(candidateItems, "tokensToDone");
  const candidateAttempts = [...candidate.values()];
  const allAttemptSummaries = summaries.filter((summary) =>
    summary.candidateId === candidateId && summary.laneId === laneId
  );
  const controlAttempts = allAttemptSummaries.filter((summary) => summary.arm !== "candidate");
  const aggregateMeasurement = (
    entries: readonly ItemArmSummary[],
    field: "durationMs",
  ): number | null => {
    const values = entries.map((summary) => summary[field]);
    if (values.length === 0 || values.some((value) => value === null)) return null;
    const result = (values as number[]).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new RangeError("candidate telemetry aggregate exceeds safe bounds");
    return result;
  };
  const aggregateCost = (
    entries: readonly ItemArmSummary[],
    field: keyof Omit<ItemArmSummary["reportedCosts"], "totalUsd"> | "totalUsd",
  ): number | null => {
    const values = entries.map((summary) => summary.reportedCosts[field]);
    if (values.length === 0 || values.some((value) => value === null)) return null;
    const result = (values as number[]).reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(result) || result > Number.MAX_SAFE_INTEGER) throw new RangeError("reported cost aggregate exceeds safe bounds");
    return result;
  };
  const reportedCost = {
    candidateArmUsd: aggregateCost(candidateAttempts, "totalUsd"),
    controlArmsUsd: aggregateCost(controlAttempts, "totalUsd"),
    allAttemptsUsd: aggregateCost(allAttemptSummaries, "totalUsd"),
    executorUsd: aggregateCost(allAttemptSummaries, "executorUsd"),
    outcomeJudgeUsd: aggregateCost(allAttemptSummaries, "outcomeJudgeUsd"),
    attributionJudgeUsd: aggregateCost(allAttemptSummaries, "attributionJudgeUsd"),
    driftJudgeUsd: aggregateCost(allAttemptSummaries, "driftJudgeUsd"),
  };
  const aggregateRoute = (field: "effectiveProvider" | "effectiveModel"): string | null => {
    const values = allAttemptSummaries.map((summary) => summary[field]);
    if (values.length === 0 || values.some((value) => value === null)) return null;
    const unique = new Set(values as string[]);
    if (unique.size !== 1) throw new TypeError("effective route changed across candidate items");
    return values[0] as string;
  };
  const reasons: string[] = [];
  let decision: Decision = "insufficient_evidence";
  if (eligibleItems.size < settings.minimumCalibratedItems) {
    reasons.push("too_few_calibrated_items");
  } else if (floorEffects.length < settings.minimumCalibratedItems || floorDelta === null) {
    reasons.push("too_few_paired_known_outcomes");
  } else if (
    candidateTaskSuccessRate === null ||
    candidateUnknownOutcomeRate > settings.maximumUnknownOutcomeRate
  ) {
    reasons.push("candidate_outcome_evidence_unavailable");
  } else if (candidateSchemaFailureRate === null) {
    reasons.push("schema_failure_rate_unavailable");
  } else if (candidateSchemaFailureRate > settings.maximumSchemaFailureRate) {
    decision = "do_not_recommend";
    reasons.push("schema_failure_rate_exceeded");
  } else if (candidateAttributionRate === null) {
    reasons.push("attribution_evidence_unavailable");
  } else if (candidateDriftAvoidanceRate === null) {
    reasons.push("drift_avoidance_evidence_unavailable");
  } else if (candidateAttributionRate < settings.minimumAttributionRate) {
    decision = "do_not_recommend";
    reasons.push("minimum_attribution_rate_not_met");
  } else if (candidateDriftAvoidanceRate < settings.minimumDriftAvoidanceRate) {
    decision = "do_not_recommend";
    reasons.push("minimum_drift_avoidance_rate_not_met");
  } else if (aggregateRoute("effectiveProvider") === null || aggregateRoute("effectiveModel") === null) {
    reasons.push("effective_route_unavailable");
  } else if (floorDelta.lower >= settings.minimumEffect) {
    decision = "recommend";
    reasons.push("prespecified_floor_delta_met");
  } else if (floorDelta.upper < settings.minimumEffect) {
    decision = "do_not_recommend";
    reasons.push("prespecified_floor_delta_not_met");
  } else {
    reasons.push("confidence_interval_crosses_threshold");
  }
  return deepFreeze({
    candidateId,
    laneId,
    calibratedItemCount: eligibleItems.size,
    calibrationExclusions,
    pairedFloorItemCount: floorEffects.length,
    pairedReferenceItemCount: referenceEffects.length,
    pairedShuffledItemCount: shuffledEffects.length,
    floorDelta,
    referenceGap,
    referenceGapRole: "descriptive_not_decision_bearing",
    shuffledDelta,
    shuffledDeltaRole: "diagnostic_not_decision_bearing",
    candidateTaskSuccessRate,
    candidateUnknownOutcomeRate,
    candidateAttributionRate,
    candidateDriftAvoidanceRate,
    candidateSchemaFailureRate,
    candidateTokensToDone,
    candidateFailures: {
      taskFailure: candidateAttempts.reduce((sum, item) => sum + item.knownFailureCount, 0),
      schemaFailure: candidateAttempts.reduce((sum, item) => sum + Math.round(item.schemaFailureRate * item.attemptCount), 0),
      attributionFailure: candidateAttempts.reduce((sum, item) => sum + item.attributionFailureCount, 0),
      driftFailure: candidateAttempts.reduce((sum, item) => sum + item.driftFailureCount, 0),
      unknownOutcome: candidateAttempts.reduce((sum, item) => sum + item.unknownOutcomeCount, 0),
      unknownAttribution: candidateAttempts.reduce((sum, item) => sum + item.unknownAttributionCount, 0),
      unknownDrift: candidateAttempts.reduce((sum, item) => sum + item.unknownDriftCount, 0),
    },
    reportedCost,
    durationMs: aggregateMeasurement(allAttemptSummaries, "durationMs"),
    effectiveProvider: aggregateRoute("effectiveProvider"),
    effectiveModel: aggregateRoute("effectiveModel"),
    decision,
    decisionReasons: reasons,
  });
}

function incompleteFamilyComparison(
  calibration: readonly CalibrationEvidence[],
  candidateId: string,
  laneId: LaneId,
  prespecifiedItemCount: number,
): CandidateComparison {
  const calibratedItemCount = new Set(
    calibration
      .filter((entry) => entry.laneId === laneId && entry.eligible)
      .map((entry) => entry.itemId),
  ).size;
  const laneCalibration = calibration.filter((entry) => entry.laneId === laneId);
  return deepFreeze({
    candidateId,
    laneId,
    calibratedItemCount,
    calibrationExclusions: {
      floorDidNotFail: laneCalibration.filter((entry) => entry.reason === "floor_did_not_fail").length,
      referenceDidNotPass: laneCalibration.filter((entry) => entry.reason === "reference_did_not_pass").length,
      unknown: laneCalibration.filter((entry) => entry.reason === "unknown").length + Math.max(0, prespecifiedItemCount - laneCalibration.length),
      instability: laneCalibration.filter((entry) => entry.reason === "calibration_instability").length,
    },
    pairedFloorItemCount: 0,
    pairedReferenceItemCount: 0,
    pairedShuffledItemCount: 0,
    floorDelta: null,
    referenceGap: null,
    referenceGapRole: "descriptive_not_decision_bearing",
    shuffledDelta: null,
    shuffledDeltaRole: "diagnostic_not_decision_bearing",
    candidateTaskSuccessRate: null,
    candidateUnknownOutcomeRate: 1,
    candidateAttributionRate: null,
    candidateDriftAvoidanceRate: null,
    candidateSchemaFailureRate: null,
    candidateTokensToDone: null,
    candidateFailures: { taskFailure: 0, schemaFailure: 0, attributionFailure: 0, driftFailure: 0, unknownOutcome: 0, unknownAttribution: 0, unknownDrift: 0 },
    reportedCost: {
      candidateArmUsd: null, controlArmsUsd: null, allAttemptsUsd: null,
      executorUsd: null, outcomeJudgeUsd: null, attributionJudgeUsd: null, driftJudgeUsd: null,
    },
    durationMs: null,
    effectiveProvider: null,
    effectiveModel: null,
    decision: "insufficient_evidence",
    decisionReasons: ["incomplete_attempt_matrix"],
  });
}

function issueComparisonFamily(
  rows: readonly CandidateComparison[],
  binding: Omit<ComparisonFamilyBinding, "familyHash">,
): readonly CandidateComparison[] {
  const family = deepFreeze([...rows]);
  const familyHash = hashJson({ binding, rows: family });
  for (const row of family) issuedComparisons.set(row, {
    familyHash,
    coordinate: `${row.candidateId}\0${row.laneId}`,
  });
  issuedComparisonFamilies.set(family, deepFreeze({ ...binding, familyHash }));
  return family;
}

export function assertCandidateComparisonFamily(
  comparisons: readonly CandidateComparison[],
  spec: ExperimentSpec,
): void {
  assertExperimentSpecIdentity(spec);
  const binding = issuedComparisonFamilies.get(comparisons);
  if (!binding || !Object.isFrozen(comparisons)) {
    throw new TypeError("candidate comparison family must be issued by MemBench");
  }
  const artifacts = binding.executionBatch === null ? null : executionBatchArtifacts(binding.executionBatch, spec);
  if (
    binding.spec !== spec || binding.specIdentityHash !== spec.identityHash ||
    binding.routeHash !== hashJson(spec.routes) ||
    artifacts === null || binding.corpusHash !== artifacts.corpusHash || binding.promptHash !== artifacts.promptHash ||
    binding.harnessHash !== artifacts.harnessHash || binding.judgeHash !== artifacts.judgeHash ||
    binding.runHash !== artifacts.runHash
  ) throw new TypeError("candidate comparison family belongs to a different experiment");
  if (
    binding.executionBatch === null || binding.executionBatchBindingHash === null || binding.observerBatch === null ||
    binding.observerEventUniverseHash === null || binding.observerMemoryUniverseHash === null
  ) throw new TypeError("candidate comparison family lacks issued experiment execution evidence");
  assertExperimentExecutionBatch(binding.executionBatch, spec);
  if (
    binding.executionBatchBindingHash !== executionBatchBindingCommitment(binding.executionBatch, spec) ||
    executionBatchObserver(binding.executionBatch, spec) !== binding.observerBatch ||
    binding.observerEventUniverseHash !== binding.observerBatch.eventUniverseHash ||
    binding.observerMemoryUniverseHash !== binding.observerBatch.memoryUniverseHash
  ) throw new TypeError("candidate comparison execution and observer evidence diverged");
  const expected = spec.experiment.candidateModels.flatMap((candidateId) =>
    spec.experiment.executorLanes.map((lane) => `${candidateId}\0${lane}`)
  ).sort(compareText);
  const received = comparisons.map((row) => {
    const rowBinding = issuedComparisons.get(row);
    if (!rowBinding || rowBinding.familyHash !== binding.familyHash || !Object.isFrozen(row)) throw new TypeError("candidate comparison row must be issued by MemBench");
    if (rowBinding.coordinate !== `${row.candidateId}\0${row.laneId}`) throw new TypeError("candidate comparison row coordinate changed");
    return `${row.candidateId}\0${row.laneId}`;
  }).sort(compareText);
  if (
    received.length !== expected.length || new Set(received).size !== received.length ||
    expected.some((coordinate, index) => coordinate !== received[index])
  ) throw new TypeError("candidate comparison family does not cover the prespecified experiment");
  if (binding.coordinateHash !== hashJson(expected) || binding.familyHash !== hashJson({ binding: {
    spec: binding.spec,
    specIdentityHash: binding.specIdentityHash,
    coordinateHash: binding.coordinateHash,
    routeHash: binding.routeHash,
    corpusHash: binding.corpusHash,
    promptHash: binding.promptHash,
    harnessHash: binding.harnessHash,
    judgeHash: binding.judgeHash,
    runHash: binding.runHash,
    attemptUniverseHash: binding.attemptUniverseHash,
    calibrationUniverseHash: binding.calibrationUniverseHash,
    evidenceUniverseHash: binding.evidenceUniverseHash,
    executionBatch: binding.executionBatch,
    executionBatchBindingHash: binding.executionBatchBindingHash,
    observerBatch: binding.observerBatch,
    observerEventUniverseHash: binding.observerEventUniverseHash,
    observerMemoryUniverseHash: binding.observerMemoryUniverseHash,
    calibrationCostUsd: binding.calibrationCostUsd,
  }, rows: comparisons })) throw new TypeError("candidate comparison family commitment changed");
}

export function candidateComparisonEvidenceCommitment(
  comparisons: readonly CandidateComparison[],
  spec: ExperimentSpec,
): Sha256 {
  assertCandidateComparisonFamily(comparisons, spec);
  return (issuedComparisonFamilies.get(comparisons) as ComparisonFamilyBinding).evidenceUniverseHash;
}

export function candidateComparisonCalibrationCost(
  comparisons: readonly CandidateComparison[],
  spec: ExperimentSpec,
): number | null {
  assertCandidateComparisonFamily(comparisons, spec);
  return (issuedComparisonFamilies.get(comparisons) as ComparisonFamilyBinding).calibrationCostUsd;
}

export function candidateComparisonExecutionBatch(
  comparisons: readonly CandidateComparison[],
  spec: ExperimentSpec,
): ExperimentExecutionBatch {
  assertCandidateComparisonFamily(comparisons, spec);
  return (issuedComparisonFamilies.get(comparisons) as ComparisonFamilyBinding).executionBatch as ExperimentExecutionBatch;
}

export function assertCandidateComparisonObserverBatch(
  comparisons: readonly CandidateComparison[],
  spec: ExperimentSpec,
  observerBatch: ObservationBatch,
): void {
  assertCandidateComparisonFamily(comparisons, spec);
  if ((issuedComparisonFamilies.get(comparisons) as ComparisonFamilyBinding).observerBatch !== observerBatch) {
    throw new TypeError("candidate comparisons and observer memory evidence come from different executions");
  }
}

function compareEvidenceArrays(
  attempts: readonly ScoredAttempt[],
  calibration: readonly CalibrationEvidence[],
  candidates: readonly { readonly candidateId: string; readonly laneId: LaneId }[],
  spec: ExperimentSpec,
  origin: {
    readonly executionBatch: ExperimentExecutionBatch | null;
    readonly executionBatchBindingHash: Sha256 | null;
    readonly observerBatch: ObservationBatch | null;
    readonly observerEventUniverseHash: Sha256 | null;
    readonly observerMemoryUniverseHash: Sha256 | null;
    readonly evidenceUniverseHash: Sha256 | null;
  },
): readonly CandidateComparison[] {
  assertExperimentSpecIdentity(spec);
  if (attempts.some((attempt) =>
    Number.isSafeInteger(attempt.repetition) && attempt.repetition >= spec.experiment.repetitions
  )) throw new TypeError("scored attempt repetition exceeds the prespecified experiment");
  const summaries = summarizeItemArms(attempts);
  validateSummariesForSpec(summaries, spec);
  const calibrationCoordinates = new Set<string>();
  const calibrationOutcomes = new Set<unknown>(["pass", "fail", "unknown"]);
  for (const entry of calibration) {
    const coordinate = `${entry.itemId}\0${entry.laneId}`;
    if (calibrationCoordinates.has(coordinate)) {
      throw new TypeError("calibration item and lane coordinate is duplicated");
    }
    calibrationCoordinates.add(coordinate);
    const outcomeEligible = entry.floorOutcome === "fail" && entry.referenceOutcome === "pass";
    const instability = entry.reason === "calibration_instability";
    const eligible = outcomeEligible && !instability;
    const expectedReason: CalibrationEvidence["reason"] = outcomeEligible
      ? "calibrated"
      : entry.floorOutcome === "unknown" || entry.referenceOutcome === "unknown"
        ? "unknown"
        : entry.floorOutcome !== "fail"
          ? "floor_did_not_fail"
          : "reference_did_not_pass";
    if (
      typeof entry.itemId !== "string" || !spec.experiment.itemIds.includes(entry.itemId) ||
      typeof entry.laneId !== "string" || !spec.experiment.executorLanes.includes(entry.laneId) ||
      !calibrationOutcomes.has(entry.floorOutcome) || !calibrationOutcomes.has(entry.referenceOutcome) ||
      typeof entry.eligible !== "boolean" ||
      (entry.reportedCostUsd !== null && (
        typeof entry.reportedCostUsd !== "number" || !Number.isFinite(entry.reportedCostUsd) ||
        entry.reportedCostUsd < 0 || entry.reportedCostUsd > SCIENTIFIC_LIMITS.maximumBudgetUsd
      )) ||
      entry.eligible !== eligible || (!instability && entry.reason !== expectedReason)
    ) throw new TypeError("calibration evidence is internally inconsistent");
  }
  const expected = spec.experiment.candidateModels.flatMap((candidateId) =>
    spec.experiment.executorLanes.map((lane) => `${candidateId}\0${lane}`)
  ).sort(compareText);
  const received = candidates.map((candidate) => `${candidate.candidateId}\0${candidate.laneId}`).sort(compareText);
  if (
    candidates.length === 0 ||
    new Set(received).size !== received.length ||
    expected.length !== received.length ||
    expected.some((value, index) => value !== received[index])
  ) throw new TypeError("comparison family must exactly match unique prespecified candidate and lane pairs");
  checkedProductWithin(
    [
      spec.experiment.itemIds.length,
      spec.decision.bootstrapSamples,
      expected.length,
      SCIENTIFIC_LIMITS.bootstrapIntervalsPerComparison,
    ],
    SCIENTIFIC_LIMITS.maximumBootstrapDraws,
    "comparison family bootstrap",
  );
  const orderedCandidates = [...candidates].sort((left, right) =>
    compareText(
      `${left.candidateId}\0${left.laneId}`,
      `${right.candidateId}\0${right.laneId}`,
    )
  );
  const expectedAttemptsPerPair = checkedProductWithin(
    [spec.experiment.itemIds.length, scheduledArms.length, spec.experiment.repetitions],
    SCIENTIFIC_LIMITS.maximumScheduleEntries,
    "attempt matrix",
  );
  const attemptsPerPair = new Map(expected.map((pair) => [pair, 0]));
  for (const attempt of attempts) {
    const pair = `${attempt.candidateId}\0${attempt.laneId}`;
    attemptsPerPair.set(pair, (attemptsPerPair.get(pair) ?? 0) + 1);
  }
  const familyComplete = [...attemptsPerPair.values()].every((count) => count === expectedAttemptsPerPair);
  const orderedAttempts = [...attempts].sort((left, right) => compareText(
    [left.candidateId, left.laneId, left.itemId, left.arm, String(left.repetition)].join("\0"),
    [right.candidateId, right.laneId, right.itemId, right.arm, String(right.repetition)].join("\0"),
  ));
  const orderedCalibration = [...calibration].sort((left, right) => compareText(
    `${left.laneId}\0${left.itemId}`,
    `${right.laneId}\0${right.itemId}`,
  ));
  canonicalJson(orderedAttempts);
  const attemptUniverseHash = hashJson(orderedAttempts);
  const calibrationUniverseHash = hashJson(orderedCalibration);
  const calibrationCostUsd = orderedCalibration.some((entry) => entry.reportedCostUsd === null)
    ? null
    : orderedCalibration.reduce((sum, entry) => sum + (entry.reportedCostUsd as number), 0);
  const derivedEvidenceUniverseHash = hashJson({
    specIdentityHash: spec.identityHash,
    attemptUniverseHash,
    calibrationUniverseHash,
  });
  const evidenceUniverseHash = origin.evidenceUniverseHash ?? derivedEvidenceUniverseHash;
  const artifacts = origin.executionBatch === null ? null : executionBatchArtifacts(origin.executionBatch, spec);
  const binding = {
    spec,
    specIdentityHash: spec.identityHash,
    coordinateHash: hashJson(expected),
    routeHash: hashJson(spec.routes),
    corpusHash: artifacts?.corpusHash ?? spec.commitments.corpusHash,
    promptHash: artifacts?.promptHash ?? spec.commitments.promptHash,
    harnessHash: artifacts?.harnessHash ?? spec.commitments.harnessHash,
    judgeHash: artifacts?.judgeHash ?? spec.commitments.judgeHash,
    runHash: artifacts?.runHash ?? spec.commitments.runHash,
    attemptUniverseHash,
    calibrationUniverseHash,
    evidenceUniverseHash,
    executionBatch: origin.executionBatch,
    executionBatchBindingHash: origin.executionBatchBindingHash,
    observerBatch: origin.observerBatch,
    observerEventUniverseHash: origin.observerEventUniverseHash,
    observerMemoryUniverseHash: origin.observerMemoryUniverseHash,
    calibrationCostUsd,
  };
  if (!familyComplete) {
    return issueComparisonFamily(orderedCandidates.map((candidate) => incompleteFamilyComparison(
      calibration,
      candidate.candidateId,
      candidate.laneId,
      spec.experiment.itemIds.length,
    )), binding);
  }
  const settings: DerivedDecisionSettings = {
    seed: spec.seeds.bootstrap,
    samples: spec.decision.bootstrapSamples,
    alpha: spec.decision.alpha,
    comparisonFamilySize: expected.length,
    minimumEffect: spec.decision.minimumEffect,
    maximumSchemaFailureRate: spec.decision.maximumSchemaFailureRate,
    maximumUnknownOutcomeRate: spec.decision.maximumUnknownOutcomeRate,
    minimumCalibratedItems: spec.decision.minimumCalibratedItems,
    minimumAttributionRate: spec.decision.minimumAttributionRate,
    minimumDriftAvoidanceRate: spec.decision.minimumDriftAvoidanceRate,
  };
  return issueComparisonFamily(orderedCandidates.map((candidate) => compareCandidate(
    summaries,
    calibration,
    candidate.candidateId,
    candidate.laneId,
    settings,
  )), binding);
}

export function compareModelFamily(
  executionBatch: ExperimentExecutionBatch,
  spec: ExperimentSpec,
): readonly CandidateComparison[] {
  assertExperimentExecutionBatch(executionBatch, spec);
  const observerBatch = executionBatchObserver(executionBatch, spec);
  const candidates = spec.experiment.candidateModels.flatMap((candidateId) =>
    spec.experiment.executorLanes.map((lane) => ({ candidateId, laneId: laneId(lane) }))
  );
  return compareEvidenceArrays(
    executionBatch.attempts,
    executionBatch.calibration,
    candidates,
    spec,
    {
      executionBatch,
      executionBatchBindingHash: executionBatchBindingCommitment(executionBatch, spec),
      observerBatch,
      observerEventUniverseHash: observerBatch.eventUniverseHash,
      observerMemoryUniverseHash: observerBatch.memoryUniverseHash,
      evidenceUniverseHash: executionBatch.evidenceUniverseHash,
    },
  );
}

/** Internal unit-test seam. Families issued here are deliberately not reportable or auditable. */
export function compareModelFamilyForTest(
  attempts: readonly ScoredAttempt[],
  calibration: readonly CalibrationEvidence[],
  candidates: readonly { readonly candidateId: string; readonly laneId: LaneId }[],
  spec: ExperimentSpec,
): readonly CandidateComparison[] {
  return compareEvidenceArrays(attempts, calibration, candidates, spec, {
    executionBatch: null,
    executionBatchBindingHash: null,
    observerBatch: null,
    observerEventUniverseHash: null,
    observerMemoryUniverseHash: null,
    evidenceUniverseHash: null,
  });
}
