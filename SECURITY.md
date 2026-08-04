# Security

This repository must remain private. Do not place credentials, real user data,
model transcripts, local filesystem details, or production run artifacts in
issues, pull requests, commits, fixtures, or logs.

Report vulnerabilities through the repository's private GitHub security
channel. Describe how to reproduce the issue with synthetic values only. If a
credential or private datum may have been exposed, stop distribution, revoke
the affected credential, and notify the repository owner outside public issue
content.

The release gate is defense in depth. A passing scan is not permission to
publish a dataset or change repository visibility.

## Scanner scope and limitations

The release gate checks the worktree, staged Git blobs, and reachable history.
It parses JSON and supported TypeScript-family files, follows resolvable local
JSON Schema Pointer references, and applies resource-bounded, lexical-symbol
static analysis to literal, concatenated, const-bound, and interpolated
TypeScript keys. External schema references are rejected because their targets
cannot be certified offline. JSON Schema `$dynamicRef` is also explicitly
rejected: dynamic-scope resolution is unsupported and therefore fails closed.
Within `patternProperties`, all supported instance-bearing schema keywords
(`const`, `default`, `enum`, `example`, and `examples`) are rejected for every
pattern without attempting to prove what the regular expression can match;
declaration-only pattern schemas remain allowed.

This is deliberately not a proof against arbitrary program behavior. Keys
constructed at runtime through input, collection operations, function calls,
reflection beyond the explicitly checked APIs, `eval`, proxies, or equivalent
dynamic mechanisms are outside the static claim. Markdown tables and prose are
not treated as serialized object fields. YAML and TOML use a conservative
key-oriented tokenizer rather than a complete parser, so malformed documents
and unsupported syntax are not certified. These cases require review or a
format-specific validator; they must not be described as scientifically proven
exclusions.

For cross-platform safety, filenames containing control or invisible format
characters, non-ASCII separators, leading or trailing spaces, trailing dots,
or Windows-reserved device names are rejected. This is a portability baseline,
not a claim that every filesystem ambiguity is detectable.
