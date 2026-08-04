import { dirname, resolve } from "node:path";

import { sha256 } from "../src/canonical";
import { deriveExperimentArtifactCommitments, issueExperimentArtifacts } from "../src/artifacts";
import {
  issueExperimentAuditEvidenceFamily,
  predeclareExperimentAuditSample,
  runIndependentExperimentAudit,
  type AuditJudgeConfig,
} from "../src/audit";
import { bindCalibrationReference } from "../src/calibration";
import { compileReferenceControl } from "../src/controls";
import { corpusContentHash, validateCorpusItem } from "../src/corpus";
import { laneId } from "../src/domain";
import { runExperimentEvidence, type PrimaryJudgeInput, type PrimaryJudgeResult } from "../src/evidence";
import { compareModelFamily } from "../src/metrics";
import { InMemoryBackend } from "../src/memory";
import type { ModelTransport } from "../src/model-transport";
import { observeExperimentInBackground } from "../src/observer";
import { writePublicBundle } from "../src/public-bundle";
import { createReport } from "../src/report";
import { parseExperimentSpec } from "../src/spec";

function outputArgument(argv: readonly string[]): string {
  if (argv.length !== 2 || argv[0] !== "--output" || !argv[1]) {
    throw new TypeError("usage: bun run demo --output <new-directory>");
  }
  return resolve(argv[1]);
}

