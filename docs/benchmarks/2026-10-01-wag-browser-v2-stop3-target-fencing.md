# WAG Browser v2 — STOP 3 / Task 4 Target Ownership, Claim Epoch & Fencing

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `238ee99020db09a30aabc49fc82d624ae77f8624`

## Result

```text
BROWSER_V2_PER_TARGET_FENCING = PASS
STALE_CLAIM_RECOVERY = PASS
STALE_OWNER_EXEC_FENCED = PASS
STALE_OWNER_DETACH_FENCED = PASS
TWO_SESSION_TARGET_ISOLATION = PASS
CROSS_PROCESS_DURABLE_CLAIMS = PASS
EFFECT_FINGERPRINT_BINDS_CLAIM_EPOCH = PASS
REAL_EDGE_AI_TAB_GROUP_REGRESSION = PASS

CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
PRODUCTION_PAIRING_UX = NOT_COMPLETE
AUTO_AI_TAB_GROUP_SELECTION = NOT_IMPLEMENTED
LIVE_RUNTIME_PROMOTION = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```

Task 4 adds durable per-target ownership without reintroducing a global Goal Lease.

## Ownership model

Every attached existing-browser target now carries a durable claim:

```text
target_id
owner_id
owner_session_id
adapter_id
browser_session_id
claim_epoch
claimed_at
heartbeat_at
expires_at
state = ACTIVE | RELEASED
```

The claim is stored in SQLite and shared through the canonical repository-engineering state path:

```text
<mutation-state>.browser-target-claims.sqlite
```

The target id is the unit of exclusion. Different sessions may own different tabs concurrently.

There is no machine-wide or browser-wide lease.

## Claim ordering

The accepted ordering is:

```text
OPEN
  durable target claim
  -> optional tab grouping
  -> debugger attach

ACT
  exact owner/session/target/epoch heartbeat + revalidation
  -> target-scoped browser operation

CLOSE
  exact owner/session/target/epoch heartbeat
  -> debugger detach
  -> durable RELEASED transition
```

This ordering prevents a stale owner from detaching a target after a successor has taken a newer epoch.

## Epoch semantics

First claim:

```text
claim_epoch = 1
```

A currently active exact claimant may renew the same epoch.

An active claim owned by a different session fails with:

```text
TARGET_OWNED_BY_OTHER_SESSION
```

An expired or released claim may be taken by a successor:

```text
next claim_epoch = prior claim_epoch + 1
```

Claim rows are not deleted on release. Epochs therefore remain monotonic across normal release and database reopen.

An exact owner whose lease expired but has not yet been superseded receives:

```text
TARGET_STALE
```

After a successor takes a newer epoch, operations from the prior epoch receive:

```text
TARGET_FENCED
```

## Heartbeat / process-death recovery

Default target lease:

```text
30 seconds
```

Active attached sessions renew through a bounded in-process heartbeat, default interval:

```text
10 seconds
```

Browser operations also synchronously heartbeat/revalidate before dispatch.

The timer itself never performs a browser effect. If renewal fails, the next synchronous browser operation surfaces the claim error.

If the owning runtime dies and heartbeats stop, the lease expires. A successor may then claim the target at a higher epoch.

## Stale-owner detach protection

A critical Task 4 invariant is:

```text
old owner must never detach successor debugger session
```

The attached port revalidates and extends the exact claim before calling browser-control `release`.

The integration test proves:

1. session A owns `tab_7`, epoch 1;
2. session B owns a separate `tab_8`;
3. B cannot claim `tab_7` while A is active;
4. after A's lease expires, B claims `tab_7`, epoch 2;
5. stale A cannot execute against `tab_7`;
6. stale A cannot call browser-control release/detach for `tab_7`;
7. B continues to operate `tab_7` and can release it normally.

The stale rejection occurs before control transport dispatch.

## Effect fencing

For attached existing-browser sessions, the durable browser effect plan now includes:

```text
action
target_id
claim_epoch
```

along with the existing logical `browser_session_id` resource identity.

Therefore an idempotency key used under epoch 1 cannot silently replay under epoch 2.

A focused regression holds the same browser session and same idempotency key constant, changes only the claim epoch, and verifies that the effect ledger rejects the second plan as conflicting.

