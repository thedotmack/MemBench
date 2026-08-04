export const SCIENTIFIC_LIMITS = Object.freeze({
  maximumItems: 10_000,
  maximumCandidates: 32,
  maximumLanes: 16,
  maximumRepetitions: 100,
  maximumConditions: 256,
  maximumScheduleEntries: 250_000,
  maximumAuditRows: 10_000,
  minimumBootstrapSamples: 500,
  maximumBootstrapSamples: 100_000,
  maximumBootstrapDraws: 10_000_000,
  bootstrapIntervalsPerComparison: 3,
  minimumAlpha: 0.000_001,
  maximumAlpha: 0.5,
  maximumSteps: 10_000,
  maximumBudgetUsd: 1_000_000,
  maximumSeedLength: 256,
  maximumTokenCount: 1_000_000_000,
  maximumCorpusDocumentBytes: 1_048_576,
  maximumCorpusTextBytes: 750_000,
  maximumStartingTreeBytes: 500_000,
  maximumCorpusFiles: 1_000,
  maximumCorpusEvents: 10_000,
  maximumStructuredNodes: 50_000,
  maximumStructuredDepth: 64,
  maximumCanonicalNodes: 3_000_000,
} as const);

export function checkedProductWithin(
  factors: readonly number[],
  maximum: number,
  label: string,
): number {
  let product = 1;
  for (const factor of factors) {
    if (!Number.isSafeInteger(factor) || factor < 0 || product > Math.floor(maximum / Math.max(1, factor))) {
      throw new RangeError(`${label} exceeds its bounded allocation`);
    }
    product *= factor;
  }
  return product;
}
