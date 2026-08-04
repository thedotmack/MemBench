import { isAbsolute, posix } from "node:path";
import { Buffer } from "node:buffer";

import { canonicalJson, compareText, deepFreeze, hashJson, type JsonValue } from "./canonical";
import type { Sha256 } from "./domain";
import { requireSafeIdentifier } from "./identifiers";
import { SCIENTIFIC_LIMITS } from "./limits";
import { requireUtcRfc3339Millis } from "./timestamps";

export interface MechanicalCheck {
  readonly kind: "command";
  readonly argv: readonly string[];
  readonly expectedExitCode: number;
}

export interface MessageEvent {
  readonly eventIndex: number;
  readonly kind: "message";
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ToolCallEvent {
  readonly eventIndex: number;
  readonly kind: "tool_call";
  readonly toolName: string;
  readonly request: JsonValue;
  readonly result: JsonValue;
}

export type CorpusEvent = MessageEvent | ToolCallEvent;

export interface CorpusProvenance {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly corpusVersion: string;
  readonly classification: "synthetic" | "authorized_public";
  readonly createdAt: string;
  readonly origin: {
    readonly method: "newly_authored_synthetic" | "authorized_public_source";
    readonly description: string;
    readonly sourceReferences?: readonly string[];
  };
  readonly license: string;
  readonly authority: {
    readonly basis: "author" | "license" | "written_permission";
    readonly recordReference: string;
  };
  readonly contentHash: Sha256;
}

export interface ReleaseAttestation {
  readonly schemaVersion: 1;
  readonly corpusId: string;
  readonly corpusVersion: string;
  readonly reviewedAt: string;
  readonly reviewerRole: string;
  readonly reviewRecordReference: string;
  readonly decision: "approved" | "rejected";
  readonly checks: {
    readonly authorityVerified: boolean;
    readonly consentVerified: boolean;
    readonly licenseVerified: boolean;
    readonly independentReviewComplete: boolean;
    readonly sensitiveDataReviewComplete: boolean;
    readonly secretScanComplete: boolean;
  };
  readonly contentHash: Sha256;
}

export interface CorpusItem {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly task: string;
  readonly mechanicalCheck: MechanicalCheck;
  readonly blindSuccessRubric?: string;
  readonly events: readonly CorpusEvent[];
  readonly startingTree: Readonly<Record<string, string>>;
  readonly provenance: CorpusProvenance;
  readonly releaseAttestation: ReleaseAttestation;
  readonly contentHash: Sha256;
}

const hashShape = /^sha256:[a-f0-9]{64}$/u;
const blockedKeyNames = new Set([
  "sessionid",
  "requestid",
  "toolcallid",
  "conversationid",
  "responseid",
  "rawprompt",
  "rawtranscript",
  "toolinput",
  "tooloutput",
  "localpath",
  "homedirectory",
  "privateartifactlocation",
]);
const blockedPathSegments = new Set([
  "ori",
  "claude",
  "codex",
  "git",
  "private",
  "home",
  "root",
  "users",
  "artifact",
  "artifacts",
  "run",
  "runs",
  "transcript",
  "transcripts",
  "tooloutput",
]);
const privateValuePatterns = [
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu,
  /\/(?:users|home)\/[^/\s"']+/iu,
  new RegExp("\\/(?:ro" + "ot)(?:\\/|[^\\p{L}\\p{N}_]|$)", "iu"),
  /[a-z]:[\\/]+users[\\/]+[^\\/\s"']+/iu,
];
const privateEmailPattern = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu;

function containsPrivateValue(value: string): boolean {
  return (value.includes("@") && privateEmailPattern.test(value)) ||
    privateValuePatterns.some((pattern) => pattern.test(value));
}

type MutableTable = Record<string, unknown>;

function normalizedKey(key: string): string {
  return key.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}

function rejectBlockedKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const nested of value) rejectBlockedKeys(nested);
    return;
  }
  if (typeof value === "string") {
    if (
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
      containsPrivateValue(value)
    ) {
      throw new TypeError("corpus contains a forbidden private identifier or field");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (blockedKeyNames.has(normalizedKey(key)) || containsPrivateValue(key)) {
      throw new TypeError("corpus contains a forbidden private identifier or field");
    }
    rejectBlockedKeys(nested);
  }
}

function objectValue(value: unknown, label: string): MutableTable {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as MutableTable;
}

function keys(value: MutableTable, allowed: readonly string[], required: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (unknown) throw new TypeError(`${label} has unknown key`);
  if (missing) throw new TypeError(`${label} is missing key: ${missing}`);
}

function text(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 100_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError(`${label} must be non-empty bounded text`);
  return value;
}

function evidenceText(value: unknown, label: string, maximum: number): string {
  const result = text(value, label);
  if (result.length > maximum || !/[\p{L}\p{N}]/u.test(result)) {
    throw new TypeError(`${label} must contain meaningful bounded text`);
  }
  return result;
}

function timestamp(value: unknown, label: string): string {
  return requireUtcRfc3339Millis(value, label);
}

function stringValue(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length > 100_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)
  ) throw new TypeError(`${label} must be bounded text`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function integer(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function identifier(value: unknown, label: string): string {
  return requireSafeIdentifier(value, label);
}

function hash(value: unknown, label: string): Sha256 {
  if (typeof value !== "string" || !hashShape.test(value)) throw new TypeError(`${label} must be a SHA-256 hash`);
  return value as Sha256;
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, jsonValue(nested, `${label}.${key}`)]),
    );
  }
  throw new TypeError(`${label} must be JSON data`);
}

