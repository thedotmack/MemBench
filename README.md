# MemBench

MemBench asks a narrow causal question: **does a background-observer memory system help an agent finish a task because it supplied the right memory, without adding misleading context, drift, or unsupported claims?**

It is an evaluation harness for memory systems. It is not a memory product, a general model leaderboard, or an OpenRouter/Ori compatibility layer.

## Relationship to Ori Eval

Ori Eval's public framing is useful, but it is not a drop-in background observer. An eval harness sits outside an agent and judges a run; MemBench's observer sits on the treatment side of the experiment and produces the memory being tested. MemBench therefore borrows the presentation pattern—not the execution boundary:

| Ori-shaped question | MemBench measurement |
| --- | --- |
| Did the required behavior occur? | Did the candidate use or retrieve task-relevant issued memory? |
| Was forbidden behavior avoided? | Did the candidate avoid misleading memory, drift, and unsupported claims? |
| Did the run complete well? | Did a mechanical check or separately configured blinded rubric measure task success? |

Ori-style assertions are a good fit for regression tests around a single agent run. MemBench adds an experimental layer for the causal question: prespecified controls, repeated executions, item-level paired effects, multiplicity correction, missingness, budget gates, and an independent-reassessment agreement check. An Ori adapter could eventually be one outcome-judge implementation; treating Ori itself as the memory observer would collapse the treatment and evaluator roles.

## The experiment in one loop

```text
synthetic events → background observer → candidate memory
                                           ↓
task + assigned arm → isolated executor → mechanical/blinded outcome
                                           ↓
                    paired item effects, audit, aggregate report
```

Every candidate is evaluated against four arms on the same calibrated items:

- `candidate`: memories produced by the system being tested.
- `none`: no injected memory, establishing a floor.
- `shuffled`: unrelated candidate memories, testing whether generic extra context explains the result.
- `reference`: a fixed, task-relevant memory, estimating a descriptive reference gap.

One factory-issued execution batch owns the whole experiment. It derives the exact candidate × lane × item × arm × repetition schedule, runs every coordinate once through the orchestrator, and records commitments to the schedule, manifest, injected inputs, validated results, calibration, and reassessment evidence. The `candidate` arm receives only the same item's issued observer-memory artifact; `none` receives an empty input; `shuffled` receives a deterministic other item's observer memory; and `reference` receives the exact compiler-issued control bound to that item and lane. Public comparison APIs accept this issued batch, not caller-supplied score arrays.

Artifact identity is resolved from evidence, not accepted from a label. MemBench hashes the validated corpus documents and events, fixed observer/executor/reference/judge protocols, routes and sampling, reference sources, complete schedule, and actual run manifest. The TOML `[commitments]` values are expected pre-registration assertions. They are deliberately excluded from the portable configuration hash and must exactly match the independently derived artifacts before issuance, so changing a label cannot mint a second self-authenticating experiment.

Before scored repetitions, calibration uses an independent `k = 1`: the `none` arm must fail and the `reference` arm must pass. Items that do not meet both conditions are excluded from the effect estimate with a recorded category. If scored `none` or `reference` outcomes contradict that screen, the item is excluded as `calibration_instability`. Spend reporting includes the measured attempt pipeline for every scheduled arm and item, including excluded items, plus the two independent calibration attempts once per item–lane.

The candidate-minus-floor effect is paired by item. Confidence intervals resample items, not attempts, and use a Bonferroni-adjusted alpha across the declared candidate/lane comparison family. Candidate-minus-shuffled is diagnostic, and the reference gap is descriptive; neither forces a recommendation. Missing measurements remain `unknown` or `unmeasured`. The current decision policy declares a zero tolerance for unknown candidate outcomes: one unknown makes that pair insufficient, while only an explicit `fail` increments the task-failure count.

## Background observer versus evaluator

The observer runs alongside the source events and writes candidate memory. Its issued batch commits both the complete event universe and one canonical memory artifact per item; those exact artifacts become execution inputs. It must report the exact requested no-fallback route. It supplies evidence; it does not decide whether the task succeeded. Outcome measurement comes from a mechanical check when available and a separately configured blinded rubric judge when needed. An independent reassessment audit estimates agreement with the primary outcome process. Its size, uniform-without-replacement policy, and minimum acceptable agreement are frozen in TOML; MemBench derives its eligible view from executor-response and tool-trace artifacts and keeps primary outcomes private from that view.

Reports borrow an easy-to-scan pattern from Ori Eval’s public framing while keeping the systems distinct:

- **Required behavior:** task-relevant memory use or retrieval occurred.
- **Avoided behavior:** misleading memory, task drift, and ungrounded claims did not occur.
- **Outcome measurement:** the mechanical check or blinded rubric supplies the task-result measurement.

MemBench reports these three dimensions; it does not claim to run Ori or reproduce Ori’s API.

## Offline synthetic quickstart

