import { compareText, deepFreeze, hashJson } from "./canonical";
import { corpusEventEvidenceLeaves, type CorpusItem } from "./corpus";
import { isSafeIdentifier } from "./identifiers";
import { SeededRandom } from "./prng";
import { SCIENTIFIC_LIMITS } from "./limits";

export interface NoneControl {
  readonly kind: "none";
}

export interface ShuffledControl {
  readonly kind: "shuffled";
  readonly donorItemId: string;
}

export interface ProposedAtomicFact {
  readonly text: string;
  readonly eventIndex: number;
  readonly supportingQuote: string;
}

export interface AuditedAtomicFact extends ProposedAtomicFact {
  readonly admitted: boolean;
  readonly exclusionReason:
    | "missing_event"
    | "quote_not_exact"
    | "quote_not_meaningful"
    | "fact_quote_mismatch"
    | "duplicate_fact"
    | "duplicate_evidence"
    | null;
}

export interface ReferenceControl {
  readonly kind: "reference";
  readonly sourceHash: `sha256:${string}`;
  readonly injectionText: string;
  readonly factTexts: readonly string[];
}

export interface ReferenceCompilation {
  readonly control: ReferenceControl;
  readonly auditEvidence: readonly AuditedAtomicFact[];
}

export function createShuffledDonorMap(
  predeclaredItemIds: readonly string[],
  seed: string,
): Readonly<Record<string, string>> {
  const items = [...predeclaredItemIds].sort(compareText);
  if (
    items.length < 2 || items.length > SCIENTIFIC_LIMITS.maximumItems ||
    new Set(items).size !== items.length ||
    items.some((value) => !isSafeIdentifier(value)) ||
    typeof seed !== "string" || seed.length === 0 || seed.length > SCIENTIFIC_LIMITS.maximumSeedLength
  ) {
    throw new TypeError("shuffled control requires at least two unique predeclared items");
  }
  const random = new SeededRandom(seed);
  const offset = 1 + random.integer(items.length - 1);
  return deepFreeze(Object.fromEntries(items.map((item, index) => [item, items[(index + offset) % items.length] as string])));
}

export function noneControl(): NoneControl {
  return deepFreeze({ kind: "none" });
}

export function shuffledControl(itemId: string, donorMap: Readonly<Record<string, string>>): ShuffledControl {
  const donorItemId = Object.hasOwn(donorMap, itemId) ? donorMap[itemId] : undefined;
  if (
    !isSafeIdentifier(itemId) || !isSafeIdentifier(donorItemId) ||
    donorItemId === itemId
  ) throw new TypeError("missing, unsafe, or self-referential shuffled donor");
  return deepFreeze({ kind: "shuffled", donorItemId });
}

function normalizedEvidence(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function meaningfulEvidence(value: string): boolean {
  const tokens = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.length >= 2 && tokens.join("").length >= 6;
}

export function compileReferenceControl(
  item: Pick<CorpusItem, "task" | "events">,
  proposedFacts: readonly ProposedAtomicFact[],
): ReferenceCompilation {
  if (proposedFacts.length > SCIENTIFIC_LIMITS.maximumItems) {
    throw new RangeError("proposed reference facts exceed the bounded allocation");
  }
  for (const fact of proposedFacts) {
    if (
      typeof fact.text !== "string" || fact.text.trim() === "" || fact.text.length > 10_000 ||
      typeof fact.supportingQuote !== "string" || fact.supportingQuote.length > 10_000 ||
      !Number.isSafeInteger(fact.eventIndex) || fact.eventIndex < 0 ||
      fact.eventIndex >= SCIENTIFIC_LIMITS.maximumItems
    ) throw new TypeError("proposed atomic facts require text with bounded length and a non-negative event index");
  }
  const admittedFacts = new Set<string>();
  const admittedEvidence = new Set<string>();
  const auditEvidence = proposedFacts.map((fact): AuditedAtomicFact => {
    const event = item.events.find((candidate) => candidate.eventIndex === fact.eventIndex);
    const normalizedFact = normalizedEvidence(fact.text);
    const normalizedQuote = normalizedEvidence(fact.supportingQuote);
    let exclusionReason: AuditedAtomicFact["exclusionReason"] = !event
      ? "missing_event"
      : !corpusEventEvidenceLeaves(event).includes(fact.supportingQuote)
        ? "quote_not_exact"
        : !meaningfulEvidence(normalizedQuote)
          ? "quote_not_meaningful"
        : !meaningfulEvidence(normalizedFact) || normalizedFact !== normalizedQuote
          ? "fact_quote_mismatch"
          : null;
    if (exclusionReason === null) {
      const evidenceCoordinate = `${fact.eventIndex}\0${normalizedQuote}`;
      if (admittedEvidence.has(evidenceCoordinate)) exclusionReason = "duplicate_evidence";
      else if (admittedFacts.has(normalizedFact)) exclusionReason = "duplicate_fact";
      else {
        admittedFacts.add(normalizedFact);
        admittedEvidence.add(evidenceCoordinate);
      }
    }
    return { ...fact, admitted: exclusionReason === null, exclusionReason };
  });
  const factTexts = auditEvidence.filter((fact) => fact.admitted).map((fact) => fact.text);
  const control: ReferenceControl = {
    kind: "reference",
    sourceHash: hashJson({ task: item.task, events: item.events }),
    injectionText: factTexts.join("\n"),
    factTexts,
  };
  return deepFreeze({ control, auditEvidence });
}