function safeRelativePath(value: string): string {
  const pathParts = value.split("/");
  const normalizedParts = pathParts.map((part) => part.normalize("NFKC"));
  if (
    isAbsolute(value) ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value) ||
    containsPrivateValue(value) ||
    normalizedParts.some((part) =>
      part === "" || part === "." || part === ".." ||
      part.startsWith(" ") || part.endsWith(" ") || part.endsWith(".") ||
      /[<>:"|?*]/u.test(part) ||
      /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
  ) {
    throw new TypeError("starting-tree paths must be normalized relative paths");
  }
  const normalized = posix.normalize(value);
  if (normalized !== value) throw new TypeError("starting-tree paths must be normalized relative paths");
  const segments = value.split("/").map(normalizedKey);
  if (segments.some((part, index) =>
    blockedPathSegments.has(part) && !(part === "run" && index === 1 && segments[0] === "src")
  )) {
    throw new TypeError("starting-tree paths cannot contain private-data segments");
  }
  return value;
}

function crossPlatformPathIdentity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\u00df/gu, "ss")
    .replace(/\u03c2/gu, "\u03c3");
}

function parseCheck(value: unknown): MechanicalCheck {
  const source = objectValue(value, "mechanicalCheck");
  keys(source, ["kind", "argv", "expectedExitCode"], ["kind", "argv", "expectedExitCode"], "mechanicalCheck");
  if (source.kind !== "command") throw new TypeError("mechanicalCheck.kind must equal command");
  if (!Array.isArray(source.argv) || source.argv.length === 0 || source.argv.length > 128) {
    throw new TypeError("mechanicalCheck.argv must contain between one and 128 entries");
  }
  const expectedExitCode = integer(source.expectedExitCode, "mechanicalCheck.expectedExitCode");
  if (expectedExitCode > 255) throw new TypeError("mechanicalCheck.expectedExitCode cannot exceed 255");
  return {
    kind: "command",
    argv: source.argv.map((entry, index) => text(entry, `mechanicalCheck.argv[${index}]`)),
    expectedExitCode,
  };
}

function parseEvents(value: unknown): readonly CorpusEvent[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SCIENTIFIC_LIMITS.maximumCorpusEvents) {
    throw new TypeError("events must contain a bounded non-empty sequence");
  }
  return value.map((entry, index) => {
    const source = objectValue(entry, `events[${index}]`);
    if (source.kind === "message") {
      keys(source, ["eventIndex", "kind", "role", "text"], ["eventIndex", "kind", "role", "text"], `events[${index}]`);
      if (source.eventIndex !== index) throw new TypeError("event indexes must be contiguous and start at zero");
      if (source.role !== "user" && source.role !== "assistant") throw new TypeError("message role is invalid");
      return {
        eventIndex: index,
        kind: "message" as const,
        role: source.role,
        text: text(source.text, `events[${index}].text`),
      };
    }
    if (source.kind === "tool_call") {
      keys(
        source,
        ["eventIndex", "kind", "toolName", "request", "result"],
        ["eventIndex", "kind", "toolName", "request", "result"],
        `events[${index}]`,
      );
      if (source.eventIndex !== index) throw new TypeError("event indexes must be contiguous and start at zero");
      return {
        eventIndex: index,
        kind: "tool_call" as const,
        toolName: text(source.toolName, `events[${index}].toolName`),
        request: jsonValue(source.request, `events[${index}].request`),
        result: jsonValue(source.result, `events[${index}].result`),
      };
    }
    throw new TypeError(`events[${index}].kind is invalid`);
  });
}

