import { constants, lstatSync, rmSync } from "node:fs";
import { lstat, mkdtemp, open, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

import { z } from "zod";

import { canonicalJson, compareText, deepFreeze, sha256 } from "./canonical";
import type { CorpusProvenance, ReleaseAttestation } from "./corpus";
import type { Sha256 } from "./domain";
import { assertMemBenchReportIssued, reportJson, reportJunit, reportMarkdown, type MemBenchReport } from "./report";
import { requireUtcRfc3339Millis } from "./timestamps";

const identifier = z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u).max(80);
const semver = z.string().regex(/^\d+\.\d+\.\d+$/u);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<Sha256>;
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum).regex(/[\p{L}\p{N}]/u);

function safeNarrative(value: string, label: string): void {
  if (
    /[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value) || value.includes("/") || value.includes("\\") ||
    value.includes("..") || /\bpath\s*=/iu.test(value) || /\b[a-z]:/iu.test(value)
  ) throw new TypeError(`${label} contains a path-shaped or control value`);
}

function httpsReference(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      !value.includes("?") && !value.includes("#") && url.hostname.includes(".");
  } catch { return false; }
}

const commitment = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const provenanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusId: identifier,
  corpusVersion: semver,
  classification: z.enum(["synthetic", "authorized_public"]),
  createdAt: timestamp,
  origin: z.strictObject({
    method: z.enum(["newly_authored_synthetic", "authorized_public_source"]),
    description: boundedText(500),
    sourceReferences: z.array(z.string().max(500).refine(httpsReference, "source reference must be an approved HTTPS URL")).min(1).max(1_000).optional(),
  }),
  license: boundedText(120),
  authority: z.strictObject({
    basis: z.enum(["author", "license", "written_permission"]),
    recordReference: commitment,
  }),
  contentHash: hash,
});

const attestationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  corpusId: identifier,
  corpusVersion: semver,
  reviewedAt: timestamp,
  reviewerRole: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u).max(120),
  reviewRecordReference: commitment,
  decision: z.enum(["approved", "rejected"]),
  checks: z.strictObject({
    authorityVerified: z.boolean(),
    consentVerified: z.boolean(),
    licenseVerified: z.boolean(),
    independentReviewComplete: z.boolean(),
    sensitiveDataReviewComplete: z.boolean(),
    secretScanComplete: z.boolean(),
  }),
  contentHash: hash,
});

const blockedKeys = new Set([
  "prompt",
  "rawprompt",
  "transcript",
  "rawtranscript",
  "toolrequest",
  "toolresult",
  "toolinput",
  "tooloutput",
  "diff",
  "judgeprose",
  "localpath",
  "absolutepath",
  "artifactlocation",
  "privateartifactlocation",
  "artifactid",
  "rawevent",
  "rawevents",
  "sessionid",
  "requestid",
  "responseid",
  "conversationid",
  "toolcallid",
]);

function normalizedKey(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}]/gu, "").toLocaleLowerCase("en-US");
}

const HOME_DIRECTORY_NAMES = ["users", "home", "root"] as const;

function containsEmbeddedHomePath(value: string): boolean {
  const normalized = value.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  return HOME_DIRECTORY_NAMES.some((directoryName) => {
    const marker = `/${directoryName}`;
    let offset = normalized.indexOf(marker);
    while (offset !== -1) {
      const previous = normalized[offset - 1];
      const following = normalized[offset + marker.length];
      const startsAtBoundary = offset === 0 || /\s/u.test(previous ?? "") ||
        (previous === ":" && /[a-z]/u.test(normalized[offset - 2] ?? ""));
      const endsAtBoundary = following === undefined || following === "/" || /\s/u.test(following);
      if (startsAtBoundary && endsAtBoundary) return true;
      offset = normalized.indexOf(marker, offset + marker.length);
    }
    return false;
  });
}

function unsafeString(value: string): boolean {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/u.test(value) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.test(value) ||
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/iu.test(value) ||
    /^(?:\/|[a-z]:[\\/])/iu.test(value) ||
    containsEmbeddedHomePath(value);
}

