# Contributing

MemBench accepts clean-room code, documentation, and synthetic fixtures.

Before opening a pull request:

1. Reauthor the change without copying private repositories, histories,
   corpora, transcripts, prompts, run artifacts, or backend internals.
2. Use invented names and data in every test and example.
3. Run `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, and
   `bun run release:gate`.
4. Explain the scientific claim, validation evidence, and privacy impact.

Never use a scanner pass as publication approval. Releasing any non-synthetic
dataset requires documented authority, consent where applicable, compatible
licensing, independent review, and a completed release attestation.

