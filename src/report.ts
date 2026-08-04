import { canonicalJson, compareText, deepFreeze, hashJson, sha256 } from "./canonical";
import {
  assertIndependentAuditResultForExperiment,
  experimentAuditJudgeConfig,
  type IndependentExperimentAuditResult,
} from "./audit";
import { createExperimentIdentity, type Decision, type Sha256 } from "./domain";
import {
  assertCandidateComparisonFamily,
  assertCandidateComparisonObserverBatch,
  candidateComparisonCalibrationCost,
  candidateComparisonEvidenceCommitment,
  candidateComparisonExecutionBatch,
  type BootstrapInterval,
  type CandidateComparison,
} from "./metrics";
import { executionBatchArtifacts, executionBatchObserver, type ExperimentBudgetEvidence, type LaneJudgeProvenance, type MoneyBudgetEvidence } from "./evidence";
import { assertExperimentSpecIdentity, type ExperimentSpec } from "./spec";

export type EvidenceStatus = "met" | "not_met" | "unknown";

export interface LaneAuditReport {
  readonly candidateId: string;
  readonly laneId: string;
  readonly status: "measured" | "incomplete" | "not_run";
  readonly declaredSampleSize: number;
  readonly selected: number | null;
  readonly judged: number | null;
  readonly coverage: number | null;
  readonly agreements: number | null;
  readonly agreementRate: number | null;
  readonly manifestHash: Sha256 | null;
  readonly evidenceUniverseHash: Sha256 | null;
  readonly selectedSampleHash: Sha256 | null;
  readonly primaryUniverseHash: Sha256 | null;
  readonly postJudgmentOutcomeCommitment: Sha256 | null;
}

export interface ReportDerivationInput {
  readonly spec: ExperimentSpec;
  readonly comparisons: readonly CandidateComparison[];
  readonly auditResult: IndependentExperimentAuditResult | null;
}

export interface CandidateLaneReport {
  readonly candidateId: string;
  readonly laneId: string;
  readonly decision: Decision;
  readonly decisionReasons: readonly string[];
  readonly calibration: {
    readonly k: 1;
    readonly eligibleItemCount: number;
    readonly excludedItemCount: number;
    readonly floorDidNotFail: number;
    readonly referenceDidNotPass: number;
    readonly unknown: number;
    readonly instability: number;
  };
  readonly instability: {
    readonly repetitions: number;
    readonly unknownOutcomeRate: number;
    readonly schemaFailureRate: number | null;
  };
  readonly taskSuccessRate: number | null;
  readonly attributedHitRate: number | null;
  readonly driftAvoidanceRate: number | null;
  readonly tokensToDone: number | null;
  readonly failures: CandidateComparison["candidateFailures"];
  readonly pairedFloorItemCount: number;
  readonly pairedShuffledItemCount: number;
  readonly pairedReferenceItemCount: number;
  readonly floorDelta: BootstrapInterval | null;
  readonly shuffledDelta: BootstrapInterval | null;
  readonly shuffledDeltaRole: "diagnostic_not_decision_bearing";
  readonly referenceGap: BootstrapInterval | null;
  readonly referenceGapRole: "descriptive_not_decision_bearing";
  readonly reportedCost: CandidateComparison["reportedCost"];
  readonly durationMs: number | null;
  readonly routeReported: boolean;
  readonly effectiveProvider: string | null;
  readonly effectiveModel: string | null;
  readonly judges: LaneJudgeProvenance;
  readonly audit: LaneAuditReport;
}

