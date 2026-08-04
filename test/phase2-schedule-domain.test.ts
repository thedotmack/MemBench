import { describe, expect, test } from "bun:test";

import {
  appendAttempt,
  AttemptJournalBuilder,
  assessCalibration,
  buildSchedule,
  canonicalJson,
  createExperimentIdentity,
  hashJson,
  laneId,
  missingUsage,
  PRNG_ALGORITHM,
  resumeSchedule,
  SeededRandom,
  sha256,
  type AttemptState,
  type ScheduleInput,
} from "../src";

const lane = laneId("executor-a");

function scheduleInput(seed: string, reverse = false): ScheduleInput {
  const conditions = [
    { candidateId: "model-a", arm: "candidate" as const },
    { candidateId: "model-a", arm: "none" as const },
    { candidateId: "model-a", arm: "reference" as const },
  ];
  return {
    itemIds: reverse ? ["item-b", "item-a"] : ["item-a", "item-b"],
    laneIds: [lane],
    conditions: reverse ? [...conditions].reverse() : conditions,
    repetitions: 3,
    seed,
  };
}

describe("deterministic schedule", () => {
  test("same inputs persist byte-identically and resume verifies bytes", () => {
    const first = buildSchedule(scheduleInput("schedule-one"));
    const second = buildSchedule(scheduleInput("schedule-one", true));
    expect(first.bytes).toEqual(second.bytes);
    expect(first.contentHash).toBe(second.contentHash);
    expect(resumeSchedule(scheduleInput("schedule-one"), first.bytes).bytes).toEqual(first.bytes);
  });

  test("a different schedule seed changes the schedule", () => {
    expect(buildSchedule(scheduleInput("schedule-one")).bytes).not.toEqual(
      buildSchedule(scheduleInput("schedule-two")).bytes,
    );
  });

  test("round robin interleaves item-lane buckets before repeating a bucket", () => {
    const entries = buildSchedule(scheduleInput("interleave-seed")).entries;
    expect(entries[0]?.itemId).toBe("item-a");
    expect(entries[1]?.itemId).toBe("item-b");
    expect(entries).toHaveLength(18);
  });

  test("resume refuses schedule mutation", () => {
    const schedule = buildSchedule(scheduleInput("schedule-one"));
    expect(() => resumeSchedule(scheduleInput("schedule-two"), schedule.bytes)).toThrow("differs");
  });

  test("schedule allocation is bounded before entries are built", () => {
    const huge = {
      ...scheduleInput("bounded-schedule"),
      itemIds: Array.from({ length: 10_000 }, (_, index) => `item-${index}`),
      laneIds: Array.from({ length: 16 }, (_, index) => laneId(`lane-${index}`)),
      conditions: Array.from({ length: 5 }, (_, index) => ({ candidateId: `model-${index}`, arm: "candidate" as const })),
      repetitions: 100,
    };
    expect(() => buildSchedule(huge)).toThrow("bounded allocation");
  });

  test("valid multi-thousand-entry schedules fit the persistence budget", () => {
    const input: ScheduleInput = {
      itemIds: Array.from({ length: 100 }, (_, index) => `item-${index}`),
      laneIds: [lane],
      conditions: ["candidate", "none", "shuffled", "reference"].map((arm) => ({
        candidateId: "model-a",
        arm: arm as "candidate" | "none" | "shuffled" | "reference",
      })),
      repetitions: 25,
      seed: "valid-large-schedule",
    };
    const schedule = buildSchedule(input);
    expect(schedule.entries).toHaveLength(10_000);
    expect(typeof schedule.bytes).toBe("string");
    expect(Array.isArray(schedule.bytes)).toBeFalse();
    expect(schedule.contentHash).toBe(sha256(schedule.bytes));
  });

  test("the maximum schedule keeps one compact immutable persistence string", () => {
    const input: ScheduleInput = {
      itemIds: Array.from({ length: 625 }, (_, index) => `item-${index}`),
      laneIds: [lane],
      conditions: ["candidate", "none", "shuffled", "reference"].map((arm) => ({
        candidateId: "model-a",
        arm: arm as "candidate" | "none" | "shuffled" | "reference",
      })),
      repetitions: 100,
      seed: "maximum-schedule",
    };
    const schedule = buildSchedule(input);
    expect(schedule.entries).toHaveLength(250_000);
    expect(typeof schedule.bytes).toBe("string");
    expect(Object.isFrozen(schedule)).toBeTrue();
  });

  test("schedule identifiers share the 80-character public bound", () => {
    const tooLong = "a".repeat(81);
    expect(() => buildSchedule({ ...scheduleInput("long-item"), itemIds: [tooLong] })).toThrow("schedule items");
    expect(() => buildSchedule({
      ...scheduleInput("long-candidate"),
      conditions: [{ candidateId: tooLong, arm: "candidate" }],
    })).toThrow("schedule condition");
    expect(() => laneId(tooLong)).toThrow("at most 80");
  });

  test("PRNG exposes a versioned algorithm and unbiased bounded integer API", () => {
    expect(PRNG_ALGORITHM).toBe("membench-mulberry32-sha256-v1");
    const first = new SeededRandom("raw-seed");
    const second = new SeededRandom("raw-seed");
    expect(first.nextUint32()).toBe(second.nextUint32());
    expect(() => first.integer(4_294_967_297)).toThrow("2^32");
  });
});

