# Scientific core contract

Phase 2 fixes the design before any outcomes are observed. The parsed TOML,
including all three seeds, budgets, thresholds, and the multiplicity policy,
is frozen and bound to an experiment identity hash.

`ExperimentSpec.identityHash` binds the portable run configuration. The
host-local `corpus_path` is validated but omitted from that portable hash, so
the same declared experiment has the same identity after relocation. The
broader `ExperimentIdentity` separately binds the actual corpus content,
prompts, requested routes, harness, configuration, and judge. That full
identity is what distinguishes different corpus inputs; the two identities are
not interchangeable. A parsed spec also carries a process-local issuance
check. After a process restart, deserialization, or structured clone, callers
must parse the TOML again rather than trusting an object that merely has the
same fields and hash.

The treatment arm is `candidate`. Its controls are `none`, `shuffled`, and
`reference`. Floor delta is candidate pass rate minus `none` pass rate.
Reference gap is `reference` pass rate minus candidate pass rate; a positive
gap is valid and is never clamped. Controls and candidate results are always
reported as distinct arms. Reference gap and its interval are descriptive;
they do not participate in the recommendation rule.

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
rows count as present observations; missing rows make the entire comparison
family `insufficient_evidence` with an incomplete-matrix reason. Comparison
output is canonically ordered by candidate and lane, independent of caller
order.

Bootstrap inputs are canonically sorted by item identifier before sampling.
The percentile interval sorts the bootstrap means and uses the zero-based,
clamped index `floor(probability * sample count)` for each endpoint. The PRNG
is `membench-mulberry32-sha256-v1`: SHA-256 supplies the initial 32-bit state,
and bounded integers use uint32 rejection sampling to avoid modulo bias.

Unknown outcomes and missing token or cost measurements remain unknown. They
are never converted to a pass, a favorable boolean, or zero. An item is
eligible only when an independent calibration attempt has floor `fail` and
reference `pass`. Too few calibrated or paired items produces
`insufficient_evidence` rather than a forced recommendation.

Primary scientific routes require an explicit provider, model, and
`allow_fallbacks = false`; the effective route remains a separate recorded
runtime value. Corpus paths must already exist outside the repository after
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
