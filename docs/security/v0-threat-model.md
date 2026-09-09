# V0 Threat Model

Date: 2026-09-09
Status: Accepted for benchmark spike

## Trust model
Trusted:
- local user decisions
- gateway policy configuration
- local approval surface when introduced
- exact-pinned DevSpace binary at the audited revision

Semi-trusted:
- DevSpace runtime (privileged backend, not a sandbox)
- repository content
- AGENTS/README/project instructions
- command/test output
- provider/model output

Untrusted:
- Internet requests
- anonymous MCP callers
- unknown repositories and files
- repository-supplied prompt injection

## V0 mandatory controls
- authenticated public MCP endpoint; fail closed on missing/invalid identity
- DevSpace localhost-only and never directly tunneled
- opaque workspace IDs mapped to canonical allowed roots
- no drive-root workspace
- deny credential/system paths
- Windows-specific path-containment tests for traversal, symlink/junction/reparse/UNC/device-path escapes where practical
- bounded file reads with size/binary handling
- `repo.snapshot` output budget and pruning
- no arbitrary public shell tool
- `verify.run` only through configured profiles with timeout/output/env limits
- request correlation IDs and failure accounting
- repository/output content cannot mutate policy or approval state

## V0 explicit limitations
V0 is not an OS sandbox. It does not claim containment against a malicious executable or repository once arbitrary code execution is intentionally allowed. Stronger controls such as a low-privilege Windows account, WSL2/container/Windows Sandbox, and network egress filtering are deferred until empirical value is proven or a prerequisite forces them.

## Future approval invariants
When mutation is introduced, approval must be local, one-time, atomic, fingerprint-bound to canonical action parameters, and rejected if the target/base hash changes. Model-generated summaries are advisory only; the approval surface renders canonical gateway data.

## Future state invariants
Persistent approval/job storage and idempotency are not required for the initial read/verify spike. If added, retries must be keyed by caller/request identity plus canonical tool-parameter hash to prevent duplicate consequential actions.
