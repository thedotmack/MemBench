import { deepFreeze, hashJson } from "./canonical";
import { snapshotIssuedReferenceControl, type ReferenceControl } from "./controls";
import { assertCorpusItemIdentity, type CorpusItem } from "./corpus";
import { assessCalibration, laneId, type CalibrationEvidence, type LaneId, type Outcome, type Sha256 } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { SCIENTIFIC_LIMITS } from "./limits";
import { utf8Text } from "./runtime-validation";

export interface CalibrationRunResult {
  readonly attemptId: string;
  readonly outcome: Outcome;
  readonly reportedCostUsd?: number | null;
}
export interface CalibrationExecutor { run(input: { readonly attemptId: string; readonly injectionText: string }): Promise<CalibrationRunResult> }

export interface BoundCalibrationReference {
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly sourceHash: Sha256;
  readonly control: ReferenceControl;
  readonly bindingHash: Sha256;
}

const issuedReferences = new WeakSet<object>();

export function assertBoundCalibrationReference(reference: BoundCalibrationReference): void {
  if (
    !issuedReferences.has(reference) || !Object.isFrozen(reference) ||
    reference.bindingHash !== hashJson({
      itemId: reference.itemId,
      laneId: reference.laneId,
      sourceHash: reference.sourceHash,
      control: reference.control,
    })
  ) throw new Error("calibration reference must be factory-issued and unchanged");
}

export function bindCalibrationReference(input: {
  readonly item: CorpusItem;
  readonly laneId: LaneId;
  readonly control: ReferenceControl;
}): BoundCalibrationReference {
  if (input === null || typeof input !== "object" || Object.keys(input).length !== 3) throw new TypeError("calibration binding has invalid fields");
  assertCorpusItemIdentity(input.item);
  const itemId = requireSafeIdentifier(input.item.id, "calibration item id");
  const boundLaneId = laneId(requireSafeIdentifier(input.laneId, "calibration lane id"));
  const control = snapshotIssuedReferenceControl(input.control);
  if (control.sourceHash !== input.item.contentHash) {
    throw new Error("calibration reference must bind the same item source");
  }
  const payload = { itemId, laneId: boundLaneId, sourceHash: input.item.contentHash, control };
  const result = deepFreeze({ ...payload, bindingHash: hashJson(payload) });
  issuedReferences.add(result);
  return result;
}

export interface CalibrationResult {
  readonly status: "calibrated" | "excluded" | "calibration_instability";
  readonly evidence: CalibrationEvidence | null;
  readonly attempts: readonly CalibrationRunResult[];
  readonly exclusions: readonly string[];
  readonly frozenReferenceHash: Sha256;
}

export function reconcileCalibrationEvidence(
  evidence: CalibrationEvidence,
  scoredControls: readonly { readonly arm: "none" | "reference"; readonly outcome: Outcome }[],
): CalibrationEvidence {
  if (!Array.isArray(scoredControls) || scoredControls.length === 0) throw new TypeError("scored controls are required for calibration reconciliation");
  let contradiction = false;
  for (const row of scoredControls) {
    if (
      row === null || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 2 ||
      (row.arm !== "none" && row.arm !== "reference") ||
      !new Set<unknown>(["pass", "fail", "unknown"]).has(row.outcome)
    ) throw new TypeError("scored control outcome is invalid");
    const calibrated = row.arm === "none" ? evidence.floorOutcome : evidence.referenceOutcome;
    if (calibrated !== "unknown" && row.outcome !== "unknown" && row.outcome !== calibrated) contradiction = true;
  }
  return contradiction
    ? deepFreeze({ ...evidence, eligible: false, reason: "calibration_instability" as const })
    : evidence;
}

function validateRunResult(value: CalibrationRunResult, expectedId: string): CalibrationRunResult {
  const source = value as unknown as Record<string, unknown>;
  const keys = Object.keys(source).sort();
  const hasCost = Object.hasOwn(source, "reportedCostUsd");
  const validKeys = hasCost
    ? ["attemptId", "outcome", "reportedCostUsd"]
    : ["attemptId", "outcome"];
  const reportedCostUsd = hasCost ? source.reportedCostUsd : null;
  if (
    value === null || typeof value !== "object" ||
    keys.length !== validKeys.length || keys.some((key, index) => key !== validKeys[index]) ||
    source.attemptId !== expectedId || !new Set<unknown>(["pass", "fail", "unknown"]).has(source.outcome) ||
    (reportedCostUsd !== null && (
      typeof reportedCostUsd !== "number" || !Number.isFinite(reportedCostUsd) ||
      reportedCostUsd < 0 || reportedCostUsd > SCIENTIFIC_LIMITS.maximumBudgetUsd
    ))
  ) throw new Error("calibration executor returned an invalid row");
  return deepFreeze({ attemptId: expectedId, outcome: source.outcome as Outcome, reportedCostUsd: reportedCostUsd as number | null });
}