Requirements: Bun `1.3.9`. The demo derives a report from newly authored synthetic attempts and a deterministic synthetic observer, makes no network request, needs no credential, and executes no task shell.

```sh
bun install --frozen-lockfile
bun test
DEMO_ROOT="$(mktemp -d)"
bun run demo --output "$DEMO_ROOT/bundle"
ls "$DEMO_ROOT/bundle"
```

The destination must not exist. MemBench writes and verifies a fresh sibling staging directory, writes its manifest last, then renames the complete directory into place. The demo publishes only the exact allowlist: canonical report JSON, self-contained Markdown, optional JUnit, release-safe provenance, release attestation, and a hash manifest.

The report starts with the decision-bearing facts:

```text
Observer: active (background evidence; not the evaluator)
Decision: recommend | do_not_recommend | insufficient_evidence
Task success: measured rate or unknown
Floor delta: estimate and item-bootstrap interval or unknown
Shuffled delta: diagnostic estimate and interval or unknown
Reference gap: descriptive estimate and interval or unknown
Attributed hits / drift avoided / tokens to done
Total measured experimental spend and component breakdown, or unmeasured
```

It then shows the complete candidate × executor-lane family, decision reasons and policy, calibration exclusions and instability, categorized failures, all three paired item effects, unmeasured telemetry, independent-reassessment status/agreement and audit commitments, every resolved experiment identity hash, budget evidence, and aggregate commitments for every issuance stage. The primary pair, evidence thresholds, zero unknown-outcome tolerance, audit-agreement threshold, expected run/corpus/prompt/harness/judge commitments, audit seed, audit sample size, and audit policy are prespecified in TOML. Reports accept only a comparison family derived from the exact issued execution batch; they recover the same issued observer and artifact set from that execution binding. The audit argument is explicit: `null` remains reportable but makes a would-be recommendation insufficient, while agreement below the declared minimum produces `do_not_recommend`. After a process restart, issued projections must be recomputed from validated persisted evidence. See [the reporting contract](docs/reporting-contract.md).

## Privacy and execution boundary

This clean-room repository contains no old repository objects, real user corpus, model transcripts, tool payloads, private evaluation artifacts, or copied memory-backend source. Committed examples are newly authored and synthetic.

The public-bundle generator is fail-closed. It accepts an exact aggregate schema and rejects unknown fields, raw prompts or events, transcripts, tool request/result data, diffs, judge prose, local paths, artifact locations/identifiers, private-shaped keys, and unsafe values. It does not silently strip input. The release gate scans the worktree, Git index, reachable history, structured field shapes, secrets, and unsafe paths. These controls are defense in depth, not proof that arbitrary data is safe.

Live task execution is **unavailable by default**. A caller-supplied environment flag is not evidence of isolation. The runtime requires a verified live sandbox capability issued by an implemented backend; none ships here. The deterministic sandbox is test-only and cannot claim live isolation.

Read [data governance](docs/data-governance.md), [corpus format](docs/corpus-format.md), and [runtime safety](docs/runtime.md) before adding data or connecting a provider.

## Limitations and non-claims

- The included demo validates plumbing, not real-world memory quality.
- An LLM judge can be wrong; agreement is reported only for the predeclared independent reassessment sample. Runner-supplied execution artifacts are not independently time-attested, so MemBench does not claim independently verified judge isolation from post-execution signals.
- The observer and independent reference calibration must report their exact requested no-fallback routes. Candidate, `none`, `shuffled`, and `reference` scored executions must report one effective provider/model pair across every item and repetition; missing or mixed route evidence cannot support a recommendation.
- Effective provider/model labels must match the public safe grammar; unsafe path-, markup-, delimiter-, control-, format-, or bidi-shaped labels are rejected rather than published.
- Total spend is reported only when every executed attempt-pipeline, calibration, observer, and audit component reports cost. Missing component spend is contagious and the breakdown remains visible. Observer, executor (including calibration), judge (including audit), and step budgets are reported separately; missing measurement or an overshoot cannot support a recommendation.
- Repeated model calls are not assumed independent; the inferential unit is the item.
- Passing the release gate does not establish ownership, consent, licensing, or absence of every possible secret.
- No benchmark result establishes performance outside its declared corpus, lanes, routes, prompts, and configuration.

## Contributing and releasing

Use a feature branch and pull request. Run:

```sh
bun install --frozen-lockfile
bun audit
bun run typecheck
bun test
bun run release:gate
```

Corpus changes require provenance, authority, consent/licensing review, an independent sensitive-data review, and an approved release attestation bound to the content hash. Public bundles must be generated through the allowlisted generator. CI repeats the offline suite and privacy checks. Live evaluation has a separate manual/scheduled template, never runs on pull requests, and remains fail-closed until an operator-controlled environment provides both a credential and an independently verified sandbox backend.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) for the full workflow.