export function assertReleaseSafeAggregate(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (nested: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 100) throw new RangeError("release aggregate exceeds structural limit");
    if (typeof nested === "string") {
      if (unsafeString(nested)) throw new TypeError("release aggregate contains a private or unsafe value");
      return;
    }
    if (nested === null || typeof nested === "boolean" || (typeof nested === "number" && Number.isFinite(nested))) return;
    if (typeof nested !== "object") throw new TypeError("release aggregate must be JSON-compatible");
    if (ancestors.has(nested)) throw new TypeError("release aggregate cannot be cyclic");
    ancestors.add(nested);
    try {
      if (Array.isArray(nested)) {
        if (Object.getPrototypeOf(nested) !== Array.prototype) throw new TypeError("release aggregate must contain ordinary arrays");
        const ownKeys = Reflect.ownKeys(nested);
        if (ownKeys.some((key) => typeof key !== "string" || (key !== "length" && !/^(?:0|[1-9]\d*)$/u.test(key)))) {
          throw new TypeError("release aggregate arrays cannot have extra properties");
        }
        for (let index = 0; index < nested.length; index += 1) {
          if (!Object.hasOwn(nested, index)) throw new TypeError("release aggregate cannot contain sparse arrays");
          visit(nested[index], depth + 1);
        }
        return;
      }
      const prototype = Object.getPrototypeOf(nested) as object | null;
      if (prototype !== Object.prototype && prototype !== null) throw new TypeError("release aggregate must contain plain objects");
      const ownKeys = Reflect.ownKeys(nested);
      if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError("release aggregate cannot contain symbol fields");
      for (const key of ownKeys as string[]) {
        const descriptor = Object.getOwnPropertyDescriptor(nested, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new TypeError("release aggregate requires enumerable data fields");
        }
        if (blockedKeys.has(normalizedKey(key)) || unsafeString(key)) {
          throw new TypeError("release aggregate contains a forbidden private-data field");
        }
        visit(descriptor.value, depth + 1);
      }
    } finally {
      ancestors.delete(nested);
    }
  };
  visit(value, 0);
}

export interface PublicBundleInput {
  readonly report: MemBenchReport;
  readonly provenance: CorpusProvenance;
  readonly releaseAttestation: ReleaseAttestation;
  readonly includeJunit: boolean;
}

export type PublicBundleFileName =
  | "report.json"
  | "report.md"
  | "report.junit.xml"
  | "release-provenance.json"
  | "release-attestation.json"
  | "manifest.json";

export interface PublicBundle {
  readonly files: Readonly<Partial<Record<PublicBundleFileName, string>>>;
  readonly bundleHash: Sha256;
}

interface PublicBundleWriteHooks {
  readonly beforeWrite?: (name: PublicBundleFileName) => void | Promise<void>;
  readonly beforeVerify?: (stagingDirectory: string) => void | Promise<void>;
  readonly beforeRename?: () => void | Promise<void>;
  readonly afterRename?: (destinationDirectory: string) => void | Promise<void>;
}

