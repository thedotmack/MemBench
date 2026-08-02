# MemBench — TL;DR 🧠

**One question:** which model writes memory that actually helps later?

**One sentence:** same transcript → every model writes its own observations →
fork the session per variant → same task → count tokens, check success.

---

## The loop

```
transcript ──→ all models observe it (parallel, OpenRouter)
                        │
                        ▼
        one fork per model's observations
        + 3 controls: none · oracle · shuffled
                        │
                        ▼
        every fork does the SAME task
                        │
                        ▼
        📊 tokens used  +  ✅/❌ success
```

That's it. Better memory = fewer tokens, more successes.

---

## Quickstart ⚡

Everything runs on [Bun](https://bun.sh) plus `git` (the offline mocks shell out
to `git init` / `add` / `commit` so a fork's `git diff` behaves exactly as it
does live). No API key, no network, no claude-mem install, no `claude` binary:

```bash
cd membench
bun install
bun test                                    # the full offline suite

# the whole loop, mocked end to end (writes runs/demo/)
bun src/cli.ts run --mock \
  --spec tests/fixtures/e2e-spec.toml \
  --run-id demo \
  --corpus-dir tests/fixtures/mini-corpus

bun src/cli.ts score --run-id demo          # → runs/demo/scoreboard.md + summary.json
bun src/cli.ts cost demo                    # → the cost table (mock spend, clearly labeled)
```

`--mock` swaps the provider, both executors, the claude-mem worker and the repo
clone for offline stand-ins, so the run exercises the real orchestration code
with fabricated numbers. Every artifact a mock run produces says `mock: true`
and carries a "do not cite" banner — mock spend must never be mistaken for a
measurement.

Subcommands: `run` · `observe` · `corpus` · `score` · `publish` · `cost`
(`bun src/cli.ts --help`).

---

## The questions we're answering ❓

| # | Question | How we answer it |
|---|---|---|
| 1 | **Which model is best at writing memory — and discerning what's most valuable?** | The scoreboard. Best memory = highest success + fewest tokens vs the no-memory floor. *Discernment* = % of oracle savings captured — a model that writes down the *right* things gets close to the hand-written ceiling; a model that writes noise doesn't. |
| 2 | **Does good memory actually reduce token usage when a new session performs the task?** | Directly measured by the fork loop: same task, same repo, only the memory differs. `tokens(model fork)` vs `tokens(no-memory fork)`, k≥3 runs, mean ± spread. |
| 3 | **Does the executor actively use mem-search? How often?** | Forks run with the claude-mem worker live and the mem-search skill available — not just static injection. We count every `search` / `timeline` / `get_observations` call per run (`mem_search_calls` in `results.jsonl`). |
| 4 | **Do some models' observations require MORE mem-searching?** | **Search burden** metric: mem-search calls per run, grouped by observer model. High burden = the injected memory wasn't sufficient or well-prioritized — the executor had to dig. Low burden + low tokens = the memory led with what mattered. |
| 5 | **Is there drift — new features or unexpected work?** | **Scope check** on every fork's diff: judge compares output against `task.md`, flags out-of-scope work (`drift_flag` + note in `results.jsonl`). Drift rate per observer model — and whether drift correlates with misleading/fabricated observations. |

---

## The 2 headline numbers

1. **Tokens to done** (vs no-memory floor, vs oracle ceiling)
2. **Success rate** (pre-written pass/fail check per task)

Supporting: 🔍 search burden (Q3/Q4) · 🌀 drift rate (Q5).
Everything else (obs count, XML parsing, tags) = diagnostics. Not the story.

## The 3 controls (why anyone will believe us)

