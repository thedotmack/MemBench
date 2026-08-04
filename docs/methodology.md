# Methodology

## Estimand and arms

MemBench estimates whether candidate memory changes task success relative to controls on calibrated items. The primary contrast is candidate minus `none`; candidate minus `shuffled` is a diagnostic for generic or unrelated context; `reference` estimates a descriptive distance from fixed task-relevant memory. Neither shuffled nor reference performance is decision-bearing under the current prespecified policy.

An experiment identity binds resolved corpus, prompt, route, harness, configuration, and judge hashes. The parser-issued specification freezes the primary candidate/lane pair, thresholds, routes, sampling, seeds, budgets, and expected artifact commitments. Those expected values are assertions, not evidence: the artifact issuer independently hashes validated corpus items/events, fixed protocols, routes/sampling, reference sources, the complete schedule, and the actual run manifest, then rejects any mismatch. The expected values are excluded from the portable configuration hash so a changed label cannot authenticate itself. Executor lanes remain separate in both inference and reports.

## Issued execution evidence

`runExperimentEvidence` is the experiment boundary. It derives the schedule and run manifest, performs independent calibration, executes every scheduled coordinate through the resumable orchestrator, validates each returned result, and issues one opaque-bound batch. Its commitments cover the observer event and memory universes, input artifacts, scored attempts, calibration rows, full execution results, and primary reassessment evidence. Comparisons cannot be created from public score arrays or relabeled under another spec.

Arm inputs are derived rather than declared by the attempt runner. `candidate` receives the same item's canonical observer-memory artifact, `none` is empty, `shuffled` receives a seed-determined donor item's observer memory, and `reference` receives the exact compiler-issued reference control bound to the item and lane. A favorable candidate attribution must cite the commitment for its exact non-empty input. Control rows cannot carry candidate attribution or drift claims.

## Calibration

Calibration is a single pre-score pair (`k = 1`) for each item and lane. An item is eligible only when `none` fails and `reference` passes. Other items are categorized as `floor_did_not_fail`, `reference_did_not_pass`, or `unknown`. Calibration calls are isolated from scored repetitions and never enter item summaries. After scored execution, a known `none` or `reference` result that contradicts the screen changes the exclusion to `calibration_instability`; it is not silently left eligible.

This filter answers whether the item can detect useful memory under the declared setup. It can change the target population, so reports disclose both eligible and excluded counts.

## Item-level inference

Attempts are first reduced within each item/arm. Unknown attempts make the affected item metric missing rather than being silently counted as failure. Candidate and control summaries are paired by item. The mean of paired item effects gives every eligible item equal weight, regardless of repetition count.

Confidence intervals use a seeded nonparametric bootstrap over paired items. A draw samples items with replacement and recomputes their mean effect. Attempts are not resampled as if independent. The report records the sample count, adjusted alpha, item count, and a hash of the bootstrap draws.

The declared family contains the candidate/lane comparisons. MemBench divides the nominal alpha by that family size (Bonferroni) before constructing intervals. This is conservative and explicit; changing the family after seeing results invalidates the declared comparison.

## Decision rule and missingness

The three states are `recommend`, `do_not_recommend`, and `insufficient_evidence`. A recommendation requires the configured minimum number of calibrated items, an adjusted lower confidence bound at or above the configured minimum effect, acceptable schema-failure rate, attribution at or above its configured minimum, drift avoidance at or above its configured minimum, the declared zero unknown-outcome tolerance, one measured effective route across all scored arms/items/repetitions, an active experiment-bound observer batch on its exact requested route, within-budget observer/executor/judge/step evidence, and a completed independent reassessment at or above its declared minimum agreement. Any candidate outcome, attribution, or drift value of `unknown` makes the pair insufficient. A missing audit or budget measurement is insufficient; a measured audit agreement below threshold is do-not-recommend. A measured attribution or drift rate below its threshold also produces `do_not_recommend`. Only explicit `fail` outcomes increment failure counts; unknowns remain separately counted. Missing route, outcome, cost, timing, or calibration is never imputed to support a recommendation.

The shuffled diagnostic and reference gap are shown for context only. Neither can independently flip a decision.

## Outcomes, attribution, and drift

Task success is evaluated mechanically where possible. A separately configured blinded rubric judge may handle outcomes that cannot be fully mechanical. Attribution asks whether the claimed useful memory is supported by the injected memory evidence. Drift asks whether execution departed from the task or relied on misleading/ungrounded memory. These signals stay distinct in the report.

## Independent reassessment audit

Before audit judging, MemBench derives a factory-issued reassessment view directly from the issued primary candidate/lane executor-response and tool-trace artifacts. It must exactly cover every prespecified item × repetition coordinate; the audit API accepts no caller-supplied row argument. Primary outcome, attribution, and drift fields and direct judgment values are forbidden from that view, while primary outcomes remain in a private issuance binding for agreement calculation. MemBench derives opaque row identifiers, the uniform-without-replacement sample, and the judge configuration from the immutable specification. The manifest freezes evidence and private primary-outcome hashes, judge configuration hash, declared sample size and policy, audit seed, exact comparison evidence-universe commitment, and selected row identifiers. Additions, omissions, size relabeling, route/config drift, and cross-experiment reuse fail closed. Because runner-supplied artifacts lack independent temporal attestation, MemBench does not claim independently verified judge isolation from post-execution signals. Reports declare that limitation and publish the declared size/policy plus manifest, configuration, universe, and selected-sample hashes.

Audit agreement describes the sampled primary/judge relationship. It does not prove either judge is correct. Its threshold is a prespecified reporting gate, not a post-hoc quality claim.

## Telemetry

OpenRouter SDK telemetry is treated as reported measurement, not reconstructed fact. Requested provider/model and fallback policy are pinned in configuration. Runtime boundaries require exact ordinary-object envelopes and finite non-negative costs, durations, tokens, steps, and call counts. Effective provider/model, generation identifier, tokens, cost, and duration remain null when the SDK does not report them. The observer and independent reference calibration must each report their exact requested provider/model; candidate and all three scored controls must share one measured effective provider/model pair across every item and repetition. Public route labels use a narrow ASCII grammar with at most one namespace slash; colon/file forms, path assignments, drive paths, Markdown/HTML metacharacters, controls, format characters, and bidi controls fail closed.

Per-pair attempt-pipeline spend sums every candidate and control repetition for every item, including excluded items. Family spend sums every pair once, then adds the independent k=1 calibration spend once per item–lane and experiment observer and audit spend once. Observer, executor (including calibration), judge (including audit), and step-budget evidence remains separate. The scored evidence runner completes the prespecified schedule when spend becomes unmeasured so missingness cannot selectively erase later coordinates; a measured overshoot stops later work, while a final-call overshoot remains a complete reportable run. Total measured experimental spend is present only when every executed component reports cost; otherwise total is null and the component breakdown identifies the missing scope. `tokensToDone` and nonexclusive task, schema, attribution, drift, and unknown categories remain separate from spend.
