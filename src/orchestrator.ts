import { canonicalJson, deepFreeze, hashJson, sha256 } from "./canonical";
import type { Outcome, ReportedUsage, Sha256 } from "./domain";
import { laneId } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { SCIENTIFIC_LIMITS } from "./limits";
import type { PersistedSchedule, ScheduleEntry } from "./schedule";
import { redactError, reportedCost, utf8Text } from "./runtime-validation";
import { requireUtcRfc3339Millis } from "./timestamps";

export interface RunManifest {
  readonly schemaVersion: 1;
  readonly experimentId: string;
  readonly experimentIdentityHash: Sha256;
  readonly scheduleHash: Sha256;
  readonly scheduleBytes: string;
  readonly entries: readonly ScheduleEntry[];
  readonly createdAt: string;
  readonly contentHash: Sha256;
}

const arms = new Set<unknown>(["candidate", "none", "shuffled", "reference"]);
function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) throw new TypeError(`${label} has invalid fields`);
  return source;
}

function validateEntry(value: unknown, expectedSequence: number): ScheduleEntry {
  const row = exactObject(value, ["sequence", "attemptId", "itemId", "laneId", "repetition", "candidateId", "arm"], "schedule entry");
  if (row.sequence !== expectedSequence || !Number.isSafeInteger(row.repetition) || (row.repetition as number) < 0 || (row.repetition as number) >= SCIENTIFIC_LIMITS.maximumRepetitions || !arms.has(row.arm)) {
    throw new Error("schedule entry coordinates are invalid");
  }
  return deepFreeze({
    sequence: expectedSequence,
    attemptId: requireSafeIdentifier(row.attemptId, "attempt id"),
    itemId: requireSafeIdentifier(row.itemId, "item id"),
    laneId: laneId(requireSafeIdentifier(row.laneId, "lane id")),
    repetition: row.repetition as number,
    candidateId: requireSafeIdentifier(row.candidateId, "candidate id"),
    arm: row.arm as ScheduleEntry["arm"],
  });
}

function validatePersistedSchedule(schedule: PersistedSchedule): { readonly entries: readonly ScheduleEntry[]; readonly bytes: string; readonly contentHash: Sha256 } {
  const source = exactObject(schedule, ["entries", "bytes", "contentHash"], "persisted schedule");
  if (!Array.isArray(source.entries) || source.entries.length === 0 || source.entries.length > SCIENTIFIC_LIMITS.maximumScheduleEntries || typeof source.bytes !== "string" || typeof source.contentHash !== "string") {
    throw new TypeError("persisted schedule is invalid");
  }
  const entries = source.entries.map(validateEntry);
  const identities = entries.map((entry) => `${entry.itemId}\0${entry.laneId}\0${entry.candidateId}\0${entry.arm}\0${entry.repetition}`);
  if (new Set(entries.map((entry) => entry.attemptId)).size !== entries.length || new Set(identities).size !== identities.length) {
    throw new Error("persisted schedule contains duplicate identities or coordinates");
  }
  const bytes = `${canonicalJson(entries)}\n`;
  if (source.bytes !== bytes || source.contentHash !== sha256(bytes)) throw new Error("persisted schedule bytes or hash mismatch");
  return deepFreeze({ entries, bytes, contentHash: source.contentHash as Sha256 });
}

export function createRunManifest(input: {
  readonly experimentId: string;
  readonly experimentIdentityHash: Sha256;
  readonly schedule: PersistedSchedule;
  readonly createdAt: string;
}): RunManifest {
  const experimentId = requireSafeIdentifier(input.experimentId, "experiment id");
  const createdAt = requireUtcRfc3339Millis(input.createdAt, "manifest timestamp");
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.experimentIdentityHash)) throw new TypeError("experiment identity hash is invalid");
  const schedule = validatePersistedSchedule(input.schedule);
  const payload = { schemaVersion: 1 as const, experimentId, experimentIdentityHash: input.experimentIdentityHash, scheduleHash: schedule.contentHash, scheduleBytes: schedule.bytes, entries: schedule.entries, createdAt };
  return deepFreeze({ ...payload, contentHash: hashJson(payload) });
}

