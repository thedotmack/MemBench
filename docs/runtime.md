# Runtime contract

MemBench treats the memory system as a background observer, not as the agent
being scored. The observer receives the declared corpus events, returns the
strict public observation shape in `schemas/observation.schema.json`, and
writes validated records through `MemoryBackend`. The deterministic backend
is for public tests. Observation writes use one atomic `createBatch` operation:
a duplicate, capacity error, interruption, or backend failure persists zero
records. The HTTP backend uses an operator-injected `fetch` implementation and
a CRUD API; it never reaches into an application's database. Its boundary
requires HTTPS (except explicitly opted-in loopback HTTP), rejects credentials,
redirects, forbidden network literals, unexpected status codes, and malformed
responses, and applies one timeout and a streaming byte cap to the complete
fetch-and-read operation.

Observation validation has two explicit layers. The published JSON Schema and
its runtime structural validator use the same Unicode-code-point length,
control-character, and nonblank rules. A semantic layer then enforces I-JSON
Unicode scalar validity, unique record ids within a batch, and persistence
semantics. Semantic failures are reported as `invalid_semantics`, separately
from `invalid_schema`; persistence interruption is also reported separately.
Only transport envelopes are byte-bounded: raw model responses and HTTP
bodies retain independent UTF-8 byte caps.

Scientific reporting does not accept a bag of individually issued observation
records. `observeExperimentInBackground` requires exactly one unique event
batch per prespecified item, contiguous event indexes, and the committed event
universe before dispatch. The event batches must equal the corpus events in the
same issued artifact set; the observer route and sampling must also equal that
set. Its issued aggregate binds the exact spec/run,
resolved corpus and prompt-protocol commitments, requested and effective observer routes, actual
prompt-hash vector, record universe, one canonical memory artifact per item,
memory universe, and contagious spend/duration. The execution issuer privately
retrieves those exact per-item artifacts; public reports expose only aggregate
commitments, never memory text. A missing or mismatched effective observer route
fails the observer. Once observer spend is missing or over budget, later items
are represented by issued `not_run_budget` records without another model call,
so the exact declared item universe remains visible. Clones,
duplicates, and cross-experiment batches are rejected.

The OpenRouter integration is pinned to `@openrouter/agent` 0.8.0. Its model
adapter uses `OpenRouter.callModel`, `ModelResult.getResponse`,
`stepCountIs`, `maxCost`, fixed `tool` definitions, and `PostModelCall` hooks.
Every request pins `provider.only` and `provider.order` to the declared
provider, sets `allowFallbacks: false`, and sets `allowFinalResponse: false`.
Usage and cost come only from `ModelResult` or the SDK hook payload. Missing
values are contagious by field across calls: one missing cost cannot be hidden
by adding the other calls. Temperature and top-p use the exact 0.8.0 request
fields. Observer and judge seeds are bound into their canonical request and
prompt identities. The executor receives an immutable policy derived from the
parser-issued experiment spec; its temperature, top-p, and seed identity are
therefore configuration commitments rather than caller-controlled options.
The executor seed identity is not sent as an invented SDK option because the
0.8.0 `ResponsesRequest` type has no seed field. The installed public response and hook types report the
effective model but do not report the selected provider; therefore effective
provider is null unless another conforming injected transport reports it.

The executor has only five fixed tools: read a file, write a file, list files,
search literal text, and submit an argv command to a sandbox. A completed
model response is not a successful task. The mechanical check runs first,
and only a passing mechanical check reaches the blinded outcome judge.
Drift and attribution are separate blinded judgments. Attribution is valid
only when it cites one injected fact and one observed downstream consequence
exactly. Judge evidence is passed as a canonical JSON envelope, and the system
instruction declares every envelope field untrusted data. Transport errors and
invalid judge output become `unknown`.
An attempt whose process-tree cleanup or isolation integrity fails cannot pass
the mechanical check and is never submitted to the outcome judge; its final
outcome is `unknown`, explicitly attributed to isolation failure.

## Isolation status

This repository currently ships no verified live sandbox adapter. Inspection
of the available project dependencies and runtime integrations found no
authoritative isolation capability that MemBench can safely claim. The
default `UnavailableLiveSandbox` therefore refuses live execution. This is a
statement about the adapters present in this checkout, not a claim about what
the host operating system can support.

Live eligibility is represented by a module-issued opaque capability, not by a
public `mode`, `verified`, or `live` claim. A structurally similar object is
rejected. This checkout issues no live capability because it contains no
verified live adapter. A future adapter must establish process, filesystem,
network, resource, and process-tree isolation inside this trust boundary.
Merely changing the current directory or invoking the host shell does not
qualify. The deterministic test backend is factory-issued, unmistakably
non-live, and accepted only by the offline executor path.

