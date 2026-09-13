# File Patch Mutation Spike Design

Date: 2026-09-11
Status: Approved for implementation
Decision authority: ADR-0008

## Goal

Prove one bounded write path without broadening the production Business/stdio surface: update one existing non-sensitive text file inside an opened workspace, with stale-target protection and a local single-use approval.

This is a post-V0 mutation spike. It is not permission to expose raw DevSpace `apply_patch`, arbitrary shell, Git writes, add/delete/move operations, wildcard approvals, or mutation in the default Business stdio command.

## Existing evidence

The read/verify architecture passed its local value gate. ChatGPT Web Plus and Gemini Web browser-adapter acceptance have both completed autonomous read/verify loops through the Gateway. The exact-pinned DevSpace exposes `apply_patch`; direct fixture probes on 2026-09-11 confirmed a single-file `*** Update File` hunk succeeds and preserves CRLF line endings.

## Public spike contract

The optional MCP tool is named `file.patch`. It is registered only when the caller explicitly enables the mutation spike. Default MCP and Business stdio continue exposing exactly five tools.

Input fields:
- `phase`: `preview` or `apply`;
- `workspace_id`: existing opaque Gateway workspace id;
- `path`: workspace-relative path to one existing file;
- `base_sha256`: lowercase SHA-256 of the exact pre-edit UTF-8 text;
- `before`: non-empty exact text expected exactly once in the target;
- `after`: replacement text;
- `approval_id`: required only for `apply`.

## Preview phase

Preview performs no mutation. Gateway:
1. resolves the opaque workspace binding;
2. validates the relative path with the existing sensitive/escape policy;
3. requires an existing canonical target inside the workspace;
4. reads the exact executor text and rejects NUL/binary or content over 64 KiB;
5. computes SHA-256 over the exact UTF-8 text and compares it with `base_sha256`;
6. requires `before` to occur exactly once;
7. computes the candidate result, result SHA-256, line addition/removal counts, and request fingerprint;
8. stores an in-memory pending approval with a 60-second TTL.

Preview returns `status: "approval_required"`, `approvalId`, `fingerprint`, `expiresAt`, `path`, `baseSha256`, `resultSha256`, `additions`, and `removals`. It never returns the canonical absolute root.

The fingerprint is SHA-256 over a stable encoding of the opaque workspace id, normalized relative path, base SHA-256, SHA-256 of `before`, SHA-256 of `after`, and result SHA-256. It is an integrity identifier, not a secret.

## Local approval

`PatchApprovalStore` is process-memory only. Pending entries contain the approval id, fingerprint, expiry, and a bounded human-readable summary. Approval state has three effective states: pending, approved, consumed/removed.

The store exposes local-only methods for listing a pending request and approving `approvalId + fingerprint`. Those methods are never MCP tools. Repository content, model output, MCP arguments, and verification command output cannot set approval state.

For the browser mutation spike, the operator approval channel is a dedicated local spike runner whose stdin is reserved for approval commands while MCP uses loopback HTTP. This keeps approval out of the remote MCP surface and avoids changing the production stdio protocol. The spike runner is not emitted by the production build.

## Apply phase

Apply requires the same `workspace_id`, `path`, `base_sha256`, `before`, and `after` values plus `approval_id`. Gateway repeats every preview validation from fresh executor state and recomputes the fingerprint.

If path policy, target existence, binary/size checks, base hash, unique `before`, result hash, fingerprint, approval id, approval state, or TTL differs, apply fails closed and does not call DevSpace. A stale or mismatched request is revoked so it cannot later succeed accidentally.

Immediately before mutation, Gateway consumes the exact approved fingerprint. Consumption is single-use. If DevSpace later reports failure, the caller must preview and obtain approval again.

Gateway constructs the Codex-style patch itself and calls only the pinned DevSpace `apply_patch` tool. The remote caller cannot provide raw patch text. The generated patch is restricted to one `*** Update File` target and is derived from the validated original/candidate contents.

After DevSpace returns, Gateway verifies its structured result reports exactly one `update` operation for the requested relative path, then re-reads the target and requires its SHA-256 to equal `resultSha256`. Any executor/result mismatch is reported as a failed mutation even though the underlying write may already have occurred; recovery is by fresh snapshot/read, never blind retry.

## Bounds

`before` and `after` are each limited to 32 KiB UTF-8. The existing target and final candidate are each limited to 64 KiB UTF-8. `before` must be non-empty and appear exactly once. NUL-containing content is rejected.

## Components

`src/patch-approval.ts` owns the TTL-bounded in-memory approval store and local-only approval methods.

`src/file-patch.ts` owns input validation, exact-text replacement, hashing/fingerprinting, generated patch construction, approval consumption, executor result checks, and post-write verification.

`src/executor/devspace.ts` adds a narrow typed `applyPatch(workspaceId, patch)` wrapper over the already-pinned `apply_patch` donor tool.

`src/server.ts` wires the file-patch controller to workspace bindings and registers the MCP tool only when `enableFilePatch` is explicitly true. Existing callers omit that option and remain five-tool surfaces.

`scripts/file-patch-browser-spike.ts` is a non-production operator runner for browser acceptance. It runs the authenticated loopback HTTP Gateway with mutation enabled and accepts local approval commands on its own terminal stdin.

## MCP annotations

`file.patch` declares `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`, and `openWorldHint: false`. Preview still uses the destructive-capability tool because the same semantic tool can apply after approval; hosts must not infer that the tool is harmless from the preview phase.

## Testing strategy

Implementation follows TDD. Tests must prove:
- preview returns an approval request without modifying the file;
- local approval is required, fingerprint-bound, short-lived, and single-use;
- changed target/base hash, duplicate `before`, sensitive path, workspace escape, binary/NUL, and oversize content fail before DevSpace mutation;
- raw model-supplied patch text is not accepted by the MCP schema;
- exactly one existing file is updated and post-write hash verification succeeds for LF and CRLF fixtures;
- DevSpace add/delete/move or wrong-target result metadata is rejected;
- default MCP and Business stdio still list exactly five tools;
- opt-in mutation MCP lists `file.patch` with destructive annotations;
- the browser spike runner can approve a pending fingerprint locally without exposing an approval MCP method.

## Acceptance gate

Before any recommendation to enable mutation in Business stdio, the spike must pass the full repository suite, typecheck, build, diff checks, exact-pinned DevSpace tests, and browser acceptance on the intended host path. Browser acceptance must prove a preview, local approval, apply, read-back, and final repository diff on a disposable fixture/worktree.

A model-generated success marker without matching Gateway execution history and file read-back is not acceptance evidence.

## Explicit non-goals

No production Business mutation enablement, public plugin mutation, Git commit/push/reset/rebase, arbitrary shell, file creation/deletion/move, multi-file transaction, binary patching, persistent approval database, wildcard approval, OS sandbox claim, or recovery by blind retry is included in this spike.
