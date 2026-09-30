# WAG Local M1 — Local Destructive Recovery Batch

Date: 2026-09-30
Branch: feat/wag-local-m1-full-acceptance-v1
Base before this batch: e3392cf3a8e5e18ccf76184e50e876c696d5dafb

## Verdict

LOCAL_DESTRUCTIVE_BATCH = PASS
PROCESS_ISOLATED_EXTERNAL_FAILURE_BATCH = PASS

This is not full M1 acceptance. The only remaining acceptance item is:
- real Windows reboot / cold boot = NOT_MEASURED

The network/auth rows below are process-isolated synthetic acceptance, not a claim that the entire Windows host lost network connectivity. They exercise the real tunnel-client against the real control-plane endpoint while leaving the live WAG tunnel untouched.

## Passing receipts

| Case | Receipt | Result | Elapsed |
|---|---|---:|---:|
| Safe batch: PS5 re-entry, PS7 direct, stale PID reconciliation, launcher drift repair, autostart drift repair, login shortcut execution | wag-local-m1-allsafe-v2.json | 6/6 PASS | per-case |
| Live tunnel crash | wag-local-m1-tunnelcrash-final.json | PASS | 22.865 s |
| Live DevSpace crash | wag-local-m1-devspacecrash-final.json | PASS | 18.987 s |
| DevSpace + tunnel crash | wag-local-m1-stackcrash-v2.json | PASS | 27.469 s |
| Exact DevSpace checkout deleted | wag-local-m1-devspace-checkout-deleted-v6.json | PASS | 55.082 s |
| WSL temporarily unavailable | wag-local-m1-wsl-unavailable-v1.json | PASS | 16.702 s |
| tunnel-client missing | wag-local-m1-tunnel-client-missing-v1.json | PASS | 15.768 s |
| unrelated listener collision on 7677 | wag-local-m1-port7677-collision-v1.json | PASS | 16.672 s |
| unrelated listener collision on 8080 | wag-local-m1-port8080-collision-v3.json | PASS | 17.727 s |
| process-isolated network offline during startup | wag-local-m1-network-offline-v1.json | PASS | 8.608 s |
| process-isolated network returns after startup failure | wag-local-m1-network-return-v1.json | PASS | 16.760 s |
| synthetic expired/invalid control-plane authorization | wag-local-m1-external-synthetic-v1.json | PASS | 8.541 s |

The combined external receipt `wag-local-m1-external-synthetic-v1.json` contains all three external synthetic cases and passed 3/3.

Receipts are stored under:
`%LOCALAPPDATA%\WAG-Local\receipts`

## Defects found and fixed in this batch

1. A launcher process could remain alive after `WAG_START_TIMEOUT`.
   - The starter now terminates only its own timed-out launcher process and clears the matching PID receipt.

2. DevSpace repair with an already-ready tunnel could block synchronously.
   - The starter now runs repair in a bounded child process with a shared startup deadline and dedicated stdout/stderr logs.

3. The supervisor captured starter output synchronously and could hang even after the stack became executable.
   - The supervisor now starts the starter as a bounded process, polls executable readiness, and records redirected stdout/stderr.

4. Deleted DevSpace checkout recovery initially put large backup-tree deletion on the critical recovery path.
   - The stack is restored before backup cleanup; cleanup is detached after recovery.

5. The 8080 collision fixture could race Windows/WSL port release.
   - The fixture now waits for port 8080 to be genuinely free before binding the unrelated listener.

## Current local state after the batch

- WAG health: ok
- MCP surface: 53 tools
- authority: AUTONOMOUS_LOCAL
- managed DevSpace pin: 33d6d0bcc2256024484d2456da924af8afd814ed
- no DevSpace `.m1-backup-*` directory remains

## Full M1 status

M1_SERVICE_AND_LOCAL_DESTRUCTIVE_RECOVERY = PASS
M1_PROCESS_ISOLATED_NETWORK_AND_AUTH_FAILURES = PASS

M1_FULL_COLD_START_RECOVERY = NOT_MEASURED

Do not promote this to full M1 acceptance until a real Windows reboot/cold-boot receipt passes. The process-isolated network/auth evidence does not by itself prove host-wide network-loss recovery.
