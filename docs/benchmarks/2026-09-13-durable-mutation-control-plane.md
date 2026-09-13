# Durable Mutation Control Plane Receipt

Date: 2026-09-13
Implementation parent SHA: `f0ed03a7ae0bff5872e089c244cb8b5481dc0813`
Branch: `feat/durable-mutation-control-plane`
DevSpace revision: `33d6d0bcc2256024484d2456da924af8afd814ed`
DevSpace package: `@waishnav/devspace@1.0.8`
Protocol baseline: MCP `2026-07-28`

## Candidate scope

This candidate replaces the timing-sensitive remote `preview -> approve -> remote apply` choreography with a durable local mutation transaction:

`mutation.preview -> local operator review -> local execution -> mutation.result`

The remote surface cannot approve or apply a mutation. The default MCP and Business stdio surfaces remain the five non-mutation tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, and `verify.run`.

The historical opt-in `file.patch` spike remains present only for compatibility evidence. It is not promoted by this candidate and is not used by the new protocol.

## Local acceptance evidence

`test/durable-mutation.acceptance.test.ts` uses a fresh disposable Git repository and exact-pinned DevSpace. The happy path proved:

1. durable `workspace.open`;
2. `mutation.preview` persists the immutable plan before returning;
3. the loopback operator surface shows the pending exact mutation;
4. local operator approval advances and executes the stored mutation;
5. `mutation.result` returns `SUCCEEDED`;
6. `file.read` returns the expected candidate content;
7. `repo.snapshot` reports the fixture dirty;
8. local Git evidence shows exactly `note.txt` changed;
9. the final SHA-256 equals the expected candidate hash.

## Restart and crash-safety evidence

The same acceptance file uses file-backed SQLite across reopen boundaries and proves:

- queued work with unchanged base content can be recovered and executed once;
- an `EXECUTING` record whose target already matches the result hash reconciles to `SUCCEEDED` without another write;
- an `EXECUTING` record whose target diverged from both base and result hashes becomes `OUTCOME_UNKNOWN`;
- recovery does not extend review or execution-admission deadlines;
- divergent recovery performs no blind rewrite.

Unit-level coordinator tests additionally prove exact owner/session/adapter fencing, single-use approval/claim transitions, stale-target rejection, sensitive/escape/binary/size bounds, and post-write SHA verification.

## Operator boundary evidence

The local operator service is loopback-only. Tests prove one-time bootstrap, `HttpOnly; SameSite=Strict` session cookies, exact Origin enforcement, per-session CSRF, HTML escaping, `Cache-Control: no-store`, restrictive CSP, `X-Frame-Options: DENY`, and no owner/session/adapter fields in rendered review data.

Operator credentials and the bootstrap URL are not projected through MCP. Remote durable mutation tools are limited to `mutation.preview` and `mutation.result`; their schemas contain no approval id, apply phase, raw patch, local root, owner id, session id, or adapter id.

## Repository verification

Executed from the isolated `feat/durable-mutation-control-plane` worktree:

- `npm test` — PASS: 86 passed, 0 failed, 0 skipped.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run test:business` — PASS: 1 passed, 0 failed, 0 skipped.
- pinned DevSpace compatibility/backend gate — PASS: 8 passed, 0 failed, 0 skipped.
- `git diff --check` — PASS.

The Business acceptance path still uses the exact-pinned DevSpace runtime and rotating OAuth and remains non-mutating.

## Timing interpretation

Historical browser evidence for the old protocol measured 66.717 seconds from preview execution to the later remote apply execution. That exceeded the old approval window and failed closed.

The new local acceptance happy path was observed at approximately 11.1 to 12.4 seconds of test-case wall time in two runs. That number includes disposable Git fixture setup, pinned DevSpace startup/authentication, local HTTP services, mutation execution, read-back, snapshot, and cleanup, so it is not a like-for-like latency benchmark against the 66.717-second browser span.

The architectural improvement is stronger than the raw timing comparison: after `mutation.preview`, successful local review no longer depends on a second Web-AI/model/browser round trip. Local approval advances the exact durable record and execution proceeds locally. The Web AI only needs to retrieve `mutation.result` afterward.

## Gate result

`DURABLE_LOCAL_CONTROL_PLANE = PASS`

`DURABLE_LOCAL_MUTATION_ACCEPTANCE = PASS`

`RESTART_RECONCILIATION = PASS`

`DEFAULT_MCP_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`BUSINESS_MUTATION_ENABLEMENT = NOT_AUTHORIZED`

`SUPPORTED_BROWSER_HOST_MUTATION = NOT_YET_RUN`

`HISTORICAL_FILE_PATCH_PROTOCOL = COMPATIBILITY_ONLY`

This receipt authorizes proceeding to the supported-host acceptance checkpoint only. It does not authorize merging mutation capability into the default or Business surface, removing the historical spike, or widening terminal/Git authority.
