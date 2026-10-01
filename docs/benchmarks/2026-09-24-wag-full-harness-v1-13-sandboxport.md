# WAG Full Harness v1.13 — SandboxPort attestation foundation

Date: 2026-09-24
Branch: feat/full-harness-sandbox-port-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / BACKEND-NEUTRAL ATTESTATION CONTRACT / NO SANDBOX VM STARTED

## Added

src/sandbox-harness/sandbox-port.ts

SandboxPort v1:
- explicit owned sandboxSessionId;
- trusted profile resolver and workspace resolver;
- exact workspace identity token revalidation before every exec;
- isolation levels: host-bounded < container < microvm;
- profile declares a minimum isolation level;
- backend capabilities are independently described and validated before open;
- optional required workspace-scope enforcement;
- optional required private process namespace;
- deny-by-default TCP-only network profile;
- exact host[:port] allowlist, no wildcard host patterns;
- credential IDs only; no secret values in SandboxOpenPlan;
- a profile with credentials requires hostCredentialInjection attestation;
- bounded argv, workspace-relative cwd, run timeout and output ceiling;
- output/exit metadata is revalidated by WAG even if backend claims it enforced limits;
- effect policy is checked before open and every exec;
- authority/profile/workspace are revalidated after backend open before admission;
- a backend opened under drifted authority is closed immediately;
- profile/workspace pair is reserved while async open is in flight;
- cleanup remains available after execution authority is revoked.

## Measured gates

SandboxPort focused:

```text
11 pass
0 fail
```

SandboxPort + existing ProcessPort regression:

```text
17 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Mutation note

The semantic profile-comparison hardening file.replace returned OUTCOME_UNKNOWN / DivergentTarget.
No blind retry was performed. Exact readback proved JSON-stringification comparison was absent and
the intended normalized semantic comparison was present. All gates above ran on those read-back
bytes.

## Security boundary

This slice intentionally distinguishes:
- process execution on the host;
- bounded process execution inside a container;
- code execution behind a microVM/hypervisor boundary.

A backend cannot satisfy a stronger profile merely by calling itself a sandbox.

## Integration target

A concrete backend should:
1. create/attach only a WAG-owned sandbox resource;
2. enforce workspace mount mode and identity;
3. enforce outbound network policy outside agent control;
4. inject credentials host-side through CredentialBroker/proxy semantics;
5. return an attested capability record;
6. make process lifetime independent of one MCP request;
7. emit cleanup/ownership receipts.

## Non-claims

- no Docker Sandbox dependency was added;
- no VM/container was created;
- no network request occurred;
- no real credential was used;
- no OS/hypervisor isolation is claimed by this source contract alone;
- no public MCP tool changed;
- no runtime/config promotion occurred.