export interface MemBenchReport {
  readonly schemaVersion: 1;
  readonly observer: {
    readonly status: "active" | "failed";
    readonly evidenceMode: "background_observation";
    readonly recordCount: number;
    readonly persistedMemoryCount: number | null;
    readonly eventUniverseHash: Sha256;
    readonly promptUniverseHash: Sha256;
    readonly recordUniverseHash: Sha256;
    readonly memoryUniverseHash: Sha256;
    readonly requestedProvider: string;
    readonly requestedModel: string;
    readonly effectiveProvider: string | null;
    readonly effectiveModel: string | null;
    readonly routeReported: boolean;
    readonly budget: ExperimentBudgetEvidence["observer"];
  };
  readonly primary: { readonly candidateId: string; readonly laneId: string };
  readonly decision: Decision;
  readonly decisionReasons: readonly string[];
  readonly policy: {
    readonly minimumEffect: number;
    readonly minimumCalibratedItems: number;
    readonly maximumSchemaFailureRate: number;
    readonly maximumUnknownOutcomeRate: 0;
    readonly minimumAttributionRate: number;
    readonly minimumDriftAvoidanceRate: number;
    readonly minimumAuditAgreement: number;
    readonly nominalAlpha: number;
    readonly multiplicity: "bonferroni";
    readonly comparisonFamilySize: number;
    readonly bootstrapSamples: number;
  };
  readonly headline: {
    readonly taskSuccessRate: number | null;
    readonly floorDelta: BootstrapInterval | null;
    readonly shuffledDelta: BootstrapInterval | null;
    readonly referenceGap: BootstrapInterval | null;
    readonly attributedHitRate: number | null;
    readonly driftAvoidanceRate: number | null;
    readonly tokensToDone: number | null;
  };
  readonly assessment: {
    readonly requiredBehavior: { readonly status: EvidenceStatus; readonly interpretation: "task_relevant_memory_use_or_retrieval" };
    readonly avoidedBehavior: { readonly status: EvidenceStatus; readonly interpretation: "misleading_memory_drift_or_ungrounded_claims" };
    readonly outcomeMeasurement: {
      readonly status: EvidenceStatus;
      readonly source: "separate_primary_outcome_judge";
      readonly protocolHash: Sha256;
      readonly configHash: Sha256;
      readonly requestedProvider: string;
      readonly requestedModel: string;
      readonly effectiveProvider: string | null;
      readonly effectiveModel: string | null;
      readonly samplingHash: Sha256;
    };
  };
  readonly spend: {
    readonly status: "measured" | "unmeasured";
    readonly totalUsd: number | null;
    readonly components: {
      readonly attemptPipelineUsd: number | null;
      readonly executorUsd: number | null;
      readonly outcomeJudgeUsd: number | null;
      readonly attributionJudgeUsd: number | null;
      readonly driftJudgeUsd: number | null;
      readonly observerUsd: number | null;
      readonly auditUsd: number | null;
      readonly calibrationUsd: number | null;
    };
    readonly calibrationAccounting: "independent_k1_counted_once_excluded_scored_items_still_counted";
  };
  readonly budgets: {
    readonly observer: ExperimentBudgetEvidence["observer"];
    readonly executor: ExperimentBudgetEvidence["executor"];
    readonly judge: MoneyBudgetEvidence;
    readonly steps: ExperimentBudgetEvidence["steps"];
  };
  readonly lanes: readonly CandidateLaneReport[];
  readonly audit: {
    readonly method: "independent_reassessment";
    readonly limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals";
    readonly declaredSampleSizePerPair: number;
    readonly samplingPolicy: "uniform_without_replacement";
    readonly requiredCoverage: 1;
    readonly status: "measured" | "incomplete" | "not_run";
    readonly aggregateManifestHash: Sha256 | null;
    readonly judgeConfigHash: Sha256;
    readonly protocolHash: Sha256;
    readonly requestedProvider: string;
    readonly requestedModel: string;
    readonly samplingHash: Sha256;
    readonly pairs: readonly LaneAuditReport[];
  };
  readonly evidence: {
    readonly scheduleHash: Sha256;
    readonly manifestHash: Sha256;
    readonly inputUniverseHash: Sha256;
    readonly attemptUniverseHash: Sha256;
    readonly calibrationUniverseHash: Sha256;
    readonly executionResultUniverseHash: Sha256;
    readonly primaryReassessmentEvidenceUniverseHash: Sha256;
    readonly comparisonEvidenceUniverseHash: Sha256;
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
    readonly judgeProvenanceUniverseHash: Sha256;
  };
  readonly unmeasured: readonly ("total_experimental_spend" | "duration" | "provider_route" | "attribution" | "drift" | "tokens_to_done" | "outcome_measurement" | "audit_agreement")[];
  readonly identity: ReturnType<typeof createExperimentIdentity>;
  readonly runHash: Sha256;
  readonly glossaryVersion: "membench-report-v1";
}

const issuedReports = new WeakMap<object, Sha256>();

function exactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  canonicalJson(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  return source;
}

function status(value: number | null, minimum: number): EvidenceStatus {
  return value === null ? "unknown" : value >= minimum ? "met" : "not_met";
}

function assertIssuedComparisonInvariant(comparison: CandidateComparison, spec: ExperimentSpec): void {
  const policy = spec.decision;
  if (
    comparison.calibratedItemCount + comparison.calibrationExclusions.floorDidNotFail +
      comparison.calibrationExclusions.referenceDidNotPass + comparison.calibrationExclusions.unknown +
      comparison.calibrationExclusions.instability !==
      spec.experiment.itemIds.length
  ) throw new Error("issued comparison calibration accounting is inconsistent");
  if (
    comparison.pairedFloorItemCount > comparison.calibratedItemCount ||
    comparison.pairedShuffledItemCount > comparison.calibratedItemCount ||
    comparison.pairedReferenceItemCount > comparison.calibratedItemCount
  ) throw new Error("issued comparison paired counts exceed calibrated items");
  const countMatches = (value: BootstrapInterval | null, paired: number): boolean =>
    value === null ? paired === 0 : value.itemCount === paired;
  if (
    !countMatches(comparison.floorDelta, comparison.pairedFloorItemCount) ||
    !countMatches(comparison.shuffledDelta, comparison.pairedShuffledItemCount) ||
    !countMatches(comparison.referenceGap, comparison.pairedReferenceItemCount)
  ) throw new Error("issued comparison interval counts are inconsistent");
  for (const interval of [comparison.floorDelta, comparison.shuffledDelta, comparison.referenceGap]) {
    if (interval && (
      interval.nominalAlpha !== policy.alpha || interval.samples !== policy.bootstrapSamples ||
      interval.comparisonFamilySize !== spec.experiment.candidateModels.length * spec.experiment.executorLanes.length ||
      interval.adjustedAlpha !== policy.alpha / interval.comparisonFamilySize
    )) throw new Error("issued comparison interval policy is inconsistent");
  }
  if (comparison.decision === "recommend" && (
    comparison.candidateTaskSuccessRate === null ||
    comparison.candidateUnknownOutcomeRate > policy.maximumUnknownOutcomeRate || comparison.candidateSchemaFailureRate === null ||
    comparison.candidateSchemaFailureRate > policy.maximumSchemaFailureRate ||
    comparison.candidateAttributionRate === null || comparison.candidateAttributionRate < policy.minimumAttributionRate ||
    comparison.candidateDriftAvoidanceRate === null || comparison.candidateDriftAvoidanceRate < policy.minimumDriftAvoidanceRate ||
    comparison.calibratedItemCount < policy.minimumCalibratedItems || comparison.floorDelta === null ||
    comparison.floorDelta.lower < policy.minimumEffect ||
    comparison.effectiveProvider === null || comparison.effectiveModel === null
  )) throw new Error("issued favorable decision contradicts its scientific measurements");
}

