# WAG Public Community Launch P0 v1

**Date:** 2026-10-01  
**Base:** `ae5417937650600055bd2363cd663097bc279ac0`  
**Branch:** `feat/wag-public-launch-p0-v1`

## Decision

WAG Community public launch is gated on product differentiation, not tool count.

Execution order:

```text
M8 private beta continues independently
        |
        +-----------------------------+
        |                             |
        v                             v
Remote Git Read / Ref Inspect     Browser v2
        |                             |
        +-------------+---------------+
                      |
                      v
          Immutable Multi-File Change Set
                      |
                      v
             WAG Community beta
                      |
                      +--> Repo History
                      +--> Controlled Branch / Worktree
                      +--> measured fixes
                      |
                      v
             public @latest
```

## P0 before public @latest

### 1. Remote Git Read / Ref Inspect

Add one bounded, read-only semantic remote Git surface:

```text
git.remote.inspect
  workspace_id
  remote
  refs?: refs/heads/...[]
```

Returns:

- exact repository identity;
- effective fetch URL;
- effective push URL;
- remote default branch;
- exact OIDs for explicitly requested refs;
- authentication state as `AVAILABLE | UNAVAILABLE | UNKNOWN`;
- observation timestamp.

Rules:

- no fetch;
- no local-ref mutation;
- no branch mutation;
- no credential/token output;
- no arbitrary remote URL from the caller when a named configured remote is used;
- reuse the same safe Git environment, dangerous-config checks, URL canonicalization and credential boundary as bounded `git.push`;
- requested refs are explicit and bounded; do not enumerate all remote refs by default.

A separate `git.remote.ref.read` tool is not required if `git.remote.inspect` can read a bounded list of exact refs.

### 2. Browser v2 — public differentiation gate

Canonical design is documented in:
`docs/superpowers/plans/2026-10-01-wag-browser-v2-hybrid-local-hardening.md`.

The public wedge is:

```text
files + terminal + repo + documents
+ existing authenticated browser
+ WAG-visible browser
+ headless browser
+ target ownership
+ framework-safe fill
+ OAuth continuity
+ exact-once effects
+ recovery
```

Browser v2 is a public-launch gate, not a post-launch nice-to-have.

### 3. Immutable Multi-File Change Set

Preferred semantic family:

```text
change.preview
change.apply
change.result
```

The immutable plan binds:

- workspace;
- exact base HEAD;
- path operation set;
- base hashes;
- result hashes;
- destination vacancy for moves/creates;
- plan digest.

Minimum operations:

- replace;
- create;
- delete;
- move.

Before apply, all preconditions must still match. Filesystem-level perfect transactions are not claimed unless implemented. Durable state must detect and reconcile partial effects.

State model:

```text
PREPARED -> APPLYING -> APPLIED -> VERIFIED
                  \-> PARTIAL_EFFECT_DETECTED
```

Do not add public `file.delete` / `file.move` first if change-set can cover them cleanly.

## P1 after/beside Community beta

- `repo.history`: bounded commit/path history, no email by default.
- controlled `git.branch.create`, `git.worktree.create`, `git.worktree.remove` with exact base OID and exact repository identity.
- artifact/result addressing foundation.

## P2 only from measured need

- `git.remote.fetch` into WAG-owned namespaced refs, never implicit local integration.
- durable long-running operation ownership/reconnect refinements.

## Explicit non-goals

Do not add generic:

- `git.pull`;
- `git.checkout *`;
- `git.reset`;
- `git.rebase`;
- `git.force_push`;
- `git.merge` without a measured workflow;
- GitHub PR/Actions duplication;
- email/Slack/project-management surfaces.

GitHub connector remains the preferred PR/review/Actions plane.

## Platform hardening, not MCP-tool count

Future security work remains executor-level:

- network/credential egress containment;
- credential isolation/brokerage;
- precise public documentation of current egress boundary.

Do not claim all remote effects are contained merely because `git.push` is bounded.

## Launch rule

Do not publish WAG Community as public `@latest` until Browser v2 final acceptance passes.

A beta distribution may be used earlier only after the beta artifact and browser state are explicitly labeled.
