import { realpathSync, statSync } from "node:fs";
import { isAbsolute, parse as parsePath, relative, resolve, sep } from "node:path";

import { deepFreeze, hashJson } from "./canonical";
import type { RequestedRoute, Sha256 } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { checkedProductWithin, SCIENTIFIC_LIMITS } from "./limits";
import { requireFixedRoute } from "./runtime-validation";

const parsedSpecBrand: unique symbol = Symbol("MemBench parsed experiment specification");
const issuedSpecs = new WeakSet<object>();

export interface ExperimentSpec {
  readonly [parsedSpecBrand]: true;
  readonly version: 1;
  readonly experiment: {
    readonly id: string;
    readonly repetitions: number;
    readonly candidateModels: readonly string[];
    readonly executorLanes: readonly string[];
    readonly primaryCandidate: string;
    readonly primaryLane: string;
    readonly itemIds: readonly string[];
    readonly corpusPath: string;
  };
  readonly routes: {
    readonly observer: RequestedRoute;
    readonly executor: RequestedRoute;
    readonly reference: RequestedRoute;
    readonly judge: RequestedRoute;
  };
  readonly seeds: {
    readonly schedule: string;
    readonly bootstrap: string;
    readonly audit: string;
  };
  readonly audit: {
    readonly sampleSize: number;
    readonly policy: "uniform_without_replacement";
  };
  readonly observerSampling: {
    readonly temperature: number;
    readonly topP: number;
    readonly seedIdentity: string;
  };
  readonly executorSampling: {
    readonly temperature: number;
    readonly topP: number;
    readonly seedIdentity: string;
  };
  readonly decision: {
    readonly alpha: number;
    readonly minimumEffect: number;
    readonly maximumSchemaFailureRate: number;
    readonly maximumUnknownOutcomeRate: 0;
    readonly minimumCalibratedItems: number;
    readonly minimumAttributionRate: number;
    readonly minimumDriftAvoidanceRate: number;
    readonly minimumAuditAgreement: number;
    readonly bootstrapSamples: number;
    readonly multiplicity: "bonferroni";
  };
  readonly commitments: {
    readonly corpusHash: Sha256;
    readonly promptHash: Sha256;
    readonly harnessHash: Sha256;
    readonly judgeHash: Sha256;
    readonly observerEventUniverseHash: Sha256;
    readonly referenceControlUniverseHash: Sha256;
    readonly runHash: Sha256;
  };
  readonly budgets: {
    readonly observerUsd: number;
    readonly executorUsd: number;
    readonly judgeUsd: number;
    readonly maximumSteps: number;
  };
  readonly identityHash: Sha256;
}

export interface ParseSpecOptions {
  readonly repositoryRoot: string;
}

type Table = Record<string, unknown>;

function table(value: unknown, label: string): Table {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a table`);
  }
  return value as Table;
}

function exactKeys(value: Table, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  if (unknown.length > 0) throw new TypeError(`${label} has unknown key`);
  if (missing.length > 0) throw new TypeError(`${label} is missing key: ${missing[0]}`);
}

function stringValue(value: unknown, label: string, maximumLength = 500): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximumLength || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new TypeError(`${label} must be non-empty bounded text`);
  }
  return value;
}

function safeIdentifier(value: unknown, label: string): string {
  return requireSafeIdentifier(value, label);
}

function hashValue(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError(`${label} must be a sha256 commitment`);
  }
  return value as Sha256;
}

function numberValue(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${label} must be a finite number of at least ${minimum}`);
  }
  return value;
}

