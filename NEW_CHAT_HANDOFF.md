# Current handoff — WAG Autonomous Local / DC Replacement

> **2026-09-24 superseding status:** the Goal Lease architecture documented below is historical.
> It is no longer part of the live private-local or browser-effect authority path. Keep the older
> sections as provenance only; do not use them to decide current execution authority.

## 2026-09-24 live cutover

```text
source migration commit:
7a6e266ac39249320a5d0327950d5b89a7e03879
refactor: remove Goal Lease from private local automation

active runtime:
E:/WAG-Runtime/7a6e266ac392

authority:
AUTONOMOUS_LOCAL
kill switch = CLEAR
```

Private stdio/WAG Local now authorizes bounded command, mutation, exact-path commit and local-machine
operations from its trusted profile plus caller-owned durable workspace identity. Goal Lease issue,
TTL, rollover, successor and human confirmation are not required. `sessionCorrelation` is stable
identity/audit continuity only.

Browser filesystem/Git effects stay on the local operator-review path. Goal UI Delegation remains a
separate Run/dispatch control and never approves those effects. Production browser runtime no longer
drives Goal Lease admission.

The live MCP server exposes 22 tools, but ChatGPT can retain a frozen 16-tool connector snapshot.
Current source therefore includes a compatibility bridge: the existing `workspace.open` can fall
back to a local-machine workspace, and existing `repo.list`, `file.read` and `command.run`
dispatch by durable workspace backend. This removes connector Refresh from the DC-replacement
execution path.

Current source HEAD may be newer than the runtime because documentation/compatibility work continues.
Always fresh-check Git and the activation receipt before promotion.

---

## Historical Goal Lease handoff — retained for provenance

Date: 2026-09-23

## Canonical rule

Do not reconstruct project state from chat history.

Fresh-check, in this order:

1. Git branch/HEAD and worktree snapshot.
2. `AGENTS.md`.
3. `README.md` plus the latest approved spec and relevant ADRs.
4. `docs/benchmarks/2026-09-23-multi-workspace-development-lanes.md`.
5. Current source/tests and live WAG capability state.
6. Durable activation / mutation / commit receipts when they exist.

If this file conflicts with live Git/source/test/runtime evidence, live evidence wins and this file
must be updated. Chat history is not an authority source for this slice.

## Current source baseline

```text
workspace:
E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1

branch:
feat/goal-ui-delegation-v1

HEAD:
f1c8cc54cb47b23253992993ba9e583f9864ce60

commit:
feat: resolve goal leases per request
```

The worktree remains intentionally dirty/private-index-like. Never use broad reset/clean/restore to
make status look clean.

The resolver slice commit contains exactly the intended 16 paths. Unrelated pre-existing dirty
paths were not swept into it.

## Latest source-only hardening — read this before chat history

The newest repository evidence is:

```text
docs/benchmarks/2026-09-23-goal-lease-effect-boundary-revalidation.md
docs/benchmarks/2026-09-23-goal-lease-atomic-budget.md
docs/benchmarks/2026-09-24-goal-lease-stable-workspace-identity.md
docs/benchmarks/2026-09-24-goal-lease-live-workspace-identity-revalidation.md
```

These slices are **not committed or deployed yet**. HEAD and the live runtime are still
`f1c8cc54cb47b23253992993ba9e583f9864ce60`.

Current source adds:

- Goal Lease re-resolution immediately before filesystem write;
- Goal Lease re-resolution immediately before the Git backend may move a ref;
- exact admitted-lease continuity across that effect boundary;
- persistent SQLite atomic budget reservation for `POLICY_APPROVED` mutation authority rows;
- cross-connection last-slot protection for both file and byte budgets;
- fail-closed startup installation in private stdio and browser operator runtimes.

Measured on the current working-tree bytes:

