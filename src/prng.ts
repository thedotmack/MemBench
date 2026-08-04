import { createHash } from "node:crypto";

export const PRNG_ALGORITHM = "membench-mulberry32-sha256-v1" as const;
const UINT32_RANGE = 4_294_967_296;

export class SeededRandom {
  #state: number;

  constructor(seed: string) {
    if (
      typeof seed !== "string" || seed.length === 0 || seed.length > 2_048
    ) throw new TypeError("seed material must be a bounded non-empty string");
    const bytes = createHash("sha256").update(seed).digest();
    this.#state = bytes.readUInt32LE(0);
  }

  nextUint32(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let value = this.#state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  next(): number {
    return this.nextUint32() / UINT32_RANGE;
  }

  integer(maxExclusive: number): number {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
      throw new RangeError("maximum must be a positive integer no greater than 2^32");
    }
    const limit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;
    let draw: number;
    do draw = this.nextUint32(); while (draw >= limit);
    return draw % maxExclusive;
  }

  shuffle<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swap = this.integer(index + 1);
      [result[index], result[swap]] = [result[swap] as T, result[index] as T];
    }
    return result;
  }
}