function parseInput(input: unknown): PublicBundleInput {
  assertReleaseSafeAggregate(input);
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("public bundle input must be an object");
  const source = input as Record<string, unknown>;
  const keys = ["report", "provenance", "releaseAttestation", "includeJunit"];
  if (Object.keys(source).length !== keys.length || keys.some((key) => !Object.hasOwn(source, key)) || typeof source.includeJunit !== "boolean") {
    throw new TypeError("public bundle input has unknown or missing fields");
  }
  const report = source.report as MemBenchReport;
  assertMemBenchReportIssued(report);
  const parsedProvenance = provenanceSchema.parse(source.provenance);
  const provenance: CorpusProvenance = {
    ...parsedProvenance,
    origin: {
      method: parsedProvenance.origin.method,
      description: parsedProvenance.origin.description,
      ...(parsedProvenance.origin.sourceReferences === undefined
        ? {}
        : { sourceReferences: parsedProvenance.origin.sourceReferences }),
    },
  };
  const releaseAttestation: ReleaseAttestation = attestationSchema.parse(source.releaseAttestation);
  requireUtcRfc3339Millis(provenance.createdAt, "provenance creation timestamp");
  requireUtcRfc3339Millis(releaseAttestation.reviewedAt, "release review timestamp");
  safeNarrative(provenance.origin.description, "provenance description");
  safeNarrative(provenance.license, "provenance license");
  if (
    provenance.origin.sourceReferences &&
    new Set(provenance.origin.sourceReferences).size !== provenance.origin.sourceReferences.length
  ) throw new TypeError("provenance source references must be unique");
  if (provenance.classification === "synthetic") {
    if (provenance.origin.method !== "newly_authored_synthetic" || provenance.authority.basis !== "author" || provenance.origin.sourceReferences !== undefined) {
      throw new TypeError("synthetic provenance is inconsistent");
    }
  } else if (provenance.origin.method !== "authorized_public_source" || provenance.origin.sourceReferences === undefined || provenance.authority.basis === "author") {
    throw new TypeError("authorized-public provenance is inconsistent");
  }
  if (releaseAttestation.corpusId !== provenance.corpusId || releaseAttestation.corpusVersion !== provenance.corpusVersion) {
    throw new TypeError("release attestation does not match provenance");
  }
  if (
    provenance.contentHash !== report.identity.corpusHash ||
    releaseAttestation.contentHash !== report.identity.corpusHash ||
    Date.parse(releaseAttestation.reviewedAt) < Date.parse(provenance.createdAt)
  ) throw new TypeError("release provenance and review do not bind the reported corpus identity");
  if (releaseAttestation.decision !== "approved" || Object.values(releaseAttestation.checks).some((value) => !value)) {
    throw new TypeError("public bundle requires an approved, fully checked release attestation");
  }
  return deepFreeze({ report, provenance, releaseAttestation, includeJunit: source.includeJunit });
}

export function generatePublicBundle(input: unknown): PublicBundle {
  const parsed = parseInput(input);
  const payload = new Map<PublicBundleFileName, string>([
    ["report.json", reportJson(parsed.report)],
    ["report.md", reportMarkdown(parsed.report)],
    ["release-provenance.json", `${canonicalJson(parsed.provenance)}\n`],
    ["release-attestation.json", `${canonicalJson(parsed.releaseAttestation)}\n`],
  ]);
  if (parsed.includeJunit) payload.set("report.junit.xml", reportJunit(parsed.report));
  const manifestFiles = Object.fromEntries([...payload.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([name, contents]) => [name, { bytes: Buffer.byteLength(contents, "utf8"), sha256: sha256(contents) }]));
  const manifestPayload = { schemaVersion: 1 as const, includeJunit: parsed.includeJunit, files: manifestFiles };
  const manifest = `${canonicalJson({ ...manifestPayload, contentHash: sha256(canonicalJson(manifestPayload)) })}\n`;
  payload.set("manifest.json", manifest);
  const files = Object.fromEntries([...payload.entries()].sort(([left], [right]) => compareText(left, right))) as Partial<Record<PublicBundleFileName, string>>;
  assertReleaseSafeAggregate(files);
  return deepFreeze({ files, bundleHash: sha256(canonicalJson(files)) });
}

async function durableWrite(path: string, contents: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
      throw new Error("public bundle child must be a singly linked regular file");
    }
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
    const after = await handle.stat();
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error("public bundle child identity changed during write");
    }
  } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    if (code !== "EINVAL" && code !== "EISDIR" && code !== "EPERM") throw error;
  }
}

interface FsIdentity { readonly dev: number; readonly ino: number }

async function requireOwnedDirectory(path: string, expected: FsIdentity, label: string): Promise<void> {
  const current = await lstat(path);
  if (
    current.isSymbolicLink() || !current.isDirectory() ||
    current.dev !== expected.dev || current.ino !== expected.ino
  ) throw new Error(`${label} identity changed`);
}

async function readOwnedDirectoryNames(
  path: string,
  expected: FsIdentity,
  label: string,
): Promise<readonly string[]> {
  await requireOwnedDirectory(path, expected, label);
  const names = await readdir(path);
  await requireOwnedDirectory(path, expected, label);
  return names;
}