Managed `WAG_VISIBLE` and `WAG_HEADLESS` sessions keep their prior exact-once path and do not receive unnecessary attached-target fencing calls.

## Cross-process durable claim proof

The claim-store tests open two independent `DatabaseSync` connections to the same SQLite file.

They prove:

- session A can claim tab A;
- session B can claim tab B;
- B cannot claim A's live tab;
- an expired claim can be succeeded from the second connection;
- the successor receives a higher epoch;
- the first connection is fenced after succession;
- release does not reset epoch;
- epoch remains monotonic after closing/reopening the SQLite store.

This is accepted as:

```text
CROSS_PROCESS_DURABLE_CLAIMS = PASS
```

It is not the same as proving two independently started WAG processes can share one extension WebSocket control connection.

## Cross-process WebSocket boundary

The durable claim state is cross-process safe, but the current Browser Control WebSocket server is still assembled with the repository-engineering runtime.

A complete process-shared control-plane lifecycle for:

```text
WAG process A
WAG process B
      |
shared extension WebSocket control plane
```

has not yet been accepted.

Therefore:

```text
CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN
```

Task 4 does not overclaim that transport property.

## Browser session metadata

Attached existing-browser session handles now expose bounded internal metadata:

```text
targetId
claimEpoch
claimExpiresAt
```

alongside:

```text
browserSessionId
executionMode
ownershipMode
groupId?
groupTitle?
```

The logical browser session remains the caller-facing resource identity; the epoch is the fencing token.

## Real Edge regression

The STOP 2B Microsoft Edge acceptance was rerun after Task 4 fencing.

Result:

```text
transport                    LOOPBACK_WEBSOCKET
executionMode                AI_TAB_GROUP
ownershipMode                ATTACHED_EXISTING
authenticatedSessionPreserved true
targetStartedInactive        true
activeTabStable              true
semanticSnapshot             true
semanticFill                 SUCCEEDED
semanticClick                SUCCEEDED
finalStateVerified           true
targetStillOpenAfterRelease  true
browserStillOpenAfterRelease true
Windows UIAutomation         false
OS pointer injection         false
user real profile            false
```

The target remained background-capable and the user's active tab stayed unchanged.

## Verification

Latest broad Browser/runtime regression:

```text
Browser / extension / WebSocket batch A = 75 / 75 PASS
Browser MCP / managed / semantic batch B = 38 / 38 PASS
Control / runtime / claim-fencing batch C = 28 / 28 PASS

Total broad regression = 141 / 141 PASS
```

Additional final focused gates:

```text
claim store + fencing integration = 5 / 5 PASS
effect fingerprint epoch binding = PASS
real Edge AI_TAB_GROUP regression = PASS
typecheck = PASS
build = PASS
git diff --check = PASS
```

## Files added

```text
src/browser-harness/browser-target-claim-store.ts
test/browser-target-claim-store.test.ts
test/browser-target-fencing.integration.test.ts
```

## Files materially modified

```text
src/browser-harness/attached-existing-browser-port.ts
src/browser-harness/browser-mcp-runtime.ts
src/browser-harness/browser-port.ts
src/repository-engineering-runtime.ts
test/browser-harness-attached-existing-port.test.ts
test/browser-harness-mcp-runtime.test.ts
```

## Remaining Browser v2 work

Still not complete:

```text
CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN
FRAMEWORK_SAFE_FILL = NOT PROVEN
RICH_TEXT_FILL = NOT PROVEN
OAUTH_TARGET_CONTINUITY = NOT IMPLEMENTED
BROWSER_SESSION_RECOVERY = NOT IMPLEMENTED
PRODUCTION_PAIRING_UX = NOT_COMPLETE
USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED
AUTO_AI_TAB_GROUP_SELECTION = NOT IMPLEMENTED
```

The next P0 product-behavior target is framework-safe form filling, while cross-process WebSocket lifecycle remains a transport hardening item before claiming full independent-process browser concurrency.

## STOP 3 decision

```text
TASK_4_TARGET_FENCING = ACCEPTED_FOR_BRANCH
PROCEED_TO_FRAMEWORK_SAFE_FILL = YES

PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```
