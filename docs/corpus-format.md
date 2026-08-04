# Corpus format

## Public contract

Each corpus item is a strict versioned JSON document containing:

- a safe item identifier and task;
- one argv-based mechanical check;
- an optional blinded success rubric;
- an ordered synthetic or authorized-public event sequence;
- a bounded, normalized relative starting tree;
- corpus provenance and release attestation;
- a canonical content hash binding the task-bearing fields.

Unknown keys are rejected. Paths must be normalized relative paths without traversal, symlinks, platform-reserved names, private-data segments, or cross-platform normalization collisions. Commands are argv arrays rather than shell strings.

The checked-in repository uses only newly authored synthetic fixtures. A message event contains a role and text. A tool-call event can represent structured request/result data inside the private corpus boundary, but these payloads are forbidden from public report bundles.

## Provenance

`classification` is either `synthetic` or `authorized_public`.

- Synthetic data must use `newly_authored_synthetic` with authority basis `author` and no source references.
- Authorized-public data must use `authorized_public_source`, cite at least one reviewed source, and use authority basis `license` or `written_permission`.

Provenance records corpus identity/version, creation time, origin description, license, authority record reference, and the bound content hash.

## Release attestation

An approved item requires all six checks: authority, consent, license, independent review, sensitive-data review, and secret scan. The review must not predate corpus creation. Corpus identity/version and content hash must agree across the item, provenance, and attestation.

An attestation records completed review; it does not make an unsafe source safe. If any basis cannot be established, the decision is rejected and the item is not eligible for a public bundle.

The public-bundle boundary is stricter than the private corpus document: authority and review record references must be SHA-256 commitments, authorized-public source references must be unique approved HTTPS URLs, and narrative provenance must contain no control or path-shaped text.

## Deliberate exclusions

The public repository and release bundle do not contain raw private prompts, transcripts, tool payloads, diffs, judge prose, local paths, artifact identifiers/locations, provider secrets, raw runtime events, or old repository history. Aggregate counts, bounded rates, intervals, categorical failures, null telemetry, and content hashes are the publication boundary.
