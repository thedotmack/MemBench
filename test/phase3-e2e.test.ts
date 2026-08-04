import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  corpusContentHash,
  createAttemptWorkspace,
  createRunManifest,
  canonicalJson,
  createDeterministicTestSandbox,
  executorAttemptPolicyFromSpec,
  executeCodingAttempt,
  InMemoryBackend,
  InMemoryRuntimeStore,
  judgeOutcome,
  laneId,
  observeInBackground,
  parseExperimentSpec,
  runResumableExperiment,
  sha256,
  validateCorpusItem,
  type CorpusItem,
  type ExecutorTransport,
  type ModelTransport,
  type ModelTransportRequest,
  type RequestedRoute,
  type ScheduleEntry,
} from "../src";

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true }); });
const route: RequestedRoute = { provider: "synthetic-provider", model: "synthetic-model", allowFallbacks: false };
const sampling = { temperature: 0, topP: 1, seed: "e2e-seed" } as const;

function fixture(): CorpusItem {
  const base = {
    schemaVersion: 1 as const,
    id: "synthetic-e2e-item",
    task: "Set the mode text in the configuration file.",
    mechanicalCheck: { kind: "command" as const, argv: ["synthetic-check"], expectedExitCode: 0 },
    blindSuccessRubric: "The configuration file contains the requested mode.",
    events: [{ eventIndex: 0, kind: "message" as const, role: "user" as const, text: "Use amber mode." }],
    startingTree: { "config.txt": "mode=unset\n" },
  };
  const contentHash = corpusContentHash(base);
  return validateCorpusItem({
    ...base,
    provenance: { schemaVersion: 1, corpusId: "synthetic-e2e-corpus", corpusVersion: "1.0.0", classification: "synthetic", createdAt: "2026-01-01T00:00:00.000Z", origin: { method: "newly_authored_synthetic", description: "Authored for the public offline end-to-end test." }, license: "MIT", authority: { basis: "author", recordReference: "repository contribution record" }, contentHash },
    releaseAttestation: { schemaVersion: 1, corpusId: "synthetic-e2e-corpus", corpusVersion: "1.0.0", reviewedAt: "2026-01-02T00:00:00.000Z", reviewerRole: "maintainer", reviewRecordReference: "synthetic fixture review", decision: "approved", checks: { authorityVerified: true, consentVerified: true, licenseVerified: true, independentReviewComplete: true, sensitiveDataReviewComplete: true, secretScanComplete: true }, contentHash },
    contentHash,
  });
}