function parseStartingTree(value: unknown): Readonly<Record<string, string>> {
  const source = objectValue(value, "startingTree");
  const entries = Object.entries(source).map(([path, contents]) => [safeRelativePath(path), stringValue(contents, `startingTree.${path}`)] as const);
  if (entries.length === 0 || entries.length > SCIENTIFIC_LIMITS.maximumCorpusFiles) {
    throw new TypeError("startingTree must contain a bounded non-empty file set");
  }
  const aggregateBytes = entries.reduce((total, [, contents]) => total + Buffer.byteLength(contents, "utf8"), 0);
  if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > SCIENTIFIC_LIMITS.maximumStartingTreeBytes) {
    throw new RangeError("startingTree exceeds its aggregate content budget");
  }
  const pathIdentities = entries.map(([path]) => crossPlatformPathIdentity(path));
  if (new Set(pathIdentities).size !== pathIdentities.length) {
    throw new TypeError("startingTree paths collide under cross-platform normalization");
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareText(left, right)));
}

function parseProvenance(value: unknown): CorpusProvenance {
  const source = objectValue(value, "provenance");
  keys(
    source,
    ["schemaVersion", "corpusId", "corpusVersion", "classification", "createdAt", "origin", "license", "authority", "contentHash"],
    ["schemaVersion", "corpusId", "corpusVersion", "classification", "createdAt", "origin", "license", "authority", "contentHash"],
    "provenance",
  );
  if (source.schemaVersion !== 1) throw new TypeError("provenance.schemaVersion must equal one");
  if (source.classification !== "synthetic" && source.classification !== "authorized_public") {
    throw new TypeError("provenance.classification is invalid");
  }
  const origin = objectValue(source.origin, "provenance.origin");
  keys(origin, ["method", "description", "sourceReferences"], ["method", "description"], "provenance.origin");
  const authority = objectValue(source.authority, "provenance.authority");
  keys(authority, ["basis", "recordReference"], ["basis", "recordReference"], "provenance.authority");
  const references = origin.sourceReferences;
  if (
    references !== undefined &&
    (!Array.isArray(references) ||
      references.length === 0 ||
      references.length > 1_000 ||
      references.some((entry) =>
        typeof entry !== "string" || entry.trim() === "" || entry.length > 500 || !/[\p{L}\p{N}]/u.test(entry)
      ) ||
      new Set(references).size !== references.length)
  ) {
    throw new TypeError("provenance origin references are invalid");
  }
  if (source.classification === "synthetic") {
    if (origin.method !== "newly_authored_synthetic" || authority.basis !== "author") {
      throw new TypeError("synthetic provenance must be newly authored by its author");
    }
  } else if (
    origin.method !== "authorized_public_source" ||
    !references ||
    (authority.basis !== "license" && authority.basis !== "written_permission")
  ) {
    throw new TypeError("authorized public provenance must cite authority and sources");
  }
  if (!/^\d+\.\d+\.\d+$/u.test(text(source.corpusVersion, "provenance.corpusVersion"))) {
    throw new TypeError("provenance.corpusVersion must be semantic");
  }
  const createdAt = timestamp(source.createdAt, "provenance.createdAt");
  const result: CorpusProvenance = {
    schemaVersion: 1,
    corpusId: identifier(source.corpusId, "provenance.corpusId"),
    corpusVersion: source.corpusVersion as string,
    classification: source.classification,
    createdAt,
    origin: {
      method: origin.method as CorpusProvenance["origin"]["method"],
      description: evidenceText(origin.description, "provenance.origin.description", 500),
      ...(references ? { sourceReferences: references as string[] } : {}),
    },
    license: evidenceText(source.license, "provenance.license", 120),
    authority: {
      basis: authority.basis as CorpusProvenance["authority"]["basis"],
      recordReference: evidenceText(authority.recordReference, "provenance.authority.recordReference", 300),
    },
    contentHash: hash(source.contentHash, "provenance.contentHash"),
  };
  return result;
}

