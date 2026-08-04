import { canonicalJson, compareText, deepFreeze, sha256 } from "./canonical";
import type { ArmKind, LaneId } from "./domain";
import { isSafeIdentifier } from "./identifiers";
import { checkedProductWithin, SCIENTIFIC_LIMITS } from "./limits";
import { SeededRandom } from "./prng";

export interface ScheduleCondition {
  readonly candidateId: string;
  readonly arm: ArmKind;
}

export interface ScheduleInput {
  readonly itemIds: readonly string[];
  readonly laneIds: readonly LaneId[];
  readonly conditions: readonly ScheduleCondition[];
  readonly repetitions: number;
  readonly seed: string;
}

export interface ScheduleEntry extends ScheduleCondition {
  readonly sequence: number;
  readonly attemptId: string;
  readonly itemId: string;
  readonly laneId: LaneId;
  readonly repetition: number;
}

export interface PersistedSchedule {
  readonly entries: readonly ScheduleEntry[];
  /** Immutable canonical UTF-8 source text; avoids a second per-byte number graph. */
  readonly bytes: string;
  readonly contentHash: `sha256:${string}`;
}

function validateInput(input: ScheduleInput): void {
  if (
    input.itemIds.length === 0 ||
    input.itemIds.length > SCIENTIFIC_LIMITS.maximumItems ||
    new Set(input.itemIds).size !== input.itemIds.length ||
    input.itemIds.some((value) => !isSafeIdentifier(value))
  ) {
    throw new TypeError("schedule items must be unique and non-empty");
  }
  if (
    input.laneIds.length === 0 ||
    input.laneIds.length > SCIENTIFIC_LIMITS.maximumLanes ||
    new Set(input.laneIds).size !== input.laneIds.length ||
    input.laneIds.some((value) => !isSafeIdentifier(value))
  ) {
    throw new TypeError("schedule lanes must be unique and non-empty");
  }
  if (input.conditions.length === 0 || input.conditions.length > SCIENTIFIC_LIMITS.maximumConditions) {
    throw new TypeError("schedule conditions must contain a bounded non-empty set");
  }
  const validArms = new Set<unknown>(["candidate", "none", "shuffled", "reference"]);
  if (input.conditions.some((value) =>
    !isSafeIdentifier(value.candidateId) ||
    !validArms.has(value.arm)
  )) throw new TypeError("schedule condition is invalid");
  const conditionKeys = input.conditions.map((value) => `${value.candidateId}\0${value.arm}`);
  if (new Set(conditionKeys).size !== conditionKeys.length) throw new TypeError("schedule conditions must be unique");
  if (
    !Number.isSafeInteger(input.repetitions) ||
    input.repetitions < 3 ||
    input.repetitions > SCIENTIFIC_LIMITS.maximumRepetitions
  ) {
    throw new TypeError("schedule repetitions are outside scientific limits");
  }
  if (
    typeof input.seed !== "string" || input.seed.length === 0 ||
    input.seed.length > SCIENTIFIC_LIMITS.maximumSeedLength
  ) throw new TypeError("schedule seed is invalid");
  checkedProductWithin(
    [input.itemIds.length, input.laneIds.length, input.conditions.length, input.repetitions],
    SCIENTIFIC_LIMITS.maximumScheduleEntries,
    "schedule",
  );
}

export function buildSchedule(input: ScheduleInput): PersistedSchedule {
  validateInput(input);
  const itemIds = [...input.itemIds].sort(compareText);
  const laneIds = [...input.laneIds].sort(compareText);
  const conditions = [...input.conditions].sort((left, right) =>
    compareText(`${left.candidateId}\0${left.arm}`, `${right.candidateId}\0${right.arm}`)
  );
  const entries: ScheduleEntry[] = [];
  for (let repetition = 0; repetition < input.repetitions; repetition += 1) {
    const buckets = itemIds.flatMap((itemId) => laneIds.map((laneId) => ({ itemId, laneId })));
    const randomized = new Map<string, readonly ScheduleCondition[]>();
    for (const bucket of buckets) {
      const key = `${bucket.itemId}\0${bucket.laneId}`;
      randomized.set(
        key,
        new SeededRandom(`${input.seed}\0${repetition}\0${key}`).shuffle(conditions),
      );
    }
    for (let round = 0; round < conditions.length; round += 1) {
      for (const bucket of buckets) {
        const condition = randomized.get(`${bucket.itemId}\0${bucket.laneId}`)?.[round];
        if (!condition) throw new Error("schedule construction failed");
        const sequence = entries.length;
        const identity = canonicalJson({
          sequence,
          itemId: bucket.itemId,
          laneId: bucket.laneId,
          repetition,
          candidateId: condition.candidateId,
          arm: condition.arm,
        });
        entries.push({
          sequence,
          attemptId: `attempt-${sha256(identity).slice("sha256:".length, "sha256:".length + 24)}`,
          itemId: bucket.itemId,
          laneId: bucket.laneId,
          repetition,
          ...condition,
        });
      }
    }
  }
  const bytes = `${canonicalJson(entries)}\n`;
  return deepFreeze({ entries, bytes, contentHash: sha256(bytes) });
}

export function resumeSchedule(input: ScheduleInput, persistedBytes: string): PersistedSchedule {
  const expected = buildSchedule(input);
  if (expected.bytes !== persistedBytes) {
    throw new Error("persisted schedule differs from the predeclared experiment schedule");
  }
  return expected;
}
