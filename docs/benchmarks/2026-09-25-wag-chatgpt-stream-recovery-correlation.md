# WAG ChatGPT stream recovery correlation — source acceptance

Date: 2026-09-25
Branch: feat/full-harness-stream-recovery-v1
Base: 6ea4ecb3fe73f1f885557e68134c31834abdf11c
Status: SOURCE-GREEN / ISOLATED INTEGRATION SLICE / NOT RUNTIME-PROMOTED

## Motivation

The ChatGPT UI can lose a response stream after WAG has already received or executed a tool call.
The visible symptom may be `ChatGPT stream recovery polling timed out`, but that message alone does
not establish whether the call never reached WAG, is still running, completed successfully, or
crossed an effect boundary whose outcome is uncertain.

A DC-replacement harness must not answer that ambiguity by blindly replaying consequential work.

This slice adds WAG-owned recovery evidence without making ChatGPT transport metadata authoritative.

## Recovery identity

Every ordinary private MCP tool call observed by `ToolUsageDiagnostics` now receives an opaque
WAG-local:

```text
request_<uuid>
```

`diagnostics.recent` exposes:

```text
in_flight[]
  request_id
  tool
  started_at_utc
  elapsed_ms

events[]
  sequence
  request_id
  tool
  success
  error_class?     // class only, never exception message
  effect_id?       // only for validated exact-once effects
  attempt_id?      // only when paired with effect_id
```

Completed diagnostics remain bounded and may be persisted. In-flight records are process-local.
Version-1 diagnostic files created before request ids existed remain readable.

No tool arguments, paths, command text, file contents, output, owner/session ids, credentials,
idempotency keys, prompt text, or raw exception messages are stored.

## Exact-once correlation

`HarnessEffectCoordinator` now carries validated `effectId` / `attemptId` recovery metadata
across executor throws by attaching non-enumerable local metadata to the Error object.

The public error message is unchanged.

The private MCP registration wrapper extracts that correlation for diagnostics on both:

- successful effect results; and
- thrown exact-once effects after they have been durably classified.

Correlation remains observability/recovery metadata. It grants no authority.

## Browser effect recovery

The Browser MCP public effect view is now sanitized. It exposes only:

```text
effectId
kind
resourceId
planFingerprint
state
createdAt
updatedAt
attemptId?
resultDigest?
errorClass?
```

It does not expose:

```text
ownerId
sessionId
adapterId
idempotencyKey
```

A new read-only tool is published when BrowserPort is enabled:

```text
browser.effect.get
```

Input:

```text
effect_id
```

The lookup is caller-owned through the durable effect ledger and never dispatches or replays an
effect.

Browser opt-in surface therefore changes from:

```text
43 core + 6 browser = 49
```

to:

```text
43 core + 7 browser = 50
```

The default non-browser private surface remains 43 tools.

## Recovery decision table

After a ChatGPT response-stream interruption:

| WAG evidence | Interpretation | Safe action |
| --- | --- | --- |
| no matching recent/in-flight evidence | WAG cannot prove it observed the call, or evidence aged out | do not infer an effect; inspect relevant durable state before a consequential retry |
| matching `in_flight` request | WAG is still executing the call | do not retry while it remains in flight |
| completed event without effect id | ordinary tool completed/failed but no exact-once effect handle is available | use tool-specific durable/readback evidence |
| completed event with `effect_id` | exact-once effect has durable identity | read `browser.effect.get` |
| `SUCCEEDED` | effect is confirmed once | do not repeat |
| `FAILED_NO_EFFECT` | execution proved no effect | a deliberate new attempt may be made under the normal policy |
| `OUTCOME_UNKNOWN` | effect boundary was crossed but persistence/result is unproven | never blindly retry; perform readback/reconciliation first |

An idempotent retry of an already `SUCCEEDED` effect continues to return the same durable record
without redispatching the semantic action.

## Authority boundaries unchanged

This slice does not change:

- `AUTONOMOUS_LOCAL` private-local authority;
- workspace/process/browser ownership;
- filesystem or Git CAS;
- the autonomous kill switch;
- browser authority isolation from filesystem/command authority;
- `GIT_PUSH` remaining unavailable/non-grantable;
- trace/request/effect correlation remaining non-authoritative;
- raw credential non-exposure.

Goal Lease is not reintroduced.

## Verification

Dependency environment for this fresh worktree was synchronized from the existing lockfile with:

```text
npm ci --ignore-scripts
```

No tracked package metadata changed.

Final gates on the exact source bytes for this receipt:

```text
npm run build       PASS
npm run typecheck   PASS
git diff --check    PASS
```

Focused stream-recovery / diagnostics / exact-once gate:

```text
14 / 14 PASS
0 FAIL
```

Full Harness regression batches excluding the known long-form DC acceptance command:

```text
31 + 32 + 31 + 31
= 125 / 125 PASS
0 FAIL
```

Current autonomous-local/core regression batch:

```text
16 / 16 PASS
0 FAIL
```

The focused recovery tests overlap the 125-test Full Harness batch and are not added to it as unique
test count.

The long-form `test/dc-replacement.acceptance.ts` remains outside this receipt because its runtime
exceeds WAG `command.run`'s 30-second observation ceiling; its current direct-MCP contract is
covered by the green 16-test core batch, consistent with the prior composite receipt.

## Non-claims

This slice does not claim:

- that ChatGPT's own stream-recovery timeout is fixed by WAG;
- access to or control over ChatGPT server-side streaming;
- live runtime promotion;
- live owned-browser acceptance;
- Notebook99 live H3 execution;
- merge into the concurrently dirty Full Harness integration worktree;
- any Git push or other remote effect.

The purpose is narrower: when the client stream disappears, WAG retains enough bounded local
evidence to avoid treating transport ambiguity as permission to repeat consequential work.

## Integration next

Keep this commit isolated until the parallel `feat/full-harness-integration-v1` transaction is
clean. Then integrate this source-green slice, rerun the combined source gate, and only after the
source/live browser acceptance sequence consider runtime promotion.
