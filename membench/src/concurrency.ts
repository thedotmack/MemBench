/**
 * Bounded-concurrency helper shared by the Phase 6 stages (observe replays and
 * fork-runs). Lives on its own so neither stage imports the other for it.
 */

/** Run `worker` over `inputs` with at most `limit` in flight. */
export async function mapWithConcurrency<T>(
  inputs: T[],
  limit: number,
  worker: (input: T, index: number) => Promise<unknown>,
): Promise<void> {
  let next = 0;
  const lanes = Math.max(1, Math.min(limit, inputs.length));
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (true) {
        const index = next++;
        if (index >= inputs.length) return;
        await worker(inputs[index], index);
      }
    }),
  );
}
