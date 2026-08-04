# Data governance

## Two boundaries

The **private evaluation boundary** may hold an authorized corpus and ephemeral runtime evidence needed to execute and judge an experiment. It belongs in operator-controlled storage outside this repository. The **public release boundary** contains source code, newly authored synthetic fixtures, aggregate reports, release-safe provenance, approved attestations, and hash manifests only.

Never copy old Git objects, user content, real transcripts, tool request/results, diffs, judge prose, local paths, artifact identifiers/locations, raw runtime events, provider credentials, or private run directories into the repository or public bundle.

## Admission and review

Before a corpus enters an evaluation:

1. establish who authored or licensed it and what use is allowed;
2. document consent or the reason consent is not applicable;
3. classify it as newly authored synthetic or authorized public;
4. independently review sensitive content and path/value shapes;
5. run bounded secret and privacy scans;
6. bind provenance and attestation to the canonical content hash;
7. reject the release if any check is incomplete.

The contributor who prepares data should not be the only sensitive-data reviewer. In a public bundle, authority and review references are opaque SHA-256 commitments. Authorized-public source references are unique approved HTTPS URLs. Narrative fields reject path-shaped content rather than carrying private ticket locations, local references, or filesystem fragments.

## Storage and publication

Raw evaluation state is not a publication format. Operators should use a dedicated private location with least-privilege access and a retention policy appropriate to their authority. MemBench does not supply that storage or claim to erase data from provider systems.

Publication uses the fail-closed bundle generator. It validates an exact aggregate allowlist and refuses unsafe or unknown input rather than silently deleting it. Effective route telemetry is public only after strict safe-label validation, and Markdown table cells are escaped. Atomic publication checks parent, staging, child, and destination type/device/inode identities around writes, reads, verification, and rename; symlinks and identity replacement fail closed, and cleanup removes only the staging identity it created.

The release gate separately scans current files, staged index blobs, reachable history, field shapes, unsafe paths, binary/archive content, and secrets. CI runs Gitleaks on the filesystem and reachable history. The redacted TruffleHog wrapper is optional operator tooling and CI tests it only with injected fake scanners; it starts the scanner in an isolated process group and uses a hard TERM-then-KILL timeout with bounded grace and redacted output. CI does not claim a real TruffleHog gate. Scanner success does not replace human authority, consent, or context review.

## Provider and live-operation boundary

Offline tests and the demo require no credential or network. Live evaluation must run only from the separate manual/scheduled workflow in an operator-controlled GitHub environment. A provider credential belongs in that environment, not repository configuration, workflow text, fixtures, logs, or pull-request contexts.

Credential presence is not enough. Live shell execution remains refused unless a real backend issues a verified live-sandbox capability. The repository ships no such backend. Scheduled/template runs default to a dry preflight and must not run on pull requests or code from untrusted forks with secrets.

## Incident response

If sensitive data is suspected, stop publication, keep the remote private, revoke exposed credentials, preserve only the minimum evidence needed for response, remove the unsafe object from all reachable history through an approved process, and rerun both current-tree and history scans. A normal follow-up commit does not remove a secret from Git history.
