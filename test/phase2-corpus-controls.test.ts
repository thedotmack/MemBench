import { describe, expect, test } from "bun:test";

import {
  compileReferenceControl,
  corpusContentHash,
  createShuffledDonorMap,
  shuffledControl,
  validateCorpusItem,
  type CorpusItem,
} from "../src";

function fixture(): CorpusItem {
  const base = {
    schemaVersion: 1 as const,
    id: "synthetic-item",
    task: "Add a deterministic greeting function.",
    mechanicalCheck: { kind: "command" as const, argv: ["bun", "test"], expectedExitCode: 0 },
    blindSuccessRubric: "The function returns the requested greeting without unrelated edits.",
    events: [
      { eventIndex: 0, kind: "message" as const, role: "user" as const, text: "Use the phrase blue lantern in the greeting." },
      {
        eventIndex: 1,
        kind: "tool_call" as const,
        toolName: "read_text",
        request: { path: "src/greeting.ts" },
        result: { contents: "export const greeting = 'hello';", status: "ok" },
      },
      { eventIndex: 2, kind: "message" as const, role: "assistant" as const, text: "USE THE PHRASE BLUE LANTERN IN THE GREETING!" },
      { eventIndex: 3, kind: "message" as const, role: "user" as const, text: "Do not use blue lantern in the greeting." },
    ],
    startingTree: { "src/greeting.ts": "" },
  };
  const contentHash = corpusContentHash(base);
  return validateCorpusItem({
    ...base,
    provenance: {
      schemaVersion: 1,
      corpusId: "synthetic-corpus",
      corpusVersion: "1.0.0",
      classification: "synthetic",
      createdAt: "2026-01-10T00:00:00.000Z",
      origin: { method: "newly_authored_synthetic", description: "Written from scratch for public tests." },
      license: "MIT",
      authority: { basis: "author", recordReference: "repository contribution record" },
      contentHash,
    },
    releaseAttestation: {
      schemaVersion: 1,
      corpusId: "synthetic-corpus",
      corpusVersion: "1.0.0",
      reviewedAt: "2026-01-11T00:00:00.000Z",
      reviewerRole: "maintainer",
      reviewRecordReference: "synthetic fixture review",
      decision: "approved",
      checks: {
        authorityVerified: true,
        consentVerified: true,
        licenseVerified: true,
        independentReviewComplete: true,
        sensitiveDataReviewComplete: true,
        secretScanComplete: true,
      },
      contentHash,
    },
    contentHash,
  });
}