const output = outputArgument(Bun.argv.slice(2));
const corpusRoot = dirname(output);
const itemIds = ["item-a", "item-b", "item-c"];
const eventBatches = itemIds.map((itemId) => ({
  itemId,
  events: [{ eventIndex: 0, kind: "message" as const, role: "user" as const, text: `Use synthetic mode for ${itemId}.` }],
}));
const artifactCreatedAt = "2026-01-03T00:00:00.000Z";
const corpusItems = itemIds.map((itemId) => {
  const text = `Use synthetic mode for ${itemId}.`;
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
      schemaVersion: 1, corpusId: `offline-${itemId}`, corpusVersion: "1.0.0", classification: "synthetic" as const,
      createdAt: "2026-01-01T00:00:00.000Z", origin: { method: "newly_authored_synthetic" as const, description: "Authored synthetic demonstration fixture." },
      license: "MIT", authority: { basis: "author" as const, recordReference: "repository review record" }, contentHash,
    },
    releaseAttestation: {
      schemaVersion: 1, corpusId: `offline-${itemId}`, corpusVersion: "1.0.0", reviewedAt: "2026-01-02T00:00:00.000Z",
      reviewerRole: "maintainer", reviewRecordReference: "synthetic fixture review", decision: "approved" as const,
      checks: { authorityVerified: true, consentVerified: true, licenseVerified: true, independentReviewComplete: true, sensitiveDataReviewComplete: true, secretScanComplete: true }, contentHash,
    },
    contentHash,
  });
});
const specSource = (commitments: {
  readonly corpusHash: string; readonly promptHash: string; readonly harnessHash: string;
  readonly judgeHash: string; readonly observerEventUniverseHash: string; readonly referenceControlUniverseHash: string; readonly runHash: string;
}) => `
version = 1
[experiment]
id = "offline-demo"
repetitions = 3
candidate_models = ["synthetic-candidate"]
executor_lanes = ["offline-synthetic"]
primary_candidate = "synthetic-candidate"
primary_lane = "offline-synthetic"
item_ids = ["item-a", "item-b", "item-c"]
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
schedule = "offline-schedule"
bootstrap = "offline-bootstrap"
audit = "offline-audit"
[audit]
sample_size = 1
policy = "uniform_without_replacement"
[observer_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "offline-observer"
[executor_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "offline-sampling"
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
maximum_steps = 100
`;
const unsetCommitment = sha256("offline-unverified-placeholder");
const preliminarySpec = parseExperimentSpec(specSource({
  corpusHash: unsetCommitment, promptHash: unsetCommitment, harnessHash: unsetCommitment,
  judgeHash: unsetCommitment, observerEventUniverseHash: unsetCommitment,
  referenceControlUniverseHash: unsetCommitment, runHash: unsetCommitment,
}), { repositoryRoot: process.cwd() });
const references = corpusItems.map((item) => {
  const event = item.events[0];
  const text = event?.kind === "message" ? event.text : "";
  const control = compileReferenceControl(item, [{ text, eventIndex: 0, supportingQuote: text }]).control;
  return bindCalibrationReference({ item, laneId: laneId("offline-synthetic"), control });
});
const derivedCommitments = deriveExperimentArtifactCommitments({
  spec: preliminarySpec, corpusItems, references, createdAt: artifactCreatedAt,
});
const spec = parseExperimentSpec(specSource(derivedCommitments), { repositoryRoot: process.cwd() });
const artifacts = issueExperimentArtifacts({ spec, corpusItems, references, createdAt: artifactCreatedAt });
const transport: ModelTransport = {
  call: (() => {
    let call = 0;
    return async (request) => ({
    text: JSON.stringify({ schemaVersion: 1, memories: [{ id: `synthetic-fact-${++call}`, text: "Use synthetic mode.", metadata: { source: "fixture" } }] }),
    generationId: null,
    route: {
      requested: request.route,
      effective: { provider: request.route.provider, model: request.route.model, routeReported: true },
    },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    durationMs: 1,
    modelCalls: 1,
    steps: 1,
    });
  })(),
};
const observerBatch = await observeExperimentInBackground({
  spec,
  artifacts,
  eventBatches,
  transport,
  memory: new InMemoryBackend(),
});
const primaryJudge = (input: PrimaryJudgeInput): PrimaryJudgeResult => {
  const outcome = input.purpose === "outcome"
    ? input.entry.arm === "candidate" || input.entry.arm === "reference" ? "pass" : "fail"
    : "pass";
  return {
    purpose: input.purpose,
    outcome,
    schemaValid: true,
    attributedInputCommitment: input.purpose === "attribution" ? input.inputCommitment : null,
    route: { requested: input.config.route, effective: { provider: input.config.route.provider, model: input.config.route.model, routeReported: true } },
    generationId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    durationMs: 1,
    protocolHash: input.config.protocolHash,
    configHash: input.config.configHash,
  };
};
const executionBatch = await runExperimentEvidence({
  spec,
  artifacts,
  observerBatch,
  calibrationRunner: { run: async (request) => ({
    attemptId: request.attemptId,
    outcome: request.injectionText === "" ? "fail" : "pass",
    reportedCostUsd: 0,
    route: { requested: request.route, effective: { provider: request.route.provider, model: request.route.model, routeReported: true } },
  }) },
  attemptRunner: { run: async (input) => {
    void input;
    return {
      reportedCostUsd: 0,
      durationMs: 1,
      route: { requested: spec.routes.executor, effective: { provider: spec.routes.executor.provider, model: spec.routes.executor.model, routeReported: true } },
      generationId: null,
      tokenCount: 10,
      steps: 1,
      modelCalls: 1,
      executionArtifacts: {
        executorResponse: {
          schemaVersion: 1 as const,
          completed: true,
          responseText: "Synthetic executor response artifact.",
          diffSummary: "Synthetic configuration changed.",
          downstreamEvidence: ["Synthetic check evidence."],
        },
        toolTrace: [{ sequence: 0, tool: "synthetic-check", state: "completed" as const, summary: "Synthetic check completed." }],
      },
    };
  } },
  primaryJudges: {
    outcome: { run: async (input) => primaryJudge(input) },
    attribution: { run: async (input) => primaryJudge(input) },
    drift: { run: async (input) => primaryJudge(input) },
  },
  now: () => "2026-01-03T00:00:00.000Z",
});
const comparisons = compareModelFamily(executionBatch, spec);
const auditEvidence = issueExperimentAuditEvidenceFamily(spec, comparisons);
const auditManifest = predeclareExperimentAuditSample(spec, comparisons, auditEvidence);
const auditResult = await runIndependentExperimentAudit(auditManifest, auditEvidence, {
  judge: async ({ config }: { config: AuditJudgeConfig }) => ({
    outcome: "pass",
    route: { requested: config.route, effective: { provider: config.route.provider, model: config.route.model, routeReported: true } },
    generationId: null,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
    durationMs: 1,
    protocolHash: config.protocolHash,
    configHash: config.configHash,
  }),
});
const report = createReport({
  spec,
  comparisons,
  auditResult,
});
const checks = { authorityVerified: true, consentVerified: true, licenseVerified: true, independentReviewComplete: true, sensitiveDataReviewComplete: true, secretScanComplete: true };
const bundle = await writePublicBundle({
  report,
  provenance: {
    schemaVersion: 1, corpusId: "offline-synthetic", corpusVersion: "1.0.0", classification: "synthetic",
    createdAt: "2026-01-01T00:00:00.000Z",
    origin: { method: "newly_authored_synthetic", description: "Newly authored synthetic aggregate demonstration data" },
    license: "MIT", authority: { basis: "author", recordReference: sha256("offline-authority") }, contentHash: artifacts.corpusHash,
  },
  releaseAttestation: {
    schemaVersion: 1, corpusId: "offline-synthetic", corpusVersion: "1.0.0", reviewedAt: "2026-01-02T00:00:00.000Z",
    reviewerRole: "synthetic-fixture-reviewer", reviewRecordReference: sha256("offline-review"), decision: "approved", checks, contentHash: artifacts.corpusHash,
  },
  includeJunit: true,
}, output);
process.stdout.write(`MemBench offline synthetic bundle: ${bundle.bundleHash}\n`);
