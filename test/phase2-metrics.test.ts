import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as publicApi from "../src";
import {
  bootstrapPairedItemEffects,
  compareModelFamily,
  equalItemMean,
  laneId,
  parseExperimentSpec,
  summarizeItemArms,
  hashJson,
  type CalibrationEvidence,
  type ExperimentSpec,
  type ScoredAttempt,
} from "../src";

const lane = laneId("executor-lane");
const corpusDirectory = mkdtempSync(join(tmpdir(), "membench-metrics-corpus."));
afterAll(() => rmSync(corpusDirectory, { recursive: true, force: true }));

function metricSpec(candidateModels: readonly string[] = ["model-a"], minimumEffect = 0.1) {
  return parseExperimentSpec(`
version = 1
[experiment]
id = "metrics-study"
repetitions = 3
candidate_models = ${JSON.stringify(candidateModels)}
executor_lanes = ["executor-lane"]
item_ids = ["item-a", "item-b", "item-c"]
corpus_path = "${corpusDirectory}"
[routes.observer]
provider = "example-provider"
model = "example/observer"
allow_fallbacks = false
[routes.executor]
provider = "example-provider"
model = "example/executor"
allow_fallbacks = false
[routes.reference]
provider = "example-provider"
model = "example/reference"
allow_fallbacks = false
[routes.judge]
provider = "example-provider"
model = "example/judge"
allow_fallbacks = false
[seeds]
schedule = "schedule-seed"
bootstrap = "bootstrap-seed"
audit = "audit-seed"
[decision]
alpha = 0.05
minimum_effect = ${minimumEffect}
maximum_schema_failure_rate = 0.1
minimum_calibrated_items = 3
bootstrap_samples = 500
multiplicity = "bonferroni"
[budgets]
observer_usd = 1.0
executor_usd = 1.0
judge_usd = 1.0
maximum_steps = 20
`, { repositoryRoot: process.cwd() });
}

function attempt(
  itemId: string,
  arm: ScoredAttempt["arm"],
  outcome: ScoredAttempt["outcome"],
  repetition: number,
  tokensToDone: number | null = outcome === "pass" ? 10 : null,
  schemaValid = true,
  candidateId = "model-a",
): ScoredAttempt {
  return { calibration: false, itemId, laneId: lane, candidateId, arm, outcome, repetition, tokensToDone, schemaValid };
}

const metricItemIds = ["item-a", "item-b", "item-c"] as const;
const metricArms = ["candidate", "none", "shuffled", "reference"] as const;

function completeAttempts(
  candidateIds: readonly string[] = ["model-a"],
  outcomeFor: (
    itemId: string,
    arm: ScoredAttempt["arm"],
    candidateId: string,
    repetition: number,
  ) => ScoredAttempt["outcome"] = (_itemId, arm) =>
    arm === "candidate" || arm === "reference" ? "pass" : "fail",
): ScoredAttempt[] {
  return candidateIds.flatMap((candidateId) => metricItemIds.flatMap((itemId) =>
    metricArms.flatMap((arm) => Array.from({ length: 3 }, (_, repetition) =>
      attempt(itemId, arm, outcomeFor(itemId, arm, candidateId, repetition), repetition, undefined, true, candidateId)
    ))
  ));
}

function calibrated(itemIds: readonly string[]): CalibrationEvidence[] {
  return itemIds.map((itemId) => ({
    itemId,
    laneId: lane,
    floorOutcome: "fail",
    referenceOutcome: "pass",
    eligible: true,
    reason: "calibrated",
  }));
}

