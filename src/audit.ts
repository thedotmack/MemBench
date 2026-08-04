import { canonicalJson, compareText, deepFreeze, hashJson, type JsonValue } from "./canonical";
import { AUDIT_JUDGE_PROTOCOL } from "./judges";
import type { Outcome, ReportedUsage, RequestedRoute, RouteProvenance, Sha256 } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { SCIENTIFIC_LIMITS } from "./limits";
import { requireModelSampling, type ModelSampling } from "./model-transport";
import { SeededRandom } from "./prng";
import { boundedInteger, finiteNonnegative, requireFixedRoute, RUNTIME_LIMITS, runtimeTelemetryId, utf8Text, validateNullableDuration, validateReportedUsage, validateRouteProvenance } from "./runtime-validation";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";
import {
  assertCandidateComparisonFamily,
  candidateComparisonExecutionBatch,
  type CandidateComparison,
} from "./metrics";
import {
  executionBatchArtifacts,
  internalExecutionBatchPrimaryReassessmentRows,
  type BudgetStatus,
  type ExperimentExecutionBatch,
  type MoneyBudgetEvidence,
} from "./evidence";

export interface AuditCandidate {
  readonly rowId: string;
  readonly reassessmentEvidence: JsonValue;
  readonly primaryOutcome: Outcome;
}

export interface AuditJudgeConfig {
  readonly route: RequestedRoute;
  readonly promptHash: Sha256;
  readonly schemaHash: Sha256;
  readonly sampling: ModelSampling;
  readonly samplingHash: Sha256;
  readonly protocolHash: Sha256;
  readonly configHash: Sha256;
}

const auditOutcomeSchema = { schemaVersion: 1, response: { outcome: ["pass", "fail", "unknown"] } } as const;

export function createAuditJudgeConfig(input: {
  readonly route: RequestedRoute;
  readonly promptHash: Sha256;
  readonly schemaHash: Sha256;
  readonly sampling: ModelSampling;
}): AuditJudgeConfig {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 4) throw new TypeError("audit judge configuration has invalid fields");
  const route = requireFixedRoute(input.route);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.promptHash) || !/^sha256:[a-f0-9]{64}$/u.test(input.schemaHash)) throw new TypeError("audit judge prompt or schema hash is invalid");
  const sampling = requireModelSampling(input.sampling);
  const samplingHash = hashJson(sampling);
  const protocolHash = hashJson(AUDIT_JUDGE_PROTOCOL);
  const payload = { route, promptHash: input.promptHash, schemaHash: input.schemaHash, sampling, samplingHash, protocolHash };
  return deepFreeze({ ...payload, configHash: hashJson(payload) });
}

export function experimentAuditJudgeConfig(spec: ExperimentSpec): AuditJudgeConfig {
  assertExperimentSpecIdentity(spec);
  return createAuditJudgeConfig({
    route: spec.routes.judge,
    promptHash: hashJson(AUDIT_JUDGE_PROTOCOL),
    schemaHash: hashJson(auditOutcomeSchema),
    sampling: { temperature: 0, topP: 1, seed: hashJson({ purpose: "audit-judge-sampling", seed: spec.seeds.audit }) },
  });
}

interface EligibleAuditRow { readonly rowId: string; readonly evidenceHash: Sha256 }

export interface AuditManifest {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly seedHash: Sha256;
  readonly sampleSize: number;
  readonly samplingPolicy: "uniform_without_replacement";
  readonly eligibleRows: readonly EligibleAuditRow[];
  readonly universeHash: Sha256;
  readonly judgeConfigHash: Sha256;
  readonly selectedRowIds: readonly string[];
  readonly selectedSampleHash: Sha256;
  readonly contentHash: Sha256;
}

interface NormalizedAuditCandidate {
  readonly rowId: string;
  readonly reassessmentEvidence: JsonValue;
  readonly evidenceHash: Sha256;
  readonly primaryOutcome: Outcome;
}

interface GenericManifestBinding {
  readonly candidates: readonly NormalizedAuditCandidate[];
  readonly configHash: Sha256;
  readonly contentHash: Sha256;
}

const genericManifests = new WeakMap<object, GenericManifestBinding>();

