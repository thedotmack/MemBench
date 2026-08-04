import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { OBSERVATION_JSON_SCHEMA, validateMemoryRecord, validateMemoryRecordSchema } from "../src";

const schemaRoot = join(import.meta.dir, "..", "schemas");

async function loadSchema(name: string): Promise<object> {
  return JSON.parse(await readFile(join(schemaRoot, name), "utf8")) as object;
}

async function strictValidator(name: string) {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });
  addFormats(ajv);
  return ajv.compile(await loadSchema(name));
}

function syntheticProvenance() {
  return {
    schemaVersion: 1,
    corpusId: "invented-corpus",
    corpusVersion: "1.0.0",
    classification: "synthetic",
    createdAt: "2026-01-15T12:30:00Z",
    origin: {
      method: "newly_authored_synthetic",
      description: "Invented examples authored for offline validation.",
    },
    license: "MIT",
    authority: {
      basis: "author",
      recordReference: "synthetic-authoring-record",
    },
    contentHash: `sha256:${"a".repeat(64)}`,
  };
}

function approvedAttestation() {
  return {
    schemaVersion: 1,
    corpusId: "invented-corpus",
    corpusVersion: "1.0.0",
    reviewedAt: "2026-01-16T09:45:00Z",
    reviewerRole: "independent-reviewer",
    reviewRecordReference: "synthetic-review-record",
    decision: "approved",
    checks: {
      authorityVerified: true,
      consentVerified: true,
      licenseVerified: true,
      independentReviewComplete: true,
      sensitiveDataReviewComplete: true,
      secretScanComplete: true,
    },
    contentHash: `sha256:${"a".repeat(64)}`,
  };
}

test("all public schemas compile in strict Draft 2020 mode with formats", async () => {
  expect(await strictValidator("corpus-provenance.schema.json")).toBeFunction();
  expect(await strictValidator("release-attestation.schema.json")).toBeFunction();
  expect(await strictValidator("observation.schema.json")).toBeFunction();
});

test("observation schema is closed and bounds public memory records", async () => {
  const validate = await strictValidator("observation.schema.json");
  const valid = { schemaVersion: 1, memories: [{ id: "synthetic-fact", text: "Use amber mode", metadata: { source: "synthetic" } }] };
  expect(validate(valid)).toBe(true);
  expect(validate({ ...valid, extra: true })).toBe(false);
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], extra: true }] })).toBe(false);
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], id: "../escape" }] })).toBe(false);
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], id: "synthetic.fact" }] })).toBe(false);
  expect(() => validateMemoryRecordSchema({ ...valid.memories[0], id: "synthetic.fact" })).toThrow();
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: "   " }] })).toBe(false);
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: "word\nnext" }] })).toBe(false);
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: "mode-😀" }] })).toBe(true);
  expect(() => validateMemoryRecord({ ...valid.memories[0], text: "   " })).toThrow();
  expect(() => validateMemoryRecord({ ...valid.memories[0], text: "word\nnext" })).toThrow();
  expect(validateMemoryRecord({ ...valid.memories[0], text: "mode-😀" }).text).toBe("mode-😀");
  const multibyteWithinCodePointLimit = `${"😀".repeat(70_000)}a`;
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: multibyteWithinCodePointLimit }] })).toBe(true);
  expect(validateMemoryRecord({ ...valid.memories[0], text: multibyteWithinCodePointLimit }).text).toBe(multibyteWithinCodePointLimit);
  const beyondCodePointLimit = `${"😀".repeat(250_000)}a`;
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: beyondCodePointLimit }] })).toBe(false);
  expect(() => validateMemoryRecordSchema({ ...valid.memories[0], text: beyondCodePointLimit })).toThrow();
  const loneSurrogate = `valid${String.fromCharCode(0xd800)}`;
  expect(validate({ ...valid, memories: [{ ...valid.memories[0], text: loneSurrogate }] })).toBe(true);
  expect(validateMemoryRecordSchema({ ...valid.memories[0], text: loneSurrogate }).text).toBe(loneSurrogate);
  expect(() => validateMemoryRecord({ ...valid.memories[0], text: loneSurrogate })).toThrow("I-JSON");
});

test("runtime observation schema exactly matches the public artifact", async () => {
  expect(await loadSchema("observation.schema.json")).toEqual(OBSERVATION_JSON_SCHEMA);
});

test("synthetic provenance binds origin and authority", async () => {
  const validate = await strictValidator("corpus-provenance.schema.json");
  const valid = syntheticProvenance();
  expect(validate(valid)).toBe(true);
  expect(
    validate({
      ...valid,
      origin: { ...valid.origin, method: "authorized_public_source" },
    }),
  ).toBe(false);
  expect(
    validate({
      ...valid,
      authority: { ...valid.authority, basis: "license" },
    }),
  ).toBe(false);
});

test("authorized public provenance requires matching origin, authority, and sources", async () => {
  const validate = await strictValidator("corpus-provenance.schema.json");
  const valid = {
    ...syntheticProvenance(),
    classification: "authorized_public",
    origin: {
      method: "authorized_public_source",
      description: "Public material with an independently reviewed license.",
      sourceReferences: ["public-source-record"],
    },
    authority: {
      basis: "license",
      recordReference: "license-review-record",
    },
  };
  expect(validate(valid)).toBe(true);
  expect(validate({ ...valid, origin: { ...valid.origin, sourceReferences: [] } })).toBe(false);
  expect(validate({ ...valid, authority: { ...valid.authority, basis: "author" } })).toBe(false);
});

