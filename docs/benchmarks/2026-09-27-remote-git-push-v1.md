# WAG Remote Git Push v1 — Acceptance

**Date:** 2026-09-27  
**Status:** SOURCE ACCEPTED  
**Branch:** `feat/remote-effect-bypass-closure-v1`  
**Base commit:** `5928c8fd6a0886c0a583221ff44afd1ea0bf231d`  
**Implementation commit:** `e80e34a98fa674682683f1531f44dbc9dbcc31e7`

## Scope

Implemented a bounded, Human-gated remote Git push path for WAG.

The model-callable MCP surface can:

```text
git.push
git.push.result
```

The model-callable surface cannot:

```text
issue grant
approve grant
activate grant
change grant
broaden grant
```

Approval/rejection exists only on the local operator surface.

## Exact authority binding

A grant is bound to:

```text
caller owner/session/adapter
workspace
repository identity
effective push URL
source commit OID
destination refs/heads/* ref
expected remote state
review fingerprint
TTL
maxUses = 1
```

Protected destinations such as `main`, `master`, tags, deletes and malformed refs are refused.

## Remote compare-and-swap

Execution uses the exact reviewed source OID and destination ref with a force-with-lease style compare-and-swap against the reviewed remote state.

Supported reviewed states:

```text
ABSENT
exact remote OID
```

Remote drift between review and execution fails closed.

Non-fast-forward planning is refused.

Effective push URL drift is refused.

Repository hooks are suppressed through a WAG-owned empty hooks directory outside the repository.

## Bypass closure

Generic local execution surfaces refuse direct Git/GitHub remote mutations, including:

```text
git push
git send-pack
gh remote-mutating commands
Git aliases/configured aliases that resolve to remote mutation
shell-indirected Git/GitHub remote mutation
persistent terminal split-input attempts
DevSpace command.run / verify.run bypass
machine.command.run / process / terminal bypass
```

The parser handles Git global options before classifying the subcommand.

## Human review

The first exact `git.push` request creates only a pending proposal.

The local operator can review:

```text
workspace/repository identity
effective push URL
source OID
destination ref
expected remote state
commit subject
changed-file summary
ahead count when available
grant fingerprint
review deadline
active grant TTL
maxUses = 1
```

Approval activates only that exact proposal.

Rejection is same-origin and CSRF-bound.

## Durable state and restart behavior

Grant states:

```text
PENDING
ACTIVE
CONSUMED
EXPIRED
REVOKED
QUARANTINED
```

Interrupted ACTIVE grants are reconciled after restart:

- observed remote equals source OID -> consumed/succeeded;
- not observed -> revoked/not-observed;
- divergent or uncertain state -> quarantined.

Uncertain effects are never blindly retried.

Duplicate matching active grants fail closed as ambiguous authority.

## Kill switch

The kill switch is checked:

- before proposal creation;
- before local approval;
- immediately before remote effect.

A kill-switch race therefore fails closed.

## Acceptance evidence

Focused Remote Git Push + bypass-closure suite:

```text
35 / 35 PASS
```

Targeted repository/MCP/operator/security regression:

```text
79 PASS
0 FAIL
6 TODO / pre-existing OPEN guard residuals
```

The six TODOs are explicitly marked pre-existing Claude harness guard residuals:

```text
OPERATOR_URL_FILE regex performance
newline word-anchor bypass
wildcard operator credential filename
incomplete guarded-server enumeration
case-sensitive self-protection / traversal
PowerShell HTTP aliases
```

They are not Remote Git Push execution regressions and do not grant the model a Remote Git Push approval path.

Build gates:

```text
npm run typecheck   PASS
npm run build       PASS
git diff --check    PASS
```

## Explicit non-claims

The following are not claimed by this source acceptance:

- production WAG promotion: **not performed**;
- live production MCP inventory containing `git.push`: **not measured**;
- live real-remote push acceptance through production WAG: **not performed**;
- remote Git push from generic `command.run`: **deliberately denied**;
- unrestricted network exfiltration prevention: **not implemented**.

Residual risk remains for arbitrary network-capable programs such as `curl` when credentials are available. Closing arbitrary outbound-network exfiltration requires a separate network-isolation boundary.

## Repository boundary

```text
implementation commit: e80e34a98fa674682683f1531f44dbc9dbcc31e7
remote push of this WAG branch: NOT PERFORMED
production WAG mutation: NOT PERFORMED
```