describe("immutable domain state", () => {
  test("missing usage remains explicitly missing", () => {
    expect(missingUsage()).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
  });

  test("calibration eligibility is derived rather than caller-selected", () => {
    expect(assessCalibration("item-a", lane, "fail", "pass")).toMatchObject({ eligible: true, reason: "calibrated" });
    expect(assessCalibration("item-a", lane, "pass", "pass")).toMatchObject({ eligible: false, reason: "floor_did_not_fail" });
    expect(assessCalibration("item-a", lane, "fail", "unknown")).toMatchObject({ eligible: false, reason: "unknown" });
  });

  test("experiment identity binds every component hash", () => {
    const value = hashJson({ synthetic: true });
    const identity = createExperimentIdentity({
      corpusHash: value,
      promptHash: value,
      routeHash: value,
      harnessHash: value,
      configHash: value,
      judgeHash: value,
    });
    expect(identity.combinedHash).toMatch(/^sha256:/);
    expect(Object.isFrozen(identity)).toBeTrue();
  });

  test("attempt journal is append-only and terminal states are final", () => {
    const scheduled: AttemptState = {
      state: "scheduled",
      attemptId: "attempt-one",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 0,
      recordedAt: "2026-01-10T00:00:00.000Z",
    };
    const terminal: AttemptState = {
      ...scheduled,
      state: "terminal",
      outcome: "unknown",
      usage: missingUsage(),
      schemaValid: false,
    };
    const first = appendAttempt([], scheduled);
    expect(Object.isFrozen(scheduled)).toBeFalse();
    expect(first[0]).not.toBe(scheduled);
    expect(Object.isFrozen(first[0])).toBeTrue();
    const second = appendAttempt(first, terminal);
    expect(second.map((row) => row.state)).toEqual(["scheduled", "terminal"]);
    expect(() => appendAttempt(second, terminal)).toThrow("terminal states are final");
    expect(Object.isFrozen(second)).toBeTrue();
  });

  test("terminal rows must exactly match every scheduled scientific coordinate", () => {
    const scheduled: AttemptState = {
      state: "scheduled",
      attemptId: "attempt-two",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 1,
      recordedAt: "2026-01-10T00:00:00.000Z",
    };
    const journal = appendAttempt([], scheduled);
    const terminal = {
      ...scheduled,
      state: "terminal" as const,
      outcome: "pass" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 },
      schemaValid: true,
    };
    const mutations = [
      { ...terminal, sequence: 3 },
      { ...terminal, itemId: "item-b" },
      { ...terminal, candidateId: "model-b" },
      { ...terminal, laneId: laneId("executor-b") },
      { ...terminal, arm: "none" as const },
      { ...terminal, repetition: 2 },
    ];
    for (const mutated of mutations) expect(() => appendAttempt(journal, mutated)).toThrow("identity differs");
  });

  test("terminal timestamps cannot travel backward from their scheduled row", () => {
    const scheduled: AttemptState = {
      state: "scheduled",
      attemptId: "attempt-time",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 0,
      recordedAt: "2026-01-10T00:00:01.000Z",
    };
    const journal = appendAttempt([], scheduled);
    expect(() => appendAttempt(journal, {
      ...scheduled,
      state: "terminal",
      recordedAt: "2026-01-10T00:00:00.999Z",
      outcome: "pass",
      usage: missingUsage(),
      schemaValid: true,
    })).toThrow("cannot predate");
  });

  test("attempt timestamps use UTC with at most millisecond precision", () => {
    const base: AttemptState = {
      state: "scheduled",
      attemptId: "attempt-precision",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 0,
      recordedAt: "2026-01-10T00:00:00Z",
    };
    for (const recordedAt of [
      "2026-01-10T00:00:00Z",
      "2026-01-10T00:00:00.1Z",
      "2026-01-10T00:00:00.123Z",
    ]) expect(() => appendAttempt([], { ...base, recordedAt })).not.toThrow();

    const scheduled = { ...base, recordedAt: "2026-01-10T00:00:00.0009Z" };
    const terminal = {
      ...scheduled,
      state: "terminal" as const,
      recordedAt: "2026-01-10T00:00:00.0001Z",
      outcome: "pass" as const,
      usage: missingUsage(),
      schemaValid: true,
    };
    expect(() => appendAttempt([scheduled], terminal)).toThrow("millisecond precision");
    const validJournal = appendAttempt([], { ...base, recordedAt: "2026-01-10T00:00:00.000Z" });
    expect(() => appendAttempt(validJournal, {
      ...terminal,
      recordedAt: "2026-01-10T00:00:00.0001Z",
    })).toThrow("millisecond precision");
    expect(() => appendAttempt([], { ...base, recordedAt: "2026-01-10T00:00:00+00:00" })).toThrow("UTC");
  });

  test("journal runtime validation rejects invalid terminal values and duplicate coordinates", () => {
    const scheduled: AttemptState = {
      state: "scheduled",
      attemptId: "attempt-three",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 2,
      recordedAt: "2026-01-10T00:00:00.000Z",
    };
    const journal = appendAttempt([], scheduled);
    expect(() => appendAttempt(journal, { ...scheduled, attemptId: "attempt-four", sequence: 1 })).toThrow("coordinate is duplicated");
    const terminal = {
      ...scheduled,
      state: "terminal",
      outcome: "maybe",
      usage: missingUsage(),
      schemaValid: true,
    } as unknown as AttemptState;
    expect(() => appendAttempt(journal, terminal)).toThrow("outcome is invalid");
    expect(() => appendAttempt(journal, { ...terminal, outcome: "pass", schemaValid: 1 } as unknown as AttemptState)).toThrow("schemaValid must be boolean");
    expect(() => appendAttempt(journal, {
      ...terminal,
      outcome: "pass",
      schemaValid: true,
      usage: { inputTokens: Number.NaN, outputTokens: null, totalTokens: null, costUsd: null },
    } as unknown as AttemptState)).toThrow("finite non-negative");
    expect(() => appendAttempt(journal, {
      ...terminal,
      outcome: "pass",
      schemaValid: true,
      usage: { inputTokens: 1.5, outputTokens: null, totalTokens: null, costUsd: null },
    } as unknown as AttemptState)).toThrow("finite non-negative");
    expect(() => appendAttempt(journal, {
      ...terminal,
      outcome: "pass",
      schemaValid: true,
      usage: { inputTokens: 1e308, outputTokens: null, totalTokens: null, costUsd: null },
    } as unknown as AttemptState)).toThrow("finite non-negative");
    expect(() => appendAttempt(journal, {
      ...terminal,
      outcome: "pass",
      schemaValid: true,
      usage: { inputTokens: 900_000_000, outputTokens: 900_000_000, totalTokens: null, costUsd: null },
    } as unknown as AttemptState)).toThrow("token aggregate");
    expect(() => appendAttempt(journal, {
      ...terminal,
      outcome: "pass",
      schemaValid: true,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 3, costUsd: null },
    } as unknown as AttemptState)).toThrow("token aggregate");
  });

  test("scheduled sequence numbers are unique, contiguous, and monotonic", () => {
    const builder = new AttemptJournalBuilder();
    const first: AttemptState = {
      state: "scheduled",
      attemptId: "sequence-zero",
      sequence: 0,
      itemId: "item-a",
      laneId: lane,
      candidateId: "model-a",
      arm: "candidate",
      repetition: 0,
      recordedAt: "2026-01-10T00:00:00.000Z",
    };
    builder.append(first);
    expect(() => builder.append({
      ...first,
      attemptId: "sequence-two",
      sequence: 2,
      itemId: "item-b",
    })).toThrow("unique, contiguous, and monotonic");
    expect(() => builder.append({
      ...first,
      attemptId: "sequence-duplicate",
      itemId: "item-c",
    })).toThrow("unique, contiguous, and monotonic");
  });

  test("indexed journal construction handles ten thousand scheduled rows", () => {
    const builder = new AttemptJournalBuilder();
    for (let index = 0; index < 10_000; index += 1) {
      builder.append({
        state: "scheduled",
        attemptId: `attempt-${index}`,
        sequence: index,
        itemId: `item-${index}`,
        laneId: lane,
        candidateId: "model-a",
        arm: "candidate",
        repetition: 0,
        recordedAt: "2026-01-10T00:00:00.000Z",
      });
    }
    const journal = builder.snapshot();
    expect(builder.size).toBe(10_000);
    expect(journal).toHaveLength(10_000);
    expect(journal[9_999]?.sequence).toBe(9_999);
    expect(Object.isFrozen(journal)).toBeTrue();
  });

  test("canonical JSON rejects non-JSON values and cycles", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [undefined, () => true, Symbol("synthetic"), 1n, Number.NaN, new Date(0), new Map(), new Set(), cyclic]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });
});
