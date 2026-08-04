# Scientific core contract

Phase 2 fixes the design before any outcomes are observed. The parsed TOML,
including the primary candidate/lane pair, all three seeds, budgets, floor,
schema, attribution, drift, and independent-reassessment thresholds, and the
multiplicity policy, is frozen and bound to a portable configuration identity
hash. TOML `[commitments]` are expected pre-registration assertions, not trusted
identity inputs: they are deliberately excluded from that configuration hash.

Executor sampling is also predeclared: temperature, top-p, and a seed identity
are part of the frozen spec and its identity hash. The executor derives its
route, limits, and sampling policy only from that parser-issued spec. With the
pinned Agent SDK 0.8.0 adapter, temperature and top-p are transmitted using
the exact supported request fields; the seed identity remains an identity
commitment because that SDK request type has no seed field.

`ExperimentSpec.identityHash` binds the portable run configuration. The
host-local `corpus_path` is validated but omitted from that portable hash, so
the same declared experiment has the same identity after relocation. The
artifact issuer separately derives hashes from the exact validated corpus
items/events, fixed prompt protocols, harness and judge descriptors, routes and
sampling, reference sources, complete schedule, and actual run manifest. It
refuses issuance unless each expected TOML commitment equals its independently
derived value. The broader `ExperimentIdentity` uses those resolved corpus,
prompt, harness, and judge hashes plus requested routes and configuration. That
full identity distinguishes different artifact inputs; changing only an
expected hash label neither changes the configuration identity nor passes
artifact issuance. A parsed spec and artifact set also carry process-local
issuance checks. After a process restart, deserialization, or structured clone,
callers must reparse and rederive from validated source evidence.

The treatment arm is `candidate`. Its controls are `none`, `shuffled`, and
`reference`. Floor delta is candidate pass rate minus `none` pass rate.
Shuffled delta is candidate pass rate minus `shuffled` pass rate. Reference
gap is `reference` pass rate minus candidate pass rate; a positive gap is
valid and is never clamped. Controls and candidate results are always reported
as distinct arms. Shuffled delta is diagnostic and reference gap is
descriptive; neither interval participates in the recommendation rule.

The item is the inferential unit. Repetitions estimate variation within an
item but never give that item extra weight. Intervals resample one paired
effect per item. Candidate-model decisions form one prespecified comparison
family. MemBench uses a Bonferroni adjusted alpha of
`nominal alpha / number of candidate comparisons`; the raw estimate, interval,
nominal alpha, adjusted alpha, and family size remain visible together.
Candidate-model by executor-lane pairs are the comparison family. Duplicate
attempt coordinates, calibration item-lane rows, or comparison pairs fail the
run rather than being overwritten or counted twice.

Before any model-family decision, every predeclared
item-by-lane-by-candidate-by-arm cell must contain exactly the configured
repetitions numbered from zero through `repetitions - 1`. Explicit `unknown`
rows count as present observations but the declared zero unknown-outcome
tolerance makes the affected comparison `insufficient_evidence`; only explicit
`fail` rows increment task failures. Missing rows make the entire comparison
family insufficient with an incomplete-matrix reason. Public comparison starts
only from a module-issued execution batch, never caller-supplied attempt or
calibration arrays. The issuer derives and executes the full schedule, maps the
exact observer/reference inputs to arms, and commits schedule, manifest, input,
attempt, calibration, execution-result, and primary-reassessment universes. Comparison
output is complete over candidate-by-lane pairs and canonically ordered. A
structured clone, raw-array relabel, reused runner-result object, Spec A→B
substitution, or deserialized comparison must be recomputed through the bound
execution path.

Bootstrap inputs are canonically sorted by item identifier before sampling.
The percentile interval sorts the bootstrap means and uses the zero-based,
clamped index `floor(probability * sample count)` for each endpoint. The PRNG
is `membench-mulberry32-sha256-v1`: SHA-256 supplies the initial 32-bit state,
and bounded integers use uint32 rejection sampling to avoid modulo bias.

Unknown outcomes and missing token or cost measurements remain unknown. Any
candidate outcome, attribution outcome, or drift outcome of `unknown` prevents
a recommendation under the current policy. They
are never converted to a pass, a favorable boolean, or zero. Recommendation
also requires measured attribution and drift-avoidance rates at or above their
prespecified thresholds; missing evidence is insufficient and a measured
shortfall is do-not-recommend. An item is
eligible only when an independent calibration attempt has floor `fail` and
reference `pass`. Too few calibrated or paired items produces
`insufficient_evidence` rather than a forced recommendation.

Primary scientific routes require an explicit provider, model, and
`allow_fallbacks = false`; the effective route remains a separate recorded
runtime value. Every candidate and control execution for a comparison must
share one effective provider/model pair across all items and repetitions.
The observer and independent reference calibration must each resolve to their
exact requested no-fallback provider/model pair before their outputs can be
used.
Public effective-route telemetry uses a narrow safe ASCII grammar and rejects
colon/file forms, local paths, markup, delimiters, controls, format characters,
and bidi shapes. Corpus paths must already exist outside the repository after
realpath resolution, including symlink resolution.

Candidate-model values in the experiment are bounded public aliases, not
provider route strings. The route tables separately preserve the requested
provider and model. Public experiment, item, candidate, lane, attempt, and
corpus identifiers use the same safe ASCII grammar and 80-character limit.

The parser and scheduler enforce conservative finite limits: at most 10,000
items, 32 candidates, 16 executor lanes, 100 repetitions, 100,000 bootstrap
samples, 10,000,000 total bootstrap item draws, 10,000 executor steps, and
250,000 scheduled entries. Schedules persist as one immutable canonical JSON
string plus its hash, avoiding a second object graph containing one number per
encoded byte. Alpha is
bounded from 0.000001 through 0.5, and the minimum decision effect is at least
0.000001. The parser checks the full four-arm schedule product and the total
candidate-by-lane bootstrap family before execution. Token counts are safe
non-negative integers capped at 1,000,000,000, with checked aggregation.
Per-pair reported attempt-pipeline spend covers all arms and all items,
including exclusions; family totals add every pair, each independent k=1
calibration item–lane, observer, and audit once. The report separately compares
observer spend, executor plus reference-calibration spend, judge plus audit
spend, and total steps with their declared limits. Any missing executed
component makes total experimental spend unknown while preserving its component
breakdown. A missing budget measurement or measured overshoot cannot support a
recommendation, including when it first appears on the final scheduled call.

Corpus validation preflights document bytes, text bytes, file and event
counts, starting-tree bytes, structural nodes, and nesting depth before
recursive parsing or hashing. Selected experiment values are bound by
`ExperimentSpec.identityHash`. Fixed implementation limits are behavior of the
harness version and are bound by the broader `ExperimentIdentity.harnessHash`;
they are not represented as user-selected spec values.

Attempt journals assign scheduled rows a unique zero-based sequence that is
contiguous and monotonic. The indexed journal builder validates attempt IDs,
scientific coordinates, and final-state transitions in constant expected time
per append; immutable snapshots are the persistence boundary. Terminal and
interrupted timestamps use strict calendar-checked RFC 3339 UTC `Z` syntax
with zero to three fractional digits and cannot predate the scheduled row.

Reference facts use a deliberately conservative mechanical support rule. A
quote must exactly equal a complete eligible string leaf in the cited event;
eligible leaves are complete message text or string values in a tool request or
result, never object keys. Cropped substrings are not evidence. Normalized fact
text must then equal normalized quote text. Evidence coordinates and normalized
facts are each deduplicated. Excluded proposals and their reasons remain in
audit evidence; only admitted fact text is injected, verbatim.