describe("public corpus contract", () => {
  test("validates provenance, attestation, event indexes, and deterministic content hash", () => {
    const item = fixture();
    expect(item.contentHash).toBe(corpusContentHash(item));
    expect(item.events.map((event) => event.eventIndex)).toEqual([0, 1, 2, 3]);
    expect(Object.isFrozen(item)).toBeTrue();
    expect(Object.isFrozen(item.startingTree)).toBeTrue();
  });

  test("rejects forbidden private identifier fields structurally", () => {
    const item = fixture() as unknown as Record<string, unknown>;
    const blockedName = ["session", "Id"].join("");
    const mutated = Object.fromEntries([...Object.entries(item), [blockedName, "synthetic-value"]]);
    expect(() => validateCorpusItem(mutated)).toThrow("forbidden private identifier");
    const obfuscatedName = ["s.e s-s_i/o@n ", "Id"].join("");
    const obfuscated = Object.fromEntries([...Object.entries(item), [obfuscatedName, "synthetic-value"]]);
    expect(() => validateCorpusItem(obfuscated)).toThrow("forbidden private identifier");
  });

  test("rejects private-shaped values before attestation is trusted", () => {
    const item = fixture();
    const shapedValue = ["12345678", "1234", "1234", "1234", "123456789abc"].join("-");
    expect(() => validateCorpusItem({ ...item, task: shapedValue })).toThrow("forbidden private identifier");
  });

  test("rejects non-contiguous events and unsafe starting-tree paths", () => {
    const item = fixture();
    const skipped = { ...item, events: item.events.map((event, index) => index === 1 ? { ...event, eventIndex: 4 } : event) };
    expect(() => validateCorpusItem(skipped)).toThrow("event indexes");
    const unsafe = { ...item, startingTree: { "../escape.ts": "synthetic" } };
    expect(() => validateCorpusItem(unsafe)).toThrow("normalized relative paths");
    const privateSegment = [".", "ori"].join("");
    expect(() => validateCorpusItem({ ...item, startingTree: { [`${privateSegment}/state.txt`]: "synthetic" } })).toThrow("private-data segments");
    expect(() => validateCorpusItem({ ...item, startingTree: { ".git/config": "synthetic" } })).toThrow("private-data segments");
    const nulName = ["bad", "name.ts"].join("\0");
    expect(() => validateCorpusItem({ ...item, startingTree: { [nulName]: "synthetic" } })).toThrow("normalized relative paths");
    const emailName = ["synthetic", "example.test"].join("@");
    expect(() => validateCorpusItem({ ...item, startingTree: { [emailName]: "synthetic" } })).toThrow("forbidden private identifier");
    expect(() => validateCorpusItem({ ...item, startingTree: { "src/a:b.ts": "synthetic" } })).toThrow("normalized relative paths");
  });

  test("rejects cross-platform equivalent starting-tree paths", () => {
    const item = fixture();
    expect(() => validateCorpusItem({
      ...item,
      startingTree: { "src/A.ts": "first", "src/a.ts": "second" },
    })).toThrow("collide under cross-platform normalization");
    expect(() => validateCorpusItem({
      ...item,
      startingTree: { "src/caf\u00e9.ts": "first", "src/cafe\u0301.ts": "second" },
    })).toThrow("collide under cross-platform normalization");
  });

  test("shared identifier limits cover item and provenance identities", () => {
    const item = fixture();
    const tooLong = "a".repeat(81);
    expect(() => validateCorpusItem({ ...item, id: tooLong })).toThrow("at most 80");
    expect(() => validateCorpusItem({
      ...item,
      provenance: { ...item.provenance, corpusId: tooLong },
    })).toThrow("at most 80");
    expect(() => validateCorpusItem({
      ...item,
      releaseAttestation: { ...item.releaseAttestation, corpusId: tooLong },
    })).toThrow("at most 80");
  });

  test("preflights deep and aggregate corpus structures before recursive parsing", () => {
    const item = fixture();
    let nested: Record<string, unknown> = { leaf: "synthetic" };
    for (let depth = 0; depth < 70; depth += 1) nested = { nested };
    const deepEvents = item.events.map((event) => event.eventIndex === 1
      ? { ...event, result: nested }
      : event);
    expect(() => validateCorpusItem({ ...item, events: deepEvents })).toThrow("structural limits");

    const largeEvents = Array.from({ length: 8 }, (_, eventIndex) => ({
      eventIndex,
      kind: "message" as const,
      role: "user" as const,
      text: "x".repeat(95_000),
    }));
    expect(() => validateCorpusItem({ ...item, events: largeEvents })).toThrow("aggregate byte limits");
  });

  test("rejects a four-billion-slot sparse array before scanning indexes", () => {
    const item = fixture();
    const hugeSparse = new Array(4_000_000_000);
    const events = item.events.map((event) => event.eventIndex === 1
      ? { ...event, request: { hugeSparse } }
      : event);
    const startedAt = performance.now();
    expect(() => validateCorpusItem({ ...item, events })).toThrow("array exceeds structural limits");
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("bounds event, file, and aggregate starting-tree allocations", () => {
    const item = fixture();
    const tooManyEvents = Array.from({ length: 10_001 }, (_, eventIndex) => ({
      eventIndex,
      kind: "message" as const,
      role: "user" as const,
      text: "synthetic event",
    }));
    expect(() => validateCorpusItem({ ...item, events: tooManyEvents })).toThrow("event allocation");

    const tooManyFiles = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [`src/file-${index}.txt`, ""]),
    );
    expect(() => validateCorpusItem({ ...item, startingTree: tooManyFiles })).toThrow("file allocation");

    const oversizedTree = Object.fromEntries(
      Array.from({ length: 6 }, (_, index) => [`src/file-${index}.txt`, "ok\n".repeat(30_000)]),
    );
    expect(() => validateCorpusItem({ ...item, startingTree: oversizedTree })).toThrow("aggregate content budget");
  });

  test("unknown corpus keys are rejected without echoing untrusted field names", () => {
    const item = fixture();
    const untrustedName = "untrusted-synthetic-field";
    try {
      validateCorpusItem({ ...item, [untrustedName]: true });
      throw new Error("expected corpus rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("unknown key");
      expect((error as Error).message).not.toContain(untrustedName);
    }
  });

  test("rejects rollover dates, pre-creation review, and weak public source references", () => {
    const item = fixture();
    expect(() => validateCorpusItem({
      ...item,
      provenance: { ...item.provenance, createdAt: "2026-02-30T00:00:00.000Z" },
    })).toThrow("RFC 3339");
    expect(() => validateCorpusItem({
      ...item,
      releaseAttestation: { ...item.releaseAttestation, reviewedAt: "2026-01-09T00:00:00.000Z" },
    })).toThrow("cannot predate");
    const authorized = {
      ...item,
      provenance: {
        ...item.provenance,
        classification: "authorized_public",
        origin: {
          method: "authorized_public_source",
          description: "Authorized public synthetic example.",
          sourceReferences: ["   "],
        },
        authority: { basis: "license", recordReference: "public license record" },
      },
    };
    expect(() => validateCorpusItem(authorized)).toThrow("references are invalid");
    expect(() => validateCorpusItem({
      ...authorized,
      provenance: {
        ...authorized.provenance,
        origin: { ...authorized.provenance.origin, sourceReferences: ["source record", "source record"] },
      },
    })).toThrow("references are invalid");
  });

  test("provenance timestamps use UTC with zero-to-three fractional digits", () => {
    const item = fixture();
    for (const createdAt of [
      "2026-01-10T00:00:00Z",
      "2026-01-10T00:00:00.1Z",
      "2026-01-10T00:00:00.123Z",
    ]) {
      expect(validateCorpusItem({
        ...item,
        provenance: { ...item.provenance, createdAt },
      }).provenance.createdAt).toBe(createdAt);
    }
    expect(() => validateCorpusItem({
      ...item,
      provenance: { ...item.provenance, createdAt: "2026-01-10T00:00:00.0001Z" },
    })).toThrow("millisecond precision");
    expect(() => validateCorpusItem({
      ...item,
      releaseAttestation: { ...item.releaseAttestation, reviewedAt: "2026-01-11T00:00:00.0001Z" },
    })).toThrow("millisecond precision");
    expect(() => validateCorpusItem({
      ...item,
      provenance: { ...item.provenance, createdAt: "2026-01-10T00:00:00+00:00" },
    })).toThrow("UTC");
  });
});

describe("prespecified controls", () => {
  test("shuffled donors depend only on the item set and seed", () => {
    const declared = ["item-c", "item-a", "item-b"];
    const first = createShuffledDonorMap(declared, "donor-seed");
    const reordered = createShuffledDonorMap([...declared].reverse(), "donor-seed");
    expect(first).toEqual(reordered);
    for (const item of declared) expect(first[item]).not.toBe(item);
    expect(shuffledControl("item-a", first).donorItemId).toBe(first["item-a"]!);
    const tooLong = "a".repeat(81);
    expect(() => shuffledControl(tooLong, { [tooLong]: "item-a" })).toThrow("unsafe");
    expect(() => shuffledControl("item-a", { "item-a": tooLong })).toThrow("unsafe");
  });

  test("reference evidence is verified and only admitted fact text is injected", () => {
    const item = fixture();
    const compiled = compileReferenceControl(item, [
      { text: "Use the phrase blue lantern in the greeting.", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
      { text: "The requested phrase is red harbor.", eventIndex: 0, supportingQuote: "red harbor" },
      { text: "A missing event claimed a fact.", eventIndex: 8, supportingQuote: "anything" },
      { text: "ok", eventIndex: 1, supportingQuote: "ok" },
      { text: "Unsupported paraphrase", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
      { text: "USE THE PHRASE BLUE LANTERN IN THE GREETING!", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
      { text: "USE THE PHRASE BLUE LANTERN IN THE GREETING!", eventIndex: 2, supportingQuote: "USE THE PHRASE BLUE LANTERN IN THE GREETING!" },
      { text: "blue lantern", eventIndex: 3, supportingQuote: "blue lantern" },
      { text: "Do not use blue lantern in the greeting.", eventIndex: 3, supportingQuote: "Do not use blue lantern in the greeting." },
    ]);
    expect(compiled.control.factTexts).toEqual([
      "Use the phrase blue lantern in the greeting.",
      "Do not use blue lantern in the greeting.",
    ]);
    expect(compiled.control.injectionText).toBe("Use the phrase blue lantern in the greeting.\nDo not use blue lantern in the greeting.");
    expect(compiled.control.injectionText).not.toContain("eventIndex");
    expect(compiled.control.injectionText).not.toContain("red harbor");
    expect(compiled.auditEvidence.map((entry) => entry.exclusionReason)).toEqual([
      null,
      "quote_not_exact",
      "missing_event",
      "quote_not_meaningful",
      "fact_quote_mismatch",
      "duplicate_evidence",
      "duplicate_fact",
      "quote_not_exact",
      null,
    ]);
    expect(Object.isFrozen(compiled.auditEvidence)).toBeTrue();
  });

  test("reference facts require stable indexes and deduplicate normalized salience", () => {
    const item = fixture();
    expect(() => compileReferenceControl(item, [
      { text: "", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
    ])).toThrow("require text");
    const duplicates = compileReferenceControl(item, [
      { text: "Use the phrase blue lantern in the greeting.", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
      { text: "USE THE PHRASE BLUE LANTERN IN THE GREETING!", eventIndex: 0, supportingQuote: "Use the phrase blue lantern in the greeting." },
    ]);
    expect(duplicates.control.factTexts).toEqual(["Use the phrase blue lantern in the greeting."]);
    expect(duplicates.auditEvidence[1]?.exclusionReason).toBe("duplicate_evidence");
  });

  test("cropped negation is excluded while its complete leaf is admitted verbatim", () => {
    const item = fixture();
    const result = compileReferenceControl(item, [
      { text: "blue lantern", eventIndex: 3, supportingQuote: "blue lantern" },
      { text: "Do not use blue lantern in the greeting.", eventIndex: 3, supportingQuote: "Do not use blue lantern in the greeting." },
    ]);
    expect(result.auditEvidence.map((entry) => entry.exclusionReason)).toEqual(["quote_not_exact", null]);
    expect(result.control.injectionText).toBe("Do not use blue lantern in the greeting.");
  });

  test("canonical object keys and cropped tool-result leaves are not evidence", () => {
    const result = compileReferenceControl(fixture(), [
      { text: "path", eventIndex: 1, supportingQuote: "path" },
      { text: "greeting", eventIndex: 1, supportingQuote: "greeting" },
    ]);
    expect(result.auditEvidence.map((entry) => entry.exclusionReason)).toEqual([
      "quote_not_exact",
      "quote_not_exact",
    ]);
    expect(result.control.factTexts).toEqual([]);
  });
});