async function readFileFromOwnedDirectory(
  directory: string,
  expected: FsIdentity,
  label: string,
  fileName: string,
): Promise<Buffer> {
  await requireOwnedDirectory(directory, expected, label);
  const bytes = await readOwnedFile(join(directory, fileName));
  await requireOwnedDirectory(directory, expected, label);
  return bytes;
}

async function readOwnedFile(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("public bundle child must be a singly linked regular non-symlink file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorBefore = await handle.stat();
    if (
      !descriptorBefore.isFile() || descriptorBefore.nlink !== 1 ||
      descriptorBefore.dev !== before.dev || descriptorBefore.ino !== before.ino
    ) {
      throw new Error("public bundle child identity changed before read");
    }
    const bytes = await handle.readFile();
    const descriptorAfter = await handle.stat();
    const after = await lstat(path);
    if (
      !descriptorAfter.isFile() || descriptorAfter.nlink !== 1 ||
      descriptorAfter.dev !== descriptorBefore.dev || descriptorAfter.ino !== descriptorBefore.ino ||
      after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 ||
      after.dev !== before.dev || after.ino !== before.ino
    ) throw new Error("public bundle child identity changed during read");
    return bytes;
  } finally { await handle.close(); }
}

async function requireMissing(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error("public bundle destination already exists");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    if (code !== "ENOENT") throw error;
  }
}

