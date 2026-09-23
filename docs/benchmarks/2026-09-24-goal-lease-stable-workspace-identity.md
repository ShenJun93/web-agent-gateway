# Multi-Session Goal Lease — stable workspace identity source acceptance

Date: 2026-09-24

## Authority for this receipt

Repository/source/runtime evidence is authoritative for this slice. Chat history is not.

Baseline commit:

```text
branch = feat/goal-ui-delegation-v1
HEAD   = f1c8cc54cb47b23253992993ba9e583f9864ce60
```

This is a **source-only** hardening slice. The working-tree changes below are not committed or
promoted. The live runtime remains the previously promoted `f1c8cc54...` runtime.

## Decision implemented

An opaque `ws_<uuid>` handle is not treated as the stable identity of the object behind a
workspace. New workspace opens can now persist a versioned identity fingerprint over:

```text
canonicalRoot
backendKind
filesystem device identity
filesystem inode/file-id identity
git top-level, when present
absolute git dir, when present
absolute git common dir, when present
```

Branch and HEAD are deliberately excluded. They are mutable repository history and remain separate
Goal Lease commit CAS bindings.

The durable adjunct table is `workspace_identity_v1`. It is installed beside the existing WAG
authority database by `WorkspaceIdentityRegistry`; `src/durable-store.ts` is not enlarged or
given an ad-hoc migration path.

The DevSpace observation helper reuses WAG's existing safe-Git runner policy. It does not inherit
repository-routing Git environment variables or executable repository hooks/filters.

## Goal Lease binding semantics

`GoalLeaseBindings.workspaceIdentities` is optional for migration safety.

- absent: an older lease retains its existing exact-canonical-root semantics;
- present: it must cover every `workspaceRoots` entry exactly once;
- every fingerprint must be a lowercase SHA-256 value;
- a matching request must carry the exact observed fingerprint;
- missing or changed identity denies with `WORKSPACE_IDENTITY_MISMATCH`.

This lets a human issue an identity-bound successor without silently changing the meaning of
already-live legacy leases.

The fingerprint is propagated through:

```text
command.run
mutation admission
mutation pre-effect revalidation
git.commit admission
git.commit pre-ref-update revalidation
```

The browser admitted-workspace service re-observes the identity when it has to reopen a durable
workspace after process/runtime state is lost. Reusing one durable workspace id for a different
filesystem/repository object is refused.

The private stdio surface keeps the pre-existing synchronous `openWorkspaceId` contract. A
separate async `bindWorkspaceIdentity(workspaceId, canonicalRoot, devspaceWorkspaceId)` step is
awaited by `workspace.open` before the handle is returned, so there is no interval in which an
identity-bound caller can use a newly returned workspace before its fingerprint is persisted.

## Current source bytes

```text
src/workspace-identity.ts
59b9bda627f57e67b24e89bcdb2bc1e9bdf21df0d50bbd6815c3c9ea4f665252

src/executor/devspace-workspace-identity.ts
b4da86cf1fd1f5667a85d1fa44c50fd7f5fd54e5fa2e099bc57c2d6ede1e708e

src/goal-lease.ts
484ecd077f4ce2a17db423c6ad3bb9b55ab86db860d1d6ca9a6f056bfc9e104b

src/admitted-workspace.ts
64bce2fecd54028c899955d595036b29e3ecf1a9bf868b621eca15fc1f4fbcd0

src/repository-engineering-runtime.ts
cbe3de2571eb94b89a73a85e8d5fefd34706cdb0134f2296b433de3a13766b14

src/browser-operator-runtime.ts
fbaa36ca7c321daa88ca5dc90960f1c009bfd99d812e3f7a35e402aaef8262f3

src/durable-mutation.ts
2b6998da0cabb644fa2b2361ce5e2bbc481c382cfa7ff4b77a79d282699eadc6

src/git-commit.ts
59129033203f18b533682a48651c8ee81ec327ecb3e0665b2c5f71f9db79af9b

src/private-runtime.ts
d0b50e0c17967b513370980d3dbcdf009d0de5de0db8e42a3d234dc8b69febbe

src/server.ts
35c481fa69e1f4fc706721acc6f849b846c2cb2d6f770f4b40e37d57c908cbc7

src/cli.ts
905f91992e2550422fc06064876f087cbaae8704960b2382a15512205efab018

test/workspace-identity.test.ts
3852ce6665153ffac84f58178c7557b97c87b01b45f96da63a1ec1d46d511860
```

## Measured gates

```text
npx.cmd tsx --test --test-concurrency=1 \
  test/workspace-identity.test.ts \
  test/goal-lease-policy.test.ts \
  test/goal-lease-resolver.test.ts \
  test/admitted-workspace.test.ts
=> 26 pass, 0 fail

npx.cmd tsx --test --test-concurrency=1 \
  test/repository-engineering-runtime.test.ts \
  test/direct-mcp-session-binding.test.ts
=> 21 pass, 0 fail

npx.cmd tsx --test --test-concurrency=1 \
  test/browser-operator-runtime.test.ts \
  test/goal-lease-effect-revalidation.test.ts \
  test/goal-lease-atomic-budget.test.ts
=> 11 pass, 0 fail

npm.cmd run typecheck
=> PASS

npm.cmd run build
=> PASS
```

Measured focused total: **58 pass, 0 fail**.

Do not infer that the entire repository suite passed.

The browser-operator regression drives the real admitted-workspace/DevSpace composition, so the new
safe-Git identity observation helper was exercised through that production assembly rather than
only by pure policy tests.

## Mutation-backend observation

Two whole-file updates to `src/repository-engineering-runtime.ts` returned
`OUTCOME_UNKNOWN / DivergentTarget`, consistent with the already-known trailing-newline patch
edge. In both cases the file was re-read before further work. The on-disk bytes contained the
intended changes; the current source SHA above is from that direct re-read. No blind retry, reset,
clean, or out-of-band write was used.

## Status and next gate

```text
stable workspace identity model       = SOURCE GREEN
durable identity registry             = SOURCE GREEN
identity-bound Goal Lease policy      = SOURCE GREEN
private stdio binding composition     = SOURCE GREEN
browser admitted-workspace binding    = SOURCE GREEN
mutation/commit effect propagation    = SOURCE GREEN
typecheck/build                        = PASS

commit                                = NOT DONE
promotion                             = NOT DONE
live identity-bound successor lease   = NOT DONE
live A/B/C multi-session acceptance   = NOT DONE
```

The existing human-issued lease remains root-bound and its commit HEAD binding is stale for any new
source commit. Do not bypass that CAS. Human-only issuance, revocation, successor review and
`sessionCorrelation` boundaries remain unchanged.

The next authority-changing step is still a human-reviewed successor. Before claiming the stable
identity phase live, the successor bindings should include the exact measured workspace
fingerprint(s), and live acceptance must prove that recreating or redirecting an admitted root does
not inherit the predecessor workspace authority.