```text
effect-boundary focused tests       = 5/5 PASS
atomic two-connection race tests    = 2/2 PASS
runtime-composition focused gate    = 23/23 PASS
Goal Lease focused regression       = 61/61 PASS
npm run typecheck                   = PASS
npm run build                       = PASS
```

Do not claim the entire repository suite passed. Exact source SHA values and commands are recorded
in the two benchmark receipts above.

The atomic budget slice does **not** edit `src/durable-store.ts`: WAG correctly rejects mutation
targets over 64 KiB. The implementation installs a persistent trigger through a separate,
short-lived connection to the same authority DB; it does not reach into the store's private DB
handle and no shell-write bypass was used.

Because the existing human lease's Git commit binding does not authorize a new source HEAD, do not
commit/promote these source-only changes until a human reviews/issues the next bounded authority.
Human-only Goal Lease issuance and `sessionCorrelation` boundaries remain unchanged.

### Stable workspace identity source candidate

The Phase 4 precursor is now source-green and recorded in:

```text
docs/benchmarks/2026-09-24-goal-lease-stable-workspace-identity.md
```

New workspace opens can persist a versioned fingerprint over the canonical root, backend identity,
filesystem device/inode identity and Git top-level/git-dir/common-dir identity. New Goal Leases may
optionally bind those fingerprints through `workspaceIdentities`; when present they must cover every
workspace root exactly once and a missing/changed request fingerprint denies. Existing leases that
omit the field retain their current root-only semantics until a human issues an identity-bound
successor.

The fingerprint is propagated through command, mutation, commit and both pre-effect revalidation
paths. `workspace.open` waits for its identity binder before returning the opaque workspace id, and
the browser admitted-workspace service re-observes identity on durable reopen.

Fresh measured gates for this slice:

```text
workspace identity + policy/resolver/admitted workspace = 26/26 PASS
direct stdio/session runtime                            = 21/21 PASS
browser + effect revalidation + atomic budget           = 11/11 PASS
focused total                                            = 58/58 PASS
npm run typecheck                                        = PASS
npm run build                                            = PASS
```

This slice is not committed or promoted. Live runtime and HEAD remain `f1c8cc54...`; live
identity-bound successor acceptance is still outstanding. Do not claim the entire repository test
suite passed.

### Live workspace identity and process-spawn revalidation extension

The latest source bytes are recorded in:

```text
docs/benchmarks/2026-09-24-goal-lease-live-workspace-identity-revalidation.md
```

A failing runtime regression proved that persisting fingerprint A at `workspace.open` was not
sufficient: replacing the filesystem/repository object behind the same canonical root could leave a
running command path using cached identity A. The source now re-observes live workspace identity
for direct command authority and at mutation/commit effect boundaries, with the same live observer
wired into the browser operator runtime.

`command.run` also performs a second runtime-owned authority check after bounded cwd/argv
validation and immediately before `executor.execCommand`. That callback is not MCP input and
cannot be supplied or removed by the client.

Fresh measured gates on the recorded bytes:

```text
identity/effect/resolver/direct runtime = 41/41 PASS
browser/atomic/admitted workspace       = 12/12 PASS
MCP surface                             = 15/15 PASS
direct readiness/session                = 48/48 PASS
npm run typecheck                       = PASS
npm run build                           = PASS
```

These are separate measured batches; do not sum them as a unique whole-suite total. This extension
is also source-only. Do not commit/promote it while the existing human Goal Lease Git-CAS binding
is stale; a human-reviewed successor remains the next authority-changing step.

## Frozen target

Goal Lease is a multi-active durable authority plane, not a singleton runtime selector.

```text
0 eligible leases  -> deny NO_LEASE
1 eligible lease   -> authorize exact lease
>1 eligible leases -> deny AMBIGUOUS_LEASE
```

No heuristic precedence. Human-only issuance remains. `git.push` remains denied/non-grantable.
Proposal/approval is separate from lease authority.

`repositoryEngineering.mutation.goalLeaseId` is legacy parsing only for this successor path; it
must not activate or prioritize a lease.