function laneReport(
  comparison: CandidateComparison,
  spec: ExperimentSpec,
  observerActive: boolean,
): Omit<CandidateLaneReport, "judges" | "audit"> {
  assertIssuedComparisonInvariant(comparison, spec);
  const exclusions = comparison.calibrationExclusions;
  const routeReported = comparison.effectiveProvider !== null && comparison.effectiveModel !== null;
  if ((comparison.effectiveProvider === null) !== (comparison.effectiveModel === null)) {
    throw new Error("issued comparison effective route is partially measured");
  }
  return deepFreeze({
    candidateId: comparison.candidateId,
    laneId: comparison.laneId,
    decision: observerActive ? comparison.decision : "insufficient_evidence",
    decisionReasons: observerActive ? [...comparison.decisionReasons] : ["observer_not_active"],
    calibration: {
      k: 1,
      eligibleItemCount: comparison.calibratedItemCount,
      excludedItemCount: exclusions.floorDidNotFail + exclusions.referenceDidNotPass + exclusions.unknown + exclusions.instability,
      floorDidNotFail: exclusions.floorDidNotFail,
      referenceDidNotPass: exclusions.referenceDidNotPass,
      unknown: exclusions.unknown,
      instability: exclusions.instability,
    },
    instability: {
      repetitions: spec.experiment.repetitions,
      unknownOutcomeRate: comparison.candidateUnknownOutcomeRate,
      schemaFailureRate: comparison.candidateSchemaFailureRate,
    },
    taskSuccessRate: comparison.candidateTaskSuccessRate,
    attributedHitRate: comparison.candidateAttributionRate,
    driftAvoidanceRate: comparison.candidateDriftAvoidanceRate,
    tokensToDone: comparison.candidateTokensToDone,
    failures: comparison.candidateFailures,
    pairedFloorItemCount: comparison.pairedFloorItemCount,
    pairedShuffledItemCount: comparison.pairedShuffledItemCount,
    pairedReferenceItemCount: comparison.pairedReferenceItemCount,
    floorDelta: comparison.floorDelta,
    shuffledDelta: comparison.shuffledDelta,
    shuffledDeltaRole: comparison.shuffledDeltaRole,
    referenceGap: comparison.referenceGap,
    referenceGapRole: comparison.referenceGapRole,
    reportedCost: comparison.reportedCost,
    durationMs: comparison.durationMs,
    routeReported,
    effectiveProvider: routeReported ? comparison.effectiveProvider : null,
    effectiveModel: routeReported ? comparison.effectiveModel : null,
  });
}

function sumContagious(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  const total = (values as number[]).reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) throw new RangeError("report aggregate exceeds safe numeric bounds");
  return total;
}

