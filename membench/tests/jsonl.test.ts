import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendJsonl, readJsonl } from '../src/jsonl.ts';

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'membench-jsonl-')), name);
}

describe('appendJsonl / readJsonl', () => {
  test('round-trips rows', async () => {
    const path = tempPath('roundtrip.jsonl');
    const rows = [
      { run_id: 'r1', item_id: 'i1', success: true, cost_usd: null },
      { run_id: 'r1', item_id: 'i2', success: false, error: 'timeout' },
      { run_id: 'r1', item_id: 'i3', success: true, tokens_in: 123 },
    ];
    for (const row of rows) {
      await appendJsonl(path, row);
    }
    const readBack = await readJsonl(path);
    expect(readBack).toEqual(rows);
  });

  test('concurrent appends do not interleave (async mutex)', async () => {
    const path = tempPath('concurrent.jsonl');
    const count = 50;
    await Promise.all(
      Array.from({ length: count }, (_, i) => appendJsonl(path, { index: i, payload: 'x'.repeat(100) })),
    );
    const readBack = await readJsonl<{ index: number; payload: string }>(path);
    expect(readBack.length).toBe(count);
    // The mutex chains appends in call order — FIFO is the actual guarantee.
    expect(readBack.map((row) => row.index)).toEqual(Array.from({ length: count }, (_, i) => i));
  });

  test('skips corrupt lines with a line-numbered warning and skips blank lines', async () => {
    const path = tempPath('corrupt.jsonl');
    const good1 = { id: 1, ok: true };
    const good2 = { id: 2, ok: true };
    const content = `${JSON.stringify(good1)}\n{broken json\n\n${JSON.stringify(good2)}\n`;
    await Bun.write(path, content);

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await readJsonl(path);
      expect(rows).toEqual([good1, good2]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).toContain('line 2');
      expect(message).toContain(path);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('missing file warns and returns []', async () => {
    const path = tempPath('does-not-exist.jsonl');
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const rows = await readJsonl(path);
      expect(rows).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('not found');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
