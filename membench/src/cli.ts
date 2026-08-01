#!/usr/bin/env bun
/**
 * membench CLI entry point. Subcommand dispatch + help.
 * Implemented: corpus (Phase 3). Pending: observe (Phase 2/6 wiring),
 * run (Phase 6), score/cost (Phase 7).
 */

import { corpusMain } from './corpus.js';

const SUBCOMMANDS = ['run', 'observe', 'corpus', 'score', 'cost'] as const;

const HELP = `membench — memory benchmark for claude-mem

Usage: membench <subcommand> [options]

Subcommands:
  run      Execute a benchmark run from a TOML run spec (run-specs/*.toml)
  observe  Replay observation generation over corpus items per observer model
  corpus   Build, list, and freeze corpus items
  score    Score a completed run's results.jsonl into the scoreboard
  cost     Report real (never estimated) spend for a run

Options:
  -h, --help   Show this help
`;

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(HELP);
    return 0;
  }

  const subcommand = args[0];
  if (!(SUBCOMMANDS as readonly string[]).includes(subcommand)) {
    console.error(`membench: unknown subcommand "${subcommand}"\n`);
    console.error(HELP);
    return 1;
  }

  if (subcommand === 'corpus') {
    return corpusMain(args.slice(1));
  }

  console.error(`membench ${subcommand}: not implemented yet`);
  return 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
