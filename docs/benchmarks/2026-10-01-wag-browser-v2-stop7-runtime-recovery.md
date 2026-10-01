# WAG Browser v2 — STOP 7 Runtime / Session Recovery

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Entering HEAD: `4a9b60c369f769f1c7fdd628a46405872acd1649`

## Result

```text
BROWSER_V2_RUNTIME_SESSION_RECOVERY = PASS
GRACEFUL_RUNTIME_RESTART_RECOVERY = PASS
SPLIT_BRAIN_LIVE_LEASE_BLOCK = PASS
CRASH_LEASE_EXPIRY_RECOVERY = PASS (source/integration)
ATOMIC_MULTI_TARGET_OAUTH_RECOVERY = PASS
EXACT_ONCE_NO_DUPLICATE_RECOVERY = PASS
REAL_EDGE_RUNTIME_RECOVERY = PASS

USER_REAL_PROFILE_RECOVERY = NOT_EXECUTED
REAL_OS_PROCESS_SIGKILL_RECOVERY = NOT_EXECUTED
PUBLIC_LAUNCH = NO
LIVE_RUNTIME_PROMOTION = NO
```

## Durable recovery model

Attached existing-browser sessions now persist to a dedicated SQLite store.

Durable state includes:

```text
browser_session_id
profile_id
owner authority tuple
execution_mode
control_state
root_target_id
current target_id
target_generation
current claim_epoch / expiry
all retained target claims
AI tab group id/title
grouped targets
created_at / last_seen_at
ACTIVE | RECOVERABLE | CLOSED | FAILED
```

The durable identity remains `browser_session_id`. Browser tab ids and process ids remain ephemeral transport identities.

## Graceful runtime restart

A runtime preparing to restart now uses:

```text
browserContext.suspendForRestart()
```

for attached sessions.

The sequence is:

```text
detach current debugger target
  -> release all retained target claims
  -> persist logical session as RECOVERABLE
  -> close runtime-local stores
  -> restart WAG runtime/control plane
  -> reopen durable session store
  -> atomically recover retained claims at higher epochs
  -> re-group AI target if required
  -> reattach exact current target
  -> restore continuity watch
  -> preserve browser_session_id
```

Normal `browser.close` and `closeAll` remain terminal and mark durable sessions CLOSED/FAILED rather than recoverable.

## Split-brain protection

A second runtime attempting to recover the same logical session while the prior target lease is still ACTIVE fails closed.

```text
live old lease
  + same durable logical session
  + second runtime
      -> TARGET_OWNED_BY_OTHER_SESSION
```

The blocked successor does not detach, close, or steal the live browser target.

After a graceful suspend releases the lease, the successor may recover the same logical browser session at a higher `claim_epoch`.

## Crash semantics

If a runtime disappears without graceful suspend, its durable session remains ACTIVE and its target claim remains live until lease expiry.

Recovery before expiry is denied.

After lease expiry, the exact prior logical claimant may recover at:

```text
claim_epoch = prior_epoch + 1
```

If another session has already succeeded the target claim, the stale recovery attempt fails with `TARGET_FENCED`.

This crash path is covered by source/integration tests. A real OS-process SIGKILL acceptance has not been executed in this checkpoint.

## Atomic OAuth / multi-target recovery

OAuth continuity can retain multiple target claims under one logical browser session.

Recovery therefore uses one SQLite `BEGIN IMMEDIATE` transaction over the complete retained claim set:

```text
validate every prior target + epoch + owner
  -> if any target is stale/fenced/live under another lease: rollback all
  -> otherwise increment every retained claim epoch
  -> COMMIT
```

This prevents partial recovery where one OAuth target advances epoch while another is already fenced.

## Exact-once recovery

Browser effects already bind target identity and claim epoch into their durable effect plan.

Across runtime recovery:

- prior successful effect receipts remain readable;
- `browser_session_id` remains stable;
- recovered target claim advances to a new epoch;
- reusing the old idempotency key + action conflicts with the old effect plan instead of dispatching again;
- no completed click/submit is blindly replayed.

## Real Microsoft Edge recovery acceptance

Real Edge acceptance used:

