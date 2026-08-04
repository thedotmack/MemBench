import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";

import {
  InMemoryBackend,
  assertReleaseSafeAggregate,
  bindCalibrationReference,
  compileReferenceControl,
  compareModelFamily,
  corpusContentHash,
  createAuditJudgeConfig,
  createReport,
  deriveExperimentArtifactCommitments,
  experimentAuditJudgeConfig,
  generatePublicBundle,
  hashJson,
  issueExperimentAuditEvidenceFamily,
  issueExperimentArtifacts,
  laneId,
  observeExperimentInBackground,
  parseExperimentSpec,
  predeclareExperimentAuditSample,
  predeclareAuditSample,
  reportJson,
  reportJunit,
  reportMarkdown,
  runExperimentEvidence,
  runIndependentAudit,
  runIndependentExperimentAudit,
  sha256,
  validateCorpusItem,
  writePublicBundle,
  type CandidateComparison,
  type ExperimentAttemptInput,
  type ExperimentAttemptResult,
  type ExperimentArtifacts,
  type ExperimentExecutionBatch,
  type IndependentAuditJudgeResult,
  type AuditJudgeConfig,
  type PrimaryJudgeInput,
  type PrimaryJudgeResult,
  type ExperimentSpec,
  type ModelTransport,
  type ObservationBatch,
  type ReportDerivationInput,
} from "../src";
import { writePublicBundleForTest } from "../src/public-bundle";
import { cleanupRegisteredTempRoot, registeredMkdtemp } from "./temp-registry";

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await cleanupRegisteredTempRoot(roots.pop() as string); });

type Mode = "recommend" | "negative" | "unknown" | "schema_failure" | "attribution_failure" | "drift_failure" | "unknown_attribution" | "unknown_drift" | "missing_cost";
const items = ["item-a", "item-b", "item-c"];
function eventBatchesFor(itemUniverse: readonly string[]) { return itemUniverse.map((itemId) => ({
  itemId,
  events: [{ eventIndex: 0, kind: "message" as const, role: "user" as const, text: `Use synthetic mode for ${itemId}.` }],
})); }
const observerEvents = eventBatchesFor(items);
const artifactCreatedAt = "2026-01-03T00:00:00.000Z";
const artifactsBySpec = new WeakMap<ExperimentSpec, ExperimentArtifacts>();
const corpusBySpec = new WeakMap<ExperimentSpec, readonly ReturnType<typeof corpusItem>[]>();
interface ExpectedCommitments {
  readonly corpusHash: string; readonly promptHash: string; readonly harnessHash: string;
  readonly judgeHash: string; readonly observerEventUniverseHash: string; readonly referenceControlUniverseHash: string; readonly runHash: string;
}

function specFor(
  corpusRoot: string,
  candidates = ["candidate-a"],
  lanes = ["lane-a"],
  itemUniverse: readonly string[] = items,
  mutateExpected: (commitments: ExpectedCommitments) => ExpectedCommitments = (commitments) => commitments,
): ExperimentSpec {
  const source = (commitments: ExpectedCommitments) => `
version = 1
[experiment]
id = "phase4-study"
repetitions = 3
candidate_models = ${JSON.stringify(candidates)}
executor_lanes = ${JSON.stringify(lanes)}
primary_candidate = "${candidates[0]}"
primary_lane = "${lanes[0]}"
item_ids = ${JSON.stringify(itemUniverse)}
corpus_path = "${corpusRoot}"
[routes.observer]
provider = "synthetic-provider"
model = "synthetic-observer"
allow_fallbacks = false
[routes.executor]
provider = "synthetic-provider"
model = "synthetic-executor"
allow_fallbacks = false
[routes.reference]
provider = "synthetic-provider"
model = "synthetic-reference"
allow_fallbacks = false
[routes.judge]
provider = "synthetic-provider"
model = "synthetic-judge"
allow_fallbacks = false
[seeds]
schedule = "schedule-seed"
bootstrap = "bootstrap-seed"
audit = "audit-seed"
[audit]
sample_size = 2
policy = "uniform_without_replacement"
[observer_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "observer-seed"
[executor_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "sampling-seed"
[decision]
alpha = 0.05
minimum_effect = 0.1
maximum_schema_failure_rate = 0.05
maximum_unknown_outcome_rate = 0.0
minimum_calibrated_items = 3
minimum_attribution_rate = 0.75
minimum_drift_avoidance_rate = 0.75
minimum_audit_agreement = 0.8
bootstrap_samples = 500
multiplicity = "bonferroni"
[commitments]
corpus_hash = "${commitments.corpusHash}"
prompt_hash = "${commitments.promptHash}"
harness_hash = "${commitments.harnessHash}"
judge_hash = "${commitments.judgeHash}"
observer_event_universe_hash = "${commitments.observerEventUniverseHash}"
reference_control_universe_hash = "${commitments.referenceControlUniverseHash}"
run_hash = "${commitments.runHash}"
[budgets]
observer_usd = 1.0
executor_usd = 1.0
judge_usd = 1.0
maximum_steps = 1000
`;
  const unset = sha256("unverified-placeholder");
  const preliminary = parseExperimentSpec(source({
    corpusHash: unset, promptHash: unset, harnessHash: unset, judgeHash: unset,
    observerEventUniverseHash: unset, referenceControlUniverseHash: unset, runHash: unset,
  }), { repositoryRoot: process.cwd() });
  const corpus = itemUniverse.map((itemId) => corpusItem(itemId));
  const references = referencesFor(preliminary, corpus);
  const commitments = deriveExperimentArtifactCommitments({
    spec: preliminary, corpusItems: corpus, references, createdAt: artifactCreatedAt,
  });
  const spec = parseExperimentSpec(source(mutateExpected(commitments)), { repositoryRoot: process.cwd() });
  const artifacts = issueExperimentArtifacts({ spec, corpusItems: corpus, references, createdAt: artifactCreatedAt });
  artifactsBySpec.set(spec, artifacts);
  corpusBySpec.set(spec, corpus);
  return spec;
}

function referencesFor(spec: ExperimentSpec, corpus: readonly ReturnType<typeof corpusItem>[]) {
  return spec.experiment.itemIds.flatMap((itemId) => {
    const item = corpus.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error("fixture artifact corpus is missing");
    const event = item.events[0];
    const text = event?.kind === "message" ? event.text : "";
    const control = compileReferenceControl(item, [{ text, eventIndex: 0, supportingQuote: text }]).control;
    return spec.experiment.executorLanes.map((lane) => bindCalibrationReference({ item, laneId: laneId(lane), control }));
  });
}

