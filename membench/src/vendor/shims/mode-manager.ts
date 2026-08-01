// Shim for MemBench vendored parser.ts: minimal ModeManager.
// Replaces claude-mem src/services/domain/ModeManager.ts @ commit 132b46343.
// The active mode is always the vendored code mode: ../modes/code.json is a
// byte-identical copy of claude-mem plugin/modes/code.json @ commit 132b46343
// (vendored 2026-08-01; JSON cannot carry a header comment, so its provenance
// is recorded here).
import type { ModeConfig } from './types.js';
import codeMode from '../modes/code.json';

class ModeManager {
  private static instance: ModeManager | null = null;

  static getInstance(): ModeManager {
    if (!ModeManager.instance) {
      ModeManager.instance = new ModeManager();
    }
    return ModeManager.instance;
  }

  getActiveMode(): ModeConfig {
    return codeMode as ModeConfig;
  }
}

export { ModeManager };