function validateScoredRow(value: CalibrationRunResult): CalibrationRunResult {
  if (value === null || typeof value !== "object") throw new Error("scored calibration row is invalid");
  const source = value as unknown as Record<string, unknown>;
  const attemptId = requireSafeIdentifier(source.attemptId, "scored attempt id");
  if (Object.keys(source).length !== 2 ||
    !new Set<unknown>(["pass", "fail", "unknown"]).has(source.outcome)) throw new Error("scored calibration row is invalid");
  return deepFreeze({ attemptId, outcome: source.outcome as Outcome });
}

export async function calibrateIndependentK1(input: {
  readonly reference: BoundCalibrationReference;
  readonly executor: CalibrationExecutor;
  readonly exclusions?: readonly string[];
  readonly scoredRows: readonly CalibrationRunResult[];
  readonly scoredControlOutcomes?: readonly { readonly arm: "none" | "reference"; readonly outcome: Outcome }[];
}): Promise<CalibrationResult> {
  assertBoundCalibrationReference(input.reference);
  const exclusions = (input.exclusions ?? []).map((reason) => utf8Text(reason, "calibration exclusion", 500, true));
  if (new Set(exclusions).size !== exclusions.length) throw new TypeError("calibration exclusions must be unique");
  const frozenReferenceHash = hashJson(input.reference);
  if (exclusions.length > 0) return deepFreeze({ status: "excluded", evidence: null, attempts: [], exclusions, frozenReferenceHash });

  const ids = {
    none: `cal-${hashJson({ bindingHash: input.reference.bindingHash, arm: "none", k: 1 }).slice(7, 31)}`,
    reference: `cal-${hashJson({ bindingHash: input.reference.bindingHash, arm: "reference", k: 1 }).slice(7, 31)}`,
  };
  const scoredRows = input.scoredRows.map(validateScoredRow);
  if (new Set(scoredRows.map((row) => row.attemptId)).size !== scoredRows.length) throw new Error("scored calibration attempt ids must be unique");
  const scoredIds = new Set(scoredRows.map((row) => row.attemptId));
  if (ids.none === ids.reference || scoredIds.has(ids.none) || scoredIds.has(ids.reference)) throw new Error("calibration attempts must be independent from scored attempts");
  const rawFloor = await input.executor.run({ attemptId: ids.none, injectionText: "" });
  const rawReference = await input.executor.run({ attemptId: ids.reference, injectionText: input.reference.control.injectionText });
  if (rawFloor === rawReference || input.scoredRows.some((row) => row === rawFloor || row === rawReference)) {
    throw new Error("calibration rows cannot reuse scored result objects");
  }
  const floor = validateRunResult(rawFloor, ids.none);
  const reference = validateRunResult(rawReference, ids.reference);
  if (hashJson(input.reference) !== frozenReferenceHash) throw new Error("reference changed during calibration");
  const reportedCostUsd = floor.reportedCostUsd === null || reference.reportedCostUsd === null ||
    floor.reportedCostUsd === undefined || reference.reportedCostUsd === undefined
    ? null
    : floor.reportedCostUsd + reference.reportedCostUsd;
  if (reportedCostUsd !== null && reportedCostUsd > SCIENTIFIC_LIMITS.maximumBudgetUsd) {
    throw new RangeError("calibration reported cost exceeds the experiment budget bound");
  }
  const evidence = assessCalibration(
    input.reference.itemId,
    input.reference.laneId,
    floor.outcome,
    reference.outcome,
    reportedCostUsd,
  );
  const controlRows = input.scoredControlOutcomes ?? [];
  if (new Set(controlRows.map((row) => row.arm)).size !== controlRows.length) throw new TypeError("scored control arms must be unique");
  const contradiction = controlRows.some((row) => {
    if (row === null || typeof row !== "object" || Object.keys(row).length !== 2 ||
      (row.arm !== "none" && row.arm !== "reference") || !new Set<unknown>(["pass", "fail", "unknown"]).has(row.outcome)) throw new TypeError("scored control outcome is invalid");
    const calibrated = row.arm === "none" ? floor.outcome : reference.outcome;
    return calibrated !== "unknown" && row.outcome !== "unknown" && row.outcome !== calibrated;
  }) ?? false;
  const derivedExclusions = evidence.eligible ? [] : [evidence.reason];
  return deepFreeze({
    status: contradiction ? "calibration_instability" : evidence.eligible ? "calibrated" : "excluded",
    evidence,
    attempts: [floor, reference],
    exclusions: derivedExclusions,
    frozenReferenceHash,
  });
}
