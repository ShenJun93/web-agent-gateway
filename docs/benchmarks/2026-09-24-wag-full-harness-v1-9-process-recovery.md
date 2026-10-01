# WAG Full Harness v1.9 — Durable process recovery identity source receipt

Date: 2026-09-24
Branch: feat/full-harness-process-recovery-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / BACKEND-NEUTRAL RECOVERY FOUNDATION / NO LIVE BROWSER CHANGE

## Added

ProcessRecoveryLedger:
- durable SQLite records keyed by existing opaque processId;
- exact owner/session/adapter ownership;
- PID + opaque process instance id + executable path;
- process start-spec fingerprint;
- states RUNNING / EXITED / STOPPED / STALE_IDENTITY;
- restart-safe list/get/state transitions.

ProcessRecoveryCoordinator:
- records only a started process that an independent ProcessIdentityObserver can observe;
- after restart, reconciles vanished process => EXITED;
- PID reuse / changed executable or instance identity => STALE_IDENTITY;
- stopRecovered re-observes the exact process before stop;
- identity mismatch refuses stop and never calls the destructive backend;
- after stop, disappearance is verified before durable STOPPED;
- a still-live exact process after stop request is not falsely reported as stopped.

## Explicit non-claim

Interactive stdin/stdout streams from a pre-restart process are not recoverable under the current
Node backend and are not claimed. This slice recovers durable identity, liveness and exact cleanup
authority only.

## Measured gates

Process recovery + existing ProcessPort/Node backend:

```text
11 pass
0 fail
```

Process recovery + ProcessPort + owned Edge composition:

```text
15 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

The first recovery test run produced five Windows EBUSY teardown failures because SQLite files were
removed before their handles were closed. Product assertions had not failed. Teardown was corrected
to close the ledger before removing the temp directory; the exact same product tests then passed.

## Windows successor

Use native process identity:
- OpenProcess with limited query rights;
- GetProcessTimes creation FILETIME;
- QueryFullProcessImageNameW executable path.

Prefer named/owned Job Object process-tree containment over PID-only broad cleanup when the native
Windows backend is introduced.

## Parallel safety

This lane does not edit BrowserPort/CDP event-plumbing files and does not touch the live WAG runtime.

## Non-claims

- no Windows native observer is implemented yet;
- no Job Object backend is implemented yet;
- no process was adopted solely by PID;
- no browser/profile was opened;
- no public MCP tool changed;
- no runtime/config promotion occurred.
