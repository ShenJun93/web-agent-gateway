# Goal Lease atomic budget reservation — source receipt

Date: 2026-09-23

This receipt is repository evidence for the multi-session Goal Lease architecture. Later sessions
must read the repo/runtime again rather than treating chat history as authoritative.

## Baseline and deployment status

```text
workspace =
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch =
feat/goal-ui-delegation-v1

HEAD =
f1c8cc54cb47b23253992993ba9e583f9864ce60

live runtime =
f1c8cc54cb47b23253992993ba9e583f9864ce60
```

HEAD did not move during this slice.

No Git commit, promotion, WAG tunnel restart, DevSpace restart, provider/session reconfiguration,
Goal Lease issuance, Goal Lease revocation, UAF mutation, or PFP mutation was performed.

The source changes below are therefore **green in the working tree but not yet deployed**. The
currently live runtime remains the already-promoted `f1c8cc54...` runtime.

## Problem closed by this slice

Request-time resolution is a read-before-write decision. Before this slice, two independent WAG
processes sharing one durable store could both observe the same remaining lease budget before either
process recorded its policy authority row.

The store already had the correct serialization boundary:

```text
policyAdmitMutation
  -> transition(PENDING_APPROVAL -> QUEUED)
  -> BEGIN IMMEDIATE
  -> record POLICY_APPROVED mutation_authority row
  -> COMMIT
```

The missing property was a budget check **inside that write transaction**.

## Implementation

New module:

```text
src/goal-lease-atomic-budget.ts
sha256 = 46f20250f87923c34851bcd1aff329a1fb49858f24399ea97ee7917f5d89aab8
size   = 5986
```

It installs a persistent SQLite `BEFORE INSERT` trigger on `mutation_authority`.

The trigger applies only when:

```text
NEW.authority = POLICY_APPROVED
AND NEW.lease_id IS NOT NULL
```

Human approvals therefore remain outside Goal Lease budget accounting.

Because `policyAdmitMutation` performs this insert inside its existing `BEGIN IMMEDIATE`
transaction, SQLite serializes competing writers before the trigger evaluates the durable spend.
The authority row is therefore the atomic budget reservation.

The trigger fail-closes on:

- missing/revoked/not-yet-valid/expired lease at the reservation timestamp;
- malformed or absent positive integer `maxFiles`, `maxBytes`, or `maxDiffBytes`;
- per-proposal diff budget overflow;
- aggregate file budget overflow;
- aggregate byte budget overflow.

The file count uses the same conservative admission semantics as the existing resolver: existing
durable distinct `(workspace_id, path)` count plus the new request.

No production code reaches into `SqliteDurableStore.db`. The installer opens the same absolute
SQLite state path through its own short-lived `DatabaseSync` connection, installs the persistent
schema invariant, then closes that connection.

The installer is wired fail-closed into both production mutation runtimes:

```text
src/repository-engineering-runtime.ts
sha256 = 680f7f410fd82a1f607d342156758aaee2a07927f973d9ae87510fe3fbb9732c
size   = 16816

src/browser-operator-runtime.ts
sha256 = c91cbd1e99c50aa4152492921c1fa4285622ac40d3242d0684da4d545fcc3c41
size   = 20417
```

Private stdio closes its just-opened store and fails startup if guard installation fails. Browser
operator installation runs inside its existing guarded startup/teardown path.

## Coordinator mapping

`src/durable-mutation.ts` now translates only the trigger's closed sentinel errors into ordinary
lease denials:

```text
src/durable-mutation.ts
sha256 = e7adac2d4dc356f2703d623cf65d774ef7288c3e1f5ac3491f83672f0f9f4800
size   = 35035
```

Stable mappings:

```text
atomic file overflow -> FILE_BUDGET_EXHAUSTED
atomic byte overflow -> BYTE_BUDGET_EXHAUSTED
atomic diff overflow -> DIFF_TOO_LARGE
stale/malformed lease at reservation -> NO_LEASE
```

Unknown SQLite failures are not converted into policy denials; they still throw. This prevents a
database fault from being mislabeled as an expected authorization refusal.

A rejected atomic reservation rolls back the store transition. The losing mutation therefore stays
`PENDING_APPROVAL`, gains no authority row, and performs no filesystem effect.

## Deterministic cross-connection race proof

New test:

```text
test/goal-lease-atomic-budget.test.ts
sha256 = e7ed813a535c966a20279dbcfb5e6dbc991ee092a9e0f45375446525c1bb168f
size   = 6551
```

The test uses **two independent `SqliteDurableStore` connections to the same state file**.