function corpusItem(itemId: string, text = `Use synthetic mode for ${itemId}.`) {
  const base = {
    schemaVersion: 1 as const,
    id: itemId,
    task: `Set synthetic mode for ${itemId}.`,
    mechanicalCheck: { kind: "command" as const, argv: ["synthetic-check"], expectedExitCode: 0 },
    blindSuccessRubric: "The synthetic configuration is correct.",
    events: [{ eventIndex: 0, kind: "message" as const, role: "user" as const, text }],
    startingTree: { "config.txt": "mode=unset\n" },
  };
  const contentHash = corpusContentHash(base);
  return validateCorpusItem({
    ...base,
    provenance: {
      schemaVersion: 1, corpusId: `corpus-${itemId}`, corpusVersion: "1.0.0", classification: "synthetic" as const,
      createdAt: "2026-01-01T00:00:00.000Z", origin: { method: "newly_authored_synthetic" as const, description: "Authored synthetic evaluation fixture." },
      license: "MIT", authority: { basis: "author" as const, recordReference: "repository review record" }, contentHash,
    },
    releaseAttestation: {
      schemaVersion: 1, corpusId: `corpus-${itemId}`, corpusVersion: "1.0.0", reviewedAt: "2026-01-02T00:00:00.000Z",
      reviewerRole: "maintainer", reviewRecordReference: "synthetic fixture review", decision: "approved" as const,
      checks: { authorityVerified: true, consentVerified: true, licenseVerified: true, independentReviewComplete: true, sensitiveDataReviewComplete: true, secretScanComplete: true },
      contentHash,
    },
    contentHash,
  });
}

function boundReferences(spec: ExperimentSpec) {
  const corpus = corpusBySpec.get(spec);
  if (!corpus) throw new Error("fixture artifact corpus is missing");
  return referencesFor(spec, corpus);
}

function attemptResult(spec: ExperimentSpec, mode: Mode, input: ExperimentAttemptInput): ExperimentAttemptResult {
  void input;
  return {
    executionArtifacts: {
      executorResponse: {
        schemaVersion: 1,
        completed: true,
        responseText: "Synthetic executor response artifact.",
        diffSummary: "Synthetic configuration changed.",
        downstreamEvidence: ["Synthetic check evidence."],
      },
      toolTrace: [{ sequence: 0, tool: "synthetic-check", state: "completed", summary: "Synthetic check completed." }],
    },
    reportedCostUsd: mode === "missing_cost" && input.entry.itemId === "item-a" && input.entry.arm === "none" && input.entry.repetition === 0 ? null : 0.004,
    durationMs: 5,
    route: { requested: spec.routes.executor, effective: { provider: spec.routes.executor.provider, model: spec.routes.executor.model, routeReported: true } },
    generationId: null,
    tokenCount: 10,
    steps: 1,
    modelCalls: 1,
  };
}

function primaryJudgeResult(spec: ExperimentSpec, mode: Mode, input: PrimaryJudgeInput): PrimaryJudgeResult {
  void spec;
  const { entry } = input;
  const outcome = input.purpose === "outcome" ? (entry.arm === "reference" ? "pass"
    : entry.arm !== "candidate" ? "fail"
      : mode === "recommend" || mode === "schema_failure" || mode === "attribution_failure" || mode === "missing_cost" ||
          mode === "drift_failure" || mode === "unknown_attribution" || mode === "unknown_drift" ? "pass"
        : mode === "negative" ? "fail" : "unknown")
    : input.purpose === "attribution" ? (
      mode === "unknown" || mode === "unknown_attribution" ? "unknown"
        : mode === "attribution_failure" ? "fail" : "pass")
      : (
        mode === "unknown_drift" ? "unknown"
          : mode === "drift_failure" ? "fail" : "pass");
  const attributedInputCommitment = input.purpose === "attribution" && outcome === "pass" ? input.inputCommitment : null;
  return {
    purpose: input.purpose,
    outcome,
    schemaValid: !(mode === "schema_failure" && entry.arm === "candidate" && input.purpose === "outcome"),
    attributedInputCommitment,
    route: { requested: input.config.route, effective: { provider: input.config.route.provider, model: input.config.route.model, routeReported: true } },
    generationId: null,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      costUsd: input.purpose === "outcome" ? 0.002 : entry.arm === "candidate" ? 0.002 : 0,
    },
    durationMs: 1,
    protocolHash: input.config.protocolHash,
    configHash: input.config.configHash,
  };
}

function auditJudgeResult(config: AuditJudgeConfig, outcome: "pass" | "fail" | "unknown", costUsd = 0): IndependentAuditJudgeResult {
  return {
    outcome,
    route: { requested: config.route, effective: { provider: config.route.provider, model: config.route.model, routeReported: true } },
    generationId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd },
    durationMs: 1,
    protocolHash: config.protocolHash,
    configHash: config.configHash,
  };
}

async function executionBatch(
  spec: ExperimentSpec,
  observed: ObservationBatch,
  mode: Mode,
  calibratedItems: readonly string[] = spec.experiment.itemIds,
  mutate?: (result: ExperimentAttemptResult, input: ExperimentAttemptInput) => ExperimentAttemptResult,
  judgeMutate?: (result: PrimaryJudgeResult, input: PrimaryJudgeInput) => PrimaryJudgeResult,
): Promise<ExperimentExecutionBatch> {
  return runExperimentEvidence({
    spec,
    artifacts: artifactsBySpec.get(spec) as ExperimentArtifacts,
    observerBatch: observed,
    calibrationRunner: {
      run: async (request) => {
        if (JSON.stringify(request.route) !== JSON.stringify(spec.routes.reference) ||
          JSON.stringify(request.sampling) !== JSON.stringify((artifactsBySpec.get(spec) as ExperimentArtifacts).referenceSampling)) {
          throw new Error("fixture received unbound reference route or sampling");
        }
        return ({
        attemptId: request.attemptId,
        outcome: request.injectionText === "" ? (calibratedItems.includes(request.itemId) ? "fail" : "pass") : "pass",
        reportedCostUsd: 0,
        route: { requested: request.route, effective: { provider: request.route.provider, model: request.route.model, routeReported: true } },
        });
      },
    },
    attemptRunner: { run: async (attemptInput) => {
      const artifactSet = artifactsBySpec.get(spec) as ExperimentArtifacts;
      const corpusCommitment = artifactSet.corpusManifest.find((item) => item.itemId === attemptInput.entry.itemId);
      if (
        attemptInput.protocol.artifactUniverseHash !== artifactSet.artifactUniverseHash ||
        attemptInput.protocol.executorProtocolHash !== hashJson(artifactSet.protocols.executor) ||
        JSON.stringify(attemptInput.protocol.executorSampling) !== JSON.stringify(artifactSet.executorSampling) ||
        !corpusCommitment ||
        attemptInput.corpus.itemHash !== corpusCommitment.itemHash ||
        attemptInput.corpus.contentHash !== corpusCommitment.contentHash ||
        attemptInput.corpus.taskHash !== corpusCommitment.taskHash ||
        attemptInput.corpus.startingTreeHash !== corpusCommitment.startingTreeHash ||
        attemptInput.corpus.mechanicalCheckHash !== corpusCommitment.mechanicalCheckHash ||
        attemptInput.corpus.rubricHash !== corpusCommitment.rubricHash
      ) throw new Error("fixture received unbound execution protocol");
      const result = attemptResult(spec, mode, attemptInput);
      return mutate ? mutate(result, attemptInput) : result;
    } },
    primaryJudges: {
      outcome: { run: async (judgeInput) => {
        const result = primaryJudgeResult(spec, mode, judgeInput);
        return judgeMutate ? judgeMutate(result, judgeInput) : result;
      } },
      attribution: { run: async (judgeInput) => {
        const result = primaryJudgeResult(spec, mode, judgeInput);
        return judgeMutate ? judgeMutate(result, judgeInput) : result;
      } },
      drift: { run: async (judgeInput) => {
        const result = primaryJudgeResult(spec, mode, judgeInput);
        return judgeMutate ? judgeMutate(result, judgeInput) : result;
      } },
    },
    now: () => "2026-01-03T00:00:00.000Z",
  });
}