function normalizedCandidates(candidates: readonly AuditCandidate[]): readonly NormalizedAuditCandidate[] {
  if (!Array.isArray(candidates) || candidates.length > RUNTIME_LIMITS.maximumAuditRows) throw new RangeError("audit candidates exceed allocation");
  const rows = candidates.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 3) throw new TypeError("audit candidate has invalid fields");
    const rowId = requireSafeIdentifier(value.rowId, "audit row id");
    if (value.primaryOutcome !== "pass" && value.primaryOutcome !== "fail" && value.primaryOutcome !== "unknown") throw new TypeError("audit primary outcome is invalid");
    canonicalJson(value.reassessmentEvidence);
    return deepFreeze({ rowId, reassessmentEvidence: value.reassessmentEvidence, evidenceHash: hashJson(value.reassessmentEvidence), primaryOutcome: value.primaryOutcome });
  }).sort((left, right) => compareText(left.rowId, right.rowId));
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) throw new TypeError("audit candidate ids must be unique");
  return deepFreeze(rows);
}

function manifestPayload(rows: readonly NormalizedAuditCandidate[], sampleSize: number, seed: string, config: AuditJudgeConfig): Omit<AuditManifest, "contentHash"> {
  boundedInteger(sampleSize, "audit sample size", RUNTIME_LIMITS.maximumAuditRows);
  if (sampleSize === 0 || sampleSize > rows.length) throw new TypeError("audit sample size must be positive and cannot exceed candidates");
  utf8Text(seed, "audit seed", 256, true);
  const eligibleRows = rows.map(({ rowId, evidenceHash }) => ({ rowId, evidenceHash }));
  const selectedRowIds = new SeededRandom(seed).shuffle(rows.map((row) => row.rowId)).slice(0, sampleSize).sort(compareText);
  return {
    schemaVersion: 1,
    seed,
    seedHash: hashJson({ seed }),
    sampleSize,
    samplingPolicy: "uniform_without_replacement",
    eligibleRows,
    universeHash: hashJson(eligibleRows),
    judgeConfigHash: config.configHash,
    selectedRowIds,
    selectedSampleHash: hashJson(selectedRowIds),
  };
}

/** Public manifest bytes intentionally have no dependency on primary outcomes. */
export function predeclareAuditSample(candidates: readonly AuditCandidate[], sampleSize: number, seed: string, config: AuditJudgeConfig): AuditManifest {
  const rows = normalizedCandidates(candidates);
  const payload = manifestPayload(rows, sampleSize, seed, config);
  const manifest = deepFreeze({ ...payload, contentHash: hashJson(payload) });
  genericManifests.set(manifest, deepFreeze({ candidates: rows, configHash: config.configHash, contentHash: manifest.contentHash }));
  return manifest;
}

function assertGenericManifest(manifest: AuditManifest, candidates: readonly AuditCandidate[], config: AuditJudgeConfig): readonly NormalizedAuditCandidate[] {
  const binding = genericManifests.get(manifest);
  const rows = normalizedCandidates(candidates);
  if (!binding || binding.configHash !== config.configHash || binding.contentHash !== manifest.contentHash ||
    canonicalJson(binding.candidates) !== canonicalJson(rows) || manifest.contentHash !== hashJson({
      schemaVersion: manifest.schemaVersion,
      seed: manifest.seed,
      seedHash: manifest.seedHash,
      sampleSize: manifest.sampleSize,
      samplingPolicy: manifest.samplingPolicy,
      eligibleRows: manifest.eligibleRows,
      universeHash: manifest.universeHash,
      judgeConfigHash: manifest.judgeConfigHash,
      selectedRowIds: manifest.selectedRowIds,
      selectedSampleHash: manifest.selectedSampleHash,
    })) throw new TypeError("audit manifest, candidate universe, or judge configuration mismatch");
  return rows;
}

export interface AuditAgreement {
  readonly selected: number;
  readonly judged: number;
  readonly agreements: number;
  readonly coverage: number;
  readonly agreementRate: number | null;
  readonly disagreements: readonly string[];
}

export interface IndependentAuditJudgeResult {
  readonly outcome: Outcome;
  readonly route: RouteProvenance;
  readonly generationId: string | null;
  readonly usage: ReportedUsage;
  readonly durationMs: number | null;
  readonly protocolHash: Sha256;
  readonly configHash: Sha256;
}

export interface IndependentAuditJudge {
  judge(input: {
    readonly rowId: string;
    readonly candidateId: string | null;
    readonly laneId: string | null;
    readonly reassessmentEvidence: JsonValue;
    readonly config: AuditJudgeConfig;
  }): Promise<IndependentAuditJudgeResult>;
}

