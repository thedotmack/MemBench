import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";

import { assertExperimentSpecIdentity, executorAttemptPolicyFromSpec, parseExperimentSpec, type ExperimentSpec } from "../src";

const repositoryRoot = process.cwd();
const externalCorpusDirectory = mkdtempSync(join(tmpdir(), "membench-spec-corpus."));
const secondCorpusDirectory = mkdtempSync(join(tmpdir(), "membench-spec-second."));
afterAll(() => {
  rmSync(externalCorpusDirectory, { recursive: true, force: true });
  rmSync(secondCorpusDirectory, { recursive: true, force: true });
});

function spec(overrides = ""): string {
  return `
version = 1

[experiment]
id = "synthetic-study"
repetitions = 3
candidate_models = ["candidate-a", "candidate-b"]
executor_lanes = ["executor-a"]
item_ids = ["item-a", "item-b", "item-c"]
corpus_path = "${externalCorpusDirectory}"

[routes.observer]
provider = "example-provider"
model = "example/model-a"
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

[executor_sampling]
temperature = 0.0
top_p = 1.0
seed_identity = "executor-seed"

[decision]
alpha = 0.05
minimum_effect = 0.1
maximum_schema_failure_rate = 0.05
minimum_calibrated_items = 3
bootstrap_samples = 500
multiplicity = "bonferroni"

[budgets]
observer_usd = 1.0
executor_usd = 2.0
judge_usd = 1.0
maximum_steps = 20
${overrides}`;
}