test("provenance date-time format is enforced", async () => {
  const validate = await strictValidator("corpus-provenance.schema.json");
  for (const createdAt of [
    "2026-01-15T12:30:00Z",
    "2026-01-15T12:30:00.1Z",
    "2026-01-15T12:30:00.123Z",
  ]) expect(validate({ ...syntheticProvenance(), createdAt })).toBe(true);
  expect(validate({ ...syntheticProvenance(), createdAt: "not-a-date" })).toBe(false);
  expect(validate({ ...syntheticProvenance(), createdAt: "2026-01-15T12:30:00.0001Z" })).toBe(false);
  expect(validate({ ...syntheticProvenance(), createdAt: "2026-01-15T12:30:00+00:00" })).toBe(false);
});

test("approved attestations require boolean true checks and valid date-time", async () => {
  const validate = await strictValidator("release-attestation.schema.json");
  const valid = approvedAttestation();
  expect(validate(valid)).toBe(true);
  for (const reviewedAt of [
    "2026-01-16T09:45:00Z",
    "2026-01-16T09:45:00.1Z",
    "2026-01-16T09:45:00.123Z",
  ]) expect(validate({ ...valid, reviewedAt })).toBe(true);
  expect(
    validate({
      ...valid,
      checks: { ...valid.checks, independentReviewComplete: false },
    }),
  ).toBe(false);
  expect(
    validate({
      ...valid,
      checks: { ...valid.checks, independentReviewComplete: "true" },
    }),
  ).toBe(false);
  expect(validate({ ...valid, reviewedAt: "not-a-date" })).toBe(false);
  expect(validate({ ...valid, reviewedAt: "2026-01-16T09:45:00.0001Z" })).toBe(false);
  expect(validate({ ...valid, reviewedAt: "2026-01-16T09:45:00+00:00" })).toBe(false);
});

test("mandatory provenance evidence rejects whitespace-only strings", async () => {
  const validate = await strictValidator("corpus-provenance.schema.json");
  const synthetic = syntheticProvenance();
  expect(validate({ ...synthetic, origin: { ...synthetic.origin, description: " \t " } })).toBe(
    false,
  );
  expect(validate({ ...synthetic, license: "   " })).toBe(false);
  expect(
    validate({
      ...synthetic,
      authority: { ...synthetic.authority, recordReference: "\n\t" },
    }),
  ).toBe(false);

  const authorized = {
    ...synthetic,
    classification: "authorized_public",
    origin: {
      method: "authorized_public_source",
      description: "Reviewed public source.",
      sourceReferences: [" \n "],
    },
    authority: {
      basis: "license",
      recordReference: "license-review-record",
    },
  };
  expect(validate(authorized)).toBe(false);
  expect(
    validate({
      ...authorized,
      origin: { ...authorized.origin, sourceReferences: ["public-source-record"] },
      license: " \t ",
    }),
  ).toBe(false);
  expect(
    validate({
      ...authorized,
      origin: { ...authorized.origin, sourceReferences: ["public-source-record"] },
      authority: { ...authorized.authority, recordReference: "  " },
    }),
  ).toBe(false);
});

test("mandatory attestation evidence rejects whitespace-only strings", async () => {
  const validate = await strictValidator("release-attestation.schema.json");
  const approved = approvedAttestation();
  expect(validate({ ...approved, reviewerRole: " \t " })).toBe(false);
  expect(validate({ ...approved, reviewRecordReference: "\n" })).toBe(false);
});

test("mandatory provenance evidence requires a Unicode letter or number in every branch", async () => {
  const validate = await strictValidator("corpus-provenance.schema.json");
  const invisible = String.fromCodePoint(0x200b, 0x2060, 0x180e);
  const synthetic = syntheticProvenance();
  expect(validate({ ...synthetic, origin: { ...synthetic.origin, description: invisible } })).toBe(
    false,
  );
  expect(validate({ ...synthetic, license: invisible })).toBe(false);
  expect(
    validate({
      ...synthetic,
      authority: { ...synthetic.authority, recordReference: invisible },
    }),
  ).toBe(false);

  const authorized = {
    ...synthetic,
    classification: "authorized_public",
    origin: {
      method: "authorized_public_source",
      description: "审查记录",
      sourceReferences: ["来源记录"],
    },
    license: "许可记录",
    authority: {
      basis: "license",
      recordReference: "授权记录",
    },
  };
  expect(validate(authorized)).toBe(true);
  expect(
    validate({
      ...authorized,
      origin: { ...authorized.origin, sourceReferences: [invisible] },
    }),
  ).toBe(false);
  expect(validate({ ...authorized, license: invisible })).toBe(false);
  expect(
    validate({
      ...authorized,
      authority: { ...authorized.authority, recordReference: invisible },
    }),
  ).toBe(false);
});

test("mandatory attestation evidence requires a Unicode letter or number", async () => {
  const validate = await strictValidator("release-attestation.schema.json");
  const invisible = String.fromCodePoint(0x200b, 0x2060, 0x180e);
  const approved = approvedAttestation();
  expect(validate({ ...approved, reviewerRole: invisible })).toBe(false);
  expect(validate({ ...approved, reviewRecordReference: invisible })).toBe(false);
  expect(validate({ ...approved, reviewerRole: "审查者", reviewRecordReference: "复核记录" })).toBe(
    true,
  );
});