function validateAuditJudgeResult(value: unknown, config: AuditJudgeConfig): IndependentAuditJudgeResult {
  const source = value === null || typeof value !== "object" || Array.isArray(value) ? null : value as Record<string, unknown>;
  const keys = ["outcome", "route", "generationId", "usage", "durationMs", "protocolHash", "configHash"];
  if (!source || Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key)) ||
    (source.outcome !== "pass" && source.outcome !== "fail" && source.outcome !== "unknown") ||
    source.protocolHash !== config.protocolHash || source.configHash !== config.configHash) throw new TypeError("audit judge result is invalid");
  const route = validateRouteProvenance(source.route, config.route);
  if (!route.effective.routeReported || route.effective.provider !== config.route.provider || route.effective.model !== config.route.model) {
    throw new TypeError("audit judge effective route must equal its requested no-fallback route");
  }
  return deepFreeze({
    outcome: source.outcome,
    route,
    generationId: source.generationId === null ? null : runtimeTelemetryId(source.generationId, "audit judge generation id"),
    usage: validateReportedUsage(source.usage, "audit judge usage"),
    durationMs: validateNullableDuration(source.durationMs, "audit judge duration"),
    protocolHash: config.protocolHash,
    configHash: config.configHash,
  });
}

function agreement(rows: readonly NormalizedAuditCandidate[], selectedIds: readonly string[], outcomes: Readonly<Record<string, Outcome>>): AuditAgreement {
  const selected = selectedIds.map((rowId) => rows.find((row) => row.rowId === rowId) as NormalizedAuditCandidate);
  const known = selected.filter((row) => row.primaryOutcome !== "unknown" && outcomes[row.rowId] !== "unknown");
  const agreements = known.filter((row) => outcomes[row.rowId] === row.primaryOutcome).length;
  const disagreements = selected.filter((row) => outcomes[row.rowId] !== row.primaryOutcome).map((row) => row.rowId);
  return deepFreeze({
    selected: selected.length,
    judged: selected.filter((row) => outcomes[row.rowId] !== "unknown").length,
    agreements,
    coverage: selected.length === 0 ? 0 : known.length / selected.length,
    agreementRate: selected.length === 0 ? null : agreements / selected.length,
    disagreements,
  });
}

export function calculateAuditAgreement(manifest: AuditManifest, candidates: readonly AuditCandidate[], outcomes: Readonly<Record<string, Outcome>>, config: AuditJudgeConfig): AuditAgreement {
  const rows = assertGenericManifest(manifest, candidates, config);
  if (Object.keys(outcomes).some((rowId) => !manifest.selectedRowIds.includes(rowId))) throw new TypeError("audit outcomes contain a substituted row");
  const complete = Object.fromEntries(manifest.selectedRowIds.map((rowId) => [rowId, outcomes[rowId] ?? "unknown"])) as Record<string, Outcome>;
  return agreement(rows, manifest.selectedRowIds, complete);
}

export interface IndependentAuditResult {
  readonly manifest: AuditManifest;
  readonly agreement: AuditAgreement;
  readonly reportedCostUsd: number | null;
  readonly primaryUniverseHash: Sha256;
  readonly postJudgmentOutcomeCommitment: Sha256;
}

const issuedGenericAuditResults = new WeakSet<object>();

export async function runIndependentAudit(manifest: AuditManifest, candidates: readonly AuditCandidate[], config: AuditJudgeConfig, judge: IndependentAuditJudge): Promise<IndependentAuditResult> {
  const rows = assertGenericManifest(manifest, candidates, config);
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  const outcomes: Record<string, Outcome> = {};
  const costs: (number | null)[] = [];
  for (const rowId of manifest.selectedRowIds) {
    const row = byId.get(rowId) as NormalizedAuditCandidate;
    try {
      const result = validateAuditJudgeResult(await judge.judge({ rowId, candidateId: null, laneId: null, reassessmentEvidence: row.reassessmentEvidence, config }), config);
      outcomes[rowId] = result.outcome;
      costs.push(result.usage.costUsd);
    } catch {
      outcomes[rowId] = "unknown";
      costs.push(null);
    }
  }
  // Primary labels are read only after all independent judge outputs have settled.
  const primaryUniverseHash = hashJson(rows.map(({ rowId, primaryOutcome }) => ({ rowId, primaryOutcome })));
  const result = deepFreeze({
    manifest,
    agreement: agreement(rows, manifest.selectedRowIds, outcomes),
    reportedCostUsd: costs.some((value) => value === null) ? null : (costs as number[]).reduce((sum, value) => sum + value, 0),
    primaryUniverseHash,
    postJudgmentOutcomeCommitment: hashJson({ primaryUniverseHash, outcomes }),
  });
  issuedGenericAuditResults.add(result);
  return result;
}

