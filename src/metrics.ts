import { compareText, deepFreeze, hashJson } from "./canonical";
import type {
  ArmKind,
  CalibrationEvidence,
  Decision,
  LaneId,
  Outcome,
} from "./domain";
import { SeededRandom } from "./prng";
import { isSafeIdentifier } from "./identifiers";
import { checkedProductWithin, SCIENTIFIC_LIMITS } from "./limits";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";

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
}

export interface ItemArmSummary {
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly candidateId: string;
  readonly arm: ArmKind;
  readonly attemptCount: number;
  readonly knownOutcomeCount: number;
  readonly unknownOutcomeCount: number;
  readonly passRate: number | null;
  readonly tokensToDone: number | null;
  readonly schemaFailureRate: number;
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
  readonly inferentialUnit: "item";
}

export interface CandidateComparison {
  readonly candidateId: string;
  readonly laneId: LaneId;
  readonly calibratedItemCount: number;
  readonly pairedFloorItemCount: number;
  readonly pairedReferenceItemCount: number;
  readonly floorDelta: BootstrapInterval | null;
  readonly referenceGap: BootstrapInterval | null;
  readonly referenceGapRole: "descriptive_not_decision_bearing";
  readonly candidateSchemaFailureRate: number | null;
  readonly candidateTokensToDone: number | null;
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
  readonly minimumCalibratedItems: number;
}

const scheduledArms = ["candidate", "none", "shuffled", "reference"] as const;

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
    if (
      !isSafeIdentifier(attempt.itemId) || !isSafeIdentifier(attempt.laneId) ||
      !isSafeIdentifier(attempt.candidateId) || !arms.has(attempt.arm) ||
      !Number.isSafeInteger(attempt.repetition) || attempt.repetition < 0 ||
      attempt.repetition >= SCIENTIFIC_LIMITS.maximumRepetitions ||
      !validOutcomes.has(attempt.outcome) || typeof attempt.schemaValid !== "boolean"
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
      const passTokens = passed.map((attempt) => attempt.tokensToDone);
      return {
        itemId: first.itemId,
        laneId: first.laneId,
        candidateId: first.candidateId,
        arm: first.arm,
        attemptCount: group.length,
        knownOutcomeCount: known.length,
        unknownOutcomeCount: group.length - known.length,
        passRate: known.length === 0 || known.length !== group.length ? null : passed.length / known.length,
        tokensToDone: passed.length !== group.length || passTokens.some((value) => value === null)
          ? null
          : mean(passTokens as number[]),
        schemaFailureRate: group.filter((attempt) => !attempt.schemaValid).length / group.length,
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
  metric: "passRate" | "schemaFailureRate" | "tokensToDone",
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
  const floor = summaryMap(summaries, candidateId, laneId, "none");
  const reference = summaryMap(summaries, candidateId, laneId, "reference");
  const floorEffects = pairedEffects(candidate, floor, eligibleItems, "left_minus_right");
  const referenceEffects = pairedEffects(candidate, reference, eligibleItems, "right_minus_left");
  const floorDelta = floorEffects.length === 0 ? null : bootstrapPairedItemEffects(floorEffects, {
    ...settings,
    seed: `${settings.seed}\0${candidateId}\0${laneId}\0floor`,
  });
  const referenceGap = referenceEffects.length === 0 ? null : bootstrapPairedItemEffects(referenceEffects, {
    ...settings,
    seed: `${settings.seed}\0${candidateId}\0${laneId}\0reference`,
  });
  const candidateItems = [...candidate.values()].filter((summary) => eligibleItems.has(summary.itemId));
  const candidateSchemaFailureRate = equalItemMean(candidateItems, "schemaFailureRate");
  const candidateTokensToDone = equalItemMean(candidateItems, "tokensToDone");
  const reasons: string[] = [];
  let decision: Decision = "insufficient_evidence";
  if (eligibleItems.size < settings.minimumCalibratedItems) {
    reasons.push("too_few_calibrated_items");
  } else if (floorEffects.length < settings.minimumCalibratedItems || floorDelta === null) {
    reasons.push("too_few_paired_known_outcomes");
  } else if (candidateSchemaFailureRate === null) {
    reasons.push("schema_failure_rate_unavailable");
  } else if (candidateSchemaFailureRate > settings.maximumSchemaFailureRate) {
    decision = "do_not_recommend";
    reasons.push("schema_failure_rate_exceeded");
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
    pairedFloorItemCount: floorEffects.length,
    pairedReferenceItemCount: referenceEffects.length,
    floorDelta,
    referenceGap,
    referenceGapRole: "descriptive_not_decision_bearing",
    candidateSchemaFailureRate,
    candidateTokensToDone,
    decision,
    decisionReasons: reasons,
  });
}

function incompleteFamilyComparison(
  calibration: readonly CalibrationEvidence[],
  candidateId: string,
  laneId: LaneId,
): CandidateComparison {
  const calibratedItemCount = new Set(
    calibration
      .filter((entry) => entry.laneId === laneId && entry.eligible)
      .map((entry) => entry.itemId),
  ).size;
  return deepFreeze({
    candidateId,
    laneId,
    calibratedItemCount,
    pairedFloorItemCount: 0,
    pairedReferenceItemCount: 0,
    floorDelta: null,
    referenceGap: null,
    referenceGapRole: "descriptive_not_decision_bearing",
    candidateSchemaFailureRate: null,
    candidateTokensToDone: null,
    decision: "insufficient_evidence",
    decisionReasons: ["incomplete_attempt_matrix"],
  });
}

export function compareModelFamily(
  attempts: readonly ScoredAttempt[],
  calibration: readonly CalibrationEvidence[],
  candidates: readonly { readonly candidateId: string; readonly laneId: LaneId }[],
  spec: ExperimentSpec,
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
    const eligible = entry.floorOutcome === "fail" && entry.referenceOutcome === "pass";
    const expectedReason: CalibrationEvidence["reason"] = eligible
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
      entry.eligible !== eligible || entry.reason !== expectedReason
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
  if (!familyComplete) {
    return deepFreeze(orderedCandidates.map((candidate) => incompleteFamilyComparison(
      calibration,
      candidate.candidateId,
      candidate.laneId,
    )));
  }
  const settings: DerivedDecisionSettings = {
    seed: spec.seeds.bootstrap,
    samples: spec.decision.bootstrapSamples,
    alpha: spec.decision.alpha,
    comparisonFamilySize: expected.length,
    minimumEffect: spec.decision.minimumEffect,
    maximumSchemaFailureRate: spec.decision.maximumSchemaFailureRate,
    minimumCalibratedItems: spec.decision.minimumCalibratedItems,
  };
  return deepFreeze(orderedCandidates.map((candidate) => compareCandidate(
    summaries,
    calibration,
    candidate.candidateId,
    candidate.laneId,
    settings,
  )));
}
