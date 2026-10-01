# WAG Remote Git Inspect v1 — Acceptance

Date: 2026-10-01  
Branch: `feat/wag-public-launch-p0-v1`  
Base: `ae5417937650600055bd2363cd663097bc279ac0`

## Result

`REMOTE_GIT_INSPECT_V1 = PASS`

Implemented one read-only MCP tool:

```text
git.remote.inspect
```

Input:

```text
workspace_id
remote
refs?    # explicit refs/heads/* only, max 32
```

Output includes:

- stable repository identity;
- effective fetch URL;
- effective push URL;
- remote default branch;
- exact OID or `null` for each requested branch ref;
- bounded authentication capability state;
- observation timestamp.

## Authority and mutation boundary

The caller cannot supply an arbitrary remote URL. The tool resolves a named Git remote from the caller-owned workspace.

It reuses the bounded remote-push Git safety path:

- allowlisted Git environment;
- inherited Git execution/transport variables removed;
- dangerous effective Git configuration rejected;
- trusted Git-for-Windows system GCM provenance only;
- credential-bearing URLs rejected;
- HTTPS/explicit SSH URL canonicalization;
- non-interactive remote access;
- WAG-owned empty hooks directory.

The observation path uses `git ls-remote --symref`.

It does **not**:

- fetch;
- write `FETCH_HEAD`;
- update local refs;
- create/delete branches;
- push;
- expose credentials/tokens;
- enumerate all refs by default.

`authenticationState=AVAILABLE` means a trusted credential mechanism is available to the bounded Git path; it is not a claim that the caller has write permission to the remote.

## Verification

Focused remote Git / surface suite:

```text
50 / 50 PASS
```

Production-local / runtime acceptance:

```text
25 / 25 PASS
```

Additional:

```text
typecheck       PASS
build           PASS
git diff --check PASS
MCP schema      PASS
```

The MCP schema rejects caller-supplied URL fields and more than 32 requested refs before coordinator execution.

## Real remote dogfood

Read-only dogfood against configured `origin` succeeded:

```text
effectiveFetchUrl = https://github.com/ShenJun93/web-agent-gateway.git
effectivePushUrl  = https://github.com/ShenJun93/web-agent-gateway.git
defaultBranch     = refs/heads/main

refs/heads/main
  oid = 033a913c2f05b8b9a62c376a70832e7ae9f9e91c

refs/heads/feat/wag-public-launch-p0-v1
  oid = null
```

No fetch or push was executed by the inspection path.

## Live-runtime status

The currently running legacy WAG runtime remains at source HEAD
`12ea8315b650e8df11ddc1483c4ee4d2e764a48e`.

Therefore:

```text
IMPLEMENTED_IN_FEATURE_LANE = YES
LIVE_PROMOTED = NO
```

No runtime promotion and no public push occurred as part of this task.
