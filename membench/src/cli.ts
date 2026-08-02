#!/usr/bin/env bun
/**
 * membench CLI entry point. Subcommand dispatch + help.
 * corpus (Phase 3), run + observe (Phase 6), score + publish + cost (Phase 7).
 */

import { costMain } from './cost-table.js';
import { corpusMain } from './corpus.js';
import { publishMain } from './publish.js';
import { observeMain, runMain } from './run-command.js';
import { scoreMain } from './scoreboard.js';

const SUBCOMMANDS = ['run', 'observe', 'corpus', 'score', 'publish', 'cost'] as const;

const HELP = `membench — memory benchmark for claude-mem

Usage: membench <subcommand> [options]

Subcommands:
  run      Execute a benchmark run from a TOML run spec (run-specs/*.toml)
  observe  Replay observation generation over corpus items per observer model
  corpus   Build, list, and freeze corpus items
  score    Score a completed run into summary.json + scoreboard.md
  publish  Write a redacted, self-checked result bundle to published-runs/
  cost     Real measured spend + extrapolated cost table (never estimated)

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
  const rest = args.slice(1);

  // Exhaustive over SUBCOMMANDS: an unknown name is the only fall-through, so
  // adding a subcommand without a handler is a type error, not a stub message.
  switch (subcommand as (typeof SUBCOMMANDS)[number]) {
    case 'corpus':
      return corpusMain(rest);
    case 'run':
      return runMain(rest);
    case 'observe':
      return observeMain(rest);
    case 'score':
      return scoreMain(rest);
    case 'publish':
      return publishMain(rest);
    case 'cost':
      return costMain(rest);
    default:
      console.error(`membench: unknown subcommand "${subcommand}"\n`);
      console.error(HELP);
      return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv));
}
