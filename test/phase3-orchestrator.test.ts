import { describe, expect, test } from "bun:test";

import {
  AttemptWorkFailure,
  createRunManifest,
  canonicalJson,
  InMemoryRuntimeStore,
  laneId,
  parseRunManifest,
  runResumableExperiment,
  sha256,
  type RuntimeJournalRow,
  type ScheduleEntry,
} from "../src";

function entry(sequence: number): ScheduleEntry {
  return { sequence, attemptId: `attempt-${sequence}`, itemId: `item-${sequence}`, laneId: laneId("lane-a"), repetition: 0, candidateId: "candidate-a", arm: "candidate" };
}

function manifest(entries: readonly ScheduleEntry[]) {
  const bytes = `${canonicalJson(entries)}\n`;
  return createRunManifest({
    experimentId: "experiment-a",
    experimentIdentityHash: sha256("identity"),
    schedule: { entries, bytes, contentHash: sha256(bytes) },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

const budgets = { observerUsd: 10, executorUsd: 10, judgeUsd: 10, maximumSteps: 10 };
const now = () => "2026-01-01T00:00:01.000Z";

describe("budgeted resumable orchestrator", () => {
  test("resume converts dangling started rows to interrupted before continuing", async () => {
    const store = new InMemoryRuntimeStore();
    const runManifest = manifest([entry(0), entry(1)]);
    await store.saveManifest(runManifest);
    await store.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: now() });
    await store.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: now() });
    const result = await runResumableExperiment({
      manifest: runManifest,
      store,
      budgets,
      now,
      worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 0.2, judgeUsd: 0.1 }, steps: 1 }),
    });
    expect(result.rows.some((row) => row.attemptId === "attempt-0" && row.state === "interrupted" && row.reason === "restored_started_row")).toBe(true);
    expect(result.rows.some((row) => row.attemptId === "attempt-1" && row.state === "terminal")).toBe(false);
    expect(result.stoppedReason).toBe("budget_measurement_missing");
    const terminalIds = new Set(result.rows.filter((row) => row.state === "terminal" || row.state === "interrupted").map((row) => row.attemptId));
    expect(result.rows.filter((row) => row.state === "started").every((row) => terminalIds.has(row.attemptId))).toBe(true);
  });

  test("resume continues a persisted scheduled row without duplicating it", async () => {
    const store = new InMemoryRuntimeStore();
    const runManifest = manifest([entry(0)]);
    await store.saveManifest(runManifest);
    await store.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: now() });
    const result = await runResumableExperiment({ manifest: runManifest, store, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 0.1, judgeUsd: 0.1 }, steps: 1 }) });
    expect(result.rows.filter((row) => row.state === "scheduled")).toHaveLength(1);
    expect(result.rows.some((row) => row.state === "terminal")).toBe(true);
  });

  test("worker errors settle as interrupted and stop when spend is unavailable", async () => {
    const store = new InMemoryRuntimeStore();
    const result = await runResumableExperiment({
      manifest: manifest([entry(0), entry(1)]),
      store,
      budgets,
      now,
      worker: async (scheduled) => {
        if (scheduled.sequence === 0) throw new Error("synthetic worker failure");
        return { outcome: "fail", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 0.2, judgeUsd: 0.1 }, steps: 1 };
      },
    });
    expect(result.rows.some((row) => row.attemptId === "attempt-0" && row.state === "interrupted")).toBe(true);
    const interrupted = result.rows.find((row) => row.attemptId === "attempt-0" && row.state === "interrupted");
    expect(interrupted?.state === "interrupted" && interrupted.usage).toEqual({ observerUsd: null, executorUsd: null, judgeUsd: null });
    expect(result.rows.some((row) => row.attemptId === "attempt-1" && row.state === "terminal")).toBe(false);
    expect(result.stoppedReason).toBe("budget_measurement_missing");
  });

  test("post-call cost and step overshoot remains visible and stops later work", async () => {
    const store = new InMemoryRuntimeStore();
    let calls = 0;
    const result = await runResumableExperiment({
      manifest: manifest([entry(0), entry(1)]),
      store,
      budgets: { observerUsd: 1, executorUsd: 1, judgeUsd: 1, maximumSteps: 1 },
      now,
      worker: async () => { calls += 1; return { outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 1.2, judgeUsd: 0.1 }, steps: 2 }; },
    });
    expect(calls).toBe(1);
    const terminal = result.rows.find((row) => row.state === "terminal");
    expect(terminal?.state === "terminal" && terminal.budgetOvershoot.executor).toBe(true);
    expect(terminal?.state === "terminal" && terminal.budgetOvershoot.steps).toBe(true);
    expect(result.stoppedReason).toBe("budget_exhausted");
  });

  test("cumulative spend may exceed the per-attempt measurement cap without becoming missing", async () => {
    let calls = 0;
    const result = await runResumableExperiment({
      manifest: manifest([entry(0), entry(1)]),
      store: new InMemoryRuntimeStore(),
      budgets: { observerUsd: 1_000_000, executorUsd: 1_000_000, judgeUsd: 1_000_000, maximumSteps: 10 },
      now,
      worker: async () => { calls += 1; return { outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 600_000, judgeUsd: 0 }, steps: 1 }; },
    });
    expect(calls).toBe(2);
    expect(result.spend.executorUsd).toBe(1_200_000);
    expect(result.stoppedReason).toBe("budget_exhausted");
    const final = [...result.rows].reverse().find((row) => row.state === "terminal");
    expect(final?.state === "terminal" && final.budgetOvershoot.executor).toBe(true);
    expect(final?.state === "terminal" && final.budgetOvershoot.measurementMissing).toBe(false);
  });

  test("the final scheduled row still reports overshoot and missing measurement stops", async () => {
    const overshot = await runResumableExperiment({
      manifest: manifest([entry(0)]),
      store: new InMemoryRuntimeStore(),
      budgets: { observerUsd: 1, executorUsd: 1, judgeUsd: 1, maximumSteps: 1 },
      now,
      worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 1.1, judgeUsd: 0.1 }, steps: 1 }),
    });
    expect(overshot.stoppedReason).toBe("budget_exhausted");
    const missing = await runResumableExperiment({
      manifest: manifest([entry(0)]),
      store: new InMemoryRuntimeStore(),
      budgets,
      now,
      worker: async () => ({ outcome: "unknown", schemaValid: false, usage: { observerUsd: 0.1, executorUsd: null, judgeUsd: 0.1 }, steps: 1 }),
    });
    expect(missing.stoppedReason).toBe("budget_measurement_missing");
  });

  test("a measured attempt failure can settle and continue", async () => {
    let calls = 0;
    const result = await runResumableExperiment({
      manifest: manifest([entry(0), entry(1)]),
      store: new InMemoryRuntimeStore(),
      budgets,
      now,
      worker: async () => {
        calls += 1;
        if (calls === 1) throw new AttemptWorkFailure("synthetic measured failure", { usage: { observerUsd: 0.1, executorUsd: 0.2, judgeUsd: 0 }, steps: 1 });
        return { outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 0.2, judgeUsd: 0.1 }, steps: 1 };
      },
    });
    expect(calls).toBe(2);
    expect(result.stoppedReason).toBe("complete");
    expect(result.rows.some((row) => row.attemptId === "attempt-0" && row.state === "interrupted" && row.usage.executorUsd === 0.2)).toBe(true);
    expect(result.rows.some((row) => row.attemptId === "attempt-1" && row.state === "terminal")).toBe(true);
  });

  test("missing spend is not silently treated as zero", async () => {
    const store = new InMemoryRuntimeStore();
    let calls = 0;
    const result = await runResumableExperiment({
      manifest: manifest([entry(0), entry(1)]),
      store,
      budgets,
      now,
      worker: async () => { calls += 1; return { outcome: "unknown", schemaValid: false, usage: { observerUsd: null, executorUsd: 0.1, judgeUsd: 0.1 }, steps: 1 }; },
    });
    expect(calls).toBe(1);
    expect(result.stoppedReason).toBe("budget_measurement_missing");
    const terminal = result.rows.find((row) => row.state === "terminal");
    expect(terminal?.state === "terminal" && terminal.budgetOvershoot.measurementMissing).toBe(true);
  });

  test("manifest is immutable across resume", async () => {
    const store = new InMemoryRuntimeStore();
    await store.saveManifest(manifest([entry(0)]));
    await expect(runResumableExperiment({ manifest: manifest([entry(0), entry(1)]), store, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("manifest");
  });

  test("manifest parsing rejects forged versions, hashes, schedule bytes, and entries", () => {
    const valid = manifest([entry(0), entry(1)]);
    expect(() => parseRunManifest({ ...valid, schemaVersion: 2 })).toThrow();
    expect(() => parseRunManifest({ ...valid, contentHash: sha256("forged") })).toThrow();
    expect(() => parseRunManifest({ ...valid, scheduleBytes: `${valid.scheduleBytes} ` })).toThrow();
    expect(() => parseRunManifest({ ...valid, entries: [entry(1), entry(0)] })).toThrow();
    expect(() => manifest([{ ...entry(0), repetition: "0" } as unknown as ScheduleEntry])).toThrow("coordinates");
    expect(() => manifest([{ ...entry(0), attemptId: "same" }, { ...entry(1), attemptId: "same" }])).toThrow("duplicate");
  });

  test("resume rejects non-prefix rows and forged cumulative flags", async () => {
    const runManifest = manifest([entry(0), entry(1)]);
    const skipped = new InMemoryRuntimeStore();
    await skipped.saveManifest(runManifest);
    await skipped.append({ attemptId: "attempt-1", sequence: 1, state: "scheduled", recordedAt: now() });
    await expect(runResumableExperiment({ manifest: runManifest, store: skipped, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("contiguous");

    const forged = new InMemoryRuntimeStore();
    await forged.saveManifest(runManifest);
    await forged.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: now() });
    await forged.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: now() });
    await forged.append({ attemptId: "attempt-0", sequence: 0, state: "terminal", recordedAt: now(), outcome: "pass", schemaValid: true, usage: { observerUsd: 0.1, executorUsd: 0.1, judgeUsd: 0.1 }, steps: 1, budgetOvershoot: { observer: true, executor: false, judge: false, steps: false, measurementMissing: false } });
    await expect(runResumableExperiment({ manifest: runManifest, store: forged, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("flags");
  });

  test("resume rejects overlapping attempts and globally reversed timestamps", async () => {
    const runManifest = manifest([entry(0), entry(1)]);
    const overlapping = new InMemoryRuntimeStore();
    await overlapping.saveManifest(runManifest);
    await overlapping.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: "2026-01-01T00:00:01.000Z" });
    await overlapping.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: "2026-01-01T00:00:02.000Z" });
    await overlapping.append({ attemptId: "attempt-1", sequence: 1, state: "scheduled", recordedAt: "2026-01-01T00:00:03.000Z" });
    await expect(runResumableExperiment({ manifest: runManifest, store: overlapping, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("sequential");

    const reversed = new InMemoryRuntimeStore();
    await reversed.saveManifest(runManifest);
    await reversed.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: "2026-01-01T00:00:02.000Z" });
    await reversed.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: "2026-01-01T00:00:01.000Z" });
    await expect(runResumableExperiment({ manifest: runManifest, store: reversed, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("globally monotonic");
  });

  test("runtime rows reject string coordinates and measurements before lifecycle logic", async () => {
    const runManifest = manifest([entry(0)]);
    const stringSequence = new InMemoryRuntimeStore();
    await stringSequence.saveManifest(runManifest);
    await stringSequence.append({ attemptId: "attempt-0", sequence: "0", state: "scheduled", recordedAt: now() } as unknown as RuntimeJournalRow);
    await expect(runResumableExperiment({ manifest: runManifest, store: stringSequence, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("sequence");

    const stringSteps = new InMemoryRuntimeStore();
    await stringSteps.saveManifest(runManifest);
    await stringSteps.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: now() });
    await stringSteps.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: now() });
    await stringSteps.append({ attemptId: "attempt-0", sequence: 0, state: "terminal", recordedAt: now(), outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: "0", budgetOvershoot: { observer: false, executor: false, judge: false, steps: false, measurementMissing: false } } as unknown as RuntimeJournalRow);
    await expect(runResumableExperiment({ manifest: runManifest, store: stringSteps, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("steps");

    const stringSpend = new InMemoryRuntimeStore();
    await stringSpend.saveManifest(runManifest);
    await stringSpend.append({ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: now() });
    await stringSpend.append({ attemptId: "attempt-0", sequence: 0, state: "started", recordedAt: now() });
    await stringSpend.append({ attemptId: "attempt-0", sequence: 0, state: "terminal", recordedAt: now(), outcome: "pass", schemaValid: true, usage: { observerUsd: "0", executorUsd: 0, judgeUsd: 0 }, steps: 0, budgetOvershoot: { observer: false, executor: false, judge: false, steps: false, measurementMissing: false } } as unknown as RuntimeJournalRow);
    await expect(runResumableExperiment({ manifest: runManifest, store: stringSpend, budgets, now, worker: async () => ({ outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }) })).rejects.toThrow("spend");
  });

  test("a reversed clock fails before durable start and never invokes the worker", async () => {
    const store = new InMemoryRuntimeStore();
    const times = ["2026-01-01T00:00:02.000Z", "2026-01-01T00:00:01.000Z"];
    let workerCalls = 0;
    await expect(runResumableExperiment({
      manifest: manifest([entry(0)]),
      store,
      budgets,
      now: () => times.shift() as string,
      worker: async () => { workerCalls += 1; return { outcome: "pass", schemaValid: true, usage: { observerUsd: 0, executorUsd: 0, judgeUsd: 0 }, steps: 0 }; },
    })).rejects.toThrow("cannot precede");
    expect(workerCalls).toBe(0);
    expect(await store.loadRows()).toEqual([{ attemptId: "attempt-0", sequence: 0, state: "scheduled", recordedAt: "2026-01-01T00:00:02.000Z" }]);
  });
});