export function createReport(input: ReportDerivationInput): MemBenchReport {
  const source = exactObject(input, ["spec", "comparisons", "auditResult"], "report derivation input");
  const spec = source.spec as ExperimentSpec;
  const comparisons = source.comparisons as readonly CandidateComparison[];
  assertExperimentSpecIdentity(spec);
  assertCandidateComparisonFamily(comparisons, spec);
  const executionBatch = candidateComparisonExecutionBatch(comparisons, spec);
  const observerBatch = executionBatchObserver(executionBatch, spec);
  const artifacts = executionBatchArtifacts(executionBatch, spec);
  assertCandidateComparisonObserverBatch(comparisons, spec, observerBatch);
  const auditResult = source.auditResult as IndependentExperimentAuditResult | null;
  if (auditResult !== null) assertIndependentAuditResultForExperiment(auditResult, spec, comparisons);

  const records = observerBatch.records;
  const observerFailed = records.some((record) => record.parseState !== "valid" || record.persistenceState !== "complete") ||
    observerBatch.budget.status !== "within" || !observerBatch.effectiveRoute.routeReported;
  const observerStatus: MemBenchReport["observer"]["status"] = observerFailed ? "failed" : "active";
  const observerActive = observerStatus === "active";
  const initialLanes = comparisons.map((comparison) => laneReport(comparison, spec, observerActive)).sort((left, right) =>
    compareText(`${left.candidateId}\0${left.laneId}`, `${right.candidateId}\0${right.laneId}`)
  );
  const attemptPipelineUsd = sumContagious(initialLanes.map((lane) => lane.reportedCost.allAttemptsUsd));
  const executorUsd = sumContagious(initialLanes.map((lane) => lane.reportedCost.executorUsd));
  const outcomeJudgeUsd = sumContagious(initialLanes.map((lane) => lane.reportedCost.outcomeJudgeUsd));
  const attributionJudgeUsd = sumContagious(initialLanes.map((lane) => lane.reportedCost.attributionJudgeUsd));
  const driftJudgeUsd = sumContagious(initialLanes.map((lane) => lane.reportedCost.driftJudgeUsd));
  const observerUsd = observerBatch.reportedCostUsd;
  const auditUsd = auditResult === null ? 0 : auditResult.reportedCostUsd;
  const calibrationUsd = candidateComparisonCalibrationCost(comparisons, spec);
  const totalUsd = sumContagious([attemptPipelineUsd, calibrationUsd, observerUsd, auditUsd]);
  const judgeBudget = auditResult?.budget ?? executionBatch.budgets.judgeBeforeAudit;
  const auditConfig = auditResult?.judgeConfig ?? experimentAuditJudgeConfig(spec);
  const auditPairs: readonly LaneAuditReport[] = initialLanes.map((lane) => {
    const pair = auditResult?.pairs.find((candidate) => candidate.candidateId === lane.candidateId && candidate.laneId === lane.laneId);
    return pair ? deepFreeze({
      candidateId: lane.candidateId,
      laneId: lane.laneId,
      status: pair.status,
      declaredSampleSize: spec.audit.sampleSize,
      selected: pair.agreement.selected,
      judged: pair.agreement.judged,
      coverage: pair.agreement.coverage,
      agreements: pair.agreement.agreements,
      agreementRate: pair.agreement.agreementRate,
      manifestHash: pair.manifestHash,
      evidenceUniverseHash: pair.evidenceUniverseHash,
      selectedSampleHash: pair.selectedSampleHash,
      primaryUniverseHash: pair.primaryUniverseHash,
      postJudgmentOutcomeCommitment: pair.postJudgmentOutcomeCommitment,
    }) : deepFreeze({
      candidateId: lane.candidateId,
      laneId: lane.laneId,
      status: "not_run" as const,
      declaredSampleSize: spec.audit.sampleSize,
      selected: null,
      judged: null,
      coverage: null,
      agreements: null,
      agreementRate: null,
      manifestHash: null,
      evidenceUniverseHash: null,
      selectedSampleHash: null,
      primaryUniverseHash: null,
      postJudgmentOutcomeCommitment: null,
    });
  });
  const lanes = initialLanes.map((lane): CandidateLaneReport => {
    const audit = auditPairs.find((candidate) => candidate.candidateId === lane.candidateId && candidate.laneId === lane.laneId) as LaneAuditReport;
    const judges = executionBatch.judgeProvenance.find((candidate) => candidate.candidateId === lane.candidateId && candidate.laneId === lane.laneId);
    if (!judges) throw new Error("lane judge provenance is absent");
    let decision = lane.decision;
    const reasons = [...lane.decisionReasons];
    const insufficient = (reason: string): void => {
      decision = "insufficient_evidence";
      if (!reasons.includes(reason)) reasons.push(reason);
    };
    if (executionBatch.budgets.observer.status !== "within") insufficient(`observer_budget_${executionBatch.budgets.observer.status}`);
    if (executionBatch.budgets.executor.status !== "within") insufficient(`executor_budget_${executionBatch.budgets.executor.status}`);
    if (judgeBudget.status !== "within") insufficient(`judge_budget_${judgeBudget.status}`);
    if (executionBatch.budgets.steps.status !== "within") insufficient(`step_budget_${executionBatch.budgets.steps.status}`);
    if (audit.status === "not_run") insufficient("independent_reassessment_not_run");
    else if (audit.coverage !== 1 || audit.judged !== audit.selected || audit.agreementRate === null) insufficient("independent_reassessment_coverage_incomplete");
    else if (decision !== "insufficient_evidence" && audit.agreementRate < spec.decision.minimumAuditAgreement) {
      decision = "do_not_recommend";
      if (!reasons.includes("minimum_independent_reassessment_agreement_not_met")) reasons.push("minimum_independent_reassessment_agreement_not_met");
    }
    return deepFreeze({ ...lane, decision, decisionReasons: reasons, judges, audit });
  });
  const primary = lanes.find((row) => row.candidateId === spec.experiment.primaryCandidate && row.laneId === spec.experiment.primaryLane) as CandidateLaneReport;
  if (!primary) throw new Error("prespecified primary comparison is absent from the issued family");
  const finalDecision = primary.decision;
  const finalReasons = primary.decisionReasons;
  const unmeasured: MemBenchReport["unmeasured"][number][] = [];
  if (totalUsd === null) unmeasured.push("total_experimental_spend");
  if (primary.durationMs === null) unmeasured.push("duration");
  if (!primary.routeReported) unmeasured.push("provider_route");
  if (primary.attributedHitRate === null) unmeasured.push("attribution");
  if (primary.driftAvoidanceRate === null) unmeasured.push("drift");
  if (primary.tokensToDone === null) unmeasured.push("tokens_to_done");
  if (primary.taskSuccessRate === null || primary.instability.unknownOutcomeRate > spec.decision.maximumUnknownOutcomeRate) unmeasured.push("outcome_measurement");
  if (primary.audit.coverage !== 1 || primary.audit.agreementRate === null) unmeasured.push("audit_agreement");

  const identity = createExperimentIdentity({
    corpusHash: artifacts.corpusHash,
    promptHash: artifacts.promptHash,
    routeHash: hashJson(spec.routes),
    harnessHash: artifacts.harnessHash,
    configHash: spec.identityHash,
    judgeHash: artifacts.judgeHash,
  });
  const report = deepFreeze({
    schemaVersion: 1 as const,
    observer: {
      status: observerStatus,
      evidenceMode: "background_observation" as const,
      recordCount: records.length,
      persistedMemoryCount: records.reduce((sum, record) => sum + record.persisted, 0),
      eventUniverseHash: observerBatch.eventUniverseHash,
      promptUniverseHash: observerBatch.promptUniverseHash,
      recordUniverseHash: hashJson(observerBatch.records),
      memoryUniverseHash: observerBatch.memoryUniverseHash,
      requestedProvider: observerBatch.requestedRoute.provider,
      requestedModel: observerBatch.requestedRoute.model,
      effectiveProvider: observerBatch.effectiveRoute.provider,
      effectiveModel: observerBatch.effectiveRoute.model,
      routeReported: observerBatch.effectiveRoute.routeReported,
      budget: observerBatch.budget,
    },
    primary: { candidateId: primary.candidateId, laneId: primary.laneId },
    decision: finalDecision,
    decisionReasons: finalReasons,
    policy: {
      minimumEffect: spec.decision.minimumEffect,
      minimumCalibratedItems: spec.decision.minimumCalibratedItems,
      maximumSchemaFailureRate: spec.decision.maximumSchemaFailureRate,
      maximumUnknownOutcomeRate: spec.decision.maximumUnknownOutcomeRate,
      minimumAttributionRate: spec.decision.minimumAttributionRate,
      minimumDriftAvoidanceRate: spec.decision.minimumDriftAvoidanceRate,
      minimumAuditAgreement: spec.decision.minimumAuditAgreement,
      nominalAlpha: spec.decision.alpha,
      multiplicity: spec.decision.multiplicity,
      comparisonFamilySize: lanes.length,
      bootstrapSamples: spec.decision.bootstrapSamples,
    },
    headline: {
      taskSuccessRate: primary.taskSuccessRate,
      floorDelta: primary.floorDelta,
      shuffledDelta: primary.shuffledDelta,
      referenceGap: primary.referenceGap,
      attributedHitRate: primary.attributedHitRate,
      driftAvoidanceRate: primary.driftAvoidanceRate,
      tokensToDone: primary.tokensToDone,
    },
    assessment: {
      requiredBehavior: { status: status(primary.attributedHitRate, spec.decision.minimumAttributionRate), interpretation: "task_relevant_memory_use_or_retrieval" as const },
      avoidedBehavior: { status: status(primary.driftAvoidanceRate, spec.decision.minimumDriftAvoidanceRate), interpretation: "misleading_memory_drift_or_ungrounded_claims" as const },
      outcomeMeasurement: {
        status: primary.taskSuccessRate === null || primary.instability.unknownOutcomeRate > spec.decision.maximumUnknownOutcomeRate
          ? "unknown" as const
          : "met" as const,
        source: "separate_primary_outcome_judge" as const,
        protocolHash: primary.judges.outcome.protocolHash,
        configHash: primary.judges.outcome.configHash,
        requestedProvider: primary.judges.outcome.route.provider,
        requestedModel: primary.judges.outcome.route.model,
        effectiveProvider: primary.judges.outcome.effectiveProvider,
        effectiveModel: primary.judges.outcome.effectiveModel,
        samplingHash: hashJson(primary.judges.outcome.sampling),
      },
    },
    spend: {
      status: totalUsd === null ? "unmeasured" as const : "measured" as const,
      totalUsd,
      components: { attemptPipelineUsd, executorUsd, outcomeJudgeUsd, attributionJudgeUsd, driftJudgeUsd, observerUsd, auditUsd, calibrationUsd },
      calibrationAccounting: "independent_k1_counted_once_excluded_scored_items_still_counted" as const,
    },
    budgets: {
      observer: executionBatch.budgets.observer,
      executor: executionBatch.budgets.executor,
      judge: judgeBudget,
      steps: executionBatch.budgets.steps,
    },
    lanes,
    audit: {
      method: "independent_reassessment" as const,
      limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals" as const,
      declaredSampleSizePerPair: spec.audit.sampleSize,
      samplingPolicy: spec.audit.policy,
      requiredCoverage: 1 as const,
      status: auditResult === null ? "not_run" as const : auditPairs.every((pair) => pair.status === "measured") ? "measured" as const : "incomplete" as const,
      aggregateManifestHash: auditResult?.manifest.contentHash ?? null,
      judgeConfigHash: auditConfig.configHash,
      protocolHash: auditConfig.protocolHash,
      requestedProvider: auditConfig.route.provider,
      requestedModel: auditConfig.route.model,
      samplingHash: auditConfig.samplingHash,
      pairs: auditPairs,
    },
    evidence: {
      scheduleHash: executionBatch.scheduleHash,
      manifestHash: executionBatch.manifestHash,
      inputUniverseHash: executionBatch.inputUniverseHash,
      attemptUniverseHash: executionBatch.attemptUniverseHash,
      calibrationUniverseHash: executionBatch.calibrationUniverseHash,
      executionResultUniverseHash: executionBatch.executionResultUniverseHash,
      primaryReassessmentEvidenceUniverseHash: executionBatch.primaryReassessmentEvidenceUniverseHash,
      comparisonEvidenceUniverseHash: candidateComparisonEvidenceCommitment(comparisons, spec),
      observerEventUniverseHash: executionBatch.observerEventUniverseHash,
      observerMemoryUniverseHash: executionBatch.observerMemoryUniverseHash,
      artifactUniverseHash: executionBatch.artifactUniverseHash,
      corpusArtifactHash: executionBatch.corpusArtifactHash,
      promptArtifactHash: executionBatch.promptArtifactHash,
      harnessArtifactHash: executionBatch.harnessArtifactHash,
      judgeArtifactHash: executionBatch.judgeArtifactHash,
      routeSamplingArtifactHash: executionBatch.routeSamplingArtifactHash,
      referenceSourceUniverseHash: executionBatch.referenceSourceUniverseHash,
      referenceControlUniverseHash: executionBatch.referenceControlUniverseHash,
      judgeProvenanceUniverseHash: executionBatch.judgeProvenanceUniverseHash,
    },
    unmeasured,
    identity,
    runHash: executionBatch.runHash,
    glossaryVersion: "membench-report-v1" as const,
  });
  issuedReports.set(report, hashJson(report));
  return report;
}