- Microsoft Edge;
- a temporary Edge profile;
- the real WAG extension modules;
- an authenticated local fixture;
- real AI tab grouping;
- real `chrome.debugger`;
- loopback WebSocket transport;
- a persisted effect ledger;
- a persisted target-claim store;
- a persisted attached-session store.

Sequence:

```text
open authenticated AI_TAB_GROUP
  -> consequential "Submit Once" click
  -> observe count:1
  -> suspend browser runtime
  -> stop WebSocket control server
  -> restart WebSocket control server on same paired endpoint
  -> extension reconnects
  -> create fresh BrowserMcpContext
  -> recover same browser_session_id
  -> claim epoch 1 -> 2
  -> retry old idempotency key/action
  -> replay blocked
  -> observe count still exactly 1
```

Observed result:

```json
{
  "status": "PASS",
  "transport": "LOOPBACK_WEBSOCKET",
  "executionMode": "AI_TAB_GROUP",
  "browserSessionStable": true,
  "initialClaimEpoch": 1,
  "recoveredClaimEpoch": 2,
  "targetGenerationStable": true,
  "extensionReconnected": true,
  "durableEffectReceiptPreserved": true,
  "completedEffectReplayBlocked": true,
  "consequentialClickCount": 1,
  "activeTabStable": true,
  "targetStayedOpen": true,
  "browserStayedOpen": true,
  "windowsUiAutomationUsed": false,
  "osPointerInjectionUsed": false,
  "nativeBrowserControlExecutable": false,
  "userRealProfileUsed": false
}
```

The acceptance restarts the Browser v2 runtime/control-plane objects and WebSocket server while preserving the same Edge process/profile. It does not claim proof of an operating-system SIGKILL of the Node process.

## Regression evidence

Latest Browser/runtime regression after recovery changes:

```text
Browser / extension / WebSocket batch A = 77 / 77 PASS
Browser MCP / semantic / recovery batch B = 43 / 43 PASS
Control / private runtime / assembly batch C = 32 / 32 PASS

Total = 152 / 152 PASS
```

Focused recovery suite:

```text
19 / 19 PASS
```

Real Edge regressions after recovery implementation:

```text
runtime/session recovery = PASS
AI_TAB_GROUP = PASS
OAuth continuity = PASS
```

Final engineering gates:

```text
typecheck = PASS
build = PASS
git diff --check = PASS
```

## Material implementation

New durable store:

```text
src/browser-harness/browser-attached-session-store.ts
```

Recovery integration materially changes:

```text
src/browser-harness/browser-target-claim-store.ts
src/browser-harness/attached-existing-browser-port.ts
src/browser-harness/browser-broker.ts
src/browser-harness/browser-mcp-runtime.ts
src/repository-engineering-runtime.ts
```

Acceptance:

```text
scripts/accept-browser-v2-runtime-recovery.ts
```

Tests:

```text
test/browser-attached-session-store.test.ts
test/browser-runtime-session-recovery.test.ts
test/browser-target-claim-store.test.ts
test/browser-harness-attached-existing-port.test.ts
test/browser-harness-mcp-runtime.test.ts
test/browser-harness-mcp-surface.test.ts
```

## Remaining Browser v2 public-launch work

Still not closed by this checkpoint:

```text
USER_REAL_PROFILE_RECOVERY = NOT_EXECUTED
REAL_OS_PROCESS_SIGKILL_RECOVERY = NOT_EXECUTED
AUTO authenticated-target selection = NOT FINALIZED
PRODUCTION_PAIRING_UX = NOT COMPLETE
P2 sanitized diagnostics/resource bounds = PENDING
full final public-launch gate = PENDING
live runtime promotion = NO
public push = NO
```

## STOP 7 decision

```text
RUNTIME_RECOVERY_ACCEPTED_FOR_BRANCH = YES
EXACT_ONCE_RECOVERY_ACCEPTED_FOR_BRANCH = YES
PROCEED_TO_P2_DIAGNOSTICS_RESOURCE_BOUNDS = YES

PROMOTE_TO_LIVE = NO
PUBLIC_LAUNCH = NO
PUBLIC_PUSH = NO
```