export interface ExperimentAuditEvidencePair {
  readonly candidateId: string;
  readonly laneId: string;
  readonly candidates: readonly { readonly rowId: string; readonly reassessmentEvidence: JsonValue }[];
  readonly universeHash: Sha256;
  readonly contentHash: Sha256;
}

export interface ExperimentAuditEvidenceFamily {
  readonly schemaVersion: 1;
  readonly method: "independent_reassessment";
  readonly limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals";
  readonly pairs: readonly ExperimentAuditEvidencePair[];
  readonly contentHash: Sha256;
}

interface ExperimentFamilyBinding {
  readonly spec: ExperimentSpec;
  readonly comparisons: readonly CandidateComparison[];
  readonly executionBatch: ExperimentExecutionBatch;
  readonly privateRows: readonly ReturnType<typeof internalExecutionBatchPrimaryReassessmentRows>[number][];
  readonly familyHash: Sha256;
}

const experimentFamilies = new WeakMap<object, ExperimentFamilyBinding>();

function auditRowId(spec: ExperimentSpec, candidateId: string, laneId: string, itemId: string, repetition: number): string {
  return `audit-${hashJson({ specIdentityHash: spec.identityHash, candidateId, laneId, itemId, repetition }).slice(7)}`;
}

export function issueExperimentAuditEvidenceFamily(spec: ExperimentSpec, comparisons: readonly CandidateComparison[]): ExperimentAuditEvidenceFamily {
  if (arguments.length !== 2) throw new TypeError("experiment audit evidence accepts no caller-supplied rows");
  assertCandidateComparisonFamily(comparisons, spec);
  const executionBatch = candidateComparisonExecutionBatch(comparisons, spec);
  const privateRows = internalExecutionBatchPrimaryReassessmentRows(executionBatch, spec);
  const pairs = comparisons.map((comparison) => {
    const rows = privateRows.filter((row) => row.candidateId === comparison.candidateId && row.laneId === comparison.laneId)
      .map((row) => ({
        rowId: auditRowId(spec, row.candidateId, row.laneId, row.itemId, row.repetition),
        reassessmentEvidence: row.reassessmentEvidence as unknown as JsonValue,
      })).sort((left, right) => compareText(left.rowId, right.rowId));
    const expected = spec.experiment.itemIds.length * spec.experiment.repetitions;
    if (rows.length !== expected || new Set(rows.map((row) => row.rowId)).size !== expected) throw new TypeError("audit evidence must exactly cover every pair item and repetition");
    const payload = { candidateId: comparison.candidateId, laneId: comparison.laneId, candidates: rows, universeHash: hashJson(rows.map((row) => ({ rowId: row.rowId, evidenceHash: hashJson(row.reassessmentEvidence) }))) };
    return deepFreeze({ ...payload, contentHash: hashJson(payload) });
  }).sort((left, right) => compareText(`${left.candidateId}\0${left.laneId}`, `${right.candidateId}\0${right.laneId}`));
  const payload = {
    schemaVersion: 1 as const,
    method: "independent_reassessment" as const,
    limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals" as const,
    pairs,
  };
  const family = deepFreeze({ ...payload, contentHash: hashJson(payload) });
  experimentFamilies.set(family, deepFreeze({ spec, comparisons, executionBatch, privateRows, familyHash: family.contentHash }));
  return family;
}

export interface ExperimentAuditPairManifest extends AuditManifest {
  readonly candidateId: string;
  readonly laneId: string;
}

export interface ExperimentAuditManifest {
  readonly schemaVersion: 1;
  readonly seedHash: Sha256;
  readonly sampleSizePerPair: number;
  readonly samplingPolicy: "uniform_without_replacement";
  readonly judgeConfigHash: Sha256;
  readonly pairs: readonly ExperimentAuditPairManifest[];
  readonly contentHash: Sha256;
}

interface ExperimentManifestBinding extends ExperimentFamilyBinding {
  readonly family: ExperimentAuditEvidenceFamily;
  readonly manifestHash: Sha256;
}

