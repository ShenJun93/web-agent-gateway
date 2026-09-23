# Goal Lease effect-boundary revalidation — source receipt

Date: 2026-09-23

This file is repository evidence. It is intentionally written so a later chat can recover exact
state from the workspace without treating chat history as an authority source.

## Baseline

```text
workspace =
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch =
feat/goal-ui-delegation-v1

HEAD =
f1c8cc54cb47b23253992993ba9e583f9864ce60
```

HEAD did not move during this slice. No commit, promotion, WAG tunnel restart, DevSpace restart,
Goal Lease issuance/revocation, provider setting change, UAF mutation, or PFP mutation was
performed.

The live runtime therefore remains the previously activated `f1c8cc54...` runtime. The changes
described below are source-working-tree changes only until a later bounded commit/promotion is
performed.

## Why this slice exists

The multi-active resolver already selected authority per request, but mutation and commit execution
still had a gap between policy admission and the actual local side effect:

- a mutation recorded `POLICY_APPROVED`, then later wrote the file;
- a commit recorded `POLICY_APPROVED`, then later called the Git commit backend;
- revocation, expiry, a newly ambiguous matching lease, or a successor appearing in that interval
  was not re-resolved immediately before the side effect.

The frozen architecture requires authority to be revalidated at the effect boundary.

## Source changes

Current raw bytes after this slice:

```text
src/goal-lease-resolver.ts
sha256 = d7ee48aece085fea21a55bd5cace225b9a22c479445e4be0a911c4fba50b29d8
size   = 3468

src/durable-mutation.ts
sha256 = b1d4fa808a9e41b577466adfc4a8d243c02faeebf327ec75431f0eeccd6f230d
size   = 34546

src/git-commit.ts
sha256 = 48e61c018b13494ebdfea7fddebeb2e6cdb50da6c75aa718bbdc58fe60202383
size   = 28808

test/goal-lease-effect-revalidation.test.ts
sha256 = 446b1e1ae034b00448781eb23f992acae0cdfb43e976e3ea79f8c773c0eab255
size   = 10187
```

### Resolver

`resolveGoalLease(...)` now accepts a narrowly documented execution-boundary
`spendOverrides` map.

Ordinary admission does not provide it and therefore still reads durable aggregate spend.

Mutation execution uses the override only for the exact lease that already recorded the current
`POLICY_APPROVED` authority row. That row is the existing durable admission/budget reservation;
counting it again during the immediate pre-write liveness check would double-charge the current
mutation.

This does **not** claim cross-process atomic budget reservation. That remains a separate store-level
gap.

### Mutation effect boundary

Immediately before `createNew(...)` or `updateExisting(...)`, a policy-approved mutation now:

1. reads its durable mutation-authority row;
2. rebuilds the request from durable record identity, workspace, path and affected bytes;
3. resolves the current durable Goal Lease set again;
4. consults the current kill switch and delegation provenance;
5. requires the resolved lease id to be exactly the lease id that admitted the mutation;
6. fails the durable mutation before the filesystem write if the authority is gone, ambiguous, or
   has changed.

Human-approved mutations remain on the existing human path.

### Commit effect boundary

Immediately before `backend.commit(...)`, a policy-approved commit now:

1. reads its durable commit-authority row;
2. rebuilds all path requests from the durable commit record;
3. re-resolves current Goal Lease authority with current kill-switch/delegation state;
4. rechecks branch and old-HEAD bindings through the resolver;
5. requires the resolved lease id to be exactly the lease that admitted the commit;
6. fails the durable commit before the backend can move a ref if authority disappeared, became
   ambiguous, or changed to a successor.

The backend's existing branch/HEAD/tree compare-and-swap remains the final Git integrity boundary.
Human-approved commits remain on the existing human path.

## New regression evidence

Focused effect-boundary test:

```text
npx tsx --test --test-concurrency=1 test/goal-lease-effect-revalidation.test.ts

tests 5
pass  5
fail  0
```

The five cases prove:

- the last mutation budget slot executes once rather than being double-charged at revalidation;
- revocation observed at the mutation effect boundary prevents the write;
- a duplicate matching lease appearing at the mutation effect boundary denies as
  `AMBIGUOUS_LEASE`;
- revoking the admitted commit lease and inserting a matching successor does not transfer authority
  to that successor;
- a duplicate matching lease appearing at the commit effect boundary prevents the commit.

Combined Goal Lease regression:

```text
npx tsx --test --test-concurrency=1 \
  test/goal-lease-resolver.test.ts \
  test/goal-lease-acceptance.test.ts \
  test/goal-lease-commit.test.ts \
  test/goal-lease-review-fixes.test.ts \
  test/goal-lease-effect-revalidation.test.ts

tests 46
pass  46
fail  0
```

Build gates on the same working tree:

```text
npm run typecheck = PASS
npm run build     = PASS
```

## Known gap not closed by this slice

Atomic concurrent budget reservation/settlement across independent WAG processes is **not** claimed
closed.

The durable store implementation is in `src/durable-store.ts`. The current WAG file-mutation
backend refuses a target larger than 64 KiB, and that source file currently exceeds that ceiling.
An attempted bounded mutation was rejected with:

```text
Gateway rejected backend target exceeds 64 KiB
```

No shell-write bypass was used. A later slice must add the store-level atomic reservation/settlement
through an authorized mechanism that can safely modify that file, then prove the concurrent
last-budget-slot case across independent store users.

## Private-index warning

This worktree intentionally carries a private-index style state with tracked deletion plus untracked
replacement pairs.

For example, ordinary `git diff HEAD -- src/goal-lease-resolver.ts` currently reports the tracked
path as deleted even though the working-tree file exists, typechecks, builds, and has the raw SHA
recorded above.

Therefore:

- do not use `git reset`, `git clean`, `checkout -- .`, or `restore .` to make status pretty;
- do not treat a bare Git status/diff line as proof that a source file is absent;
- verify the current file bytes directly and use the recorded raw SHA plus fresh tests;
- do not commit or promote blindly from this worktree.

## Acceptance status after this slice

```text
multi-active request-time resolver                  = SOURCE + LIVE AT f1c8cc54
pre-side-effect mutation authority revalidation     = SOURCE GREEN, NOT YET DEPLOYED
pre-side-effect commit authority revalidation       = SOURCE GREEN, NOT YET DEPLOYED
effect-boundary regression                           = 5/5 PASS
combined focused Goal Lease regression               = 46/46 PASS
typecheck/build                                      = PASS
atomic cross-process budget reserve/settle           = OPEN
stable provider-derived per-chat session identity    = OPEN
live A/B/C multi-session acceptance                  = BLOCKED ON HUMAN-ISSUED AUTHORITY
git.push authority                                   = DENIED / NON-GRANTABLE
```

Human-only Goal Lease issuance remains an invariant. This source slice did not mint, renew, widen,
or revoke authority.