export function assertMemBenchReportIssued(report: MemBenchReport): void {
  const commitment = issuedReports.get(report);
  if (!commitment || commitment !== hashJson(report) || !Object.isFrozen(report)) {
    throw new TypeError("report must be derived and issued by MemBench");
  }
}

function percent(value: number | null): string { return value === null ? "unknown / unmeasured" : `${(value * 100).toFixed(1)}%`; }
function money(value: number | null): string { return value === null ? "unmeasured" : `$${value.toFixed(6)} reported`; }
function interval(value: BootstrapInterval | null): string {
  return value === null ? "unknown" : [
    `${value.estimate.toFixed(3)} [${value.lower.toFixed(3)}, ${value.upper.toFixed(3)}]`,
    `items=${value.itemCount}`, `nominal alpha=${value.nominalAlpha}`, `adjusted alpha=${value.adjustedAlpha}`,
    `family=${value.comparisonFamilySize}`, `bootstrap samples=${value.samples}`, `sample hash=${value.sampleHash}`,
  ].join("; ");
}
function markdownCell(value: unknown): string {
  return String(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

export function reportMarkdown(report: MemBenchReport): string {
  assertMemBenchReportIssued(report);
  const identityLines = ["corpusHash", "promptHash", "routeHash", "harnessHash", "configHash", "judgeHash", "combinedHash"]
    .map((key) => `- ${key}: ${report.identity[key as keyof typeof report.identity]}`);
  const lines = [
    "# MemBench aggregate report", "",
    `Observer: **${report.observer.status}** (background evidence; not the evaluator); records=${report.observer.recordCount}; persisted=${report.observer.persistedMemoryCount ?? "unmeasured"}`,
    `Observer route: requested=${report.observer.requestedProvider}/${report.observer.requestedModel}; effective=${report.observer.routeReported ? `${report.observer.effectiveProvider}/${report.observer.effectiveModel}` : "unmeasured"}.`,
    `Decision: **${report.decision}** — ${report.decisionReasons.join(", ")}`,
    `Primary comparison: **${report.primary.candidateId} / ${report.primary.laneId}**`,
    `Task success: **${percent(report.headline.taskSuccessRate)}**`,
    `Floor delta: **${interval(report.headline.floorDelta)}**`,
    `Shuffled delta: **${interval(report.headline.shuffledDelta)}** (diagnostic; not decision-bearing)`,
    `Reference gap: **${interval(report.headline.referenceGap)}** (descriptive; not decision-bearing)`,
    `Attributed hits: **${percent(report.headline.attributedHitRate)}**`,
    `Drift avoided: **${percent(report.headline.driftAvoidanceRate)}**`,
    `Tokens to done: **${report.headline.tokensToDone ?? "unmeasured"}**`,
    `Total measured experimental spend: **${money(report.spend.totalUsd)}**`,
    `Spend components: attempt pipeline=${money(report.spend.components.attemptPipelineUsd)}; executor=${money(report.spend.components.executorUsd)}; outcome judge=${money(report.spend.components.outcomeJudgeUsd)}; attribution judge=${money(report.spend.components.attributionJudgeUsd)}; drift judge=${money(report.spend.components.driftJudgeUsd)}; observer=${money(report.spend.components.observerUsd)}; audit=${money(report.spend.components.auditUsd)}; calibration=${money(report.spend.components.calibrationUsd)} (${report.spend.calibrationAccounting}).`, "",
    "Rate scope: success, attribution, drift, and unknown rates are calculated separately for each candidate × executor lane over that lane's calibrated/scored attempts. Cost scope: executor and primary-judge spend cover calibration plus scheduled attempts; observer spend covers background observation; audit spend covers independent reassessment; each measured call is counted once.", "",
    `Budget evidence: observer=${report.budgets.observer.status} (${money(report.budgets.observer.measuredUsd)} / ${money(report.budgets.observer.limitUsd)} limit); executor=${report.budgets.executor.status} (${money(report.budgets.executor.measuredUsd)} / ${money(report.budgets.executor.limitUsd)} limit); judge including audit=${report.budgets.judge.status} (${money(report.budgets.judge.measuredUsd)} / ${money(report.budgets.judge.limitUsd)} limit); steps=${report.budgets.steps.status} (${report.budgets.steps.measured}/${report.budgets.steps.limit}).`, "",
    "## Required, avoided, and outcome measurement", "",
    `- Required behavior — task-relevant memory use or retrieval: ${report.assessment.requiredBehavior.status}`,
    `- Avoided behavior — misleading memory, drift, or ungrounded claims: ${report.assessment.avoidedBehavior.status}`,
    `- Outcome measurement — ${report.assessment.outcomeMeasurement.source}: ${report.assessment.outcomeMeasurement.status}`, "",
    "## Prespecified policy", "",
    `Minimum effect=${report.policy.minimumEffect}; minimum calibrated items=${report.policy.minimumCalibratedItems}; maximum unknown outcome=${report.policy.maximumUnknownOutcomeRate}; maximum schema failure=${report.policy.maximumSchemaFailureRate}; minimum attribution=${report.policy.minimumAttributionRate}; minimum drift avoidance=${report.policy.minimumDriftAvoidanceRate}; minimum independent reassessment agreement=${report.policy.minimumAuditAgreement}; nominal alpha=${report.policy.nominalAlpha}; multiplicity=${report.policy.multiplicity}; family=${report.policy.comparisonFamilySize}; bootstrap samples=${report.policy.bootstrapSamples}.`, "",
    "## Candidate × executor-lane family", "",
    "| Candidate | Lane | Decision | Success | Attribution | Drift avoided | Tokens | Eligible/excluded | Unknown/schema | Paired floor/shuffled/reference | Candidate/control/all spend | Duration | Effective route |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...report.lanes.map((row) => {
      const cells = [
        row.candidateId, row.laneId, `${row.decision} (${row.decisionReasons.join(", ")})`, percent(row.taskSuccessRate),
        percent(row.attributedHitRate), percent(row.driftAvoidanceRate), row.tokensToDone ?? "unmeasured",
        `${row.calibration.eligibleItemCount}/${row.calibration.excludedItemCount}`,
        `${percent(row.instability.unknownOutcomeRate)}/${percent(row.instability.schemaFailureRate)}`,
        `${row.pairedFloorItemCount}/${row.pairedShuffledItemCount}/${row.pairedReferenceItemCount}`,
        `${money(row.reportedCost.candidateArmUsd)}/${money(row.reportedCost.controlArmsUsd)}/${money(row.reportedCost.allAttemptsUsd)}`,
        row.durationMs === null ? "unmeasured" : `${row.durationMs.toFixed(0)} ms`,
        row.routeReported ? `${row.effectiveProvider} / ${row.effectiveModel}` : "unmeasured",
      ].map(markdownCell);
      return `| ${cells.join(" | ")} |`;
    }), "",
    "## Per-pair intervals, calibration, and categorized failures", "",
    ...report.lanes.flatMap((row) => [
      `### ${row.candidateId} / ${row.laneId}`, "",
      `Calibration k=1; eligible=${row.calibration.eligibleItemCount}; floor_did_not_fail=${row.calibration.floorDidNotFail}; reference_did_not_pass=${row.calibration.referenceDidNotPass}; unknown=${row.calibration.unknown}; calibration_instability=${row.calibration.instability}.`,
      `Instability repetitions=${row.instability.repetitions}; unknown=${percent(row.instability.unknownOutcomeRate)}; schema failure=${percent(row.instability.schemaFailureRate)}.`,
      `Failures (nonexclusive): task=${row.failures.taskFailure}; schema=${row.failures.schemaFailure}; attribution=${row.failures.attributionFailure}; drift=${row.failures.driftFailure}; unknown outcome=${row.failures.unknownOutcome}; unknown attribution=${row.failures.unknownAttribution}; unknown drift=${row.failures.unknownDrift}.`,
      `Floor (${row.pairedFloorItemCount} paired): ${interval(row.floorDelta)}.`,
      `Shuffled diagnostic (${row.pairedShuffledItemCount} paired): ${interval(row.shuffledDelta)}.`,
      `Reference descriptive (${row.pairedReferenceItemCount} paired): ${interval(row.referenceGap)}.`,
      `Primary judges: outcome protocol=${row.judges.outcome.protocolHash}, config=${row.judges.outcome.configHash}, requested=${row.judges.outcome.route.provider}/${row.judges.outcome.route.model}, effective=${row.judges.outcome.effectiveProvider ?? "unmeasured"}/${row.judges.outcome.effectiveModel ?? "unmeasured"}; attribution protocol=${row.judges.attribution.protocolHash}, config=${row.judges.attribution.configHash}; drift protocol=${row.judges.drift.protocolHash}, config=${row.judges.drift.configHash}.`,
      `Independent reassessment: ${row.audit.status}; declared=${row.audit.declaredSampleSize}; selected=${row.audit.selected ?? "unmeasured"}; judged=${row.audit.judged ?? "unmeasured"}; coverage=${percent(row.audit.coverage)}; agreements=${row.audit.agreements ?? "unmeasured"}; agreement=${percent(row.audit.agreementRate)}; manifest=${row.audit.manifestHash ?? "not_run"}; evidence universe=${row.audit.evidenceUniverseHash ?? "not_run"}; selected sample=${row.audit.selectedSampleHash ?? "not_run"}; primary universe=${row.audit.primaryUniverseHash ?? "not_run"}; post-judgment outcome commitment=${row.audit.postJudgmentOutcomeCommitment ?? "not_run"}.`, "",
    ]),
    `Independent reassessment audit: ${report.audit.status}; declared size per candidate × lane=${report.audit.declaredSampleSizePerPair}; required coverage=${percent(report.audit.requiredCoverage)}; policy=${report.audit.samplingPolicy}; aggregate pre-judgment manifest=${report.audit.aggregateManifestHash ?? "not_run"}.`,
    `Audit judge: protocol=${report.audit.protocolHash}; config=${report.audit.judgeConfigHash}; requested=${report.audit.requestedProvider}/${report.audit.requestedModel}; sampling=${report.audit.samplingHash}. Limitation=${report.audit.limitation}.`, "",
    `Observer event universe: ${report.observer.eventUniverseHash ?? "not_run"}; prompt universe: ${report.observer.promptUniverseHash ?? "not_run"}; record universe: ${report.observer.recordUniverseHash ?? "not_run"}; memory universe: ${report.observer.memoryUniverseHash ?? "not_run"}.`,
    `Issued evidence commitments: schedule=${report.evidence.scheduleHash}; manifest=${report.evidence.manifestHash}; inputs=${report.evidence.inputUniverseHash}; attempts=${report.evidence.attemptUniverseHash}; calibration=${report.evidence.calibrationUniverseHash}; execution results=${report.evidence.executionResultUniverseHash}; primary reassessment evidence=${report.evidence.primaryReassessmentEvidenceUniverseHash}; comparisons=${report.evidence.comparisonEvidenceUniverseHash}.`,
    `Resolved artifact commitments: artifacts=${report.evidence.artifactUniverseHash}; corpus=${report.evidence.corpusArtifactHash}; prompts=${report.evidence.promptArtifactHash}; harness=${report.evidence.harnessArtifactHash}; judges=${report.evidence.judgeArtifactHash}; routes and sampling=${report.evidence.routeSamplingArtifactHash}; reference sources=${report.evidence.referenceSourceUniverseHash}; reference controls=${report.evidence.referenceControlUniverseHash}; judge provenance=${report.evidence.judgeProvenanceUniverseHash}; run manifest=${report.runHash}.`,
    `Unmeasured fields: ${report.unmeasured.length === 0 ? "none" : report.unmeasured.join(", ")}.`, "",
    "## Identity and glossary", "", ...identityLines, `- runHash: ${report.runHash}`,
    `- glossary: ${report.glossaryVersion}; candidate is compared with none and shuffled floors; shuffled is diagnostic; reference is descriptive; unknown is not failure.`, "",
  ];
  return `${lines.join("\n")}\n`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
export function reportJunit(report: MemBenchReport): string {
  assertMemBenchReportIssued(report);
  const failures = report.lanes.filter((lane) => lane.decision === "do_not_recommend").length;
  const skipped = report.lanes.filter((lane) => lane.decision === "insufficient_evidence").length;
  const cases = report.lanes.map((lane) => {
    const child = lane.decision === "do_not_recommend"
      ? `<failure message="do_not_recommend">${xml(lane.decisionReasons.join(","))}</failure>`
      : lane.decision === "insufficient_evidence"
        ? `<skipped message="insufficient_evidence">${xml(lane.decisionReasons.join(","))}</skipped>`
        : "";
    return `<testcase classname="membench.${xml(lane.candidateId)}" name="${xml(lane.laneId)}">${child}</testcase>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="MemBench" tests="${report.lanes.length}" failures="${failures}" skipped="${skipped}">${cases}</testsuite>\n`;
}
export function reportJson(report: MemBenchReport): string { assertMemBenchReportIssued(report); return `${canonicalJson(report)}\n`; }
export function reportContentHashes(report: MemBenchReport): Readonly<Record<"json" | "markdown" | "junit", Sha256>> {
  return deepFreeze({ json: sha256(reportJson(report)), markdown: sha256(reportMarkdown(report)), junit: sha256(reportJunit(report)) });
}
