import { canonicalJson, compareText, deepFreeze, hashJson, type JsonValue } from "./canonical";
import type { Outcome, RequestedRoute, Sha256 } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { requireModelSampling, type ModelSampling } from "./model-transport";
import { SeededRandom } from "./prng";
import { boundedInteger, requireFixedRoute, RUNTIME_LIMITS, utf8Text } from "./runtime-validation";

export interface AuditCandidate { readonly rowId: string; readonly evidence: JsonValue; readonly primaryOutcome: Outcome }
export interface AuditJudgeConfig {
  readonly route: RequestedRoute;
  readonly promptHash: Sha256;
  readonly schemaHash: Sha256;
  readonly sampling: ModelSampling;
  readonly samplingHash: Sha256;
  readonly configHash: Sha256;
}

export function createAuditJudgeConfig(input: { readonly route: RequestedRoute; readonly promptHash: Sha256; readonly schemaHash: Sha256; readonly sampling: ModelSampling }): AuditJudgeConfig {
  if (Object.keys(input).length !== 4 || Object.keys(input.sampling).length !== 3 || !Object.hasOwn(input.sampling, "temperature") || !Object.hasOwn(input.sampling, "topP") || !Object.hasOwn(input.sampling, "seed")) {
    throw new TypeError("audit judge configuration has invalid fields");
  }
  const route = requireFixedRoute(input.route);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.promptHash) || !/^sha256:[a-f0-9]{64}$/u.test(input.schemaHash)) throw new TypeError("audit judge prompt or schema hash is invalid");
  const sampling = requireModelSampling(input.sampling);
  const samplingHash = hashJson(sampling);
  const payload = { route, promptHash: input.promptHash, schemaHash: input.schemaHash, sampling, samplingHash };
  return deepFreeze({ ...payload, configHash: hashJson(payload) });
}

interface EligibleAuditRow { readonly rowId: string; readonly evidenceHash: Sha256 }
interface PrimaryAuditRow { readonly rowId: string; readonly outcomeHash: Sha256 }
export interface AuditManifest {
  readonly schemaVersion: 1;
  readonly seed: string;
  readonly seedHash: Sha256;
  readonly sampleSize: number;
  readonly eligibleRows: readonly EligibleAuditRow[];
  readonly universeHash: Sha256;
  readonly primaryRows: readonly PrimaryAuditRow[];
  readonly primaryUniverseHash: Sha256;
  readonly judgeConfigHash: Sha256;
  readonly selectedRowIds: readonly string[];
  readonly contentHash: Sha256;
}

function normalizedCandidates(candidates: readonly AuditCandidate[]): readonly { readonly rowId: string; readonly evidence: JsonValue; readonly evidenceHash: Sha256; readonly primaryOutcome: Outcome }[] {
  if (!Array.isArray(candidates) || candidates.length > RUNTIME_LIMITS.maximumAuditRows) throw new RangeError("audit candidates exceed allocation");
  const rows = candidates.map((row) => {
    if (row === null || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== 3 || !Object.hasOwn(row, "rowId") || !Object.hasOwn(row, "evidence") || !Object.hasOwn(row, "primaryOutcome")) {
      throw new TypeError("audit candidate has invalid fields");
    }
    const rowId = requireSafeIdentifier(row.rowId, "audit row id");
    if (!new Set<unknown>(["pass", "fail", "unknown"]).has(row.primaryOutcome)) throw new TypeError("audit primary outcome is invalid");
    const encoded = canonicalJson(row.evidence);
    if (Buffer.byteLength(encoded) > RUNTIME_LIMITS.maximumResponseBytes) throw new RangeError("audit evidence is too large");
    return { rowId, evidence: row.evidence, evidenceHash: hashJson(row.evidence), primaryOutcome: row.primaryOutcome };
  }).sort((a, b) => compareText(a.rowId, b.rowId));
  if (new Set(rows.map((row) => row.rowId)).size !== rows.length) throw new Error("audit candidate ids must be unique");
  return deepFreeze(rows);
}

function assertJudgeConfig(config: AuditJudgeConfig): void {
  const expected = createAuditJudgeConfig({ route: config.route, promptHash: config.promptHash, schemaHash: config.schemaHash, sampling: config.sampling });
  if (canonicalJson(expected) !== canonicalJson(config)) throw new Error("audit judge configuration identity mismatch");
}