## Implemented and committed

Key files:

```text
src/goal-lease-resolver.ts
src/goal-lease.ts
src/durable-mutation.ts
src/git-commit.ts
src/repository-engineering-runtime.ts
src/browser-operator-runtime.ts
src/private-config.ts
src/cli.ts
scripts/prepare-direct-mcp-tunnel.ts
scripts/goal-lease-delegation-control.ts

test/goal-lease-resolver.test.ts
test/repository-engineering-runtime.test.ts
test/direct-mcp-readiness.test.ts
test/direct-mcp-session-binding.test.ts
```

Fresh measured gates before promotion:

```text
goal-lease resolver + repository runtime = 15 pass, 0 fail
direct MCP readiness + session binding   = 48 pass, 0 fail
CLI/config/issuance guard                = 30 pass, 0 fail
DC replacement surface                   = 12 pass, 0 fail
browser operator runtime                 = 4 pass, 0 fail

focused measured total                   = 109 pass, 0 fail
typecheck                                = pass
build                                    = pass
```

A larger mixed regression batch hit the 30-second command ceiling after many passes and before
completion. Do not report it as either a pass or a test failure. Do not claim the whole repository
test suite passed.

The runtime preparation helper independently typechecked and built a detached worktree of
`f1c8cc54cb47b23253992993ba9e583f9864ce60`.

## Live runtime — promoted

Activation receipt:

```text
E:/WAG-Acceptance/promotion-logs/activate-f1c8cc54cb47.json

state       = SUCCEEDED
sourceHead  = f1c8cc54cb47b23253992993ba9e583f9864ce60
previousCli = E:/WAG-Runtime/b05ec91dbc93/dist/cli.js
cli         = E:/WAG-Runtime/f1c8cc54cb47/dist/cli.js
launcherPid = 19820
completed   = 2026-09-23T16:25:27.870Z
```

DevSpace was not restarted.

Fresh live behavioral fingerprint after activation:

- WAG health = ok;
- current WAG development workspace resolves `lease_mue8eeve_793f7c2c` as ACTIVE;
- FILE_WRITE, GIT_COMMIT and LOCAL_COMMAND are granted there;
- GIT_PUSH remains denied/non-grantable;
- `E:/Projects/web-agent-gateway` has no matching lease, reports
  `LOCAL_COMMAND.reason = NO_LEASE`, and `command.run` is denied with
  `Gateway denied command: NO_LEASE`.

That zero-match behavior is the deployed resolver path, not the old singleton selected-lease path.

## Durable lease inventory / current live blocker

The durable store was inspected directly. Historical A/B/multi-workspace leases are expired or
revoked. Exactly the current development lease is ACTIVE:

```text
lease_mue8eeve_793f7c2c
session = session_d9e39801-87fd-40f5-92b7-999a48609f1d
adapter = private.stdio.v1
workspace =
  E:/Projects/web-agent-gateway/.worktrees/claude-autonomous-wag-harness-v1
commit HEAD binding =
  b05ec91dbc93cb772e8d1d2b73ea4ff4ff4426d5
expiresAt = 1790190116042
```

Because source HEAD is now `f1c8cc54...`, this lease still grants command/file authority but its
commit CAS is intentionally stale. Do not weaken or bypass that CAS.

A read-only rollover preview measured current spend:

```text
source lease = lease_mue8eeve_793f7c2c
filesChanged = 18
bytesWritten = 207515
preview digest =
  19dfa4aabc8194d6ae143e549fe9c6724673c87050fae8bd8161e912b6cd2b73
```

Prepared successor bindings intentionally narrower than the measured residual budget, while updating only the commit HEAD, are stored
at:

```text
docs/benchmarks/2026-09-23-goal-lease-successor-f1c8cc54.bindings.json

maxFiles     = 96
maxBytes     = 3500000
maxDiffBytes = 262144
HEAD         = f1c8cc54cb47b23253992993ba9e583f9864ce60
```