const experimentManifests = new WeakMap<object, ExperimentManifestBinding>();

export function predeclareExperimentAuditSample(spec: ExperimentSpec, comparisons: readonly CandidateComparison[], family: ExperimentAuditEvidenceFamily): ExperimentAuditManifest {
  const binding = experimentFamilies.get(family);
  if (!binding || binding.spec !== spec || binding.comparisons !== comparisons || binding.familyHash !== family.contentHash) throw new TypeError("experiment audit evidence family must be issued for the exact comparisons");
  const config = experimentAuditJudgeConfig(spec);
  const pairs = family.pairs.map((pair) => {
    const rows = pair.candidates.map((row) => ({ rowId: row.rowId, reassessmentEvidence: row.reassessmentEvidence, evidenceHash: hashJson(row.reassessmentEvidence), primaryOutcome: "unknown" as const }));
    const pairSeed = hashJson({ seed: spec.seeds.audit, candidateId: pair.candidateId, laneId: pair.laneId });
    const base = manifestPayload(rows, spec.audit.sampleSize, pairSeed, config);
    const payload = { ...base, candidateId: pair.candidateId, laneId: pair.laneId };
    return deepFreeze({ ...payload, contentHash: hashJson(payload) });
  });
  const payload = {
    schemaVersion: 1 as const,
    seedHash: hashJson({ seed: spec.seeds.audit }),
    sampleSizePerPair: spec.audit.sampleSize,
    samplingPolicy: spec.audit.policy,
    judgeConfigHash: config.configHash,
    pairs,
  };
  const manifest = deepFreeze({ ...payload, contentHash: hashJson(payload) });
  experimentManifests.set(manifest, deepFreeze({ ...binding, family, manifestHash: manifest.contentHash }));
  return manifest;
}

export interface ExperimentAuditPairResult {
  readonly candidateId: string;
  readonly laneId: string;
  readonly status: "measured" | "incomplete";
  readonly agreement: AuditAgreement;
  readonly manifestHash: Sha256;
  readonly evidenceUniverseHash: Sha256;
  readonly selectedSampleHash: Sha256;
  readonly primaryUniverseHash: Sha256;
  readonly postJudgmentOutcomeCommitment: Sha256;
}

export interface IndependentExperimentAuditResult {
  readonly manifest: ExperimentAuditManifest;
  readonly pairs: readonly ExperimentAuditPairResult[];
  readonly reportedCostUsd: number | null;
  readonly budget: MoneyBudgetEvidence;
  readonly judgeConfig: AuditJudgeConfig;
}

interface ExperimentResultBinding extends ExperimentManifestBinding { readonly resultHash: Sha256 }
const experimentResults = new WeakMap<object, ExperimentResultBinding>();

class AuditLedger {
  readonly limit: number;
  measured: number | null;
  status: BudgetStatus;
  skipped = 0;
  constructor(before: MoneyBudgetEvidence) { this.limit = before.limitUsd; this.measured = before.measuredUsd; this.status = before.status; }
  allow(): boolean {
    if (this.status !== "within" || this.measured === null || this.measured >= this.limit) {
      if (this.status === "within") this.status = this.measured === null ? "measurement_unknown" : "exhausted";
      this.skipped += 1;
      return false;
    }
    return true;
  }
  add(value: number | null): void {
    if (value === null || this.measured === null) { this.measured = null; this.status = "measurement_unknown"; return; }
    this.measured += finiteNonnegative(value, "audit judge cost", SCIENTIFIC_LIMITS.maximumBudgetUsd);
    if (this.measured > this.limit) this.status = "exceeded";
  }
  snapshot(): MoneyBudgetEvidence { return deepFreeze({ limitUsd: this.limit, measuredUsd: this.measured, status: this.status, skippedCalls: this.skipped }); }
}

