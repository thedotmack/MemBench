import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ObserveStageError, loadCorpusItem, observeRecordPath } from '../src/observe-stage.ts';

const MINI_CORPUS = join(import.meta.dir, 'fixtures', 'mini-corpus');

describe('loadCorpusItem id containment', () => {
  test('rejects traversal and separator ids before touching the filesystem', async () => {
    // Greptile P1 (PR #1): `../../victim` in corpus_items escaped --corpus-dir
    // for reads and landed observeRecordPath writes in a sibling run dir.
    for (const bad of ['../../victim', 'a/b', '/etc/passwd', '..', '.hidden']) {
      expect(loadCorpusItem(MINI_CORPUS, bad)).rejects.toThrow(
        'not a single safe path segment',
      );
    }
  });

  test('safe-but-missing id still reports not-found (segment check runs first)', async () => {
    expect(loadCorpusItem(MINI_CORPUS, 'no-such-item')).rejects.toThrow(
      'corpus item not found',
    );
    expect(loadCorpusItem(MINI_CORPUS, 'no-such-item')).rejects.toThrow(ObserveStageError);
  });

  test('observeRecordPath keeps validated ids inside the run dir', () => {
    const path = observeRecordPath('/runs/r1', 'item-1', 'openai/gpt-4o');
    expect(path.startsWith(join('/runs/r1', 'obs') + '/')).toBe(true);
  });
});