| Control | Proves |
|---|---|
| 🚫 No memory | the floor — what memory has to beat |
| 🎯 Oracle (hand-written perfect notes) | the ceiling — "model X got 71% of the way" |
| 🔀 Shuffled (wrong session's notes) | value comes from *content*, not vibes |

---

## Scoreboard metrics 📊

`bun src/cli.ts score --run-id <id>` reads `runs/<id>/` and writes
`summary.json` (every number, machine-readable) and `scoreboard.md` (the
rendering). Each metric is defined exactly once, in `membench/src/scoreboard.ts`,
with its formula in a comment:

| Metric | Formula | Notes |
|---|---|---|
| **success rate** | `successes / runs` | Every row in the cell counts, including rows that errored — a crashed run is not a success. Read against the `none` floor. |
| **tokens-to-done** | mean ± sample stddev (n−1) of `tokens_total` | **Successful runs only**, and only those whose provider reported usage. A successful run with no reported usage is counted and shown separately, never averaged in as 0. |
| **% of oracle savings** | `(floor_mean − model_mean) / (floor_mean − oracle_mean)` | How much of the hand-written ceiling's saving this model captured. Renders `n/a (floor==oracle)` / `n/a (no floor tokens)` / … instead of a NaN. Values below 0% or above 100% are reported as-is. |
| **real cost** | Σ reported `cost_usd` (exec side) and Σ reported `obs_cost_usd` (observe side) | Never estimated. Rows whose cost the provider did not report are counted and printed, so a sum always reads as a lower bound. |
| **search burden** | mean `mem_search_calls` over completed runs | An aborted run never got the chance to search; counting its 0 would fake a low burden. |
| **drift rate** | `drifted / judged` over rows with `judged == true` | A row the judge never decided is UNJUDGED and shown as its own count — never counted as "no drift". |

Two structural rules hold in every scoreboard:

- **Lanes never mix.** The markdown is sectioned by executor and no cell
  combines `claude-cli` and `openrouter-agent` rows. Cross-executor deltas
  appear only under Diagnostics and in the cost table.
- **Counts are diagnostics.** Observation counts, observe tokens, parse notes
  and accommodations live under `## Diagnostics`, never in the headline tables.
  Count ≠ value.

`score --diff <other-run-id>` renders metric deltas per (executor, variant)
against another run.

---

## Corpus format 📦

Each frozen item is a directory under `corpus/<item-id>/` with **7 content
files** plus its provenance:

| file | what it is |
|---|---|
| `transcript.jsonl` | the sanitized session-N transcript |
| `toolcalls.jsonl` | `(tool_name, tool_input, tool_output, created_at_epoch, cwd)` records replayed to the observer models |
| `repo.lock` | `{url, commit, branch, cwd_at_recording}` — the exact repo state the task starts from |
| `task.md` | the hindsight task: session N+1's opening human prompt, edited only to remove machine-specific context |
| `check.sh` | mechanical pass/fail, run from the fork's repo root. Exit `0` = pass, exit `3` = "defer to the judge with `success.md`", anything else = fail. **Written before any model runs.** |
| `success.md` | the judge rubric, for the cases mechanical checking can't decide |
| `oracle.md` | hand-written perfect notes — the ceiling control's memory |
| `provenance.json` | session ids, project slug, dates, sanitizer version, **content hash** |
| `sanitization-report.md` | build artifact: every redaction the sanitizer made, for hand review (excluded from the content hash) |

**Freezing.** `bun src/cli.ts corpus freeze <item-dir>` hashes the sorted file list
(sha256 over `path\0bytes\0`, excluding `provenance.json` and the sanitization
report) and records it as `content_hash`. Every run re-computes the hash and
**refuses to start if an item changed since it was frozen** — a published number
always names the exact bytes it measured. The corpus is append-only: fix an item
by adding a new one.

`bun src/cli.ts corpus list` prints the item table (7 required files + frozen
status); `corpus candidates` and `corpus build` mine new items from the local
claude-mem DB and transcripts (read-only, sanitized, with a per-item
sanitization report for hand review).

Tasks come from what the user actually did next. They are never "improved"
beyond de-machining, and `check.sh` is written before any model sees the item
(no post-hoc fitting).

---

## The two executors 🏎️

Both are first-class in v0.1 and implement the same `Executor` interface, so
they share the fork, measurement and scoring pipeline.

**`claude-cli`** runs the production consumer: `claude --print --output-format
json --permission-mode bypassPermissions` with an isolated `HOME` per fork, a
`--mcp-config` pointing the `mcp-search` MCP server at that fork's own
claude-mem worker, and the injection block prepended to `task.md`. No `--bare`
(it would disable plugin/skill discovery). `mem_search_calls` is counted from
`mcp__mcp-search__*` tool-use blocks in the session transcript, and the fork's
`git diff` is saved for the judge.

**`openrouter-agent`** is a minimal coding agent on the exact-pinned
`@openrouter/agent` SDK: `bash` / `read_file` / `write_file` / `edit_file` tools
locked to the fork's repo (path escapes rejected), plus `search` / `timeline` /
`get_observations` tools that call the fork worker's HTTP routes — the same
routes the production MCP server proxies. Any OpenRouter model can execute, which
is what makes an executor-side model matrix possible, and every step's real
`usage.cost` is captured. Stop conditions are `stepCountIs(max_steps)` and
`maxCost(max_cost_per_run_usd)`.

**Lane separation is a rule, not a preference.** The two executors differ in
tooling and pricing, so a number from one lane is not comparable to a number
from the other. No scoreboard cell mixes them; cross-lane figures live only in
Diagnostics and in the cost table.

---

## Run governance 🚦

Ported from the conventions OpenRouter's own team publishes benchmarks with
(`OpenRouterTeam/search-benchmarks`):

```bash
# 1. reviewable spec, committed to the repo
cat run-specs/smoke-1item.toml

# 2. dry run: validates the spec + corpus, prints the planned call matrix and a
#    cost estimate built ONLY from measured rates in prior runs. Zero network.
bun src/cli.ts run --spec ../run-specs/smoke-1item.toml --run-id smoke-1 --dry-run

# 3. live runs REQUIRE an explicit ceiling
bun src/cli.ts run --spec ../run-specs/smoke-1item.toml --run-id smoke-1 --approve-cost-usd 5

# 4. a stopped or partial run resumes without re-spending
bun src/cli.ts run --spec ../run-specs/smoke-1item.toml --run-id smoke-1 --resume
```

- **`--dry-run`** makes no network calls and writes nothing. Its estimate is
  built from real costs measured in earlier runs; mock runs are excluded from
  the rates, and a component with no measured rate is listed as excluded rather
  than guessed.
- **`--approve-cost-usd <ceiling>`** is mandatory for live runs. The effective
  ceiling is `min(flag, spec.max_cost_usd)`. The runner refuses to start when the
  measured-rate estimate exceeds it, and stops between items when cumulative
  **real reported** spend crosses it. Calls that report no cost are counted as
  UNKNOWN and surfaced — never assumed free — and a run where nothing has
  reported a cost stops on its own after `--max-unreported-calls`.
- **`--resume`** skips `(item, variant, executor, run_index)` cells already in
  `results.jsonl`, reuses non-errored observe records, and refuses to resume
  into a run with a different spec, corpus hash or mock flag.
  `--retry-failed` re-queues errored cells (their old rows move to
  `retried-rows.jsonl`, never discarded).
- Every fork-run writes a row, even on timeout or crash. Rows are appended
  immediately, never batched.
- Every fork gets its own `CLAUDE_MEM_DATA_DIR`, its own worker port and its own
  `HOME`. Nothing ever points at your real `~/.claude-mem`.

`OPENROUTER_API_KEY`, `CLAUDE_MEM_ROOT`, `MEMBENCH_RUNS_DIR` and
`MEMBENCH_CLAUDE_CREDENTIALS_FILE` are env-only — they are secrets or
machine-local paths and are rejected if put in a spec.

| env var | what it does |
|---|---|
| `OPENROUTER_API_KEY` | observer, openrouter-agent executor and judge calls |
| `CLAUDE_MEM_ROOT` | claude-mem checkout used for the per-fork workers |
| `MEMBENCH_RUNS_DIR` | where `runs/<run-id>/` trees are written (default `./runs`) |
| `MEMBENCH_CLAUDE_CREDENTIALS_FILE` | explicit `.credentials.json` for the `claude-cli` lane, overriding host lookup |

### Cost governance

The ceiling is enforced on REPORTED spend, and fork-runs additionally reserve
headroom for cells still in flight so concurrency cannot overshoot it. One
residual softness is by design: the `claude-cli` lane has no mid-run cost stop
(wall-clock timeout only), so before its first row lands there is no measured
worst case to price it at and that first run can exceed the ceiling on its own.
Runs print this caveat when the lane is selected.

---

## Publishing results 📤

```bash
bun src/cli.ts publish --run-id smoke-1     # → published-runs/smoke-1/
```

The bundle is **redacted**: `results.jsonl`, `summary.json`, `scoreboard.md`,
the run spec, the corpus hashes and a README. No transcripts, no diffs, no fork
trees, no judge replies — those stay in the gitignored `runs/` tree for audit.
Machine-local paths are stripped from the manifest.

Before writing, the bundle is **self-checked** for `/Users/` paths, key-shaped
tokens (`sk-…`, `ghp_…`, `github_pat_…`, `AKIA…`, `Bearer …`, JWTs, PEM blocks)
and third-party email addresses. Any hit deletes the bundle and refuses to
publish, naming the file and line (with the secret masked). `publish` also
refuses to overwrite an existing bundle.

A bundle is committed **only after a human reads it end to end**.

---

## Cost table 💸

```bash
bun src/cli.ts cost smoke-1 [more-run-ids...] [--models 6 --items 5 --k 3]
```

Sums the **real reported** `usage.cost` per pass (observe pass per model,
executor pass per lane, judge pass), then extrapolates — the plan's formula
`N_models × (obs pass) + (N_models + 3) × k × N_executors × (executor pass)`,
written out per item and per route:

```
observe  = items × Σ(per-model measured observe mean)      [shared by both routes]
executor = items × (models + 3 controls) × k × mean cost per fork-run in that lane
judge    = items × (models + 3 controls) × k × mean judge cost      [UPPER BOUND]
```

Observe cost is priced **per model** (a cheap model must never be priced at an
expensive model's rate); only models the source runs never measured fall back to
the blended mean, and the table says how many did. The judge term is an upper
bound because the judge is skipped when `check.sh` decided mechanically and the
diff was empty.

Both executor routes are shown side by side, every number is labeled
**measured** or **extrapolated**, and calls whose cost was not reported are
counted in their own column. Defaults for the target matrix come from the run's
own spec; when several source runs disagree about the matrix they ran, the table
says so instead of silently picking one.

**There is no pricing table anywhere in MemBench.** A pass with no measured rate
is excluded from the total and named; a run that reported no cost at all is
refused, not estimated.

---

## Reproduce from a clean clone 🔁

```bash
git clone <this repo> mb-verify
cd mb-verify/membench
bun install            # one runtime dep: the exact-pinned @openrouter/agent (+ zod peer)
bun test               # full offline suite — no network, no API key
bun src/cli.ts run --mock --spec tests/fixtures/e2e-spec.toml \
  --run-id verify --corpus-dir tests/fixtures/mini-corpus
bun src/cli.ts score --run-id verify
```

That proves the harness runs with nothing but Bun and git. A live run
additionally needs `OPENROUTER_API_KEY`, a claude-mem checkout
(`CLAUDE_MEM_ROOT`) for the per-fork workers, and — for the `claude-cli` lane —
the Claude Code CLI on `PATH`. Live runs are local-machine only: remote
sandboxes block `openrouter.ai`.

`claude-cli` credentials are resolved host-side (macOS Keychain, looked up
account-qualified, or a `.credentials.json` / `MEMBENCH_CLAUDE_CREDENTIALS_FILE`),
seeded into the isolated fork `HOME` as `.claude/.credentials.json` mode `0600`,
and scrubbed on every exit path so live tokens never persist in a kept fork dir.

Every published number is reproducible from this repo: the corpus is
content-hashed and frozen, the spec is committed, `results.jsonl` carries one
row per fork-run, and the observation prompt, parser and mode config are
vendored verbatim from claude-mem (with provenance headers) rather than
reimplemented.

### Repo layout

- `corpus/` — the frozen items (see [Corpus format](#corpus-format-))
- `membench/` — the harness (`src/`, `tests/`)
- `run-specs/` — the reviewable TOML spec of every run we publish
- `runs/` — raw run artifacts: transcripts, diffs, fork trees (gitignored)
- `published-runs/` — redacted, self-checked, hand-reviewed result bundles
- `plans/2026-07-31-membench-v0.1-plan.md` — the normative build plan

---

## What we ship

- 📦 `corpus/` — transcripts + tasks + pass/fail checks (frozen, versioned)
- ⚙️ `membench/` — one command runs everything, spits out a scoreboard
- 🧾 every run auditable (full transcripts + diffs + mem-search logs kept)

**Runnable by anyone. That's the credibility.**

---

## Why us

- 🥇 Only claude-mem has **real session N → session N+1 data** (tasks come from
  what the user *actually did next* — no made-up tasks)
- 🔌 Real production pipeline (observation prompt, parser, injection,
  mem-search) — we benchmark the actual product, not a toy
- 📈 50M+ sessions of telemetry to sanity-check lab results

## The OpenRouter deal 🤝

- Alex Atallah donates credits → **we owe him a cost estimate FIRST**
  (run 2–3 items, read real `usage.cost`, extrapolate, send numbers)
- OpenRouter gets cited in everything published
- All models run through OpenRouter

**Where the citation lands:** every scoreboard, every cost table and every
bundle under `published-runs/` carries the OpenRouter credit, and every cost
figure in this repo is a reported `usage.cost` value — never a rate-table
estimate. `bun src/cli.ts cost <run-id>` is the deliverable itself.

---

## Do next ▶️

1. Open a fresh Claude Code session
2. Paste the kickoff prompt (bottom of
   `plans/2026-07-29-membench-openrouter-kickoff.md`)
3. It builds `membench/` + 5-item corpus, offline-tested
4. Live cost probe runs on **a local machine** (remote Claude Code envs block openrouter.ai)
5. Send Alex the cost table 💸

## Don't forget ⚠️

- Publish results **even where Claude loses** — that's the credibility engine
- k≥3 runs per fork (executors are random-ish)
- Count ≠ value. Never headline count.
- Full details: `plans/2026-07-29-membench-openrouter-kickoff.md`
- Never estimate a cost, never split tokens 70/30 — report `null` and say so
  (the harness enforces this: unreported cost stays `null` and is surfaced)
