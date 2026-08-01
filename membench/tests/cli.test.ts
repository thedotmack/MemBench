import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

describe('cli', () => {
  test('--help prints all subcommands and exits 0', () => {
    const result = Bun.spawnSync(['bun', CLI, '--help']);
    const stdout = result.stdout.toString();
    for (const subcommand of ['run', 'observe', 'corpus', 'score', 'cost']) {
      expect(stdout).toContain(subcommand);
    }
    expect(result.exitCode).toBe(0);
  });

  test('unknown subcommand exits non-zero', () => {
    const result = Bun.spawnSync(['bun', CLI, 'frobnicate']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('unknown subcommand');
  });
});