function parseAttestation(value: unknown): ReleaseAttestation {
  const source = objectValue(value, "releaseAttestation");
  keys(
    source,
    ["schemaVersion", "corpusId", "corpusVersion", "reviewedAt", "reviewerRole", "reviewRecordReference", "decision", "checks", "contentHash"],
    ["schemaVersion", "corpusId", "corpusVersion", "reviewedAt", "reviewerRole", "reviewRecordReference", "decision", "checks", "contentHash"],
    "releaseAttestation",
  );
  if (source.schemaVersion !== 1) throw new TypeError("releaseAttestation.schemaVersion must equal one");
  if (source.decision !== "approved" && source.decision !== "rejected") throw new TypeError("release decision is invalid");
  const checks = objectValue(source.checks, "releaseAttestation.checks");
  const checkNames = [
    "authorityVerified",
    "consentVerified",
    "licenseVerified",
    "independentReviewComplete",
    "sensitiveDataReviewComplete",
    "secretScanComplete",
  ] as const;
  keys(checks, checkNames, checkNames, "releaseAttestation.checks");
  const parsedChecks = Object.fromEntries(checkNames.map((name) => [name, bool(checks[name], `checks.${name}`)])) as unknown as ReleaseAttestation["checks"];
  if (source.decision !== "approved" || Object.values(parsedChecks).some((complete) => !complete)) {
    throw new TypeError("a corpus item requires an approved, fully completed release attestation");
  }
  const reviewedAt = timestamp(source.reviewedAt, "releaseAttestation.reviewedAt");
  return {
    schemaVersion: 1,
    corpusId: identifier(source.corpusId, "releaseAttestation.corpusId"),
    corpusVersion: text(source.corpusVersion, "releaseAttestation.corpusVersion"),
    reviewedAt,
    reviewerRole: evidenceText(source.reviewerRole, "releaseAttestation.reviewerRole", 120),
    reviewRecordReference: evidenceText(source.reviewRecordReference, "releaseAttestation.reviewRecordReference", 300),
    decision: "approved",
    checks: parsedChecks,
    contentHash: hash(source.contentHash, "releaseAttestation.contentHash"),
  };
}

export function corpusContentHash(value: Pick<CorpusItem, "schemaVersion" | "id" | "task" | "mechanicalCheck" | "events" | "startingTree"> & { readonly blindSuccessRubric?: string }): Sha256 {
  enforceCorpusBudget(value);
  return hashJson({
    schemaVersion: value.schemaVersion,
    id: value.id,
    task: value.task,
    mechanicalCheck: value.mechanicalCheck,
    ...(value.blindSuccessRubric === undefined ? {} : { blindSuccessRubric: value.blindSuccessRubric }),
    events: value.events,
    startingTree: value.startingTree,
  });
}

function enforceCorpusBudget(root: unknown): void {
  if (root !== null && typeof root === "object" && !Array.isArray(root)) {
    const eventsDescriptor = Object.getOwnPropertyDescriptor(root, "events");
    if (
      eventsDescriptor && "value" in eventsDescriptor && Array.isArray(eventsDescriptor.value) &&
      eventsDescriptor.value.length > SCIENTIFIC_LIMITS.maximumCorpusEvents
    ) throw new RangeError("corpus exceeds its event allocation");
    const treeDescriptor = Object.getOwnPropertyDescriptor(root, "startingTree");
    if (
      treeDescriptor && "value" in treeDescriptor && treeDescriptor.value !== null &&
      typeof treeDescriptor.value === "object" && !Array.isArray(treeDescriptor.value)
    ) {
      const treeKeys = Reflect.ownKeys(treeDescriptor.value);
      if (treeKeys.length > SCIENTIFIC_LIMITS.maximumCorpusFiles) {
        throw new RangeError("corpus exceeds its file allocation");
      }
      let treeBytes = 0;
      for (const key of treeKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(treeDescriptor.value, key);
        if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
          treeBytes += Buffer.byteLength(descriptor.value, "utf8");
          if (!Number.isSafeInteger(treeBytes) || treeBytes > SCIENTIFIC_LIMITS.maximumStartingTreeBytes) {
            throw new RangeError("startingTree exceeds its aggregate content budget");
          }
        }
      }
    }
  }
  const stack: { readonly value: unknown; readonly depth: number }[] = [{ value: root, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let documentBytes = 0;
  let textBytes = 0;
  const addString = (value: string): void => {
    textBytes += Buffer.byteLength(value, "utf8");
    documentBytes += Buffer.byteLength(JSON.stringify(value), "utf8");
  };
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (
      nodes > SCIENTIFIC_LIMITS.maximumStructuredNodes ||
      current.depth > SCIENTIFIC_LIMITS.maximumStructuredDepth
    ) throw new RangeError("corpus exceeds structural limits");
    const value = current.value;
    if (typeof value === "string") addString(value);
    else if (value === null || typeof value === "boolean" || typeof value === "number") {
      documentBytes += String(value).length;
    } else if (typeof value === "object") {
      if (seen.has(value)) throw new TypeError("corpus cannot contain cycles or aliased objects");
      seen.add(value);
      documentBytes += 2;
      if (Array.isArray(value)) {
        if (
          value.length > SCIENTIFIC_LIMITS.maximumStructuredNodes ||
          nodes > SCIENTIFIC_LIMITS.maximumStructuredNodes - value.length ||
          value.length > SCIENTIFIC_LIMITS.maximumCorpusDocumentBytes ||
          documentBytes > SCIENTIFIC_LIMITS.maximumCorpusDocumentBytes - value.length
        ) throw new RangeError("corpus array exceeds structural limits");
        documentBytes += value.length;
        for (let index = value.length - 1; index >= 0; index -= 1) {
          if (Object.hasOwn(value, index)) stack.push({ value: value[index], depth: current.depth + 1 });
        }
      } else {
        const ownKeys = Reflect.ownKeys(value);
        documentBytes += ownKeys.length * 2;
        for (const key of ownKeys) {
          if (typeof key !== "string") throw new TypeError("corpus keys must be strings");
          addString(key);
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) throw new TypeError("corpus properties must contain data");
          stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
      }
    } else {
      throw new TypeError("corpus must contain JSON-compatible data");
    }
    if (
      textBytes > SCIENTIFIC_LIMITS.maximumCorpusTextBytes ||
      documentBytes > SCIENTIFIC_LIMITS.maximumCorpusDocumentBytes
    ) throw new RangeError("corpus exceeds aggregate byte limits");
  }
}

