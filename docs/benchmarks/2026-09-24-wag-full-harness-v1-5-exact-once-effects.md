# WAG Full Harness v1.5 — Durable exact-once effect ledger

Date: 2026-09-24
Branch: feat/full-harness-browserport-v1
Parent: 83e0c5bb3feec3fc0563217b686c8bb7b57765bb
Status: SOURCE-GREEN / NO LIVE BROWSER EFFECT / NOT MCP-PUBLISHED

## Added

HarnessEffectLedger:
- reserve
- claim
- confirmSuccess
- failNoEffect
- markOutcomeUnknown
- get
- reconcileExecuting

HarnessEffectCoordinator:
- executes one reserved/claimed plan;
- returns durable SUCCEEDED record on idempotent retry;
- explicit NO_EFFECT and OUTCOME_UNKNOWN results remain distinct;
- an unexpected executor throw is conservatively recorded OUTCOME_UNKNOWN.

## Exact-once invariants

- idempotency key is scoped by exact owner/session/adapter;
- same key + same canonical plan returns the same effect record;
- same key + different canonical plan fails closed;
- claim is RESERVED -> EXECUTING exactly once;
- EXECUTING and OUTCOME_UNKNOWN cannot be blindly reclaimed;
- SUCCEEDED replay returns the existing durable result without re-executing;
- runtime restart reconciliation maps every orphan EXECUTING row to OUTCOME_UNKNOWN;
- OUTCOME_UNKNOWN may become SUCCEEDED only through explicit later evidence confirmation;
- no page text, prompt body or result body is stored as a receipt; only canonical fingerprint,
  bounded state metadata, error class and result digest.

The ledger reuses WAG's canonicalEncoding primitive and Node native SQLite with BEGIN IMMEDIATE.

## Measured gates

Effect ledger/coordinator focused:
```text
8 pass
0 fail
```

Browser + Process Harness regression:
```text
35 pass
0 fail
```

Autonomous-local / repository / effect regression:
```text
24 pass
0 fail
```

Repository source build:
```text
npm run build
PASS
```

## Test defect resolved

The first ledger run passed production assertions but Windows teardown attempted to delete WAL/SQLite
files before closing DatabaseSync. Fixture cleanup was corrected to close the ledger before rm.

A later coordinator fixture emitted malformed deterministic UUIDs; build remained green and the
test-only UUID generator was corrected to a valid 36-character UUID form.

Several file.replace calls returned OUTCOME_UNKNOWN / DivergentTarget while exact readback proved
the intended bytes were present. No blind replay was used.

## Notebook99 consequence

A future Notebook99 H3 submission can use the exact canonical tag as idempotencyKey. If the browser
connection is lost after submit, the record becomes OUTCOME_UNKNOWN and a retry is blocked until a
readback proves whether the tag persisted. This is the required foundation for exactly-once H3.

## Non-claims

- no Notebook99 prompt was submitted;
- no browser effect was executed;
- no MCP tool surface changed;
- no runtime was promoted;
- this ledger is separate from WAG-Core durable-store.ts to avoid cross-lane conflict.