async function observerBatch(spec: ExperimentSpec, empty = false, costUsd: number | null = 0): Promise<ObservationBatch> {
  let call = 0;
  const transport: ModelTransport = {
    call: async (request) => ({
      text: JSON.stringify({
        schemaVersion: 1,
        memories: empty ? [] : [{ id: `synthetic-fact-${++call}`, text: "Use synthetic mode.", metadata: { source: "fixture" } }],
      }),
      generationId: null,
      route: { requested: request.route, effective: { provider: "synthetic-provider", model: "synthetic-observer", routeReported: true } },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd },
      durationMs: 1,
      modelCalls: 1,
      steps: 1,
    }),
  };
  return observeExperimentInBackground({
    spec,
    artifacts: artifactsBySpec.get(spec) as ExperimentArtifacts,
    eventBatches: eventBatchesFor(spec.experiment.itemIds),
    transport,
    memory: new InMemoryBackend(),
  });
}

interface Fixture {
  readonly spec: ExperimentSpec;
  readonly executionBatch: ExperimentExecutionBatch;
  readonly comparisons: readonly CandidateComparison[];
  readonly observerBatch: ObservationBatch;
  readonly report: ReturnType<typeof createReport>;
}

async function fixture(mode: Mode = "recommend", candidates = ["candidate-a"], lanes = ["lane-a"], calibratedItems = items): Promise<Fixture> {
  const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
  roots.push(root);
  const spec = specFor(root, candidates, lanes);
  const observed = await observerBatch(spec);
  const executed = await executionBatch(spec, observed, mode, calibratedItems);
  const comparisons = compareModelFamily(executed, spec);
  const evidenceFamily = issueExperimentAuditEvidenceFamily(spec, comparisons);
  const manifest = predeclareExperimentAuditSample(spec, comparisons, evidenceFamily);
  const auditResult = await runIndependentExperimentAudit(manifest, evidenceFamily, {
    judge: async ({ config }) => auditJudgeResult(config, "pass"),
  });
  const report = createReport({ spec, comparisons, auditResult });
  return { spec, executionBatch: executed, comparisons, observerBatch: observed, report };
}

function derivation(value: Fixture): ReportDerivationInput {
  return { spec: value.spec, comparisons: value.comparisons, auditResult: null };
}

function bundleInput(report: Fixture["report"], includeJunit = true) {
  const contentHash = report.identity.corpusHash;
  return {
    report,
    provenance: {
      schemaVersion: 1, corpusId: "synthetic-corpus", corpusVersion: "1.0.0", classification: "synthetic",
      createdAt: "2026-01-01T00:00:00.000Z",
      origin: { method: "newly_authored_synthetic", description: "Newly authored synthetic aggregate fixture" },
      license: "MIT", authority: { basis: "author", recordReference: sha256("authority-record") }, contentHash,
    },
    releaseAttestation: {
      schemaVersion: 1, corpusId: "synthetic-corpus", corpusVersion: "1.0.0", reviewedAt: "2026-01-02T00:00:00.000Z",
      reviewerRole: "fixture-reviewer", reviewRecordReference: sha256("review-record"), decision: "approved",
      checks: { authorityVerified: true, consentVerified: true, licenseVerified: true, independentReviewComplete: true, sensitiveDataReviewComplete: true, secretScanComplete: true },
      contentHash,
    },
    includeJunit,
  };
}

function privateShape(suffix: string): string { return String.fromCodePoint(114, 97, 119) + suffix; }