export function validateCorpusItem(value: unknown): CorpusItem {
  enforceCorpusBudget(value);
  const canonicalDocument = canonicalJson(value);
  if (Buffer.byteLength(canonicalDocument, "utf8") > SCIENTIFIC_LIMITS.maximumCorpusDocumentBytes) {
    throw new RangeError("corpus exceeds aggregate byte limits");
  }
  rejectBlockedKeys(value);
  const source = objectValue(value, "corpus item");
  keys(
    source,
    ["schemaVersion", "id", "task", "mechanicalCheck", "blindSuccessRubric", "events", "startingTree", "provenance", "releaseAttestation", "contentHash"],
    ["schemaVersion", "id", "task", "mechanicalCheck", "events", "startingTree", "provenance", "releaseAttestation", "contentHash"],
    "corpus item",
  );
  if (source.schemaVersion !== 1) throw new TypeError("corpus schemaVersion must equal one");
  const base = {
    schemaVersion: 1 as const,
    id: identifier(source.id, "corpus item id"),
    task: text(source.task, "task"),
    mechanicalCheck: parseCheck(source.mechanicalCheck),
    ...(source.blindSuccessRubric === undefined ? {} : { blindSuccessRubric: text(source.blindSuccessRubric, "blindSuccessRubric") }),
    events: parseEvents(source.events),
    startingTree: parseStartingTree(source.startingTree),
  };
  const contentHash = hash(source.contentHash, "contentHash");
  const expected = corpusContentHash(base);
  if (contentHash !== expected) throw new TypeError("corpus content hash does not match canonical content");
  const provenance = parseProvenance(source.provenance);
  const releaseAttestation = parseAttestation(source.releaseAttestation);
  if (provenance.corpusId !== releaseAttestation.corpusId || provenance.corpusVersion !== releaseAttestation.corpusVersion) {
    throw new TypeError("provenance and attestation identify different corpus versions");
  }
  if (provenance.contentHash !== contentHash || releaseAttestation.contentHash !== contentHash) {
    throw new TypeError("provenance and attestation must bind the item content hash");
  }
  if (Date.parse(releaseAttestation.reviewedAt) < Date.parse(provenance.createdAt)) {
    throw new TypeError("release review cannot predate corpus creation");
  }
  return deepFreeze({ ...base, provenance, releaseAttestation, contentHash });
}

export function corpusEventEvidence(event: CorpusEvent): string {
  return event.kind === "message"
    ? event.text
    : canonicalJson({ request: event.request, result: event.result });
}

export function corpusEventEvidenceLeaves(event: CorpusEvent): readonly string[] {
  if (event.kind === "message") return deepFreeze([event.text]);
  const leaves: string[] = [];
  const stack: JsonValue[] = [event.result, event.request];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === "string") leaves.push(value);
    else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push(value[index] as JsonValue);
      }
    } else if (value !== null && typeof value === "object") {
      const entries = Object.entries(value).sort(([left], [right]) => compareText(right, left));
      for (const [, nested] of entries) stack.push(nested);
    }
  }
  return deepFreeze(leaves);
}
