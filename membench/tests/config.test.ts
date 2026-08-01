import { describe, expect, test } from 'bun:test';
import { DEFAULT_CLAUDE_MEM_ROOT, DEFAULT_RUNS_DIR, loadConfig } from '../src/config.ts';

describe('loadConfig precedence: CLI flag > env > default', () => {
  test('defaults apply when no flags and no env', () => {
    const config = loadConfig({}, {});
    expect(config.claudeMemRoot).toBe(DEFAULT_CLAUDE_MEM_ROOT);
    expect(config.runsDir).toBe(DEFAULT_RUNS_DIR);
    expect(config.openrouterApiKey).toBeUndefined();
  });

  test('env beats default', () => {
    const config = loadConfig(
      {},
      {
        CLAUDE_MEM_ROOT: '/env/claude-mem',
        MEMBENCH_RUNS_DIR: '/env/runs',
        OPENROUTER_API_KEY: 'sk-or-test',
      },
    );
    expect(config.claudeMemRoot).toBe('/env/claude-mem');
    expect(config.runsDir).toBe('/env/runs');
    expect(config.openrouterApiKey).toBe('sk-or-test');
  });

  test('CLI flag beats env', () => {
    const config = loadConfig(
      { claudeMemRoot: '/flag/claude-mem', runsDir: '/flag/runs' },
      { CLAUDE_MEM_ROOT: '/env/claude-mem', MEMBENCH_RUNS_DIR: '/env/runs' },
    );
    expect(config.claudeMemRoot).toBe('/flag/claude-mem');
    expect(config.runsDir).toBe('/flag/runs');
  });

  test('CLI flag beats default when env is empty', () => {
    const config = loadConfig({ runsDir: '/flag/runs' }, {});
    expect(config.runsDir).toBe('/flag/runs');
    expect(config.claudeMemRoot).toBe(DEFAULT_CLAUDE_MEM_ROOT);
  });
});
