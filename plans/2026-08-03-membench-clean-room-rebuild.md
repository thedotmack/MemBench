# MemBench clean-room v0.2 rebuild

**Status:** approved for execution on 2026-08-03.

**Goal:** recreate `thedotmack/MemBench` as a private, history-free repository containing a scientifically defensible benchmark for comparing background-observer memory models. Publish only synthetic fixtures. Present results using OpenRouter/Ori's required-behavior, avoided-behavior, outcome-quality, failure, and cost conventions without delegating MemBench's causal design to Ori.

## Non-negotiable release boundary

- Create the new working tree with a new `git init -b main` and a new object database. Never push, copy, merge, filter, mirror, or reconnect the surviving repository's Git history.
- Create the GitHub repository **private**. Changing visibility is a separate owner decision after merge and a separate release attestation.
- Do not copy any current real corpus file, transcript, tool output, provenance file, sanitization report, run artifact, run spec, absolute local path, session/request/tool identifier, personal identity, or historical plan into the new repository.
- Do not vendor the surviving claude-mem prompt/parser code. The clean implementation defines its own public schema and integrates with memory backends through documented interfaces.
- Commit only synthetic corpus fixtures written from scratch.
- Do not treat a scanner pass as publication permission. Dataset license, consent/authority, independent review, and an attestation are all required before any future real corpus is released.
- Keep the remote private throughout this task.

## Phase 0 — documentation discovery (complete)

### Sources

- OpenRouter Ori Eval documentation: <https://openrouter.ai/docs/guides/ori/eval.md>
- OpenRouter Ori file/privacy documentation: <https://openrouter.ai/docs/guides/ori/files.md>
- Ori `cli-0.4.0-063b32e` official release source and checksums.
- OpenRouter Agent SDK API, tools, hooks, and stop-condition documentation.
- `OpenRouterTeam/typescript-agent` commit `680bceb4598f228d3e2ec58e2416e4335cdff059`, corresponding to `@openrouter/agent@0.8.0`.
- Surviving local implementation and tests as behavior references only; exact safe-pattern locations are listed below.
- Redacted gitleaks snapshot/history scans, Git/GitHub metadata inventory, corpus schema inventory, and dependency-license metadata.

### Allowed external APIs