Both proposals are created before either reservation. The second resolver is then deliberately
pinned to the spend snapshot read before the first writer commits. This deterministically recreates
the dangerous read-before-write race without scheduler sleeps.

Measured:

```text
npx tsx --test --test-concurrency=1 test/goal-lease-atomic-budget.test.ts

tests 2
pass  2
fail  0
```

Proved:

1. with exactly one file-budget slot remaining, store A reserves it and writes; store B still sees
   the stale zero-spend snapshot but is rejected by the trigger as `FILE_BUDGET_EXHAUSTED`;
2. with exactly one byte-budget slot remaining, the same stale-read race rejects store B as
   `BYTE_BUDGET_EXHAUSTED`;
3. the losing proposal has no mutation-authority row;
4. the losing proposal remains `PENDING_APPROVAL`;
5. the losing backend performs no write;
6. durable spend contains exactly the winner.

This is the required "concurrent last budget slot: exactly one wins" property at the shared durable
SQLite serialization boundary.

## Effect-boundary hardening retained

The prior slice remains present and green:

```text
src/goal-lease-resolver.ts
sha256 = d7ee48aece085fea21a55bd5cace225b9a22c479445e4be0a911c4fba50b29d8
size   = 3468

src/git-commit.ts
sha256 = 48e61c018b13494ebdfea7fddebeb2e6cdb50da6c75aa718bbdc58fe60202383
size   = 28808

test/goal-lease-effect-revalidation.test.ts
sha256 = 446b1e1ae034b00448781eb23f992acae0cdfb43e976e3ea79f8c773c0eab255
size   = 10187
```

That slice re-resolves policy authority immediately before filesystem writes and immediately before
the Git commit backend may move a ref. Revocation, ambiguity, successor substitution, and kill state
therefore remain fail-closed at the effect boundary.

## Verification on the exact working-tree bytes above

Production composition plus new gates:

```text
npx tsx --test --test-concurrency=1 \
  test/goal-lease-atomic-budget.test.ts \
  test/goal-lease-effect-revalidation.test.ts \
  test/repository-engineering-runtime.test.ts \
  test/browser-operator-runtime.test.ts

tests 23
pass  23
fail  0
```

Goal Lease policy/regression set:

```text
npx tsx --test --test-concurrency=1 \
  test/goal-lease-policy.test.ts \
  test/goal-lease-resolver.test.ts \
  test/goal-lease-acceptance.test.ts \
  test/goal-lease-commit.test.ts \
  test/goal-lease-review-fixes.test.ts \
  test/goal-lease-effect-revalidation.test.ts \
  test/goal-lease-atomic-budget.test.ts

tests 61
pass  61
fail  0
```

Build gates:

```text
npm run typecheck = PASS
npm run build     = PASS
```

Do not inflate this into a claim that the entire repository suite passed; only the measured gates
above are claimed here.

## Why durable-store.ts was not edited

`src/durable-store.ts` exceeds the current WAG mutation backend's 64 KiB target ceiling. An earlier
bounded edit attempt was explicitly rejected by WAG. No shell-write or private-DB bypass was used.

The trigger design closes the race at the existing database transaction boundary without weakening
that WAG guard and without exposing the store's private SQLite handle.

## Current acceptance state

```text
multi-active request-time resolver                  = LIVE at f1c8cc54
pre-side-effect mutation authority revalidation     = SOURCE GREEN, NOT DEPLOYED
pre-side-effect commit authority revalidation       = SOURCE GREEN, NOT DEPLOYED
atomic cross-process file/byte budget reservation   = SOURCE GREEN, NOT DEPLOYED
two-connection stale-read race proof                 = 2/2 PASS
runtime-composition focused gate                     = 23/23 PASS
Goal Lease focused regression                        = 61/61 PASS
typecheck/build                                      = PASS
stable provider-derived per-chat session identity    = OPEN
live A/B/C multi-session acceptance                  = BLOCKED ON HUMAN-ISSUED AUTHORITY
git.push authority                                   = DENIED / NON-GRANTABLE
```

## Next authority/deployment boundary

The current Git HEAD is still `f1c8cc54...`, while the existing human lease's commit binding was
issued for an older HEAD. This slice does not widen or rewrite that authority.

Do not:

- mint/renew/widen a Goal Lease automatically;
- edit `sessionCorrelation` automatically;
- bypass Git branch/HEAD CAS;
- reset/clean the private-index worktree;
- commit or promote blindly from the current dirty state.

A person must review and issue the next bounded authority envelope before any source commit that
requires a new HEAD binding. Live multi-session A/B/C acceptance still requires independently
usable stable provider/session contexts and human-issued leases for those contexts.

Human-only Goal Lease issuance remains intact.