export async function runIndependentExperimentAudit(manifest: ExperimentAuditManifest, family: ExperimentAuditEvidenceFamily, judge: IndependentAuditJudge): Promise<IndependentExperimentAuditResult> {
  if (arguments.length !== 3) throw new TypeError("experiment audit runner accepts only its issued manifest, evidence family, and judge");
  const binding = experimentManifests.get(manifest);
  if (!binding || binding.family !== family || binding.manifestHash !== manifest.contentHash) throw new TypeError("experiment audit manifest and evidence family must be issued together");
  const config = experimentAuditJudgeConfig(binding.spec);
  if (config.configHash !== manifest.judgeConfigHash) throw new TypeError("experiment audit judge configuration changed");
  const ledger = new AuditLedger(binding.executionBatch.budgets.judgeBeforeAudit);
  const captured: { pair: ExperimentAuditPairManifest; rowId: string; outcome: Outcome; cost: number | null }[] = [];
  for (const pair of manifest.pairs) {
    const evidencePair = family.pairs.find((candidate) => candidate.candidateId === pair.candidateId && candidate.laneId === pair.laneId);
    if (!evidencePair) throw new TypeError("audit pair manifest is outside the evidence family");
    const byId = new Map(evidencePair.candidates.map((row) => [row.rowId, row]));
    for (const rowId of pair.selectedRowIds) {
      const row = byId.get(rowId);
      if (!row) throw new TypeError("audit selected row is outside the evidence pair");
      if (!ledger.allow()) { captured.push({ pair, rowId, outcome: "unknown", cost: 0 }); continue; }
      try {
        const result = validateAuditJudgeResult(await judge.judge({ rowId, candidateId: pair.candidateId, laneId: pair.laneId, reassessmentEvidence: row.reassessmentEvidence, config }), config);
        ledger.add(result.usage.costUsd);
        captured.push({ pair, rowId, outcome: result.outcome, cost: result.usage.costUsd });
      } catch {
        ledger.add(null);
        captured.push({ pair, rowId, outcome: "unknown", cost: null });
      }
    }
  }

  // This is the first read of primary labels in the audit run: all judge calls above have settled.
  const privateRows = binding.privateRows;
  const pairs = manifest.pairs.map((pair): ExperimentAuditPairResult => {
    const allPrimary = privateRows.filter((row) => row.candidateId === pair.candidateId && row.laneId === pair.laneId)
      .map((row) => ({ rowId: auditRowId(binding.spec, row.candidateId, row.laneId, row.itemId, row.repetition), primaryOutcome: row.primaryOutcome }))
      .sort((left, right) => compareText(left.rowId, right.rowId));
    const selectedRows = allPrimary.filter((row) => pair.selectedRowIds.includes(row.rowId)).map((row) => ({ ...row, reassessmentEvidence: null, evidenceHash: hashJson(null) }));
    const outcomes = Object.fromEntries(captured.filter((row) => row.pair === pair).map((row) => [row.rowId, row.outcome])) as Record<string, Outcome>;
    const measured = agreement(selectedRows, pair.selectedRowIds, outcomes);
    const primaryUniverseHash = hashJson(allPrimary);
    const postJudgmentOutcomeCommitment = hashJson({ primaryUniverseHash, outcomes });
    return deepFreeze({
      candidateId: pair.candidateId,
      laneId: pair.laneId,
      status: measured.coverage === 1 ? "measured" : "incomplete",
      agreement: measured,
      manifestHash: pair.contentHash,
      evidenceUniverseHash: pair.universeHash,
      selectedSampleHash: pair.selectedSampleHash,
      primaryUniverseHash,
      postJudgmentOutcomeCommitment,
    });
  });
  const auditCosts = captured.map((row) => row.cost);
  const result = deepFreeze({
    manifest,
    pairs,
    reportedCostUsd: auditCosts.some((value) => value === null) ? null : (auditCosts as number[]).reduce((sum, value) => sum + value, 0),
    budget: ledger.snapshot(),
    judgeConfig: config,
  });
  experimentResults.set(result, deepFreeze({ ...binding, resultHash: hashJson(result) }));
  return result;
}

export function assertIndependentAuditResultIssued(result: IndependentAuditResult | IndependentExperimentAuditResult): void {
  if (!issuedGenericAuditResults.has(result) && !experimentResults.has(result)) throw new TypeError("independent audit result must be issued by MemBench");
}

export function assertIndependentAuditResultForExperiment(result: IndependentExperimentAuditResult, spec: ExperimentSpec, comparisons: readonly CandidateComparison[]): void {
  const binding = experimentResults.get(result);
  if (!binding || binding.spec !== spec || binding.comparisons !== comparisons || binding.resultHash !== hashJson(result) ||
    result.pairs.length !== comparisons.length || result.manifest.sampleSizePerPair !== spec.audit.sampleSize) {
    throw new TypeError("independent audit result belongs to a different experiment");
  }
}