async function writePublicBundleWithHooks(
  input: unknown,
  outputDirectory: string,
  hooks: PublicBundleWriteHooks = {},
): Promise<PublicBundle> {
  if (typeof outputDirectory !== "string" || outputDirectory.length === 0 || !isAbsolute(outputDirectory)) {
    throw new TypeError("public bundle destination must be an explicit absolute path");
  }
  if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) throw new TypeError("public bundle write hooks must be an object");
  const hookKeys = Object.keys(hooks);
  if (hookKeys.some((key) => key !== "beforeWrite" && key !== "beforeVerify" && key !== "beforeRename" && key !== "afterRename") ||
    (hooks.beforeWrite !== undefined && typeof hooks.beforeWrite !== "function") ||
    (hooks.beforeVerify !== undefined && typeof hooks.beforeVerify !== "function") ||
    (hooks.beforeRename !== undefined && typeof hooks.beforeRename !== "function") ||
    (hooks.afterRename !== undefined && typeof hooks.afterRename !== "function")) {
    throw new TypeError("public bundle write hooks are invalid");
  }
  const bundle = generatePublicBundle(input);
  const parent = dirname(outputDirectory);
  const name = basename(outputDirectory);
  if (!/^[a-zA-Z0-9._-]{1,120}$/u.test(name) || name === "." || name === "..") throw new TypeError("public bundle destination name is unsafe");
  const parentIdentity = await lstat(parent);
  if (!parentIdentity.isDirectory() || parentIdentity.isSymbolicLink()) throw new TypeError("public bundle parent must be a real directory");
  await requireMissing(outputDirectory);
  let temporaryRoot: string | null = await mkdtemp(join(parent, `.${name}.membench-publish-`));
  const stagingRoot = temporaryRoot;
  const temporaryIdentity = await lstat(temporaryRoot);
  const cleanupOwnedSync = (): void => {
    if (!temporaryRoot) return;
    try {
      const current = lstatSync(temporaryRoot);
      if (!current.isSymbolicLink() && current.isDirectory() && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    } catch { /* owned temporary state is best-effort on signal */ }
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = (): void => { cleanupOwnedSync(); process.kill(process.pid, signal); };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const ordered = Object.entries(bundle.files).sort(([left], [right]) => {
      if (left === "manifest.json") return 1;
      if (right === "manifest.json") return -1;
      return compareText(left, right);
    }) as [PublicBundleFileName, string][];
    for (const [fileName, contents] of ordered) {
      await hooks.beforeWrite?.(fileName);
      await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
      await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
      await durableWrite(join(stagingRoot, fileName), contents);
      await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
      await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
    }
    await hooks.beforeVerify?.(stagingRoot);
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
    const actualNames = (await readdir(stagingRoot)).sort(compareText);
    const expectedNames = Object.keys(bundle.files).sort(compareText);
    if (canonicalJson(actualNames) !== canonicalJson(expectedNames)) throw new Error("public bundle temporary file set changed");
    const manifestBytes = (await readOwnedFile(join(stagingRoot, "manifest.json"))).toString("utf8");
    if (manifestBytes !== bundle.files["manifest.json"]) throw new Error("public bundle manifest bytes changed after generation");
    const manifest = JSON.parse(manifestBytes) as {
      schemaVersion: number;
      includeJunit: boolean;
      files: Record<string, { bytes: number; sha256: Sha256 }>;
      contentHash: Sha256;
    };
    if (manifest.includeJunit !== Object.hasOwn(bundle.files, "report.junit.xml")) throw new Error("public bundle manifest JUnit decision is inconsistent");
    const expectedPayload = { schemaVersion: 1, includeJunit: manifest.includeJunit, files: manifest.files };
    if (manifest.schemaVersion !== 1 || manifest.contentHash !== sha256(canonicalJson(expectedPayload))) {
      throw new Error("public bundle manifest identity is inconsistent");
    }
    const expectedManifestNames = expectedNames.filter((fileName) => fileName !== "manifest.json");
    if (canonicalJson(Object.keys(manifest.files).sort(compareText)) !== canonicalJson(expectedManifestNames)) {
      throw new Error("public bundle manifest file set is incomplete");
    }
    for (const [fileName, expected] of Object.entries(manifest.files)) {
      await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
      await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
      const bytes = await readOwnedFile(join(stagingRoot, fileName));
      if (
        bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256 ||
        bytes.toString("utf8") !== bundle.files[fileName as keyof typeof bundle.files]
      ) throw new Error("public bundle temporary bytes failed manifest verification");
    }
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
    await syncDirectory(stagingRoot);
    await hooks.beforeRename?.();
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(stagingRoot, temporaryIdentity, "public bundle staging directory");
    await requireMissing(outputDirectory);
    await rename(stagingRoot, outputDirectory);
    // Until post-rename verification completes, the destination remains owned
    // temporary state and is removed on any failure by exact directory identity.
    temporaryRoot = outputDirectory;
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(outputDirectory, temporaryIdentity, "published public bundle");
    await hooks.afterRename?.(outputDirectory);
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(outputDirectory, temporaryIdentity, "published public bundle");
    const publishedNames = [...await readOwnedDirectoryNames(
      outputDirectory,
      temporaryIdentity,
      "published public bundle",
    )].sort(compareText);
    if (canonicalJson(publishedNames) !== canonicalJson(expectedNames)) {
      throw new Error("published public bundle file set changed during rename");
    }
    for (const fileName of publishedNames) {
      await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
      const bytes = await readFileFromOwnedDirectory(
        outputDirectory,
        temporaryIdentity,
        "published public bundle",
        fileName,
      );
      await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
      if (bytes.toString("utf8") !== bundle.files[fileName as PublicBundleFileName]) {
        throw new Error("published public bundle bytes changed during rename");
      }
    }
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(outputDirectory, temporaryIdentity, "published public bundle");
    await syncDirectory(parent);
    await requireOwnedDirectory(parent, parentIdentity, "public bundle parent");
    await requireOwnedDirectory(outputDirectory, temporaryIdentity, "published public bundle");
    temporaryRoot = null;
    return bundle;
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    if (temporaryRoot) {
      const cleanupTarget = temporaryRoot;
      temporaryRoot = null;
      try {
        const current = await lstat(cleanupTarget);
        if (!current.isSymbolicLink() && current.isDirectory() && current.dev === temporaryIdentity.dev && current.ino === temporaryIdentity.ino) {
          await rm(cleanupTarget, { recursive: true, force: true });
        }
      } catch { /* preserve the original publication failure */ }
    }
  }
}

export async function writePublicBundle(input: unknown, outputDirectory: string): Promise<PublicBundle> {
  return writePublicBundleWithHooks(input, outputDirectory);
}

/** @internal Test-only race injection. This symbol is intentionally omitted from the package index. */
export async function writePublicBundleForTest(
  input: unknown,
  outputDirectory: string,
  hooks: PublicBundleWriteHooks,
): Promise<PublicBundle> {
  return writePublicBundleWithHooks(input, outputDirectory, hooks);
}