describe("strict experiment specification", () => {
  test("parses a fully prespecified experiment and freezes its identity", () => {
    const parsed = parseExperimentSpec(spec(), { repositoryRoot });
    expect(parsed.experiment.repetitions).toBe(3);
    expect(parsed.routes.observer.allowFallbacks).toBeFalse();
    expect(parsed.decision.multiplicity).toBe("bonferroni");
    expect(parsed.executorSampling).toEqual({ temperature: 0, topP: 1, seedIdentity: "executor-seed" });
    expect(parsed.identityHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(Object.isFrozen(parsed)).toBeTrue();
    expect(Object.isFrozen(parsed.decision)).toBeTrue();
  });

  test("decision settings are part of immutable experiment identity", () => {
    const first = parseExperimentSpec(spec(), { repositoryRoot });
    const second = parseExperimentSpec(spec().replace("minimum_effect = 0.1", "minimum_effect = 0.2"), { repositoryRoot });
    expect(first.identityHash).not.toBe(second.identityHash);
  });

  test("executor sampling is strict, frozen, and bound to experiment identity", () => {
    const first = parseExperimentSpec(spec(), { repositoryRoot });
    const second = parseExperimentSpec(spec().replace("seed_identity = \"executor-seed\"", "seed_identity = \"other-seed\""), { repositoryRoot });
    expect(first.identityHash).not.toBe(second.identityHash);
    expect(Object.isFrozen(first.executorSampling)).toBeTrue();
    const firstPolicy = executorAttemptPolicyFromSpec(first);
    const secondPolicy = executorAttemptPolicyFromSpec(second);
    expect(firstPolicy.policyHash).not.toBe(secondPolicy.policyHash);
    expect(firstPolicy.sampling).toEqual({ temperature: 0, topP: 1, seed: "executor-seed" });
    expect(() => parseExperimentSpec(spec().replace("seed_identity = \"executor-seed\"", "seed_identity = \"\""), { repositoryRoot })).toThrow();
    expect(() => parseExperimentSpec(spec().replace("top_p = 1.0", "top_p = 2.0"), { repositoryRoot })).toThrow();
  });

  test("portable identity excludes the host-local corpus directory", () => {
    const first = parseExperimentSpec(spec(), { repositoryRoot });
    const second = parseExperimentSpec(spec().replace(externalCorpusDirectory, secondCorpusDirectory), { repositoryRoot });
    expect(first.experiment.corpusPath).not.toBe(second.experiment.corpusPath);
    expect(first.identityHash).toBe(second.identityHash);
  });

  test("structured clones must be reparsed before scientific use", () => {
    const parsed = parseExperimentSpec(spec(), { repositoryRoot });
    const cloned = structuredClone(parsed) as ExperimentSpec;
    expect(cloned.identityHash).toBe(parsed.identityHash);
    expect(() => assertExperimentSpecIdentity(cloned)).toThrow("parsed and frozen");
  });

  test("rejects unknown keys and too few repetitions", () => {
    expect(() => parseExperimentSpec(spec().replace("repetitions = 3", "repetitions = 2"), { repositoryRoot })).toThrow("at least 3");
    expect(() => parseExperimentSpec(spec("\nextra = true"), { repositoryRoot })).toThrow("budgets has unknown key");
  });

  test("rejects unsafe item identifiers and repository-local corpus paths", () => {
    expect(() => parseExperimentSpec(spec().replace("item-a", "../item-a"), { repositoryRoot })).toThrow("safe identifier");
    expect(() => parseExperimentSpec(spec().replace(externalCorpusDirectory, repositoryRoot), { repositoryRoot })).toThrow("outside the repository");
  });

  test("rejects filesystem roots and ancestors containing the repository", () => {
    expect(() => parseExperimentSpec(spec().replace(externalCorpusDirectory, parsePath(repositoryRoot).root), { repositoryRoot })).toThrow("outside the repository");
    expect(() => parseExperimentSpec(spec().replace(externalCorpusDirectory, dirname(repositoryRoot)), { repositoryRoot })).toThrow("outside the repository");
  });

  test("shared identifier limits reject 81-character candidates, items, and lanes", () => {
    const tooLong = "a".repeat(81);
    expect(() => parseExperimentSpec(spec().replace("candidate-a", tooLong), { repositoryRoot })).toThrow("at most 80");
    expect(() => parseExperimentSpec(spec().replace("item-a", tooLong), { repositoryRoot })).toThrow("at most 80");
    expect(() => parseExperimentSpec(spec().replace("executor-a", tooLong), { repositoryRoot })).toThrow("at most 80");
  });

  test("realpath containment rejects an external symlink into the repository", () => {
    const link = join(externalCorpusDirectory, "repository-link");
    symlinkSync(repositoryRoot, link, "dir");
    expect(() => parseExperimentSpec(spec().replace(externalCorpusDirectory, link), { repositoryRoot })).toThrow("outside the repository");
  });

  test("requires explicit routes, fallbacks, seeds, thresholds, and budgets", () => {
    expect(() => parseExperimentSpec(spec().replace("allow_fallbacks = false\n\n[routes.executor]", "\n[routes.executor]"), { repositoryRoot })).toThrow("missing key: allow_fallbacks");
    expect(() => parseExperimentSpec(spec().replace("allow_fallbacks = false", "allow_fallbacks = true"), { repositoryRoot })).toThrow("must be false");
    expect(() => parseExperimentSpec(spec().replace("audit = \"audit-seed\"", ""), { repositoryRoot })).toThrow("missing key: audit");
    expect(() => parseExperimentSpec(spec().replace("seed_identity = \"executor-seed\"", ""), { repositoryRoot })).toThrow("missing key: seed_identity");
    expect(() => parseExperimentSpec(spec().replace("minimum_calibrated_items = 3", "minimum_calibrated_items = 2"), { repositoryRoot })).toThrow("at least 3");
    expect(() => parseExperimentSpec(spec().replace("judge_usd = 1.0", ""), { repositoryRoot })).toThrow("missing key: judge_usd");
  });

  test("requires a fixed multiplicity policy and sufficient bootstrap samples", () => {
    expect(() => parseExperimentSpec(spec().replace("bonferroni", "none"), { repositoryRoot })).toThrow("must equal bonferroni");
    expect(() => parseExperimentSpec(spec().replace("bootstrap_samples = 500", "bootstrap_samples = 100"), { repositoryRoot })).toThrow("at least 500");
  });

  test("rejects zero effects and bounded-allocation overflows", () => {
    expect(() => parseExperimentSpec(spec().replace("minimum_effect = 0.1", "minimum_effect = 0.0"), { repositoryRoot })).toThrow("at least");
    expect(() => parseExperimentSpec(spec().replace("repetitions = 3", "repetitions = 101"), { repositoryRoot })).toThrow("between 3 and 100");
    expect(() => parseExperimentSpec(spec().replace("maximum_steps = 20", "maximum_steps = 10001"), { repositoryRoot })).toThrow("between 1 and 10000");
    expect(() => parseExperimentSpec(spec().replace("alpha = 0.05", "alpha = 0.0000001"), { repositoryRoot })).toThrow("at least");
  });

  test("rejects unschedulable and family-wide bootstrap products", () => {
    const candidates = Array.from({ length: 16 }, (_, index) => `"candidate-${index}"`).join(", ");
    const lanes = Array.from({ length: 10 }, (_, index) => `"lane-${index}"`).join(", ");
    const items = Array.from({ length: 100 }, (_, index) => `"item-${index}"`).join(", ");
    const expanded = spec()
      .replace('["candidate-a", "candidate-b"]', `[${candidates}]`)
      .replace('["executor-a"]', `[${lanes}]`)
      .replace('["item-a", "item-b", "item-c"]', `[${items}]`)
      .replace("repetitions = 3", "repetitions = 4");
    expect(() => parseExperimentSpec(expanded, { repositoryRoot })).toThrow("experiment schedule exceeds");

    const familyHeavy = expanded
      .replace("repetitions = 4", "repetitions = 3")
      .replace("bootstrap_samples = 500", "bootstrap_samples = 1001");
    expect(() => parseExperimentSpec(familyHeavy, { repositoryRoot })).toThrow("comparison family bootstrap exceeds");
  });

  test("unknown-key failures do not echo untrusted names", () => {
    const untrustedName = "untrusted-synthetic-field";
    try {
      parseExperimentSpec(spec(`\n${untrustedName} = true`), { repositoryRoot });
      throw new Error("expected parser rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("unknown key");
      expect((error as Error).message).not.toContain(untrustedName);
    }
  });
});
