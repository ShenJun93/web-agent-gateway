# WAG Autonomous Remote Git Push v2 — Acceptance

**Date:** 2026-09-28  
**Status:** SOURCE ACCEPTED  
**Branch:** `feat/remote-effect-bypass-closure-v1`  
**Base commit:** `d9cef10a33013b4c68de0f42a448ecd1f4669ad4`  
**Implementation commit:** `0866d1c96359bdbccf0ca30d5c92225ef3f067f8`

## Goal

Remove per-push Human approval from the private stdio automation path without creating unrestricted remote Git authority.

The Human-gated v1 path remains the default when no standing autonomous policy is configured.

## Standing authority

The private config may opt into an exact local allowlist:

```json
{
  "repositoryEngineering": {
    "remoteGitPush": {
      "autonomous": {
        "allowedPushUrls": [
          "https://github.com/ShenJun93/WAG-Commercial.git"
        ],
        "allowedDestinationRefs": [
          "refs/heads/work/commercial-packaging-v1",
          "refs/heads/backup/wag-source"
        ]
      }
    }
  }
}
```

This configuration is local authority and is not supplied through MCP arguments.

When autonomous mode is configured:

- the effective push URL must exactly match an allowlisted canonical URL;
- the destination ref must exactly match an allowlisted non-protected `refs/heads/*` ref;
- a non-matching request is denied rather than falling back to per-push approval;
- `main`, `master`, tags, deletes, malformed refs and non-fast-forward updates remain denied;
- the model cannot add or broaden URLs or refs in the tool request.

## Execution

An allowlisted first request performs:

```text
plan exact remote state
-> create durable PENDING record
-> atomically activate + claim one use
-> revalidate kill switch and workspace identity
-> re-observe remote identity/state
-> execute exact CAS fast-forward push
-> reconcile result
-> CONSUMED / REVOKED / QUARANTINED
```

The PENDING -> ACTIVE transition, `use_count=1`, and `execution_started_at` are one SQLite transaction. There is no Human-approval-to-consume timing window.

A crash after the execution claim is handled by the existing restart reconciliation path. Uncertain remote effects are never blindly retried.

## Boundaries preserved

Existing v1 protections remain:

- exact caller owner/session/adapter and workspace ownership;
- exact repository identity and effective push URL;
- exact source OID and destination branch ref;
- expected remote state CAS;
- fast-forward ancestry;
- remote default-branch denial;
- protected branch, tag and delete denial;
- no ordinary force push;
- dangerous Git config rejection;
- WAG-owned empty hooks directory;
- immediate kill switch;
- fresh workspace identity revalidation immediately before the effect;
- durable reconciliation of interrupted attempts.

Generic command/process/terminal surfaces still deny direct Git/GitHub remote mutations.

The public WAG repository is not part of the intended live allowlist for this M1 run and must not be pushed by this policy.

## MCP / platform boundary

`git.push` remains truthfully annotated as a consequential, destructive/open-world tool. This change removes the **WAG local per-push approval loop** only. It does not attempt to disable, mislabel, or bypass any confirmation or safety behavior imposed by the MCP host/platform.

## Validation

Focused coordinator/config/runtime/MCP validation:

```text
39 / 39 PASS
```

Focused remote-push backend/operator/bypass/surface validation:

```text
43 / 43 PASS
```

Required full suite:

```text
1010 tests
1001 pass
3 fail
6 todo
0 skipped/cancelled
```

Full-suite failures:

1. `browser runtime isolates sessions and recovers owned workspace across WAG restart` — DevSpace startup timeout. Immediate exact-worktree serialized rerun of `test/browser-adapter-runtime.test.ts`: **3/3 PASS**. Classified **environmental/flaky, not an autonomous-push regression**.
2. `browser adapter local path survives native-host reconnect` — Windows `spawn UNKNOWN`. Classified **pre-existing**; same failure was present at the pre-hotfix Task 3 full-suite baseline.
3. `Windows SEA native host speaks framed protocol against local WAG` — Windows `spawn UNKNOWN`. Classified **pre-existing**; same failure was present at the pre-hotfix Task 3 full-suite baseline.

The 6 Claude harness `OPEN` cases remain TODOs and are unchanged.

New Autonomous Remote Push v2 regression failures: **0**.

## Non-claims

- live runtime promotion: not performed yet;
- live config activation: not performed yet;
- real autonomous private remote push through the promoted runtime: not performed yet;
- public repository push: not performed and not authorized.