describe("item-level metrics", () => {
  test("items receive equal weight despite unequal repetition counts", () => {
    const attempts = [
      ...Array.from({ length: 9 }, (_, index) => attempt("item-a", "candidate", "pass", index)),
      attempt("item-a", "candidate", "fail", 9),
      attempt("item-b", "candidate", "fail", 0),
    ];
    const summaries = summarizeItemArms(attempts);
    expect(summaries.map((entry) => entry.passRate)).toEqual([0.9, 0]);
    expect(equalItemMean(summaries, "passRate")).toBeCloseTo(0.45);
  });

  test("unknown outcomes and missing usage propagate", () => {
    const summaries = summarizeItemArms([
      attempt("item-a", "candidate", "unknown", 0, null),
      attempt("item-b", "candidate", "pass", 0, null),
      attempt("item-b", "candidate", "unknown", 1, null),
    ]);
    expect(summaries[0]?.passRate).toBeNull();
    expect(summaries[1]?.passRate).toBeNull();
    expect(summaries[1]?.tokensToDone).toBeNull();
    expect(equalItemMean(summaries, "tokensToDone")).toBeNull();
  });

  test("bootstrap accepts one paired value per item and is seed deterministic", () => {
    const effects = [
      { itemId: "item-a", value: -0.2 },
      { itemId: "item-b", value: 0.4 },
      { itemId: "item-c", value: 0.8 },
    ];
    const options = { seed: "bootstrap-one", samples: 500, alpha: 0.05, comparisonFamilySize: 2 };
    const first = bootstrapPairedItemEffects(effects, options);
    expect(first).toEqual(bootstrapPairedItemEffects(effects, options));
    expect(first).not.toEqual(bootstrapPairedItemEffects(effects, { ...options, seed: "bootstrap-two" }));
    expect(first.adjustedAlpha).toBe(0.025);
    expect(first.inferentialUnit).toBe("item");
    expect(() => bootstrapPairedItemEffects([...effects, effects[0]!], options)).toThrow("unique item");
    expect(bootstrapPairedItemEffects([...effects].reverse(), options)).toEqual(first);
    expect(() => bootstrapPairedItemEffects([{ itemId: "item-a", value: 2 }], options)).toThrow("bounded");
    expect(() => bootstrapPairedItemEffects(
      Array.from({ length: 101 }, (_, index) => ({ itemId: `item-${index}`, value: 0.1 })),
      { ...options, samples: 100_000 },
    )).toThrow("bounded allocation");
  });

  test("reports positive reference gaps without treating them as invalid", () => {
    const attempts = completeAttempts(["model-a"], (itemId, arm) =>
      arm === "candidate" ? itemId === "item-a" ? "pass" : "fail" : arm === "reference" ? "pass" : "fail"
    );
    const [comparison] = compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    );
    expect(comparison?.floorDelta?.estimate).toBeCloseTo(1 / 3);
    expect(comparison?.referenceGap?.estimate).toBeCloseTo(2 / 3);
  });

  test("low calibration evidence never forces a winner", () => {
    const [comparison] = compareModelFamily(
      completeAttempts(),
      calibrated(["item-a"]),
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    );
    expect(comparison?.decision).toBe("insufficient_evidence");
  });

  test("calibration rows cannot be scored", () => {
    const invalid = { ...attempt("item-a", "candidate", "pass", 0), calibration: true };
    expect(() => summarizeItemArms([invalid as unknown as ScoredAttempt])).toThrow("calibration attempts");
  });

  test("runtime attempt validation rejects duplicate coordinates and invalid flags", () => {
    const valid = attempt("item-a", "candidate", "pass", 0);
    expect(() => summarizeItemArms([valid, { ...valid }])).toThrow("coordinate is duplicated");
    expect(() => summarizeItemArms([{ ...valid, outcome: "maybe" } as unknown as ScoredAttempt])).toThrow("runtime fields");
    expect(() => summarizeItemArms([{ ...valid, schemaValid: 1 } as unknown as ScoredAttempt])).toThrow("runtime fields");
  });

  test("non-passing attempts cannot acquire a favorable completion-token value", () => {
    expect(() => summarizeItemArms([
      attempt("item-a", "candidate", "fail", 0, 0),
    ])).toThrow("must be missing");
    expect(() => summarizeItemArms([
      attempt("item-a", "candidate", "pass", 0, 1.5),
    ])).toThrow("bounded non-negative integer");
    expect(() => summarizeItemArms([
      attempt("item-a", "candidate", "pass", 0, 1e308),
    ])).toThrow("bounded non-negative integer");
  });

  test("internally inconsistent calibration evidence is rejected", () => {
    const inconsistent: CalibrationEvidence = {
      itemId: "item-a",
      laneId: lane,
      floorOutcome: "pass",
      referenceOutcome: "pass",
      eligible: true,
      reason: "calibrated",
    };
    expect(() => compareModelFamily(
      completeAttempts(),
      [inconsistent],
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    )).toThrow("internally inconsistent");
  });

  test("duplicate calibration and comparison coordinates fail closed", () => {
    const attempts = completeAttempts();
    const evidence = calibrated(metricItemIds);
    expect(() => compareModelFamily(
      attempts,
      [...evidence, evidence[0]!],
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    )).toThrow("calibration item and lane coordinate is duplicated");
    expect(() => compareModelFamily(
      attempts,
      evidence,
      [
        { candidateId: "model-a", laneId: lane },
        { candidateId: "model-a", laneId: lane },
      ],
      metricSpec(),
    )).toThrow("unique prespecified");
  });

  test("decision policy must be a genuinely parsed branded specification", () => {
    const parsed = metricSpec();
    const tampered = Object.freeze({ ...parsed, identityHash: hashJson({ changed: true }) }) as ExperimentSpec;
    expect(() => compareModelFamily(
      [],
      [],
      [{ candidateId: "model-a", laneId: lane }],
      tampered,
    )).toThrow("parsed and frozen");
  });

  test("comparison rejects a forged impossible summary instead of treating it as scored data", () => {
    const [summary] = summarizeItemArms([attempt("item-a", "candidate", "pass", 0)]);
    expect(() => compareModelFamily(
      [{ ...summary!, schemaFailureRate: Number.NaN }] as unknown as ScoredAttempt[],
      [],
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    )).toThrow();
  });

  test("comparison family size adjusts inference and raw estimates remain visible", () => {
    const attempts = completeAttempts(["model-a", "model-b"]);
    const results = compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [
        { candidateId: "model-a", laneId: lane },
        { candidateId: "model-b", laneId: lane },
      ],
      metricSpec(["model-a", "model-b"], 0.2),
    );
    expect(results.every((result) => result.floorDelta?.adjustedAlpha === 0.025)).toBeTrue();
    expect(results.every((result) => result.floorDelta?.estimate === 1)).toBeTrue();
    expect(results.every((result) => result.decision === "recommend")).toBeTrue();
  });

  test("missing repetitions make the whole model family insufficient", () => {
    const attempts = completeAttempts(["model-a", "model-b"]);
    attempts.pop();
    const results = compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [
        { candidateId: "model-a", laneId: lane },
        { candidateId: "model-b", laneId: lane },
      ],
      metricSpec(["model-a", "model-b"]),
    );
    expect(results.every((result) => result.decision === "insufficient_evidence")).toBeTrue();
    expect(results.every((result) => result.decisionReasons.includes("incomplete_attempt_matrix"))).toBeTrue();
    expect(results.every((result) => result.floorDelta === null)).toBeTrue();
  });

  test("spec-level repetition bounds reject repetition 99", () => {
    const attempts = completeAttempts();
    attempts.push({ ...attempts[0]!, repetition: 99 });
    expect(() => compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    )).toThrow("exceeds the prespecified experiment");
  });

  test("explicit unknown rows count as a complete attempt matrix", () => {
    const attempts = completeAttempts(["model-a"], (_itemId, arm) =>
      arm === "candidate" ? "unknown" : arm === "reference" ? "pass" : "fail"
    );
    const [result] = compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [{ candidateId: "model-a", laneId: lane }],
      metricSpec(),
    );
    expect(result?.decision).toBe("insufficient_evidence");
    expect(result?.decisionReasons).toContain("too_few_paired_known_outcomes");
    expect(result?.decisionReasons).not.toContain("incomplete_attempt_matrix");
  });

  test("comparison output is canonical regardless of caller family order", () => {
    const attempts = completeAttempts(["model-b", "model-a"]);
    const forward = compareModelFamily(
      attempts,
      calibrated(metricItemIds),
      [
        { candidateId: "model-a", laneId: lane },
        { candidateId: "model-b", laneId: lane },
      ],
      metricSpec(["model-b", "model-a"]),
    );
    const reversed = compareModelFamily(
      [...attempts].reverse(),
      calibrated(metricItemIds),
      [
        { candidateId: "model-b", laneId: lane },
        { candidateId: "model-a", laneId: lane },
      ],
      metricSpec(["model-b", "model-a"]),
    );
    expect(forward.map((result) => result.candidateId)).toEqual(["model-a", "model-b"]);
    expect(hashJson(forward)).toBe(hashJson(reversed));
  });
});

test("public exports avoid misleading aggregate and answer-key terminology", () => {
  const exportedNames = Object.keys(publicApi).join(" ").toLocaleLowerCase();
  const forbidden = [
    ["pool", "edtoken"].join(""),
    ["or", "acle"].join(""),
    ["ceiling", "attainment"].join(""),
  ];
  for (const term of forbidden) expect(exportedNames).not.toContain(term);
  expect(exportedNames).not.toContain("comparisonsettings");
  expect(exportedNames).not.toContain("comparecandidate");
  expect(exportedNames).not.toContain("deepfreeze");
});