export function parseRunManifest(value: unknown): RunManifest {
  const source = exactObject(value, ["schemaVersion", "experimentId", "experimentIdentityHash", "scheduleHash", "scheduleBytes", "entries", "createdAt", "contentHash"], "run manifest");
  if (source.schemaVersion !== 1 || typeof source.scheduleHash !== "string" || typeof source.scheduleBytes !== "string" || typeof source.contentHash !== "string") throw new Error("run manifest version or hashes are invalid");
  const manifest = createRunManifest({
    experimentId: requireSafeIdentifier(source.experimentId, "experiment id"),
    experimentIdentityHash: source.experimentIdentityHash as Sha256,
    schedule: { entries: source.entries as ScheduleEntry[], bytes: source.scheduleBytes, contentHash: source.scheduleHash as Sha256 },
    createdAt: requireUtcRfc3339Millis(source.createdAt, "manifest timestamp"),
  });
  if (manifest.contentHash !== source.contentHash || canonicalJson(manifest) !== canonicalJson(value)) throw new Error("run manifest identity mismatch");
  return manifest;
}

interface RuntimeBase { readonly attemptId: string; readonly sequence: number; readonly recordedAt: string }
export interface RuntimeScheduledRow extends RuntimeBase { readonly state: "scheduled" }
export interface RuntimeStartedRow extends RuntimeBase { readonly state: "started" }
export interface RuntimeTerminalRow extends RuntimeBase { readonly state: "terminal"; readonly outcome: Outcome; readonly schemaValid: boolean; readonly usage: RuntimeSpend; readonly steps: number; readonly budgetOvershoot: RuntimeBudgetFlags }
export interface RuntimeInterruptedRow extends RuntimeBase { readonly state: "interrupted"; readonly reason: string; readonly usage: RuntimeSpend; readonly steps: number; readonly budgetOvershoot: RuntimeBudgetFlags }
export type RuntimeJournalRow = RuntimeScheduledRow | RuntimeStartedRow | RuntimeTerminalRow | RuntimeInterruptedRow;