Do **not** use the old `--apply-rollover` activation path for this architecture: the new invariant
is that durable leases are resolved hot and do not require `goalLeaseId` config edits or WAG
restart.

The next authority-changing step is deliberately human-only. The agent must not mint, renew, widen,
or choose a new session correlation on the human's behalf.

## Direct stdio session identity reality

The private stdio adapter does not currently receive or derive a ChatGPT per-conversation identity.
Its stable session is selected by human-written local `sessionCorrelation`, then resolved through
`adapterCorrelationDigest(...)` and the durable adapter-session store.

Therefore two ChatGPT conversations that enter through the same configured stdio lane are not, by
themselves, two WAG authority sessions. Live A/B acceptance currently requires two separately
human-configured connector/runtime lanes with distinct stable correlations, or a later Phase 4
provider-derived identity mechanism. The agent must not create those correlations on the human's
behalf; the human-presence guard explicitly treats writing `sessionCorrelation` as authority
configuration.

## Human-only next step — successor handoff

The next mutation of authority must be performed by a person in an interactive local terminal. The
prepared envelope is deliberately tighter than the measured predecessor residual budget.

While `lease_mue8eeve_793f7c2c` is still ACTIVE with more than 60 minutes remaining, run:

```powershell
Push-Location 'E:\Projects\web-agent-gateway\.worktrees\claude-autonomous-wag-harness-v1'
try {
  npx.cmd tsx .\scripts\goal-lease-delegation-control.ts --issue `
    --state 'E:\AI-BROWSER\wag-acceptance\devspace-state\wag-mutation.sqlite' `
    --bindings 'E:\Projects\web-agent-gateway\.worktrees\claude-autonomous-wag-harness-v1\docs\benchmarks\2026-09-23-goal-lease-successor-f1c8cc54.bindings.json' `
    --ttl-minutes 60
} finally {
  Pop-Location
}
```

Review the emitted plan and type the exact requested `ISSUE <sha256>` only if it matches.

For the live ambiguity acceptance, **do not revoke the predecessor yet**. With both matching rows
active, the deployed resolver should report `AMBIGUOUS_LEASE` without any WAG restart. After that
observation, revoke the predecessor locally:

```powershell
Push-Location 'E:\Projects\web-agent-gateway\.worktrees\claude-autonomous-wag-harness-v1'
try {
  npx.cmd tsx .\scripts\goal-lease-delegation-control.ts `
    --revoke lease_mue8eeve_793f7c2c `
    --state 'E:\AI-BROWSER\wag-acceptance\devspace-state\wag-mutation.sqlite'
} finally {
  Pop-Location
}
```

The new lease must then become uniquely resolvable immediately, again without config edit or WAG
restart. If the predecessor has less than 60 minutes remaining, do not use the fixed TTL above;
remeasure/review the grant as a new human issuance instead of pretending it is a bounded successor.

## Live acceptance still required

Source-level acceptance is green and the resolver runtime is live, but full multi-session production
acceptance is not yet claimed.

Still required:

- human-issued successor for the current HEAD, with residual budget preserved;
- at least two concurrently usable stable provider/session contexts with independent workspace
  leases;
- A/Workspace A -> Lease A and B/Workspace B -> Lease B;
- cross-session/workspace denial;
- revoke A while B remains usable;
- issue C and successor C2 observed without WAG restart;
- duplicate matching lease -> AMBIGUOUS_LEASE;
- branch/HEAD CAS and path/argv/budget/kill constraints;
- GIT_PUSH remains impossible.

## Do not mutate

- UAF
- PFP
- DevSpace configuration merely for this deployment
- Goal Lease human-only issuance boundary
- provider/account/tunnel credentials

Do not restart DevSpace unless fresh evidence proves it is required.

After live multi-session Goal Lease acceptance, return to UAF Task4 runtime verification.