- `new OpenRouter(options)` and `openrouter.callModel(request, { timeout?, signal? })`.
- `tool({ name, description?, inputSchema, outputSchema?, execute })` with Zod object schemas.
- `stepCountIs(n)`, `maxCost(usd)`, `maxTokensUsed(n)`, `hasToolCall(name)`, and `finishReasonIs(reason)`; stop arrays have OR semantics.
- `allowFinalResponse: false` when a budget stop must not trigger an extra model call.
- `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `PostModelCall` hooks with their documented payloads.
- `PostModelCall.usage.{inputTokens,outputTokens,totalTokens,cachedTokens,reasoningTokens,cost?}`; missing cost remains missing.
- Direct Agent SDK provider controls, including `provider.only`, `provider.allowFallbacks`, and `provider.dataCollection`.
- Ori report patterns may be copied conceptually. Ori `toComplete()` is not a code-task success oracle.

### Allowed internal behavior references (rewrite; do not copy files)

- Strict unknown-key spec validation and safe path-segment IDs: surviving `membench/src/spec.ts`.
- Reported-usage normalization: surviving `membench/src/openrouter.ts`.
- Growing-history observer replay: surviving `membench/src/observe-runner.ts`.
- Deterministic `path\0bytes\0` content hashing: surviving `membench/src/corpus-item.ts`.
- Worker environment allowlisting, API seeding, pinned clone, and per-fork isolation: surviving `membench/src/fork.ts`.
- Realpath containment, Agent SDK hooks, process-tree timeout, and pinned-base diff capture: surviving executor modules.
- Immediate append-only attempt rows, mechanical-check precedence, explicit unknown judgment, lane separation, and refusal to publish without provenance: surviving run/measure/report modules.

### External anti-patterns

- Do not invent an Ori background-observer API; none exists.
- Do not assume Ori supplies randomization, repeated-trial statistics, paired inference, blinding, calibration, exact-provider routing, or filesystem containment.
- Do not use `setupJudge()` with its default `minScore: 0` as a meaningful threshold.
- Do not use `maxCost()` as a hard pre-spend ceiling; it evaluates reported cost only after calls land and missing cost can appear as zero internally.
- Do not use moving model aliases or live candidate lists for longitudinal claims without freezing and recording the resolved set.
- Do not put `curl | sh`, `@latest`, unpinned actions, or live credentialed evals in ordinary PR CI.

## Phase 1 — clean repository shell and private origin

### Implementation

1. Create `<CLEAN_ROOT>` with `mktemp -d` and `git init -b main`; record the absolute path in the orchestration handoff only, never in tracked files.
2. Configure the local author to the authenticated GitHub account's noreply address.
3. Add a minimal, synthetic-only root package:
   - `.gitignore`, `.gitleaks.toml`, `.editorconfig`
   - `package.json`, `bunfig.toml`, `tsconfig.json`
   - `LICENSE` (MIT, “MemBench contributors”), `NOTICE`, `SECURITY.md`, `CONTRIBUTING.md`
   - `.github/CODEOWNERS`
   - `scripts/release-gate.sh`
   - corpus provenance and release-attestation JSON Schemas
   - placeholder README that states the repository is private and contains no real corpus data
4. Generate a lockfile with exact versions: `@openrouter/agent@0.8.0`, `@types/bun@1.3.14`, and TypeScript `7.0.2`.
5. Make the release gate fail closed on symlinks, archives/binaries, files over 1 MiB, forbidden private-data paths/fields, UUIDs, absolute home paths, real email shapes, and secret scans. Scanner output must be redacted.
6. After verification, commit the single baseline root commit.
7. Create `thedotmack/MemBench` with `gh repo create ... --private`, verify `visibility == PRIVATE`, add `origin`, push `main`, then create `agent/rebuild-membench-v02`.

### Documentation/pattern references

- GitHub CLI `gh repo create --private`, `gh repo view --json visibility`, and authenticated account metadata.
- Gitleaks 8.30.0 redacted filesystem/history modes discovered in Phase 0.
- Privacy report's staged-tree and history gates.

### Verification

- `git rev-list --count HEAD == 1`; no non-main refs before the feature branch is created.
- `git status --short` is clean.
- `bun install --frozen-lockfile`, `bun test`, and `bun run typecheck` pass without live credentials.
- Gitleaks filesystem and one-commit-history scans report zero findings.
- The release gate prints no candidate secret values.
- `gh repo view thedotmack/MemBench --json visibility` returns `PRIVATE`.

### Anti-pattern guards

- No path from the surviving repository is copied wholesale.
- No old `.git` object, remote ref, corpus, plan, run spec, README, or vendor file enters `<CLEAN_ROOT>`.
- No public remote and no visibility change.

## Phase 2 — scientific core, corpus contract, controls, and statistics

### Implementation

1. Define public domain types with explicit `pass | fail | unknown` outcomes, missing-usage fields, requested/effective route provenance, immutable experiment identity, lane ids, calibration evidence, and append-only attempt states.
2. Implement strict TOML spec parsing with unknown-key rejection, safe item ids, `k >= 3`, explicit provider/fallback policy, seeded schedule/bootstrap/audit settings, decision thresholds, minimum calibrated-item rule, budgets, and corpus path supplied outside the repo.
3. Implement a synthetic/public corpus contract:
   - task, prewritten mechanical check, optional blinded success rubric, event-indexed transcript, tool-call events, starting-tree fixture, provenance, content hash, and release attestation;
   - no hand-authored `oracle.md` and no native `oracle` terminology;
   - structural rejection of private identifiers/fields.
4. Implement controls:
   - `none`;
   - `shuffled` with a predeclared donor mapping independent of candidate order;
   - `reference`, generated once from transcript + future task, with an event id and exact supporting quote for each atomic fact.
5. Verify reference evidence against the cited event, retain the evidence in a private audit artifact, and strip it from executor injection.
6. Implement a deterministic seeded round-robin schedule interleaved within `(item, executor lane)`, persisted byte-for-byte and reused on resume.
7. Implement paired item-level metrics: floor delta, reference gap, per-item tokens-to-done, schema-failure rate, item-cluster bootstrap intervals, multiplicity-aware model comparisons, and `recommend | do_not_recommend | insufficient_evidence`.
8. Write unit tests entirely from new synthetic strings and fixtures.

### Documentation/pattern references

- Reauthor validation/hash/unknown-state behavior from the allowed local reference list.
- Ori history identity pattern, strengthened with corpus, prompt, route, harness, config, and judge hashes.
- Revised v0.2 methodology: item is the inferential unit; repetitions estimate within-item stochasticity.

### Verification

- Same seeds produce byte-identical schedules/bootstrap samples; different seeds differ.
- Unequal repetition counts cannot reweight items.
- Bootstrap resamples items, never individual attempts.
- Candidate order cannot affect shuffled donors.
- Unsupported reference facts are removed and never injected.
- Calibration rows cannot be scored.
- Positive reference gaps are valid.
- Missing values never become favorable booleans or zero cost.
- Low evidence yields `insufficient_evidence`; no forced winner.

### Anti-pattern guards

- No `oracle`, “ceiling attainment,” `% oracle savings`, or pooled cross-item token efficiency in public APIs/reports.
- No boolean coercion of unknown outcomes.
- No post-outcome decision thresholds.

## Phase 3 — observer, executor, calibration, judging, and durable orchestration

### Implementation

1. Implement the background observer on the documented Agent SDK with a public JSON observation schema and injectable transport for offline tests. Record requested/effective model, response id, route metadata when reported, tokens, real cost, duration, prompt hash, and parse state.
2. Implement a memory-backend interface with an in-memory backend for public tests and an HTTP adapter for operator-supplied external backends. Never write an external backend's database directly.
3. Implement the fixed OpenRouter coding executor with file/retrieval tools, exact Agent SDK hooks, real reported usage only, `allowFinalResponse: false`, and provider pins from the spec.
4. Implement process execution behind a fail-closed `SandboxBackend`. Supported backends must be documented and tested. If no verified OS/container sandbox is available, live shell execution refuses to start; there is no cwd-only fallback.
5. Implement isolated starting-tree copies, data/home directories, worker ports, process-tree cleanup, and captured diffs for every attempt.
6. Implement independent k=1 calibration: floor must fail and reference must pass. Freeze the generated reference; do not reuse executor attempts in scoring. Preserve every exclusion and flag scored contradictions as `calibration_instability`.
7. Implement blinded outcome/drift/attribution judges. Mechanical checks take precedence. Attribution verdicts must cite an injected fact and a downstream consequence. Invalid/unavailable verdicts remain unknown.
8. Implement a seeded, predeclared independent-judge audit sample and agreement calculation.
9. Implement budgeted, resumable orchestration with an immutable manifest, scheduled attempt-start row before execution, terminal row afterward, and separate observer/executor/judge spend.
10. Implement a fully offline mocked end-to-end run on the synthetic corpus.

### Documentation/pattern references

- Exact Agent SDK `callModel`, `tool`, stop helpers, provider options, lifecycle hooks, and `ModelResult` APIs from Phase 0.
- Reauthor isolation/durable-row/check-before-judge patterns from the allowed local reference list.
- Sandbox implementation must cite the authoritative platform/container documentation it copies. Missing APIs block the live shell feature; they are not guessed.

### Verification

- Mocked model, memory backend, executor, and judge run end to end with no key/network.
- Every started attempt has a terminal or explicit interrupted state after resume.
- Provider/model/usage absence remains visible.
- Judge prompts contain no observer model or control labels.
- Calibration evidence is independent from scored rows.
- Sandbox escape tests cover `..`, absolute paths, symlink targets, subprocesses, and timeout cleanup. Unsupported hosts fail closed.
- Cost/step stop behavior matches documented Agent SDK semantics, including overshoot visibility.

### Anti-pattern guards

- No raw database writes, host-level unsandboxed shell, invented SDK fields, hidden retries, or estimated cost.
- No `Promise.all` that can discard sibling attempt rows after one rejection.
- No completion event used as task success.

## Phase 4 — OpenRouter-shaped report, privacy publishing, documentation, and CI

### Implementation

1. Build a self-contained Markdown/JSON report with separate executor lanes and the front-page contract:
   - required behavior: task-relevant memory use and rubric-required retrieval;
   - avoided behavior: misleading-memory failures, drift, and ungrounded claims;
   - outcome quality: mechanical or blinded-rubric task outcome.
2. Lead with observer, decision, task success, delta vs floor, gap vs reference, memory-attributed hits, drift avoided, and real cost.
3. Follow with calibrated/excluded counts, item-level effects, representative failures, cost/timing including unmeasured calls, calibration instability, judge agreement, experiment identity, glossary, and raw private-artifact pointers that are removed from public bundles.
4. Implement fail-closed public bundle generation containing only aggregate results and release-safe provenance. Never include prompts, transcripts, tool inputs/outputs, diffs, judge prose, local paths, or private artifact locations.
5. Rewrite README from scratch: problem, causal loop, controls, calibration, metrics, Ori-style interpretation, quickstart with synthetic fixtures, privacy boundary, limitations, and explicit non-claims.
6. Add `docs/methodology.md`, `docs/corpus-format.md`, `docs/reporting-contract.md`, and `docs/data-governance.md` from the public contract—not copied historical plans.
7. Add ordinary credential-free CI for install/typecheck/tests/release gate with SHA-pinned actions and minimal permissions. Add a separate manual/scheduled live-eval workflow template that has no repository key and cannot run on pull requests by default.

### Documentation/pattern references

- Ori release report modules: Markdown sections, failures, correctness, history, JUnit results, and explicit unmeasured states.
- Ori official CI guidance: live evals in separate manual/scheduled jobs.
- Phase 0 privacy release gates and data-governance requirements.

### Verification

- Golden report tests cover pass/fail/unknown/unmeasured and contradictory signals.
- Reports never force a recommendation.
- Public bundle scan proves forbidden raw fields/content are absent.
- README commands work from a clean checkout with no key.
- `bun install --frozen-lockfile`, typecheck, full tests, offline demo, release gate, gitleaks filesystem/history scans, and redacted TruffleHog wrapper pass.
- Actions use immutable commit SHAs, `contents: read`, and no pull-request secrets.

### Anti-pattern guards

- No unsupported marketing scale/reproducibility claims.
- No real corpus, moving install scripts, raw scanner values, public artifacts containing `.ori/`, or live evals in PR CI.

## Phase 5 — final verification, PR, and review watch

1. Fresh agents independently run the full verification checklist, anti-pattern grep, privacy/license review, and code-quality review.
2. Confirm all phase commits exist on `agent/rebuild-membench-v02`, the base `main` contains only the clean shell, and the remote is still private.
3. Push the verified branch and open a ready-for-review PR to `main` with a complete methodology, privacy, validation, and clean-history explanation.
4. Run one fresh PR sweep: CI, mergeability, review decision, comments, and unresolved threads.
5. Use `claude-mem:babysit` until checks pass or are intentionally skipped, all actionable findings are fixed in focused verified commits, and no unresolved actionable thread remains.
6. Stop with the repository still private. Public visibility requires a later explicit owner instruction and corpus release attestation.

## Final release checklist

- New object database and private origin proved.
- No current corpus/history/vendor file copied.
- Only synthetic fixtures tracked.
- All scientific thresholds and seeds fixed before results.
- Item-level paired inference, unknown states, randomization, blinding, calibration independence, and judge audit tested.
- Shell fails closed without a verified sandbox.
- Full offline suite, typecheck, demo, release gate, and redacted secret scans pass.
- README/report use the OpenRouter-native behavior/quality/failure/cost shape.
- PR CI/reviews/threads are clean.