describe("fully offline synthetic corpus run", () => {
  test("observer, memory, executor, mechanical check, blind judge, and journal compose", async () => {
    const item = fixture();
    const runRoot = mkdtempSync(join(tmpdir(), "membench-e2e-synthetic-"));
    roots.push(runRoot);
    const spec = parseExperimentSpec(`
version = 1
[experiment]
id = "e2e-study"
repetitions = 3
candidate_models = ["candidate-a"]
executor_lanes = ["lane-a"]
primary_candidate = "candidate-a"
primary_lane = "lane-a"
item_ids = ["item-a", "item-b", "item-c"]
corpus_path = "${runRoot}"
[routes.observer]
provider = "synthetic-provider"
model = "synthetic-model"
allow_fallbacks = false
[routes.executor]
provider = "synthetic-provider"
model = "synthetic-model"
allow_fallbacks = false
[routes.reference]
provider = "synthetic-provider"
model = "synthetic-model"
allow_fallbacks = false
[routes.judge]
provider = "synthetic-provider"
model = "synthetic-model"
allow_fallbacks = false
[seeds]
schedule = "schedule-seed"
bootstrap = "bootstrap-seed"
audit = "audit-seed"
[audit]
sample_size = 1
policy = "uniform_without_replacement"
[observer_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "observer-seed"
[executor_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "e2e-seed"
[decision]
alpha = 0.05
minimum_effect = 0.1
maximum_schema_failure_rate = 0.05
maximum_unknown_outcome_rate = 0.0
minimum_calibrated_items = 3
minimum_attribution_rate = 0.5
minimum_drift_avoidance_rate = 0.5
minimum_audit_agreement = 0.8
bootstrap_samples = 500
multiplicity = "bonferroni"
[commitments]
corpus_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
prompt_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
harness_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
judge_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
observer_event_universe_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
reference_control_universe_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
run_hash = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
[budgets]
observer_usd = 1.0
executor_usd = 1.0
judge_usd = 1.0
maximum_steps = 2
`, { repositoryRoot: process.cwd() });
    const policy = executorAttemptPolicyFromSpec(spec);
    const requests: ModelTransportRequest[] = [];
    const models: ModelTransport = {
      call: async (request) => {
        requests.push(request);
        const text = request.purpose === "observer"
          ? JSON.stringify({ schemaVersion: 1, memories: [{ id: "mode-fact", text: "Use amber mode.", metadata: { source: "synthetic" } }] })
          : JSON.stringify({ outcome: "pass", reason: "The configuration contains the requested mode." });
        return { text, generationId: null, route: { requested: request.route, effective: { provider: request.route.provider, model: request.route.model, routeReported: true } }, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 }, durationMs: 1, modelCalls: 1, steps: 1 };
      },
    };
    const memory = new InMemoryBackend();
    const observer = await observeInBackground({ events: item.events, route, transport: models, memory, sampling });
    const injectedMemory = (await memory.list()).map((record) => record.text).join("\n");
    const workspace = createAttemptWorkspace({ runRoot, attemptId: "attempt-e2e", startingTree: item.startingTree, port: 21_001 });
    const sandbox = createDeterministicTestSandbox(async (command) => {
      const passed = command.argv[0] === "synthetic-check" && readFileSync(join(workspace.work, "config.txt"), "utf8") === "mode=amber\n";
      return { exitCode: passed ? 0 : 1, stdout: "", stderr: "", timedOut: false, processTreeCleaned: true };
    });
    const executor: ExecutorTransport = {
      run: async (request) => {
        expect(request.injectedMemory).toContain("amber");
        expect(request.sampling).toEqual({ temperature: 0, topP: 1, seed: "e2e-seed" });
        request.tools.write("config.txt", "mode=amber\n");
        return { completed: true, generationId: null, route: { requested: route, effective: { provider: null, model: null, routeReported: false } }, usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4, costUsd: 0.02 }, durationMs: 1, steps: 1, modelCalls: 1 };
      },
    };
    const execution = await executeCodingAttempt({ workspace, sandbox, transport: executor, policy, prompt: item.task, injectedMemory, mechanicalCheck: item.mechanicalCheck });
    const judgment = await judgeOutcome({ mechanicalPassed: execution.mechanicalPassed, isolationPassed: execution.isolationPassed, task: item.task, blindRubric: item.blindSuccessRubric!, diffSummary: JSON.stringify(execution.diff), route, transport: models, sampling });
    const scheduleEntry: ScheduleEntry = { sequence: 0, attemptId: "attempt-e2e", itemId: item.id, laneId: laneId("lane-a"), repetition: 0, candidateId: "candidate-a", arm: "candidate" };
    const scheduleBytes = `${canonicalJson([scheduleEntry])}\n`;
    const manifest = createRunManifest({ experimentId: "experiment-e2e", experimentIdentityHash: sha256("e2e-identity"), schedule: { entries: [scheduleEntry], bytes: scheduleBytes, contentHash: sha256(scheduleBytes) }, createdAt: "2026-01-03T00:00:00.000Z" });
    const stored = await runResumableExperiment({
      manifest,
      store: new InMemoryRuntimeStore(),
      budgets: { observerUsd: 1, executorUsd: 1, judgeUsd: 1, maximumSteps: 10 },
      now: () => "2026-01-03T00:00:01.000Z",
      worker: async () => ({ outcome: judgment.outcome, schemaValid: observer.parseState === "valid" && judgment.schemaValid, usage: { observerUsd: observer.usage.costUsd, executorUsd: execution.usage.costUsd, judgeUsd: judgment.telemetry?.usage.costUsd ?? null }, steps: execution.steps }),
    });
    expect(observer.parseState).toBe("valid");
    expect(execution.mechanicalPassed).toBe(true);
    expect(judgment.outcome).toBe("pass");
    expect(stored.rows.some((row) => row.state === "terminal" && row.outcome === "pass")).toBe(true);
    expect(requests.map((request) => request.purpose)).toEqual(["observer", "outcome_judge"]);
  });
});