Each attempt is created below an explicit operator-owned external run root
with separate work, data, and home directories and a declared unprivileged
port. Absolute paths, traversal, backslashes, symlinks, special files,
oversized trees, and out-of-root cleanup are rejected. Diff capture is
deterministic and compares against a private factory-held baseline. Every file
operation revalidates the run, attempt, work, data, and home directory identity
(real path, device, and inode); cloning a workspace object or replacing a
directory cannot authorize access. Paths use a cross-platform collision
identity, and text is bounded by UTF-8 bytes with invalid Unicode, NUL, binary,
and special files rejected. Sandbox cleanup is aggregated across every tool
command, the mechanical check, and final cleanup, including after timeouts and
executor failures.

The deterministic sandbox races every injected handler against its own
timeout, so a handler that ignores cancellation cannot hang the harness. Its
result must be an ordinary object with exactly `exitCode`, `stdout`, `stderr`,
`timedOut`, and `processTreeCleaned`; field types, exit semantics, Unicode,
NULs, and per-stream plus aggregate byte limits are checked before use.

## Calibration, audit, and resume

`runExperimentEvidence` derives one complete schedule and manifest and submits
every candidate, control, item, lane, and repetition through the orchestrator.
The attempt runner receives a factory-derived input: same-item observer memory
for `candidate`, empty text for `none`, a deterministic donor's observer memory
for `shuffled`, or the exact bound reference for `reference`. Returned attempt
and calibration values must be exact ordinary objects with strict finite,
non-negative telemetry. Reusing one returned object for another scheduled
coordinate fails closed. All four arms must resolve to one effective route for
the pair. Only the resulting issued execution batch can enter public comparison
and reporting.

Calibration uses one independent floor attempt and one independent frozen
reference attempt per item and lane. Their attempt identities cannot overlap
the scored schedule. Floor must fail and reference must pass. Exclusions are
preserved, and a contradiction with scored control outcomes is reported as
`calibration_instability`.

A calibration reference accepts only a same-process, compiler-issued reference
control paired with the independently validated corpus item whose content hash,
lane, source hash, facts, and exact injected text it commits to. Cloned or
deserialized controls and items are rejected; after restart the corpus must be
validated and the reference control compiled again.

The audit sample size and uniform-without-replacement policy are declared in
TOML. The audit universe is derived from the issued primary item × repetition
execution results; no public audit API accepts alternate source rows. The sample
is selected with the specification's predeclared audit seed before independent judgments run. The manifest
separately commits to every eligible row and evidence hash and to every primary
row and outcome hash, with distinct universe hashes. It also binds sample size,
raw seed and seed hash, requested provider and model with fallback disabled,
prompt and schema hashes, and the independent judge sampling and seed identity.
The independent judge sees only the row id, derived reassessment view, and its bound
configuration—never the private primary outcome. The view is structurally limited
to runner-supplied executor-response and tool-trace artifacts and forbids outcome,
attribution, and drift judgment keys and direct values. Those artifacts lack
independent temporal attestation, so the report declares an independent-reassessment
limitation rather than claiming blinding. The audit route, protocol hashes, and
zero-temperature sampling identity are derived from the immutable specification.
An experiment-bound audit also binds
the exact parser-issued spec and issued comparison evidence-universe
commitment. Generic audit results, candidate substitution, duplicate ids,
seed/judge drift, and cross-experiment use fail closed. Invalid or unavailable audit
judgments remain unknown; agreement excludes unknown pairs and reports its
denominator.

The orchestrator derives its immutable manifest from canonical persisted
schedule bytes and validates both the schedule and manifest hashes on every
parse or resume. The journal must be a contiguous schedule prefix with exact
lifecycle transitions, coordinates, timestamps, cumulative spend, and derived
budget flags. It appends scheduled and started rows before work. Every started
row receives a terminal or interrupted row.
On resume, a previously dangling started row is first made interrupted.
Attempts settle sequentially so one failure cannot discard other rows.
Observer, executor, and judge spend remain separate. A model call may exceed a
cost or step threshold because Agent SDK stop conditions are evaluated after a
step; the terminal row records that overshoot and prevents another attempt.
Missing spend is never treated as zero. The generic resumable orchestrator stops
on missing spend by default. The experiment evidence issuer opts into completing
the already-prespecified scored schedule with contagious null spend, preventing
missing telemetry from selectively removing later coordinates; its report then
marks the relevant budget `measurement_unknown` and cannot recommend. A measured
overshoot stops later work; when it first appears on the final scheduled row,
the complete run remains reportable as over budget. An ordinary worker exception
records all spend as unknown and interrupts the exact evidence schedule; only a
typed, fully measured attempt failure can settle and continue.

Journal decoding validates exact primitive runtime types before lifecycle
logic: sequence, repetition, steps, measurements, outcomes, reasons, and flags
cannot arrive as numeric strings or coercible values. Each attempt measurement
must respect its per-attempt bound, while checked cumulative totals may exceed
that bound up to the finite schedule-derived aggregate maximum. `null` is
contagious only for genuinely missing measurements. Every clock value is
validated before its row is written, so a reversed start time leaves only the
already-valid scheduled row and never invokes the worker.

All public runtime tests use newly authored synthetic fixtures, injected model
responses, injected HTTP behavior, and the non-live deterministic sandbox.
They require neither network access nor credentials.