function integerValue(value: unknown, label: string, minimum: number, maximum: number): number {
  const result = numberValue(value, label, minimum);
  if (!Number.isSafeInteger(result) || result > maximum) {
    throw new TypeError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return result;
}

function uniqueStrings(value: unknown, label: string, minimumLength: number, maximumLength: number): readonly string[] {
  if (!Array.isArray(value) || value.length < minimumLength || value.length > maximumLength) {
    throw new TypeError(`${label} must contain between ${minimumLength} and ${maximumLength} entries`);
  }
  const values = value.map((entry, index) => stringValue(entry, `${label}[${index}]`));
  if (new Set(values).size !== values.length) throw new TypeError(`${label} must be unique`);
  return values;
}

function route(value: unknown, label: string): RequestedRoute {
  const source = table(value, label);
  exactKeys(source, ["provider", "model", "allow_fallbacks"], label);
  if (typeof source.allow_fallbacks !== "boolean") {
    throw new TypeError(`${label}.allow_fallbacks must be explicit`);
  }
  if (source.allow_fallbacks) {
    throw new TypeError(`${label}.allow_fallbacks must be false for a scientific primary run`);
  }
  return requireFixedRoute({
    provider: source.provider as string,
    model: source.model as string,
    allowFallbacks: source.allow_fallbacks,
  });
}

function externalCorpusPath(value: unknown, repositoryRoot: string): string {
  const candidate = stringValue(value, "experiment.corpus_path");
  if (!isAbsolute(candidate) || candidate.split(/[\\/]/u).includes("..") || resolve(candidate) !== candidate) {
    throw new TypeError("experiment.corpus_path must be an absolute normalized path");
  }
  let resolvedCandidate: string;
  let resolvedRepository: string;
  try {
    resolvedCandidate = realpathSync(resolve(candidate));
    resolvedRepository = realpathSync(resolve(repositoryRoot));
  } catch {
    throw new TypeError("experiment.corpus_path and repository root must exist");
  }
  if (!statSync(resolvedCandidate).isDirectory()) {
    throw new TypeError("experiment.corpus_path must identify a directory");
  }
  const within = (parent: string, child: string): boolean => {
    const relation = relative(parent, child);
    return relation === "" || (!relation.startsWith(`..${sep}`) && relation !== ".." && !isAbsolute(relation));
  };
  if (
    parsePath(resolvedCandidate).root === resolvedCandidate ||
    within(resolvedRepository, resolvedCandidate) ||
    within(resolvedCandidate, resolvedRepository)
  ) {
    throw new TypeError("experiment.corpus_path must be outside the repository");
  }
  return resolvedCandidate;
}

function identityPayload(spec: Omit<ExperimentSpec, "identityHash">): object {
  const { corpusPath: _hostLocalPath, ...portableExperiment } = spec.experiment;
  const { commitments: _expectedArtifactCommitments, ...configuration } = spec;
  return {
    version: configuration.version,
    experiment: portableExperiment,
    routes: configuration.routes,
    seeds: configuration.seeds,
    audit: configuration.audit,
    observerSampling: configuration.observerSampling,
    executorSampling: configuration.executorSampling,
    decision: configuration.decision,
    budgets: configuration.budgets,
  };
}

export function assertExperimentSpecIdentity(spec: ExperimentSpec): void {
  if (!issuedSpecs.has(spec) || !Object.isFrozen(spec) || !Object.isFrozen(spec.decision) || !Object.isFrozen(spec.audit)) {
    throw new TypeError("experiment specification must be parsed and frozen");
  }
  const { identityHash, ...payload } = spec;
  if (identityHash !== hashJson(identityPayload(payload))) {
    throw new TypeError("experiment specification identity hash mismatch");
  }
}

export function parseExperimentSpec(source: string, options: ParseSpecOptions): ExperimentSpec {
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(source);
  } catch (error) {
    throw new TypeError(`invalid TOML: ${error instanceof Error ? error.message : "parse failure"}`);
  }
  const root = table(parsed, "spec");
  exactKeys(root, ["version", "experiment", "routes", "seeds", "audit", "observer_sampling", "executor_sampling", "decision", "commitments", "budgets"], "spec");
  if (root.version !== 1) throw new TypeError("spec.version must equal 1");

  const experiment = table(root.experiment, "experiment");
  exactKeys(experiment, ["id", "repetitions", "candidate_models", "executor_lanes", "primary_candidate", "primary_lane", "item_ids", "corpus_path"], "experiment");
  const repetitions = integerValue(experiment.repetitions, "experiment.repetitions", 3, SCIENTIFIC_LIMITS.maximumRepetitions);
  const candidateModels = uniqueStrings(experiment.candidate_models, "experiment.candidate_models", 1, SCIENTIFIC_LIMITS.maximumCandidates)
    .map((value, index) => safeIdentifier(value, `experiment.candidate_models[${index}]`));
  const executorLanes = uniqueStrings(experiment.executor_lanes, "experiment.executor_lanes", 1, SCIENTIFIC_LIMITS.maximumLanes)
    .map((value, index) => safeIdentifier(value, `experiment.executor_lanes[${index}]`));
  const primaryCandidate = safeIdentifier(experiment.primary_candidate, "experiment.primary_candidate");
  const primaryLane = safeIdentifier(experiment.primary_lane, "experiment.primary_lane");
  if (!candidateModels.includes(primaryCandidate) || !executorLanes.includes(primaryLane)) {
    throw new TypeError("experiment primary comparison must be a declared candidate and lane pair");
  }
  const itemIds = uniqueStrings(experiment.item_ids, "experiment.item_ids", 3, SCIENTIFIC_LIMITS.maximumItems)
    .map((value, index) => safeIdentifier(value, `experiment.item_ids[${index}]`));

  const routesSource = table(root.routes, "routes");
  exactKeys(routesSource, ["observer", "executor", "reference", "judge"], "routes");

  const seeds = table(root.seeds, "seeds");
  exactKeys(seeds, ["schedule", "bootstrap", "audit"], "seeds");

  const audit = table(root.audit, "audit");
  exactKeys(audit, ["sample_size", "policy"], "audit");
  const auditSampleSize = integerValue(
    audit.sample_size,
    "audit.sample_size",
    1,
    SCIENTIFIC_LIMITS.maximumAuditRows,
  );
  if (audit.policy !== "uniform_without_replacement") {
    throw new TypeError("audit.policy must equal uniform_without_replacement");
  }
  const primaryAuditUniverseSize = checkedProductWithin(
    [itemIds.length, repetitions],
    SCIENTIFIC_LIMITS.maximumAuditRows,
    "primary audit universe",
  );
  if (auditSampleSize > primaryAuditUniverseSize) {
    throw new TypeError("audit.sample_size cannot exceed the primary audit universe");
  }

  const observerSampling = table(root.observer_sampling, "observer_sampling");
  exactKeys(observerSampling, ["temperature", "top_p", "seed_identity"], "observer_sampling");
  const observerTemperature = numberValue(observerSampling.temperature, "observer_sampling.temperature");
  if (observerTemperature > 2) throw new TypeError("observer sampling temperature exceeds two");
  const observerTopP = numberValue(observerSampling.top_p, "observer_sampling.top_p");
  if (observerTopP > 1) throw new TypeError("observer sampling top_p exceeds one");

  const executorSampling = table(root.executor_sampling, "executor_sampling");
  exactKeys(executorSampling, ["temperature", "top_p", "seed_identity"], "executor_sampling");
  const executorTemperature = numberValue(executorSampling.temperature, "executor_sampling.temperature");
  if (executorTemperature > 2) throw new TypeError("executor sampling temperature exceeds two");
  const executorTopP = numberValue(executorSampling.top_p, "executor_sampling.top_p");
  if (executorTopP > 1) throw new TypeError("executor sampling top_p exceeds one");

  const decision = table(root.decision, "decision");
  exactKeys(
    decision,
    ["alpha", "minimum_effect", "maximum_schema_failure_rate", "maximum_unknown_outcome_rate", "minimum_calibrated_items", "minimum_attribution_rate", "minimum_drift_avoidance_rate", "minimum_audit_agreement", "bootstrap_samples", "multiplicity"],
    "decision",
  );
  const alpha = numberValue(decision.alpha, "decision.alpha", SCIENTIFIC_LIMITS.minimumAlpha);
  if (alpha > SCIENTIFIC_LIMITS.maximumAlpha) throw new TypeError("decision.alpha exceeds the conservative maximum");
  const maximumSchemaFailureRate = numberValue(
    decision.maximum_schema_failure_rate,
    "decision.maximum_schema_failure_rate",
  );
  if (maximumSchemaFailureRate > 1) throw new TypeError("maximum schema failure rate cannot exceed one");
  const maximumUnknownOutcomeRate = numberValue(
    decision.maximum_unknown_outcome_rate,
    "decision.maximum_unknown_outcome_rate",
  );
  if (maximumUnknownOutcomeRate !== 0) {
    throw new TypeError("maximum unknown outcome rate must be zero for decision-bearing evidence");
  }
  const minimumEffect = numberValue(
    decision.minimum_effect,
    "decision.minimum_effect",
    SCIENTIFIC_LIMITS.minimumAlpha,
  );
  if (minimumEffect > 1) throw new TypeError("decision.minimum_effect cannot exceed one");
  const minimumCalibratedItems = integerValue(
    decision.minimum_calibrated_items,
    "decision.minimum_calibrated_items",
    3,
    SCIENTIFIC_LIMITS.maximumItems,
  );
  if (minimumCalibratedItems > itemIds.length) {
    throw new TypeError("minimum calibrated items cannot exceed the predeclared item set");
  }
  const minimumAttributionRate = numberValue(
    decision.minimum_attribution_rate,
    "decision.minimum_attribution_rate",
    SCIENTIFIC_LIMITS.minimumAlpha,
  );
  const minimumDriftAvoidanceRate = numberValue(
    decision.minimum_drift_avoidance_rate,
    "decision.minimum_drift_avoidance_rate",
    SCIENTIFIC_LIMITS.minimumAlpha,
  );
  const minimumAuditAgreement = numberValue(
    decision.minimum_audit_agreement,
    "decision.minimum_audit_agreement",
    SCIENTIFIC_LIMITS.minimumAlpha,
  );
  if (minimumAttributionRate > 1 || minimumDriftAvoidanceRate > 1 || minimumAuditAgreement > 1) {
    throw new TypeError("decision evidence rates cannot exceed one");
  }
  if (decision.multiplicity !== "bonferroni") {
    throw new TypeError("decision.multiplicity must equal bonferroni");
  }

  const budgets = table(root.budgets, "budgets");
  exactKeys(budgets, ["observer_usd", "executor_usd", "judge_usd", "maximum_steps"], "budgets");

  const commitments = table(root.commitments, "commitments");
  exactKeys(commitments, ["corpus_hash", "prompt_hash", "harness_hash", "judge_hash", "observer_event_universe_hash", "reference_control_universe_hash", "run_hash"], "commitments");

  const resultWithoutHash = {
    version: 1 as const,
    experiment: {
      id: safeIdentifier(experiment.id, "experiment.id"),
      repetitions,
      candidateModels,
      executorLanes,
      primaryCandidate,
      primaryLane,
      itemIds,
      corpusPath: externalCorpusPath(experiment.corpus_path, options.repositoryRoot),
    },
    routes: {
      observer: route(routesSource.observer, "routes.observer"),
      executor: route(routesSource.executor, "routes.executor"),
      reference: route(routesSource.reference, "routes.reference"),
      judge: route(routesSource.judge, "routes.judge"),
    },
    seeds: {
      schedule: stringValue(seeds.schedule, "seeds.schedule"),
      bootstrap: stringValue(seeds.bootstrap, "seeds.bootstrap"),
      audit: stringValue(seeds.audit, "seeds.audit"),
    },
    audit: {
      sampleSize: auditSampleSize,
      policy: "uniform_without_replacement" as const,
    },
    observerSampling: {
      temperature: observerTemperature,
      topP: observerTopP,
      seedIdentity: stringValue(observerSampling.seed_identity, "observer_sampling.seed_identity", SCIENTIFIC_LIMITS.maximumSeedLength),
    },
    executorSampling: {
      temperature: executorTemperature,
      topP: executorTopP,
      seedIdentity: stringValue(executorSampling.seed_identity, "executor_sampling.seed_identity", SCIENTIFIC_LIMITS.maximumSeedLength),
    },
    decision: {
      alpha,
      minimumEffect,
      maximumSchemaFailureRate,
      maximumUnknownOutcomeRate: 0 as const,
      minimumCalibratedItems,
      minimumAttributionRate,
      minimumDriftAvoidanceRate,
      minimumAuditAgreement,
      bootstrapSamples: integerValue(
        decision.bootstrap_samples,
        "decision.bootstrap_samples",
        SCIENTIFIC_LIMITS.minimumBootstrapSamples,
        SCIENTIFIC_LIMITS.maximumBootstrapSamples,
      ),
      multiplicity: "bonferroni" as const,
    },
    commitments: {
      corpusHash: hashValue(commitments.corpus_hash, "commitments.corpus_hash"),
      promptHash: hashValue(commitments.prompt_hash, "commitments.prompt_hash"),
      harnessHash: hashValue(commitments.harness_hash, "commitments.harness_hash"),
      judgeHash: hashValue(commitments.judge_hash, "commitments.judge_hash"),
      observerEventUniverseHash: hashValue(commitments.observer_event_universe_hash, "commitments.observer_event_universe_hash"),
      referenceControlUniverseHash: hashValue(commitments.reference_control_universe_hash, "commitments.reference_control_universe_hash"),
      runHash: hashValue(commitments.run_hash, "commitments.run_hash"),
    },
    budgets: {
      observerUsd: numberValue(budgets.observer_usd, "budgets.observer_usd", SCIENTIFIC_LIMITS.minimumAlpha),
      executorUsd: numberValue(budgets.executor_usd, "budgets.executor_usd", SCIENTIFIC_LIMITS.minimumAlpha),
      judgeUsd: numberValue(budgets.judge_usd, "budgets.judge_usd", SCIENTIFIC_LIMITS.minimumAlpha),
      maximumSteps: integerValue(budgets.maximum_steps, "budgets.maximum_steps", 1, SCIENTIFIC_LIMITS.maximumSteps),
    },
  };
  for (const [label, value] of Object.entries({
    observerUsd: resultWithoutHash.budgets.observerUsd,
    executorUsd: resultWithoutHash.budgets.executorUsd,
    judgeUsd: resultWithoutHash.budgets.judgeUsd,
  })) {
    if (value > SCIENTIFIC_LIMITS.maximumBudgetUsd) throw new TypeError(`${label} exceeds the maximum budget`);
  }
  for (const [label, value] of Object.entries(resultWithoutHash.seeds)) {
    if (value.length > SCIENTIFIC_LIMITS.maximumSeedLength) throw new TypeError(`${label} seed is too long`);
  }
  const comparisonCount = checkedProductWithin(
    [candidateModels.length, executorLanes.length],
    SCIENTIFIC_LIMITS.maximumCandidates * SCIENTIFIC_LIMITS.maximumLanes,
    "comparison family",
  );
  checkedProductWithin(
    [itemIds.length, executorLanes.length, candidateModels.length, 4, repetitions],
    SCIENTIFIC_LIMITS.maximumScheduleEntries,
    "experiment schedule",
  );
  checkedProductWithin(
    [
      itemIds.length,
      resultWithoutHash.decision.bootstrapSamples,
      comparisonCount,
      SCIENTIFIC_LIMITS.bootstrapIntervalsPerComparison,
    ],
    SCIENTIFIC_LIMITS.maximumBootstrapDraws,
    "comparison family bootstrap",
  );
  const identityHash = hashJson(identityPayload(
    resultWithoutHash as unknown as Omit<ExperimentSpec, "identityHash">,
  ));
  const result = { ...resultWithoutHash, identityHash } as unknown as ExperimentSpec;
  const frozen = deepFreeze(result);
  issuedSpecs.add(frozen);
  return frozen;
}