function assertManifest(manifest: AuditManifest, candidates: readonly AuditCandidate[], judgeConfig: AuditJudgeConfig): ReturnType<typeof normalizedCandidates> {
  const keys = ["schemaVersion", "seed", "seedHash", "sampleSize", "eligibleRows", "universeHash", "primaryRows", "primaryUniverseHash", "judgeConfigHash", "selectedRowIds", "contentHash"];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).length !== keys.length || keys.some((key) => !Object.hasOwn(manifest, key)) || manifest.schemaVersion !== 1) {
    throw new Error("audit manifest shape is invalid");
  }
  assertJudgeConfig(judgeConfig);
  const rows = normalizedCandidates(candidates);
  const eligibleRows = rows.map(({ rowId, evidenceHash }) => ({ rowId, evidenceHash }));
  const primaryRows = rows.map(({ rowId, primaryOutcome }) => ({ rowId, outcomeHash: hashJson({ rowId, primaryOutcome }) }));
  const expected = predeclareAuditSample(candidates, manifest.sampleSize, manifest.seed, judgeConfig);
  if (canonicalJson(expected) !== canonicalJson(manifest) || manifest.universeHash !== hashJson(eligibleRows) || manifest.primaryUniverseHash !== hashJson(primaryRows)) throw new Error("audit manifest identity or candidate universe mismatch");
  return rows;
}

export function predeclareAuditSample(candidates: readonly AuditCandidate[], sampleSize: number, seed: string, judgeConfig: AuditJudgeConfig): AuditManifest {
  assertJudgeConfig(judgeConfig);
  boundedInteger(sampleSize, "audit sample size", RUNTIME_LIMITS.maximumAuditRows);
  if (sampleSize === 0) throw new TypeError("audit sample size must be positive");
  utf8Text(seed, "audit seed", 256, true);
  const rows = normalizedCandidates(candidates);
  if (sampleSize > rows.length) throw new RangeError("audit sample cannot exceed candidates");
  const eligibleRows = rows.map(({ rowId, evidenceHash }) => ({ rowId, evidenceHash }));
  const primaryRows = rows.map(({ rowId, primaryOutcome }) => ({ rowId, outcomeHash: hashJson({ rowId, primaryOutcome }) }));
  const selectedRowIds = new SeededRandom(seed).shuffle(rows.map((row) => row.rowId)).slice(0, sampleSize).sort(compareText);
  const payload = {
    schemaVersion: 1 as const,
    seed,
    seedHash: hashJson({ seed }),
    sampleSize,
    eligibleRows,
    universeHash: hashJson(eligibleRows),
    primaryRows,
    primaryUniverseHash: hashJson(primaryRows),
    judgeConfigHash: judgeConfig.configHash,
    selectedRowIds,
  };
  return deepFreeze({ ...payload, contentHash: hashJson(payload) });
}

export interface AuditAgreement { readonly selected: number; readonly judged: number; readonly agreements: number; readonly agreementRate: number | null; readonly disagreements: readonly string[] }
export interface IndependentAuditJudge { judge(input: { readonly rowId: string; readonly blindedEvidence: JsonValue; readonly config: AuditJudgeConfig }): Promise<Outcome> }
export interface IndependentAuditResult { readonly manifest: AuditManifest; readonly outcomes: Readonly<Record<string, Outcome>>; readonly agreement: AuditAgreement }

export function calculateAuditAgreement(manifest: AuditManifest, candidates: readonly AuditCandidate[], independentOutcomes: Readonly<Record<string, Outcome>>, judgeConfig: AuditJudgeConfig): AuditAgreement {
  const rows = assertManifest(manifest, candidates, judgeConfig);
  if (Object.keys(independentOutcomes).some((id) => !manifest.selectedRowIds.includes(id))) throw new Error("audit outcomes contain a substituted row");
  const primary = new Map(rows.map((row) => [row.rowId, row.primaryOutcome]));
  let judged = 0;
  let agreements = 0;
  const disagreements: string[] = [];
  for (const rowId of manifest.selectedRowIds) {
    const right = Object.hasOwn(independentOutcomes, rowId) ? independentOutcomes[rowId] : undefined;
    if (right !== undefined && !new Set<unknown>(["pass", "fail", "unknown"]).has(right)) throw new TypeError("audit outcome is invalid");
    const left = primary.get(rowId);
    if (!left || left === "unknown" || !right || right === "unknown") continue;
    judged += 1;
    if (left === right) agreements += 1; else disagreements.push(rowId);
  }
  return deepFreeze({ selected: manifest.selectedRowIds.length, judged, agreements, agreementRate: judged === 0 ? null : agreements / judged, disagreements });
}

export async function runIndependentAudit(manifest: AuditManifest, candidates: readonly AuditCandidate[], judgeConfig: AuditJudgeConfig, judge: IndependentAuditJudge): Promise<IndependentAuditResult> {
  const rows = assertManifest(manifest, candidates, judgeConfig);
  const byId = new Map(rows.map((row) => [row.rowId, row]));
  const outcomes: Record<string, Outcome> = {};
  for (const rowId of manifest.selectedRowIds) {
    const row = byId.get(rowId) as (typeof rows)[number];
    try {
      const outcome = await judge.judge({ rowId, blindedEvidence: row.evidence, config: judgeConfig });
      outcomes[rowId] = new Set<unknown>(["pass", "fail", "unknown"]).has(outcome) ? outcome : "unknown";
    } catch { outcomes[rowId] = "unknown"; }
  }
  return deepFreeze({ manifest, outcomes, agreement: calculateAuditAgreement(manifest, candidates, outcomes, judgeConfig) });
}
