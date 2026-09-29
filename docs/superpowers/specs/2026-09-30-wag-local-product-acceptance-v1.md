# WAG_LOCAL_PRODUCT_ACCEPTANCE_V1

Date: 2026-09-30  
Status: M0 ACCEPTANCE CONTRACT — implementation candidate  
Parent plan: `docs/superpowers/plans/2026-09-30-wag-local-productization-dc-learning-v1.md`

## Purpose

Define one machine-readable, repeatable contract for deciding whether WAG Local is product-ready
enough to begin destructive cold-start/recovery acceptance.

This contract does not claim M1 cold-start/reboot acceptance. It freezes the M0 identity, health and
evidence semantics that M1 must use.

## Receipt

Canonical local receipt schema:

```text
WAG_LOCAL_PRODUCT_HEALTH_V1
```

Development command:

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/wag-local-product-health.ps1
```

Default receipt location:

```text
%LOCALAPPDATA%\WAG-Local\receipts\wag-local-product-health.json
```

The PowerShell wrapper decrypts the existing DPAPI-protected DevSpace owner credential only into
process memory/environment, launches the TypeScript health collector, then clears the environment.
The credential value is never written to the receipt or passed as a command-line argument.

## Required identity fields

A receipt must identify, without secret values:

- development source branch / HEAD / clean state;
- active WAG runtime source HEAD and capability marker;
- active runtime CLI SHA-256;
- canonical and installed local-launcher SHA-256 values;
- accepted exact DevSpace revision and observed managed-checkout revision;
- Node / PowerShell / WSL prerequisite state;
- tunnel `/healthz` and `/readyz` state;
- fresh local stdio MCP round-trip result;
- exact published MCP tool inventory from `listTools`;
- `health.mcpToolCount`, executor, protocol version and authority mode;
- stable diagnostics.

Absolute WAG config/runtime paths are intentionally not serialized into the product receipt.

## Product status

### READY

All executable layers are healthy:

```text
DEVSPACE_DISCOVERY = ready
TUNNEL_HEALTH      = ready
TUNNEL_READINESS   = ready
FRESH_MCP_ROUNDTRIP= ready
```

The fresh MCP round trip must be a new stdio client process against the active bound runtime/config,
not only a process-list or port-presence check.

### DEGRADED

At least one executable layer is healthy, but the complete product path is not.

### OFFLINE

DevSpace discovery, tunnel readiness and a fresh MCP round trip all fail.

A source-repository/runtime HEAD difference on a development machine is informational and does not
by itself make the installed product Degraded.

## M0 required checks

| ID | Check | Required for M0 PASS |
| --- | --- | --- |
| M0-01 | receipt schema is `WAG_LOCAL_PRODUCT_HEALTH_V1` | yes |
| M0-02 | status is `READY` | yes |
| M0-03 | Node satisfies project engine range | yes |
| M0-04 | PowerShell 7 is available | yes |
| M0-05 | WSL is available | yes |
| M0-06 | installed launchers match repository canonical hashes | yes |
| M0-07 | WAG Local per-user startup registration exists | yes |
| M0-08 | exact DevSpace managed checkout exists and matches accepted revision | yes |
| M0-09 | DevSpace OAuth discovery returns success | yes |
| M0-10 | tunnel `/healthz` and `/readyz` return success | yes |
| M0-11 | a fresh stdio MCP client completes `listTools` + `health` | yes |
| M0-12 | `health.mcpToolCount == listTools.tools.length` | yes |
| M0-13 | private local authority reports `AUTONOMOUS_LOCAL` | yes |
| M0-14 | no DevSpace owner credential appears in captured stdio stderr | yes |
| M0-15 | development worktree is clean at the committed M0 receipt | yes |

## Stable M0 diagnostics

The M0 implementation reserves these codes:

- `WAG_NODE_VERSION_UNSUPPORTED`
- `WAG_POWERSHELL7_UNAVAILABLE`
- `WAG_WSL_UNAVAILABLE`
- `WAG_WRAPPER_BINDING_INVALID`
- `WAG_RUNTIME_MARKER_MISSING`
- `WAG_RUNTIME_MARKER_INVALID`
- `WAG_LAUNCHER_DRIFT`
- `WAG_AUTOSTART_MISSING`
- `WAG_DEVSPACE_PIN_MISSING`
- `WAG_DEVSPACE_PIN_MISMATCH`
- `WAG_DEVSPACE_DISCOVERY_DOWN`
- `WAG_TUNNEL_NOT_READY`
- `WAG_MCP_ROUNDTRIP_FAILED`
- `WAG_MCP_HEALTH_NOT_OK`
- `WAG_AUTHORITY_MODE_UNEXPECTED`
- `WAG_MCP_SURFACE_COUNT_MISMATCH`
- `WAG_SECRET_LEAK_STDERR`
- `WAG_DEVELOPMENT_SOURCE_RUNTIME_DRIFT`
- `WAG_SOURCE_WORKTREE_DIRTY`

M1 may add failure-injection-specific codes, but must not repurpose these meanings.

## M0 acceptance decision

M0 passes only when:

1. the collector/unit tests pass;
2. typecheck and `git diff --check` pass;
3. one live receipt reports `READY`;
4. all M0-01 through M0-15 are evidenced;
5. the receipt is saved as a benchmark artifact with no credential values;
6. the implementation and receipt are committed, leaving a clean worktree.

## Boundary to M1

After M0 is committed, the next task is the destructive M1 harness.

M1 must consume the same receipt/status vocabulary and inject the failure matrix from the parent
plan. Killing the currently active WAG tunnel from the same MCP session is intentionally not part of
M0.