export interface RuntimeStore { loadManifest(): Promise<RunManifest | null>; saveManifest(manifest: RunManifest): Promise<void>; loadRows(): Promise<readonly RuntimeJournalRow[]>; append(row: RuntimeJournalRow): Promise<void> }
export class InMemoryRuntimeStore implements RuntimeStore {
  #manifest: RunManifest | null = null;
  readonly #rows: RuntimeJournalRow[] = [];
  async loadManifest(): Promise<RunManifest | null> { return this.#manifest; }
  async saveManifest(manifest: RunManifest): Promise<void> {
    const parsed = parseRunManifest(manifest);
    if (this.#manifest && canonicalJson(this.#manifest) !== canonicalJson(parsed)) throw new Error("run manifest is immutable");
    this.#manifest = parsed;
  }
  async loadRows(): Promise<readonly RuntimeJournalRow[]> { return deepFreeze([...this.#rows]); }
  async append(row: RuntimeJournalRow): Promise<void> { this.#rows.push(deepFreeze({ ...row })); }
}

export interface RuntimeSpend { readonly observerUsd: number | null; readonly executorUsd: number | null; readonly judgeUsd: number | null }
export interface RuntimeBudgets { readonly observerUsd: number; readonly executorUsd: number; readonly judgeUsd: number; readonly maximumSteps: number }
export interface RuntimeBudgetFlags { readonly observer: boolean; readonly executor: boolean; readonly judge: boolean; readonly steps: boolean; readonly measurementMissing: boolean }
export interface AttemptWorkResult { readonly outcome: Outcome; readonly schemaValid: boolean; readonly usage: RuntimeSpend; readonly steps: number }
export interface AttemptWorker { (entry: ScheduleEntry): Promise<AttemptWorkResult> }

export class AttemptWorkFailure extends Error {
  readonly usage: RuntimeSpend;
  readonly steps: number;
  constructor(message: string, measurement: { readonly usage: RuntimeSpend; readonly steps: number }) {
    super(message);
    this.name = "AttemptWorkFailure";
    const validated = validateMeasurement(measurement.usage, measurement.steps);
    this.usage = validated.usage;
    this.steps = validated.steps;
  }
}

function validateSpend(value: unknown): RuntimeSpend {
  const source = exactObject(value, ["observerUsd", "executorUsd", "judgeUsd"], "runtime spend");
  const read = (key: keyof RuntimeSpend): number | null => {
    const measured = source[key];
    if (measured === null) return null;
    const valid = reportedCost(measured);
    if (valid === null) throw new TypeError("runtime spend is invalid");
    return valid;
  };
  return deepFreeze({ observerUsd: read("observerUsd"), executorUsd: read("executorUsd"), judgeUsd: read("judgeUsd") });
}

function validateMeasurement(usage: unknown, steps: unknown): { readonly usage: RuntimeSpend; readonly steps: number } {
  if (!Number.isSafeInteger(steps) || (steps as number) < 0 || (steps as number) > SCIENTIFIC_LIMITS.maximumSteps * 2) throw new TypeError("attempt steps are invalid");
  return { usage: validateSpend(usage), steps: steps as number };
}

function validateWorkResult(value: AttemptWorkResult): AttemptWorkResult {
  const source = exactObject(value, ["outcome", "schemaValid", "usage", "steps"], "attempt worker result");
  if (!new Set<unknown>(["pass", "fail", "unknown"]).has(source.outcome) || typeof source.schemaValid !== "boolean") throw new TypeError("attempt worker result is invalid");
  const measured = validateMeasurement(source.usage, source.steps);
  return deepFreeze({ outcome: source.outcome as Outcome, schemaValid: source.schemaValid, ...measured });
}

function validateBudgets(budgets: RuntimeBudgets): RuntimeBudgets {
  const source = exactObject(budgets, ["observerUsd", "executorUsd", "judgeUsd", "maximumSteps"], "runtime budgets");
  const money = (key: "observerUsd" | "executorUsd" | "judgeUsd") => {
    const value = reportedCost(source[key]);
    if (value === null || value <= 0) throw new TypeError("runtime budgets must be finite and positive");
    return value;
  };
  if (!Number.isSafeInteger(source.maximumSteps) || (source.maximumSteps as number) <= 0 || (source.maximumSteps as number) > SCIENTIFIC_LIMITS.maximumSteps) throw new TypeError("runtime step budget is invalid");
  return deepFreeze({ observerUsd: money("observerUsd"), executorUsd: money("executorUsd"), judgeUsd: money("judgeUsd"), maximumSteps: source.maximumSteps as number });
}

function addSpend(left: RuntimeSpend, right: RuntimeSpend, maximumAggregate: number): RuntimeSpend {
  const add = (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) return null;
    const result = a + b;
    if (!Number.isFinite(result) || result < 0 || result > maximumAggregate || Math.abs(result) > Number.MAX_SAFE_INTEGER) {
      throw new RangeError("cumulative runtime spend exceeds its schedule-derived bound");
    }
    return result;
  };
  return deepFreeze({ observerUsd: add(left.observerUsd, right.observerUsd), executorUsd: add(left.executorUsd, right.executorUsd), judgeUsd: add(left.judgeUsd, right.judgeUsd) });
}
function flags(spend: RuntimeSpend, steps: number, budgets: RuntimeBudgets): RuntimeBudgetFlags {
  return deepFreeze({
    observer: spend.observerUsd !== null && spend.observerUsd > budgets.observerUsd,
    executor: spend.executorUsd !== null && spend.executorUsd > budgets.executorUsd,
    judge: spend.judgeUsd !== null && spend.judgeUsd > budgets.judgeUsd,
    steps: steps > budgets.maximumSteps,
    measurementMissing: Object.values(spend).some((value) => value === null),
  });
}
function sameFlags(left: RuntimeBudgetFlags, right: RuntimeBudgetFlags): boolean { return canonicalJson(left) === canonicalJson(right); }
function validateStoredFlags(value: unknown): RuntimeBudgetFlags {
  const source = exactObject(value, ["observer", "executor", "judge", "steps", "measurementMissing"], "runtime budget flags");
  if (Object.values(source).some((entry) => typeof entry !== "boolean")) throw new TypeError("runtime budget flags are invalid");
  return source as unknown as RuntimeBudgetFlags;
}

interface JournalState { readonly lifecycle: Map<string, "scheduled" | "started" | "final">; readonly terminalIds: Set<string>; readonly spend: RuntimeSpend; readonly steps: number }
function validatePersistedRows(manifest: RunManifest, rows: readonly RuntimeJournalRow[], budgets: RuntimeBudgets): JournalState {
  if (!Array.isArray(rows) || rows.length > manifest.entries.length * 3) throw new RangeError("runtime journal exceeds allocation");
  const lifecycle = new Map<string, "scheduled" | "started" | "final">();
  const terminalIds = new Set<string>();
  let spend: RuntimeSpend = { observerUsd: 0, executorUsd: 0, judgeUsd: 0 };
  let steps = 0;
  let scheduledCount = 0;
  let lastTimestamp = Date.parse(manifest.createdAt);
  const maximumAggregate = manifest.entries.length * SCIENTIFIC_LIMITS.maximumBudgetUsd;
  const maximumAggregateSteps = manifest.entries.length * SCIENTIFIC_LIMITS.maximumSteps * 2;
  for (const value of rows) {
    const baseKeys = ["attemptId", "sequence", "recordedAt", "state"];
    const state = (value as { state?: unknown }).state;
    const keys = state === "terminal" ? [...baseKeys, "outcome", "schemaValid", "usage", "steps", "budgetOvershoot"] : state === "interrupted" ? [...baseKeys, "reason", "usage", "steps", "budgetOvershoot"] : baseKeys;
    const row = exactObject(value, keys, "runtime journal row");
    if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0 || (row.sequence as number) >= manifest.entries.length) throw new TypeError("runtime journal sequence is invalid");
    const entry = manifest.entries[row.sequence as number];
    const attemptId = requireSafeIdentifier(row.attemptId, "runtime attempt id");
    if (!entry || attemptId !== entry.attemptId) throw new Error("runtime journal row is outside the manifest");
    const at = Date.parse(requireUtcRfc3339Millis(row.recordedAt, "runtime journal timestamp"));
    if (at < lastTimestamp) throw new Error("runtime journal timestamps are not globally monotonic");
    lastTimestamp = at;
    let measured: { readonly usage: RuntimeSpend; readonly steps: number } | null = null;
    let storedFlags: RuntimeBudgetFlags | null = null;
    if (state === "terminal") {
      measured = validateMeasurement(row.usage, row.steps);
      storedFlags = validateStoredFlags(row.budgetOvershoot);
      if (!new Set<unknown>(["pass", "fail", "unknown"]).has(row.outcome) || typeof row.schemaValid !== "boolean") throw new TypeError("terminal outcome is invalid");
    } else if (state === "interrupted") {
      measured = validateMeasurement(row.usage, row.steps);
      storedFlags = validateStoredFlags(row.budgetOvershoot);
      utf8Text(row.reason, "interruption reason", 500, true);
    } else if (state !== "scheduled" && state !== "started") throw new Error("runtime row state is invalid");
    const previous = lifecycle.get(entry.attemptId);
    if (state === "scheduled") {
      const prior = entry.sequence === 0 ? null : manifest.entries[entry.sequence - 1];
      if (previous || entry.sequence !== scheduledCount || (prior && lifecycle.get(prior.attemptId) !== "final")) {
        throw new Error("runtime journal must schedule one contiguous sequential manifest prefix");
      }
      scheduledCount += 1; lifecycle.set(entry.attemptId, "scheduled"); continue;
    }
    if (state === "started") {
      if (previous !== "scheduled") throw new Error("runtime attempt must be scheduled before start");
      lifecycle.set(entry.attemptId, "started"); continue;
    }
    if (previous !== "started") throw new Error("runtime attempt must start before final state");
    if (measured === null || storedFlags === null) throw new Error("runtime final row validation failed");
    spend = addSpend(spend, measured.usage, maximumAggregate);
    steps += measured.steps;
    if (!Number.isSafeInteger(steps) || steps > maximumAggregateSteps) throw new RangeError("cumulative runtime steps exceed their schedule-derived bound");
    const expectedFlags = flags(spend, steps, budgets);
    if (!sameFlags(storedFlags, expectedFlags)) throw new Error("persisted budget flags do not match cumulative measurements");
    lifecycle.set(entry.attemptId, "final"); terminalIds.add(entry.attemptId);
  }
  return { lifecycle, terminalIds, spend, steps };
}

function nextTimestamp(input: () => string, label: string, minimum: number): string {
  const value = requireUtcRfc3339Millis(input(), label);
  if (Date.parse(value) < minimum) throw new Error(`${label} cannot precede the durable journal`);
  return value;
}

export interface OrchestratorResult { readonly rows: readonly RuntimeJournalRow[]; readonly spend: RuntimeSpend; readonly steps: number; readonly stoppedReason: "complete" | "budget_exhausted" | "budget_measurement_missing" }

function stopFrom(spend: RuntimeSpend, steps: number, budgets: RuntimeBudgets, allFinal: boolean, continueOnMissingTelemetry: boolean): OrchestratorResult["stoppedReason"] {
  const current = flags(spend, steps, budgets);
  if (current.measurementMissing && !(continueOnMissingTelemetry && allFinal)) return "budget_measurement_missing";
  if (current.observer || current.executor || current.judge || current.steps) return "budget_exhausted";
  return allFinal ? "complete" : "budget_exhausted";
}

export async function runResumableExperiment(input: { readonly manifest: RunManifest; readonly store: RuntimeStore; readonly budgets: RuntimeBudgets; readonly worker: AttemptWorker; readonly now: () => string; readonly continueOnMissingTelemetry?: boolean }): Promise<OrchestratorResult> {
  const manifest = parseRunManifest(input.manifest);
  const budgets = validateBudgets(input.budgets);
  const storedManifest = await input.store.loadManifest();
  if (storedManifest && canonicalJson(parseRunManifest(storedManifest)) !== canonicalJson(manifest)) throw new Error("persisted manifest differs from requested manifest");
  if (!storedManifest) await input.store.saveManifest(manifest);
  let rows = [...await input.store.loadRows()];
  let journal = validatePersistedRows(manifest, rows, budgets);
  const maximumAggregate = manifest.entries.length * SCIENTIFIC_LIMITS.maximumBudgetUsd;
  for (const entry of manifest.entries) {
    if (journal.lifecycle.get(entry.attemptId) !== "started") continue;
    const usage: RuntimeSpend = { observerUsd: null, executorUsd: null, judgeUsd: null };
    const budgetOvershoot = flags(addSpend(journal.spend, usage, maximumAggregate), journal.steps, budgets);
    const minimum = Date.parse(rows.at(-1)?.recordedAt ?? manifest.createdAt);
    const interrupted: RuntimeInterruptedRow = { attemptId: entry.attemptId, sequence: entry.sequence, state: "interrupted", recordedAt: nextTimestamp(input.now, "resume timestamp", minimum), reason: "restored_started_row", usage, steps: 0, budgetOvershoot };
    await input.store.append(interrupted); rows.push(interrupted);
    journal = validatePersistedRows(manifest, rows, budgets);
  }
  let forcedStop: OrchestratorResult["stoppedReason"] | null = null;
  for (const entry of manifest.entries) {
    if (journal.terminalIds.has(entry.attemptId)) continue;
    const before = flags(journal.spend, journal.steps, budgets);
    if (before.measurementMissing && input.continueOnMissingTelemetry !== true) { forcedStop = "budget_measurement_missing"; break; }
    if (before.observer || before.executor || before.judge || before.steps || journal.spend.observerUsd! >= budgets.observerUsd || journal.spend.executorUsd! >= budgets.executorUsd || journal.spend.judgeUsd! >= budgets.judgeUsd || journal.steps >= budgets.maximumSteps) { forcedStop = "budget_exhausted"; break; }
    if (!journal.lifecycle.has(entry.attemptId)) {
      const minimum = Date.parse(rows.at(-1)?.recordedAt ?? manifest.createdAt);
      const scheduled: RuntimeScheduledRow = { attemptId: entry.attemptId, sequence: entry.sequence, state: "scheduled", recordedAt: nextTimestamp(input.now, "scheduled timestamp", minimum) };
      await input.store.append(scheduled); rows.push(scheduled);
      journal = validatePersistedRows(manifest, rows, budgets);
    }
    const scheduledAt = Date.parse(rows.at(-1)?.recordedAt ?? manifest.createdAt);
    const started: RuntimeStartedRow = { attemptId: entry.attemptId, sequence: entry.sequence, state: "started", recordedAt: nextTimestamp(input.now, "started timestamp", scheduledAt) };
    await input.store.append(started); rows.push(started);
    journal = validatePersistedRows(manifest, rows, budgets);
    let result: AttemptWorkResult | null = null;
    let failure: unknown = null;
    try { result = validateWorkResult(await input.worker(entry)); }
    catch (error) { failure = error; }
    if (result !== null) {
      const cumulativeSpend = addSpend(journal.spend, result.usage, maximumAggregate);
      const cumulativeSteps = journal.steps + result.steps;
      const terminal: RuntimeTerminalRow = { attemptId: entry.attemptId, sequence: entry.sequence, state: "terminal", recordedAt: nextTimestamp(input.now, "terminal timestamp", Date.parse(started.recordedAt)), outcome: result.outcome, schemaValid: result.schemaValid, usage: result.usage, steps: result.steps, budgetOvershoot: flags(cumulativeSpend, cumulativeSteps, budgets) };
      await input.store.append(terminal); rows.push(terminal);
    } else {
      const measured = failure instanceof AttemptWorkFailure ? validateMeasurement(failure.usage, failure.steps) : { usage: { observerUsd: null, executorUsd: null, judgeUsd: null } as RuntimeSpend, steps: 0 };
      const cumulativeSpend = addSpend(journal.spend, measured.usage, maximumAggregate);
      const cumulativeSteps = journal.steps + measured.steps;
      const interrupted: RuntimeInterruptedRow = { attemptId: entry.attemptId, sequence: entry.sequence, state: "interrupted", recordedAt: nextTimestamp(input.now, "interrupted timestamp", Date.parse(started.recordedAt)), reason: redactError(failure), usage: measured.usage, steps: measured.steps, budgetOvershoot: flags(cumulativeSpend, cumulativeSteps, budgets) };
      await input.store.append(interrupted); rows.push(interrupted);
      if (!(failure instanceof AttemptWorkFailure)) forcedStop = "budget_measurement_missing";
    }
    journal = validatePersistedRows(manifest, rows, budgets);
    const post = flags(journal.spend, journal.steps, budgets);
    if (post.measurementMissing && input.continueOnMissingTelemetry !== true) forcedStop = "budget_measurement_missing";
    else if (post.observer || post.executor || post.judge || post.steps) forcedStop = "budget_exhausted";
    if (forcedStop) break;
  }
  const allFinal = journal.terminalIds.size === manifest.entries.length;
  return deepFreeze({ rows, spend: journal.spend, steps: journal.steps, stoppedReason: forcedStop ?? stopFrom(journal.spend, journal.steps, budgets, allFinal, input.continueOnMissingTelemetry === true) });
}

export function reportedUsageSpend(usage: ReportedUsage): number | null { return usage.costUsd; }
