# WAG Local M3 — Doctor and Bounded Self-Repair

Date: 2026-09-30
Branch: `feat/wag-local-m3-doctor-repair-v1`
Base: `01e33229e2498fd76d330cdd9e6fed25f1bae58d`

## Verdict

`M3_DOCTOR_SURFACE = PASS`

`M3_FAILURE_MATRIX_COVERAGE = PASS`

`M3_BOUNDED_REPAIR_DOGFOOD = PASS`

No account/cloud mutation, credential rotation, user-repository overwrite, or unrelated-process kill
was performed.

M3 does not re-run the full destructive M1 battery through the live ChatGPT connector. The accepted
M1 recovery receipts remain the execution evidence for those failure injections; M3 adds stable
diagnosis/remediation coverage over the same failure families.

## Supported UX

Public product diagnosis:

```text
web-agent-gateway doctor
web-agent-gateway doctor --repair
```

The legacy developer/runtime preflight remains available as:

```text
web-agent-gateway doctor --config <absolute-path>
```

The product doctor writes a `WAG_LOCAL_DOCTOR_V1` receipt and reports:

- package/source/runtime identity;
- Node and PowerShell versions;
- WSL availability;
- exact DevSpace pin and discovery health;
- tunnel-client path, executable state and version;
- tunnel profile presence;
- tunnel `/healthz` and `/readyz`;
- local MCP round-trip;
- stale launcher/DevSpace/supervisor PID receipts;
- exact 7677/8080 owner/collision state;
- launcher and login-start registration drift;
- control-plane reachability;
- authorization-failure evidence when active startup is degraded;
- update status, currently explicit `UNCONFIGURED`;
- last meaningful failure category and source log.

The local doctor does not claim to independently prove the remote ChatGPT client round-trip. That
field is explicitly `NOT_TESTABLE_FROM_LOCAL_DOCTOR`; M2 carries separate live connector evidence.

## Stable diagnostic/remediation matrix

Machine-readable matrix:

`docs/benchmarks/2026-09-30-wag-local-product-m3-failure-matrix.json`

Coverage includes all accepted M1 failure families. Key mappings:

| Failure family | Stable diagnosis | Action |
|---|---|---|
| Tunnel stopped | `WAG_TUNNEL_NOT_READY` | bounded WAG-owned stack start when external prerequisites are healthy |
| DevSpace down | `WAG_DEVSPACE_DISCOVERY_DOWN` | exact managed DevSpace repair |
| DevSpace checkout missing/mismatched | `WAG_DEVSPACE_PIN_MISSING/MISMATCH` | restore exact accepted managed checkout |
| Stale WAG PID receipts | `WAG_STALE_*_PID` | remove exact stale receipt only |
| WSL unavailable | `WAG_WSL_UNAVAILABLE` | precise external action; no implicit system change |
| Tunnel client missing | `WAG_TUNNEL_CLIENT_MISSING` | supported setup/external action; no arbitrary binary install |
| Tunnel profile missing | `WAG_TUNNEL_PROFILE_MISSING` | supported provisioning flow |
| Port 7677 unrelated owner | `WAG_PORT_7677_COLLISION_UNRELATED` | report owner; never kill unrelated process |
| Port 8080 unrelated owner | `WAG_PORT_8080_COLLISION_UNRELATED` | report owner; never kill unrelated process |
| Network unavailable | `WAG_CONTROL_PLANE_NETWORK_UNREACHABLE` | restore network, rerun doctor/repair |
| Authorization rejected/expired | `WAG_CONTROL_PLANE_AUTHORIZATION_FAILED` | supported reauthorization; never auto-rotate |
| Launcher drift | `WAG_LAUNCHER_DRIFT` | installed doctor restores packaged canonical copies |
| Startup registration missing/drifted | `WAG_AUTOSTART_*` | installed doctor restores per-user Startup registration |

PowerShell 5 invocation is handled by the product PowerShell wrapper re-entering PowerShell 7.
PowerShell 7 support is reported directly in the host section.

## Repair safety policy

`wag doctor --repair` may:

- remove stale WAG-owned PID receipts after exact identity validation fails;
- persist the exact running WAG tunnel-client path when the legacy install lacks its path pin;
- restore packaged per-user launchers and Startup registration from an **installed package**;
- repair the exact managed DevSpace checkout/process when port 7677 is not occupied by an unrelated process;
- start the WAG-owned local stack when network/profile/credential/port prerequisites are healthy;
- start the exact WAG recovery supervisor.

It does not:

- overwrite user repositories;
- kill unknown processes;
- rotate credentials;
- accept or retain admin credentials;
- create/modify tunnels, API keys, connectors, billing, or other cloud/account state;
- replace launchers from an arbitrary development checkout.

## Live doctor evidence

Read-only receipt after repair:

`docs/benchmarks/2026-09-30-wag-local-product-m3-doctor-live-after-repair.json`

Observed:

- product status `READY`;
- exact DevSpace revision matched;
- DevSpace discovery = HTTP 200;
- tunnel health/readiness = HTTP 200/200;
- local MCP round-trip = true;
- tunnel-client executable/version detected;
- no stale WAG PID receipts;
- no 7677/8080 unrelated collision;
- control plane reachable;
- live WAG remained usable.

Development-checkout launcher/source drift is reported as WARN/INFO rather than a false product
failure. Installed-package doctor remains authoritative for canonical launcher drift.

## Live bounded repair dogfood

Repair receipt:

`docs/benchmarks/2026-09-30-wag-local-product-m3-doctor-repair-live.json`

The exact per-user `tunnel-client-path.txt` was deliberately removed while the live WAG tunnel
continued running. Doctor discovered the exact running WAG tunnel-client command, verified the
executable, and repaired only that per-user path pin.

Observed repair:

```text
WAG_REPAIR_TUNNEL_CLIENT_PIN = SUCCEEDED
final status = READY
clientPathPinned = true
clientExecutable = true
exactProcessRunning = true
```

The live WAG MCP surface remained `ok` with 53 tools after repair.

## Verification

Final source verification for this M3 batch:

- `npm run test:wag-product` — 21/21 PASS
- `npx tsx --test test/cli.test.ts` — 9/9 PASS
- `npm run typecheck` — PASS
- `npm run build` — PASS
- `npm pack --dry-run` — PASS; package includes `dist/product-doctor.js` and `scripts/wag-local-doctor.ps1`
- `git diff --check` — PASS

All values were refreshed immediately before commit preparation.

## Scope after M3

M3 diagnosis and bounded local repair are complete for the M1 failure families.

Update discovery, transactional upgrade/rollback and uninstall belong to M4. M2 external clean-user
acceptance remains separately pending because the official account/control-plane page hit a
Cloudflare human challenge; existing live ChatGPT connector list/read acceptance already passed.