describe("derived scientific report", () => {
  test("derives recommendation, complete candidate×lane family, policy, shuffled diagnostic, and Markdown parity", async () => {
    const { report } = await fixture("recommend", ["candidate-b", "candidate-a"], ["lane-b", "lane-a"]);
    expect(report.decision).toBe("recommend");
    expect(report.lanes).toHaveLength(4);
    expect(report.lanes.map((row) => `${row.candidateId}/${row.laneId}`)).toEqual([
      "candidate-a/lane-a", "candidate-a/lane-b", "candidate-b/lane-a", "candidate-b/lane-b",
    ]);
    expect(report.headline.shuffledDelta?.estimate).toBe(1);
    expect(report.headline.tokensToDone).toBe(10);
    expect(report.spend).toMatchObject({ status: "measured", components: { observerUsd: 0, auditUsd: 0 } });
    expect(report.spend.totalUsd).toBeCloseTo(1.008);
    expect(report.spend.components.executorUsd).toBeCloseTo(0.576);
    expect(report.spend.components.outcomeJudgeUsd).toBeCloseTo(0.288);
    expect(report.spend.components.attributionJudgeUsd).toBeCloseTo(0.072);
    expect(report.spend.components.driftJudgeUsd).toBeCloseTo(0.072);
    expect(report.spend.components.attemptPipelineUsd).toBeCloseTo(1.008);
    expect(report.spend.components.calibrationUsd).toBe(0);
    expect(report.lanes.every((row) => row.failures.taskFailure === 0)).toBeTrue();
    expect(report.policy).toMatchObject({ minimumEffect: 0.1, minimumCalibratedItems: 3, maximumSchemaFailureRate: 0.05, maximumUnknownOutcomeRate: 0, minimumAttributionRate: 0.75, minimumDriftAvoidanceRate: 0.75, nominalAlpha: 0.05, multiplicity: "bonferroni", comparisonFamilySize: 4, bootstrapSamples: 500 });
    expect(report.audit).toMatchObject({
      method: "independent_reassessment",
      limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals",
      declaredSampleSizePerPair: 2,
      samplingPolicy: "uniform_without_replacement",
      status: "measured",
      requiredCoverage: 1,
    });
    expect(report.audit.pairs).toHaveLength(4);
    expect(report.audit.pairs.every((pair) => pair.selected === 2 && pair.judged === 2 && pair.agreements === 2 && pair.agreementRate === 1)).toBeTrue();
    expect(report.audit.judgeConfigHash).toMatch(/^sha256:/u);
    for (const commitment of [
      report.evidence.scheduleHash,
      report.evidence.manifestHash,
      report.evidence.inputUniverseHash,
      report.evidence.executionResultUniverseHash,
      report.evidence.primaryReassessmentEvidenceUniverseHash,
    ]) expect(commitment).toMatch(/^sha256:/u);
    const markdown = reportMarkdown(report);
    for (const token of [
      "Shuffled delta", "diagnostic; not decision-bearing", "paired", "nominal alpha", "adjusted alpha", "bootstrap samples", "sample hash",
      "corpusHash", "promptHash", "routeHash", "harnessHash", "configHash", "judgeHash", "combinedHash", "persisted=3",
    ]) expect(markdown).toContain(token);
    expect(reportJson(report)).toBe(reportJson(report));
    expect(reportJson(report)).toContain('"outcomeMeasurement"');
    expect(reportJson(report)).not.toContain('"outcomeQuality"');
    expect(reportJunit(report)).toContain('tests="4" failures="0" skipped="0"');
  });

  test("issued comparisons make negative, unknown, schema-failure, and low-calibration outcomes non-forgeable", async () => {
    expect((await fixture("negative")).report.decision).toBe("do_not_recommend");
    expect(reportJunit((await fixture("negative")).report)).toContain("<failure");
    const unknown = (await fixture("unknown")).report;
    expect(unknown.decision).toBe("insufficient_evidence");
    expect(unknown.lanes[0]?.instability.unknownOutcomeRate).toBe(1);
    expect(reportJunit(unknown)).toContain("<skipped");
    expect((await fixture("schema_failure")).report.decision).toBe("do_not_recommend");
    expect((await fixture("attribution_failure")).report.decision).toBe("do_not_recommend");
    expect((await fixture("drift_failure")).report.decision).toBe("do_not_recommend");
    expect((await fixture("unknown_attribution")).report.decision).toBe("insufficient_evidence");
    expect((await fixture("unknown_drift")).report.decision).toBe("insufficient_evidence");
    const missingCost = (await fixture("missing_cost")).report;
    expect(missingCost.decision).toBe("insufficient_evidence");
    expect(missingCost.spend.totalUsd).toBeNull();
    expect(missingCost.budgets.executor.status).toBe("measurement_unknown");
    expect((await fixture("recommend", ["candidate-a"], ["lane-a"], ["item-a"])).report.decision).toBe("insufficient_evidence");
  });

  test("rejects forged comparison rows, cloned families, omissions, and cross-experiment substitution", async () => {
    const base = await fixture();
    const forged = Object.freeze({ ...base.comparisons[0], decision: "recommend" }) as CandidateComparison;
    expect(() => createReport({ ...derivation(base), comparisons: Object.freeze([forged]) })).toThrow("issued");
    expect(() => createReport({ ...derivation(base), comparisons: Object.freeze([...base.comparisons]) })).toThrow("issued");

    const family = await fixture("recommend", ["candidate-a", "candidate-b"], ["lane-a"]);
    expect(() => createReport({ ...derivation(family), comparisons: family.comparisons.slice(0, 1) })).toThrow("issued");
    const other = await fixture();
    expect(() => createReport({ ...derivation(other), comparisons: base.comparisons })).toThrow("exact experiment");
    expect(() => createReport({ ...derivation(other), observerBatch: base.observerBatch } as unknown as ReportDerivationInput)).toThrow("unknown or missing fields");
    expect(() => createReport({ ...derivation(base), observerBatch: structuredClone(base.observerBatch) } as unknown as ReportDerivationInput)).toThrow("unknown or missing fields");
    expect(() => reportJson(structuredClone(base.report))).toThrow("issued");
  });

  test("plain score arrays cannot be relabeled as issued evidence under this or another spec", async () => {
    const base = await fixture();
    const invokeComparison = compareModelFamily as unknown as (batch: unknown, spec: ExperimentSpec) => unknown;
    expect(() => invokeComparison(base.executionBatch.attempts, base.spec)).toThrow("exact experiment");
    expect(() => invokeComparison(structuredClone(base.executionBatch), base.spec)).toThrow("exact experiment");

    const otherRoot = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(otherRoot);
    const otherSpec = specFor(otherRoot);
    expect(() => compareModelFamily(base.executionBatch, otherSpec)).toThrow("exact experiment");
  });

  test("resolved artifacts reject every changed declarative identity label", async () => {
    for (const field of ["corpusHash", "promptHash", "harnessHash", "judgeHash", "runHash"] as const) {
      const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
      roots.push(root);
      expect(() => specFor(root, ["candidate-a"], ["lane-a"], items, (commitments) => ({
        ...commitments,
        [field]: sha256(`changed-${field}`),
      }))).toThrow("do not match resolved experiment artifacts");
    }
  });

  test("observer dispatch requires the exact corpus-item event artifacts", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    let calls = 0;
    const changed = eventBatchesFor(spec.experiment.itemIds).map((batch) => batch.itemId === "item-b"
      ? { ...batch, events: [{ ...batch.events[0]!, text: "Changed after artifact issuance." }] }
      : batch
    );
    await expect(observeExperimentInBackground({
      spec,
      artifacts: artifactsBySpec.get(spec) as ExperimentArtifacts,
      eventBatches: changed,
      transport: { call: async () => { calls += 1; throw new Error("must not dispatch"); } },
      memory: new InMemoryBackend(),
    })).rejects.toThrow("exactly match the issued corpus artifacts");
    expect(calls).toBe(0);
  });

  test("candidate attribution cannot claim an empty observer-memory input", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const observed = await observerBatch(spec, true);
    expect(observed.memoryArtifacts.every((artifact) => artifact.memoryCount === 0)).toBeTrue();
    await expect(executionBatch(spec, observed, "recommend")).rejects.toThrow("exact non-empty issued input");
  });

  test("scored control contradictions become calibration-instability exclusions", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const observed = await observerBatch(spec);
    const executed = await executionBatch(spec, observed, "recommend", items, undefined, (result, input) =>
      input.purpose === "outcome" && input.entry.itemId === "item-a" && input.entry.arm === "none" && input.entry.repetition === 0
        ? { ...result, outcome: "pass" }
        : result);
    expect(executed.calibration.find((row) => row.itemId === "item-a")?.reason).toBe("calibration_instability");
    const comparisons = compareModelFamily(executed, spec);
    expect(comparisons[0]?.calibrationExclusions.instability).toBe(1);
    expect(comparisons[0]?.decision).toBe("insufficient_evidence");
  });

  test("reference controls must bind the exact artifact corpus source before calibration dispatch", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const observed = await observerBatch(spec);
    const wrongItem = corpusItem("item-a", "Changed reference source after artifact issuance.");
    const wrongText = (wrongItem.events[0] as { readonly text: string }).text;
    const wrongControl = compileReferenceControl(wrongItem, [{ text: wrongText, eventIndex: 0, supportingQuote: wrongText }]).control;
    const wrongReference = bindCalibrationReference({ item: wrongItem, laneId: laneId("lane-a"), control: wrongControl });
    const references = boundReferences(spec).map((reference) => reference.itemId === "item-a" ? wrongReference : reference);
    expect(() => issueExperimentArtifacts({
      spec,
      corpusItems: corpusBySpec.get(spec) as readonly ReturnType<typeof corpusItem>[],
      references,
      createdAt: artifactCreatedAt,
    })).toThrow("exactly bind the corpus item and lane universe");
    expect(observed.records).toHaveLength(items.length);
  });

  test("observer unknown or exceeded spend stops further calls and remains reportable", async () => {
    for (const costUsd of [null, 2] as const) {
      const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
      roots.push(root);
      const spec = specFor(root);
      const observed = await observerBatch(spec, false, costUsd);
      expect(observed.records.filter((record) => record.parseState === "not_run_budget")).toHaveLength(2);
      expect(observed.budget.status).toBe(costUsd === null ? "measurement_unknown" : "exceeded");
      const executed = await executionBatch(spec, observed, "unknown_attribution");
      const comparisons = compareModelFamily(executed, spec);
      const report = createReport({ spec, comparisons, auditResult: null });
      expect(report.decision).toBe("insufficient_evidence");
      expect(report.observer.status).toBe("failed");
      expect(report.observer.budget.status).toBe(observed.budget.status);
    }
  });

  test("observer effective route must equal its requested no-fallback route", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    await expect(observeExperimentInBackground({
      spec,
      artifacts: artifactsBySpec.get(spec) as ExperimentArtifacts,
      eventBatches: eventBatchesFor(spec.experiment.itemIds),
      transport: { call: async (request) => ({
        text: JSON.stringify({ schemaVersion: 1, memories: [] }), generationId: null,
        route: { requested: request.route, effective: { provider: null, model: null, routeReported: false } },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }, durationMs: 1, modelCalls: 1, steps: 1,
      }) },
      memory: new InMemoryBackend(),
    })).rejects.toThrow("effective route must equal");
  });

  test("observer sampling is derived from the issued specification and ignores caller variation", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const artifacts = artifactsBySpec.get(spec) as ExperimentArtifacts;
    const dispatched: unknown[] = [];
    await observeExperimentInBackground({
      spec,
      artifacts,
      eventBatches: eventBatchesFor(spec.experiment.itemIds),
      transport: { call: async (request: Parameters<ModelTransport["call"]>[0]) => {
        dispatched.push(request.sampling);
        return {
          text: JSON.stringify({ schemaVersion: 1, memories: [] }), generationId: null,
          route: { requested: request.route, effective: { provider: request.route.provider, model: request.route.model, routeReported: true } },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 }, durationMs: 1, modelCalls: 1, steps: 1,
        };
      } },
      memory: new InMemoryBackend(),
      sampling: { temperature: 1, topP: 0.1, seed: "caller-override" },
    } as unknown as Parameters<typeof observeExperimentInBackground>[0]);
    expect(dispatched).toEqual(spec.experiment.itemIds.map(() => artifacts.observerSampling));
  });

  test("one hidden control route and malformed or negative attempt telemetry fail closed", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const observed = await observerBatch(spec);
    await expect(executionBatch(spec, observed, "recommend", spec.experiment.itemIds, (result, input) =>
      input.entry.itemId === "item-a" && input.entry.arm === "none" && input.entry.repetition === 0
        ? { ...result, route: { requested: spec.routes.executor, effective: { provider: null, model: null, routeReported: false } } }
        : result
    )).rejects.toThrow("effective route must equal");

    const malformed: readonly ((result: ExperimentAttemptResult) => ExperimentAttemptResult)[] = [
      (result) => ({ ...result, tokenCount: -1 }),
      (result) => ({ ...result, durationMs: -1 }),
      (result) => ({ ...result, reportedCostUsd: -1 }),
      (result) => ({ ...result, route: { requested: spec.routes.executor, effective: { provider: "provider:colon", model: spec.routes.executor.model, routeReported: true } } }),
      (result) => ({ ...result, executionArtifacts: { ...result.executionArtifacts, executorResponse: { outcome: "completed" } as unknown as ExperimentAttemptResult["executionArtifacts"]["executorResponse"] } }),
      (result) => ({ ...result, executionArtifacts: { ...result.executionArtifacts, executorResponse: { ...result.executionArtifacts.executorResponse, state: "pass" } as unknown as ExperimentAttemptResult["executionArtifacts"]["executorResponse"] } }),
      (result) => ({ ...result, executionArtifacts: { ...result.executionArtifacts, toolTrace: [{ attribution: "none" }] as unknown as ExperimentAttemptResult["executionArtifacts"]["toolTrace"] } }),
      (result) => ({ ...result, executionArtifacts: { ...result.executionArtifacts, toolTrace: [{ sequence: 0, tool: "synthetic-check", state: "present", summary: "bad" }] as unknown as ExperimentAttemptResult["executionArtifacts"]["toolTrace"] } }),
      (result) => ({ ...result, auditEvidence: { caller: "authored" } } as unknown as ExperimentAttemptResult),
    ];
    for (const mutate of malformed) {
      await expect(executionBatch(spec, observed, "recommend", spec.experiment.itemIds, (result, input) =>
        input.entry.itemId === "item-a" && input.entry.arm === "candidate" && input.entry.repetition === 0
          ? mutate(result)
          : result
      )).rejects.toThrow();
    }
  });

  test("final-attempt executor and judge overshoots remain reportable and prevent recommendation", async () => {
    for (const domain of ["executor", "judge"] as const) {
      const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
      roots.push(root);
      const spec = specFor(root);
      const observed = await observerBatch(spec);
      const finalSequence = spec.experiment.itemIds.length * spec.experiment.repetitions * 4 - 1;
      const executed = await executionBatch(
        spec,
        observed,
        "recommend",
        items,
        domain === "executor" ? (result, input) => input.entry.sequence === finalSequence ? { ...result, reportedCostUsd: 2 } : result : undefined,
        domain === "judge" ? (result, input) => input.entry.sequence === finalSequence && input.purpose === "outcome"
          ? { ...result, usage: { ...result.usage, costUsd: 2 } }
          : result : undefined,
      );
      const comparisons = compareModelFamily(executed, spec);
      const evidenceFamily = issueExperimentAuditEvidenceFamily(spec, comparisons);
      const manifest = predeclareExperimentAuditSample(spec, comparisons, evidenceFamily);
      const auditResult = await runIndependentExperimentAudit(manifest, evidenceFamily, {
        judge: async ({ config }) => auditJudgeResult(config, "pass"),
      });
      const report = createReport({ spec, comparisons, auditResult });
      expect(report.decision).toBe("insufficient_evidence");
      expect(report.budgets[domain].status).toBe("exceeded");
      expect(reportJunit(report)).toContain("<skipped");
    }
  });

  test("one unknown outcome in four items is insufficient and never becomes a task failure", async () => {
    const fourItems = ["item-a", "item-b", "item-c", "item-d"];
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root, ["candidate-a"], ["lane-a"], fourItems);
    const observed = await observerBatch(spec);
    const executed = await executionBatch(spec, observed, "recommend", fourItems, undefined, (result, input) =>
      input.purpose === "outcome" && input.entry.itemId === "item-d" && input.entry.arm === "candidate" && input.entry.repetition === 0
        ? { ...result, outcome: "unknown" }
        : result);
    const comparisons = compareModelFamily(executed, spec);
    const evidenceFamily = issueExperimentAuditEvidenceFamily(spec, comparisons);
    const manifest = predeclareExperimentAuditSample(spec, comparisons, evidenceFamily);
    const auditResult = await runIndependentExperimentAudit(manifest, evidenceFamily, {
      judge: async ({ config }) => auditJudgeResult(config, "pass"),
    });
    const report = createReport({ spec, comparisons, auditResult });
    expect(report.decision).toBe("insufficient_evidence");
    expect(report.headline.taskSuccessRate).toBeNull();
    expect(report.assessment.outcomeMeasurement.status).toBe("unknown");
    expect(report.lanes[0]?.failures.taskFailure).toBe(0);
    expect(report.lanes[0]?.instability.unknownOutcomeRate).toBeCloseTo(1 / 12);
  });

  test("accepts only a module-issued independent reassessment and reports aggregate agreement", async () => {
    const base = await fixture();
    const evidenceFamily = issueExperimentAuditEvidenceFamily(base.spec, base.comparisons);
    expect(evidenceFamily.pairs).toHaveLength(1);
    const evidencePair = evidenceFamily.pairs[0]!;
    expect(evidencePair.candidates).toHaveLength(items.length * base.spec.experiment.repetitions);
    expect(evidenceFamily).toMatchObject({
      method: "independent_reassessment",
      limitation: "harness_verifies_dispatch_artifacts_and_returned_provenance_not_remote_provider_internals",
    });
    expect(evidencePair.candidates.every((row) => {
      const encoded = JSON.stringify(row.reassessmentEvidence).toLowerCase();
      return Object.keys(row).sort().join(",") === "reassessmentEvidence,rowId" &&
        !encoded.includes("outcome") && !encoded.includes("attribution") && !encoded.includes("drift") &&
        !encoded.includes('"pass"') && !encoded.includes('"fail"') && !encoded.includes('"unknown"');
    })).toBeTrue();
    const config = experimentAuditJudgeConfig(base.spec);
    const manifest = predeclareExperimentAuditSample(base.spec, base.comparisons, evidenceFamily);
    expect(manifest).toMatchObject({ sampleSizePerPair: 2, samplingPolicy: "uniform_without_replacement" });
    expect(manifest.pairs[0]).toMatchObject({ sampleSize: 2, candidateId: "candidate-a", laneId: "lane-a" });
    const auditResult = await runIndependentExperimentAudit(manifest, evidenceFamily, {
      judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "fail", 0.01),
    });
    const report = createReport({ ...derivation(base), auditResult });
    expect(report.audit.pairs[0]).toMatchObject({
      status: "measured", selected: 2, judged: 2, agreements: 0, agreementRate: 0,
      declaredSampleSize: 2,
      manifestHash: manifest.pairs[0]?.contentHash,
      evidenceUniverseHash: manifest.pairs[0]?.universeHash,
      selectedSampleHash: hashJson(manifest.pairs[0]!.selectedRowIds),
    });
    expect(report.audit).toMatchObject({ status: "measured", declaredSampleSizePerPair: 2, judgeConfigHash: manifest.judgeConfigHash });
    expect(report.decision).toBe("do_not_recommend");
    expect(reportJunit(report)).toContain("<failure");
    expect(reportMarkdown(report)).toContain("Independent reassessment audit: measured");
    expect(() => createReport({ ...derivation(base), auditResult: structuredClone(auditResult) })).toThrow("different experiment");

    const genericCandidates = evidencePair.candidates.map((row) => ({ ...row, primaryOutcome: "pass" as const }));
    const wrongSeedManifest = predeclareAuditSample(genericCandidates, 2, "wrong-audit-seed", config);
    const wrongSeedResult = await runIndependentAudit(wrongSeedManifest, genericCandidates, config, { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") });
    expect(() => createReport({ ...derivation(base), auditResult: wrongSeedResult as unknown as typeof auditResult })).toThrow("different experiment");
    const other = await fixture();
    expect(() => createReport({ ...derivation(other), auditResult })).toThrow("different experiment");
    const changedConfig = createAuditJudgeConfig({
      route: { ...base.spec.routes.judge, model: "different-judge" },
      promptHash: config.promptHash,
      schemaHash: config.schemaHash,
      sampling: config.sampling,
    });
    await expect(runIndependentAudit(wrongSeedManifest, genericCandidates, changedConfig, { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("manifest");

    const notRun = createReport(derivation(base));
    expect(notRun.decision).toBe("insufficient_evidence");
    expect(notRun.decisionReasons).toContain("independent_reassessment_not_run");
    expect(reportJunit(notRun)).toContain("<skipped");

    const expensiveAudit = await runIndependentExperimentAudit(manifest, evidenceFamily, {
      judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass", 0.6),
    });
    const overBudget = createReport({ ...derivation(base), auditResult: expensiveAudit });
    expect(overBudget.audit.pairs[0]?.agreementRate).toBe(1);
    expect(overBudget.budgets.judge.status).toBe("exceeded");
    expect(overBudget.decision).toBe("insufficient_evidence");
  });

  test("pre-judgment audit manifests are invariant across every primary relabeling", async () => {
    const base = await fixture();
    const family = issueExperimentAuditEvidenceFamily(base.spec, base.comparisons);
    const publicRows = family.pairs[0]!.candidates.slice(0, 4);
    const config = experimentAuditJudgeConfig(base.spec);
    const labels = ["pass", "fail", "unknown"] as const;
    let expectedBytes: string | null = null;
    for (let assignment = 0; assignment < labels.length ** publicRows.length; assignment += 1) {
      let cursor = assignment;
      const candidates = publicRows.map((row) => {
        const primaryOutcome = labels[cursor % labels.length]!;
        cursor = Math.floor(cursor / labels.length);
        return { ...row, primaryOutcome };
      });
      const declared = predeclareAuditSample(candidates, 2, "brute-force-audit-seed", config);
      const publicBytes = JSON.stringify(declared);
      expectedBytes ??= publicBytes;
      expect(publicBytes).toBe(expectedBytes);
      expect(publicBytes.toLowerCase()).not.toContain("primary");
    }
  });

  test("audit coverage and decisions are gated separately for every candidate and lane", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root, ["candidate-a", "candidate-b"], ["lane-a"]);
    const observed = await observerBatch(spec);
    const executed = await executionBatch(spec, observed, "recommend");
    const comparisons = compareModelFamily(executed, spec);
    const family = issueExperimentAuditEvidenceFamily(spec, comparisons);
    const manifest = predeclareExperimentAuditSample(spec, comparisons, family);
    const auditResult = await runIndependentExperimentAudit(manifest, family, {
      judge: async ({ candidateId, config }) => auditJudgeResult(config, candidateId === "candidate-b" ? "unknown" : "pass"),
    });
    const report = createReport({ spec, comparisons, auditResult });
    const measured = report.lanes.find((lane) => lane.candidateId === "candidate-a")!;
    const incomplete = report.lanes.find((lane) => lane.candidateId === "candidate-b")!;
    expect(measured.audit).toMatchObject({ selected: 2, judged: 2, coverage: 1, agreementRate: 1, status: "measured" });
    expect(measured.decision).toBe("recommend");
    expect(incomplete.audit).toMatchObject({ selected: 2, judged: 0, coverage: 0, agreementRate: 0, status: "incomplete" });
    expect(incomplete.decision).toBe("insufficient_evidence");
    expect(reportJunit(report)).toContain('tests="2" failures="0" skipped="1"');
  });

  test("experiment audit issuance rejects arbitrary universes, relabeled sizes, and undeclared judge configurations", async () => {
    const base = await fixture();
    const arbitraryRows = [{ itemId: "arbitrary-item", repetition: 0, reassessmentEvidence: {}, primaryOutcome: "pass" }];
    const invokeWithRows = issueExperimentAuditEvidenceFamily as unknown as (...args: unknown[]) => unknown;
    expect(() => invokeWithRows(base.spec, base.comparisons, arbitraryRows)).toThrow("no caller-supplied rows");
    const family = issueExperimentAuditEvidenceFamily(base.spec, base.comparisons);
    expect(() => predeclareExperimentAuditSample(
      base.spec,
      base.comparisons,
      structuredClone(family),
    )).toThrow("must be issued");
    const manifest = predeclareExperimentAuditSample(base.spec, base.comparisons, family);
    const config = experimentAuditJudgeConfig(base.spec);
    const relabeled = Object.freeze({ ...manifest, sampleSizePerPair: 1 });
    await expect(runIndependentExperimentAudit(relabeled, family, { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("issued together");
    await expect(runIndependentExperimentAudit(manifest, structuredClone(family), { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("issued together");
    const invokeRunnerWithConfig = runIndependentExperimentAudit as unknown as (...args: unknown[]) => Promise<unknown>;
    await expect(invokeRunnerWithConfig(manifest, family, config, { judge: async ({ config: judgeConfig }: { config: AuditJudgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("accepts only");

    const undeclaredRoute = createAuditJudgeConfig({
      route: { ...config.route, model: "undeclared-audit-model" },
      promptHash: config.promptHash,
      schemaHash: config.schemaHash,
      sampling: config.sampling,
    });
    const undeclaredConfig = createAuditJudgeConfig({
      route: config.route,
      promptHash: sha256("undeclared-audit-prompt"),
      schemaHash: config.schemaHash,
      sampling: config.sampling,
    });
    const genericCandidates = family.pairs[0]!.candidates.map((row) => ({ ...row, primaryOutcome: "pass" as const }));
    const genericManifest = predeclareAuditSample(genericCandidates, 2, "generic-audit-seed", config);
    await expect(runIndependentAudit(genericManifest, genericCandidates, undeclaredRoute, { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("manifest");
    await expect(runIndependentAudit(genericManifest, genericCandidates, undeclaredConfig, { judge: async ({ config: judgeConfig }) => auditJudgeResult(judgeConfig, "pass") })).rejects.toThrow("manifest");
  });

  test("rejects duplicate observer item coordinates before model dispatch", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root);
    const duplicate = [observerEvents[0]!, observerEvents[0]!, observerEvents[2]!];
    let calls = 0;
    await expect(observeExperimentInBackground({
      spec,
      artifacts: artifactsBySpec.get(spec) as ExperimentArtifacts,
      eventBatches: duplicate,
      transport: { call: async () => { calls += 1; throw new Error("must not dispatch"); } },
      memory: new InMemoryBackend(),
    })).rejects.toThrow("duplicated");
    expect(calls).toBe(0);
  });

  test("JUnit emits every prespecified pair so a favorable primary cannot conceal another failure", async () => {
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-corpus-"));
    roots.push(root);
    const spec = specFor(root, ["candidate-a", "candidate-b"], ["lane-a"]);
    const observed = await observerBatch(spec);
    const executed = await executionBatch(spec, observed, "recommend", items, undefined, (result, input) =>
      input.purpose === "outcome" && input.entry.candidateId === "candidate-b" && input.entry.arm === "candidate"
        ? { ...result, outcome: "fail" }
        : result);
    const comparisons = compareModelFamily(executed, spec);
    const evidenceFamily = issueExperimentAuditEvidenceFamily(spec, comparisons);
    const manifest = predeclareExperimentAuditSample(spec, comparisons, evidenceFamily);
    const auditResult = await runIndependentExperimentAudit(manifest, evidenceFamily, {
      judge: async ({ config }) => auditJudgeResult(config, "pass"),
    });
    const report = createReport({ spec, comparisons, auditResult });
    expect(report.decision).toBe("recommend");
    expect(reportJunit(report)).toContain('tests="2" failures="1" skipped="0"');
    expect(reportJunit(report).match(/<testcase/gu)).toHaveLength(2);
  });
});

describe("fail-closed public bundle", () => {
  test("uses a fixed-key manifest with runtime/schema parity and explicit JUnit decision", async () => {
    const { report } = await fixture();
    for (const includeJunit of [true, false]) {
      const bundle = generatePublicBundle(bundleInput(report, includeJunit));
      const manifest = JSON.parse(bundle.files["manifest.json"] as string) as { includeJunit: boolean; files: Record<string, { bytes: number; sha256: string }> };
      expect(manifest.includeJunit).toBe(includeJunit);
      expect(Array.isArray(manifest.files)).toBeFalse();
      expect(Object.keys(manifest.files).sort()).toEqual(Object.keys(bundle.files).filter((name) => name !== "manifest.json").sort());
      for (const [name, entry] of Object.entries(manifest.files)) expect(entry.sha256).toBe(sha256(bundle.files[name as keyof typeof bundle.files] as string));
    }
    const schema = JSON.parse(await readFile("schemas/public-bundle-manifest.schema.json", "utf8"));
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const valid = JSON.parse(generatePublicBundle(bundleInput(report)).files["manifest.json"] as string);
    expect(validate(valid)).toBeTrue();
    expect(validate({ ...valid, files: [{ name: "report.json" }, { name: "report.json" }] })).toBeFalse();
    expect(validate({ ...valid, files: { ...valid.files, "unexpected.txt": valid.files["report.json"] } })).toBeFalse();
  });

  test("rejects private shapes, unsafe provenance paths, controls, weak references, and cloned reports", async () => {
    const { report } = await fixture();
    expect(() => generatePublicBundle({ ...bundleInput(report), [privateShape("Prompt")]: "synthetic" })).toThrow("forbidden");
    expect(() => generatePublicBundle(bundleInput(structuredClone(report)))).toThrow("issued");
    for (const description of [
      "relative/segment", "../segment", "C" + ":\\segment", "embedded /var/segment", "path=segment", "tab\tvalue",
      "zero\u200bwidth", "override\u202etext", "isolate\u2066text", "bom\ufefftext",
    ]) {
      const input = bundleInput(report);
      input.provenance.origin.description = description;
      expect(() => generatePublicBundle(input)).toThrow();
    }
    const unsafeLicense = bundleInput(report);
    unsafeLicense.provenance.license = "M\u202eIT";
    expect(() => generatePublicBundle(unsafeLicense)).toThrow("unsafe");
    expect(() => assertReleaseSafeAggregate({ nested: { narrative: "safe\u200blooking" } })).toThrow("unsafe");
    expect(() => assertReleaseSafeAggregate({ [`safe\u2066key`]: "value" })).toThrow("forbidden");
    const credentialedReference = new URL("https://example.invalid/source");
    credentialedReference.username = "user";
    for (const reference of [
      "http" + "://example.invalid/source",
      credentialedReference.toString(),
      "https://example.invalid/source?version=1",
      "https://example.invalid/source#review",
    ]) {
      const publicInput = bundleInput(report);
      publicInput.provenance.classification = "authorized_public";
      publicInput.provenance.origin.method = "authorized_public_source";
      Object.assign(publicInput.provenance.origin, { sourceReferences: [reference] });
      publicInput.provenance.authority.basis = "license";
      expect(() => generatePublicBundle(publicInput)).toThrow();
    }
    const nonOpaqueAuthority = bundleInput(report);
    Object.assign(nonOpaqueAuthority.provenance.authority, { recordReference: "https://example.invalid/review" });
    expect(() => generatePublicBundle(nonOpaqueAuthority)).toThrow();
    const nonOpaqueReview = bundleInput(report);
    Object.assign(nonOpaqueReview.releaseAttestation, { reviewRecordReference: "https://example.invalid/review" });
    expect(() => generatePublicBundle(nonOpaqueReview)).toThrow();
    const publicInput = bundleInput(report);
    publicInput.provenance.classification = "authorized_public";
    publicInput.provenance.origin.method = "authorized_public_source";
    Object.assign(publicInput.provenance.origin, { sourceReferences: ["https://example.invalid/source"] });
    publicInput.provenance.authority.basis = "license";
    expect(() => generatePublicBundle(publicInput)).not.toThrow();
    expect(() => assertReleaseSafeAggregate({ location: "/" + "private/place" })).toThrow("unsafe");
  });

  test("publishes atomically, rejects existing destinations, and cleans staging after injected write/rename failures", async () => {
    const { report } = await fixture();
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-publish-"));
    roots.push(root);
    const destination = join(root, "bundle");
    const writeOrder: string[] = [];
    await writePublicBundleForTest(bundleInput(report), destination, { beforeWrite: (name) => { writeOrder.push(name); } });
    expect(writeOrder.at(-1)).toBe("manifest.json");
    expect((await readdir(destination)).sort()).toEqual(Object.keys(generatePublicBundle(bundleInput(report)).files).sort());
    await expect(writePublicBundle(bundleInput(report), destination)).rejects.toThrow("exists");

    const writeFailure = join(root, "write-failure");
    await expect(writePublicBundleForTest(bundleInput(report), writeFailure, { beforeWrite: (name) => { if (name === "report.md") throw new Error("injected write failure"); } })).rejects.toThrow("injected write failure");
    expect(await readdir(root)).not.toContain("write-failure");
    expect((await readdir(root)).some((name) => name.startsWith(".write-failure.membench-publish-"))).toBeFalse();

    const renameFailure = join(root, "rename-failure");
    await expect(writePublicBundleForTest(bundleInput(report), renameFailure, { beforeRename: () => { throw new Error("injected rename failure"); } })).rejects.toThrow("injected rename failure");
    expect(await readdir(root)).not.toContain("rename-failure");
    expect((await readdir(root)).some((name) => name.startsWith(".rename-failure.membench-publish-"))).toBeFalse();

    for (const [name, mutate] of [
      ["tampered-report", async (staging: string) => { await writeFile(join(staging, "report.json"), "{}\n"); }],
      ["tampered-manifest", async (staging: string) => { await writeFile(join(staging, "manifest.json"), "{}\n"); }],
    ] as const) {
      const target = join(root, name);
      await expect(writePublicBundleForTest(bundleInput(report), target, { beforeVerify: mutate })).rejects.toThrow();
      expect(await readdir(root)).not.toContain(name);
      expect((await readdir(root)).some((entry) => entry.startsWith(`.${name}.membench-publish-`))).toBeFalse();
    }

    const raced = join(root, "raced");
    await expect(writePublicBundleForTest(bundleInput(report), raced, { beforeRename: async () => { await mkdir(raced); } })).rejects.toThrow("exists");
    expect(await readdir(raced)).toEqual([]);
    expect((await readdir(root)).some((name) => name.startsWith(".raced.membench-publish-"))).toBeFalse();
  });

  test("rejects staging replacement, child symlink/hardlink, and parent replacement races by identity", async () => {
    const { report } = await fixture();
    const root = await registeredMkdtemp(join(tmpdir(), "membench-phase4-publish-"));
    roots.push(root);

    const replaced = join(root, "replaced");
    let replacementPath = "";
    await expect(writePublicBundleForTest(bundleInput(report), replaced, {
      beforeVerify: async (staging) => {
        replacementPath = staging;
        await rename(staging, `${staging}.moved`);
        await mkdir(staging);
      },
    })).rejects.toThrow("identity changed");
    expect(await readdir(replacementPath)).toEqual([]);

    const symlinked = join(root, "symlinked");
    const target = join(root, "outside.txt");
    await writeFile(target, "outside\n");
    await expect(writePublicBundleForTest(bundleInput(report), symlinked, {
      beforeVerify: async (staging) => {
        const child = join(staging, "report.json");
        await rm(child);
        await symlink(target, child);
      },
    })).rejects.toThrow("non-symlink");
    expect(await readFile(target, "utf8")).toBe("outside\n");

    const hardlinked = join(root, "hardlinked");
    const externalAlias = join(root, "external-alias.json");
    let hardlinkStaging = "";
    await expect(writePublicBundleForTest(bundleInput(report), hardlinked, {
      beforeVerify: (staging) => { hardlinkStaging = staging; },
      beforeRename: async () => { await link(join(hardlinkStaging, "report.json"), externalAlias); },
    })).rejects.toThrow("singly linked");
    await writeFile(externalAlias, "externally mutable\n");
    expect(await readFile(externalAlias, "utf8")).toBe("externally mutable\n");
    expect(await readdir(root)).not.toContain("hardlinked");

    const parent = join(root, "publication-parent");
    const movedParent = join(root, "publication-parent-moved");
    await mkdir(parent);
    await expect(writePublicBundleForTest(bundleInput(report), join(parent, "bundle"), {
      beforeRename: async () => {
        await rename(parent, movedParent);
        await mkdir(parent);
      },
    })).rejects.toThrow("identity changed");
    expect(await readdir(parent)).toEqual([]);

    const ownedPostRenameFailure = join(root, "post-rename-owned-failure");
    await expect(writePublicBundleForTest(bundleInput(report), ownedPostRenameFailure, {
      afterRename: () => { throw new Error("injected post-rename failure"); },
    })).rejects.toThrow("injected post-rename failure");
    expect(await readdir(root)).not.toContain("post-rename-owned-failure");

    const postRename = join(root, "post-rename");
    const movedOwnedBundle = join(root, "post-rename-owned");
    const replacementBundle = generatePublicBundle(bundleInput(report));
    await expect(writePublicBundleForTest(bundleInput(report), postRename, {
      afterRename: async (published) => {
        await rename(published, movedOwnedBundle);
        await mkdir(published);
        for (const [fileName, contents] of Object.entries(replacementBundle.files)) {
          await writeFile(join(published, fileName), contents);
        }
      },
    })).rejects.toThrow("identity changed");
    expect((await readdir(postRename)).sort()).toEqual(Object.keys(replacementBundle.files).sort());
    for (const [fileName, contents] of Object.entries(replacementBundle.files)) {
      expect(await readFile(join(postRename, fileName), "utf8")).toBe(contents);
    }
    expect((await readdir(movedOwnedBundle)).sort()).toEqual(Object.keys(replacementBundle.files).sort());
    expect((await readdir(root)).some((entry) => entry.startsWith(".post-rename.membench-publish-"))).toBeFalse();
  });
});
