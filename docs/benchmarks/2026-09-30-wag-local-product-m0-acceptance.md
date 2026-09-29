# WAG Local Productization M0 Acceptance

Date: 2026-09-30  
Result: **PASS**  
Contract: `WAG_LOCAL_PRODUCT_ACCEPTANCE_V1`  
Candidate source HEAD: `4ae22d4d7322fcaaea6e78086227c5c7d1bde43f`

## Scope

This receipt closes M0 only: identity freeze + machine-readable product health semantics.

It does **not** claim destructive cold-start/reboot recovery. That remains M1.

Machine-readable evidence:

```text
docs/benchmarks/2026-09-30-wag-local-product-baseline.json
```

## Measured baseline

```text
schema               WAG_LOCAL_PRODUCT_HEALTH_V1
status               READY

source branch        feat/remote-effect-bypass-closure-v1
source HEAD          4ae22d4d7322fcaaea6e78086227c5c7d1bde43f
source clean         true

active runtime HEAD  12ea8315b650e8df11ddc1483c4ee4d2e764a48e
runtime capability   autonomous-local-runtime-v1

Node                 v24.20.0
PowerShell           7.6.6
WSL                  available

DevSpace expected    33d6d0bcc2256024484d2456da924af8afd814ed
DevSpace observed    33d6d0bcc2256024484d2456da924af8afd814ed
DevSpace discovery   HTTP 200

tunnel healthz       HTTP 200
tunnel readyz        HTTP 200

fresh MCP roundtrip  PASS
MCP status           ok
executor             devspace
protocol             2026-07-28
authority            AUTONOMOUS_LOCAL
health tool count    53
listTools count      53
```

The development repository HEAD differs from the active runtime source HEAD. The acceptance contract
classifies this as informational development drift, not product unavailability, because the active
runtime is independently identified and the fresh MCP round trip is healthy.

## M0 checklist

| ID | Result | Evidence |
| --- | --- | --- |
| M0-01 schema `WAG_LOCAL_PRODUCT_HEALTH_V1` | PASS | baseline JSON |
| M0-02 product status `READY` | PASS | baseline JSON |
| M0-03 supported Node | PASS | `v24.20.0` |
| M0-04 PowerShell 7 | PASS | `7.6.6` |
| M0-05 WSL available | PASS | host probe |
| M0-06 installed launchers match canonical hashes | PASS | both expected/installed SHA-256 pairs equal |
| M0-07 per-user autostart exists | PASS | `startupShortcutPresent=true` |
| M0-08 exact DevSpace managed checkout | PASS | exact `33d6d0b...` |
| M0-09 DevSpace discovery | PASS | HTTP 200 |
| M0-10 tunnel health + readiness | PASS | HTTP 200 / 200 |
| M0-11 fresh stdio MCP `listTools` + `health` | PASS | roundtrip true |
| M0-12 health/listTools count consistency | PASS | 53 = 53 |
| M0-13 `AUTONOMOUS_LOCAL` | PASS | MCP health |
| M0-14 no owner credential in captured stdio stderr | PASS | no `WAG_SECRET_LEAK_STDERR` diagnostic |
| M0-15 clean development worktree at receipt generation | PASS | `source.clean=true` |

## Repository verification

Before the live baseline was generated:

```text
git diff --check
PASS

npm run typecheck
PASS

npm run test:wag-product
7 tests
7 pass
0 fail
```

The live health collector then started a **fresh** stdio MCP client against the runtime/config bound
by the current WSL wrapper. This avoids treating a listener or already-running tunnel process as
proof that WAG can execute MCP.

## Security / privacy notes

The receipt contains hashes, versions, source/runtime identities, tool names and health states.

It does not serialize:

- the DevSpace owner credential;
- the control-plane API key;
- OAuth access/refresh tokens;
- the private config body;
- absolute active runtime/config paths.

The DPAPI-protected DevSpace owner credential is decrypted only into the health collector process
environment and removed by the PowerShell wrapper after the collector exits.

## M0 decision

```text
WAG_LOCAL_PRODUCT_ACCEPTANCE_V1 = PASS
M0 = CLOSED
M1_DESTRUCTIVE_RECOVERY = NOT_YET_RUN
```

Next planned gate: implement the M1 destructive recovery harness using this exact status and
diagnostic vocabulary, then stop before intentionally severing the active WAG control channel or
rebooting the machine.
