# WAG DC Replacement v1 — Acceptance Plan

Date: 2026-09-19
Status: ACCEPTANCE PLAN — defines the exact evidence required for local production acceptance
Companion design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Decision authority: ADR-0018, ADR-0020, ADR-0021, ADR-0022, ADR-0023
Research: `docs/research/2026-09-19-wag-dc-replacement-v1-surface-selection.md`
Measured gap: `docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`

## Goal

Define the exact evidence required before WAG may be recorded as **locally production-accepted as the primary
repository-engineering operator on this machine**, replacing Remote Desktop Commander on the workflows the DC
Replacement Workflow Benchmark v1 measured.

The plan separates three things that must never be conflated:

1. **local production acceptance** — this plan, achievable entirely on this machine;
2. **shared/public distribution** — push, PR, merge, release, tag, signing; explicitly out of scope;
3. **supported-host WebChat acceptance** — Layer B provider evidence; explicitly a separate later gate.

Passing this plan authorizes the first and nothing else.

## Gate 0 — Authority lock

Before implementation:

- ADR-0020 is accepted and authoritative for surface assignment;
- ADR-0018's workflow-scoped replacement rule is unchanged;
- ADR-0017 and ADR-0019 browser restrictions are unchanged, and no browser tool list, adapter id or protocol revision
  is touched;
- ADR-0008, ADR-0009, ADR-0011, ADR-0014, ADR-0015 mutation/approval/ownership contracts are reused without
  relaxation;
- exact base SHA recorded;
- no dependency added, removed or upgraded;
- no shell/process/PTY/Git-write/directory/config-mutation capability on any surface;
- no native-host, registry, release, tag, signing or provider action.

Failure condition: implementation requires a new execution primitive, a new dependency, remote approval, OS elevation,
a new listener beyond the existing loopback operator server, or relaxation of any mutation invariant.

Disposition: return to design review.

## Gate 1 — Source gate: configuration

Tests must prove:

- `repositoryEngineering` absent means both capabilities disabled;
- `inspect` defaults to `false`;
- `mutation` absent by default;
- `mutation.statePath` required when `mutation` present, and rejected when not absolute;
- `mutation.ownerId` defaults to the fixed literal and rejects values outside the caller-context authority pattern;
- the config schema remains strict: an unknown key is a load error, never a silent capability;
- every existing private-config behavior — allowed roots, DevSpace loopback/resource URL rules, verify profiles,
  `browserVerifyProfiles` — is unchanged.

## Gate 2 — Source gate: gateway inspection methods

Tests must prove:

- `repoSearch`, `repoList` and `repoDiff` resolve the same workspace binding as `file.read` and `repo.snapshot`,
  and reject an unknown `workspace_id`;
- defaults and clamps match the accepted browser projection exactly: `ignoreCase` false, `maxResults` 20 clamped to
  `[1, 50]`, `contextLines` 1 clamped to `[0, 2]`;
- they delegate to the shared `DevspaceRepositoryInspectionBackend` and introduce no second implementation;
- each emits its own telemetry trace with success and failure outcomes;
- existing `repo.snapshot` and `file.read` behavior is unchanged.

## Gate 3 — Source gate: capability profile

Tests must prove the exact tool list, in order, for all four combinations:

```text
default            health, workspace.open, repo.snapshot, file.read, verify.run
inspect only       health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                   file.read, verify.run
mutation only      health, workspace.open, repo.snapshot, file.read, verify.run,
                   mutation.preview, mutation.result
both               health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                   file.read, verify.run, mutation.preview, file.create, mutation.result
all three          health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                   file.read, verify.run, mutation.preview, file.create, mutation.result,
                   git.commit, git.commit.result
```

`gitCommit` without `mutation` is a configuration error, not a silent half-capability.

Negative discovery tests must prove absence, in every combination, of:

- `verify.preview` / `verify.result` (browser-only proposal tools);
- `job.*`;
- shell, process, PTY, terminal, or command tools;
- Git write tools;
- file move/delete or directory tools;
- runtime configuration mutation tools;
- arbitrary tool forwarding.

`validSearchQuery` rejection must be proven on the stdio surface, not only on the browser surface.

## Gate 4 — Source gate: runtime assembly

Tests must prove:

- disabled mode opens no durable store, binds no port and builds no caller context;
- enabled mode calls `coordinator.reconcile()` before the surface serves traffic;
- `openWorkspaceId` persists a durable workspace record owned by the exact WAG-generated caller tuple, so
  `mutation.preview` can resolve it;
- `close()` is idempotent and tears down operator server before store;
- a failure during `attach` still releases the store and any partially started server;
- production and tests share one assembly path — the previously test-only wiring is no longer duplicated.

## Gate 5 — Source gate: CLI

Tests must prove:

- `doctor` reports the resolved capability profile, binds no operator review port, issues no bootstrap URL, and closes
  the engineering runtime before returning;
- nothing at all is emitted for the shipped default profile, so unconfigured output is byte-unchanged;
- the operator bootstrap URL is emitted on stderr and never on stdout;
- stdout carries MCP transport bytes only;
- teardown order is stdio server, engineering runtime, private gateway runtime, on success and on each failure path,
  with each step individually guarded;
- existing CLI usage, config-error, and bootstrap-error behavior is unchanged.

## Gate 6 — Security gate

Independently test, with no real credential, user document, unrelated process or canonical WAG repository as target:

- foreign `ownerId`, `sessionId` or `adapterId` denied on `mutation.result`;
- unknown `mutation_id` denied through the same bounded denial;
- a mutation proposed by one gateway process cannot be read or approved by a restarted process;
- repository content that instructs the reader to access a path outside the workspace cannot cause an outside-workspace
  read — the committed fixture's `notes/operator-notes.md` and its sibling canary are used for this;
- repository content cannot self-approve a mutation, change the verify profile, or widen `allowedRoots`;
- the MCP caller cannot reach, guess or be told the operator origin, bootstrap URL, session cookie or CSRF token;
- `statePath`, the DevSpace owner token, and operator credentials are absent from every MCP response, error and
  telemetry event;
- operator reject produces no backend write;
- review-deadline expiry produces no backend write;
- approval is single-use; a replayed approval creates no second write;
- a path traversal or absolute-escape argument to `repo.search`, `repo.list`, `repo.diff`, `file.read` or
  `mutation.preview` fails closed;
- a caller-supplied path that is legal on disk but full of shell syntax reaches git as a single argv element and
  executes no embedded command;
- a commit message containing `$(...)`, backticks, `;`, `&&` and redirection is stored verbatim and executes
  nothing;
- executable hooks installed in both `.git/hooks` and a hostile `core.hooksPath` — `pre-commit`,
  `prepare-commit-msg`, `commit-msg`, `post-commit`, `post-index-change`, `reference-transaction` and the
  rest — do not run for either half of a WAG commit; a separate attribution test proves that any surviving
  `post-index-change` / `reference-transaction` invocation comes from the execution backend's own
  `open_workspace`, which WAG cannot pass git options into, and never from WAG's git invocations;
- a directory in HEAD replaced by a regular file of the same name is refused, not silently committed as a subtree
  deletion;
- a dirty real index and unrelated dirty worktree files are byte-identical after a commit and after every refusal;
- HEAD drift, branch drift and selected-file drift between preview and approval each fail closed;
- a foreign owner/session/adapter is denied on `git.commit.result`, and a replayed approval commits nothing twice;
- `main` and `master` are refused by default, case-insensitively;
- a detached HEAD, an in-progress merge/cherry-pick/revert/rebase, and unmerged index entries are each refused;
- `commit.gpgsign=true` does not produce a signed object, and an unusable `user.name`/`user.email` fails closed
  at proposal time rather than being synthesised or discovered after approval;
- a repository whose `.git/config` sets `core.worktree` elsewhere is refused, and a decoy file of the selected
  name in the workspace does not make the outside file's bytes committable;
- a workspace nested inside a larger repository cannot commit to that outer repository's branch;
- the author the commit would be attributed to is bound into the record, shown on the review page, and revalidated at
  approval, so a repository cannot re-attribute an approved commit;
- bidi overrides and zero-width characters in a filename, a change-set entry or the message are rendered on the
  review page as visible code points, never verbatim;
- an input too large for the executor's bounded command string is refused while proposing, with a named reason;
- an executor error, an interrupted helper, or truncated or unreadable output is recorded as `OUTCOME_UNKNOWN` and
  never as a clean failure;
- a commit message cannot forge the helper's result sentinel;
- one caller cannot fill the operator's review list with proposals.

## Gate 7 — Restart gate

Four exact windows, applied to stdio mutation:

### A. Pending across restart

- propose a mutation;
- restart the gateway;
- the original review deadline is unchanged and is not refreshed;
- the record does not execute on restart alone;
- the new session's MCP caller cannot read it;
- an already-expired record is expired by `reconcile()` and can never be approved afterwards.

Local operator authority is independent of the caller session and this milestone does not change that, so a pending
record that survives a restart inside its original deadline remains locally reviewable. That must be recorded as the
verified behavior rather than claimed as cross-session fail-closed.

Windows B, C and D below are properties of the accepted durable mutation core, which this milestone reuses without
relaxation. They are satisfied by the existing committed coverage in `test/durable-mutation.test.ts` and
`test/durable-mutation.acceptance.test.ts`, which run in the full suite. The acceptance receipt must name that
inherited coverage rather than duplicate it, and must state that projecting the coordinator onto stdio changed none of
those semantics.

### B. Approved before claim, then restart

- approve;
- restart before the backend claim;
- recovery must not silently replay the write;
- the record reaches a terminal state consistent with the accepted durable mutation contract.

### C. Claimed/executing, then restart

- restart without completion proof;
- the record becomes `OUTCOME_UNKNOWN`;
- execution is not replayed.

### D. Backend exception or timeout

- ambiguous execution becomes `OUTCOME_UNKNOWN`;
- no retry path can reuse the old approval.

## Gate 8 — Integration gate

In-process integration over a real MCP client/server pair and the real coordinator, using a fresh copy of the
committed `docs/benchmarks/fixtures/dc-replacement-v1` template:

- admit the stdio caller;
- open the exact fixture workspace;
- `repo.search` locates the implementation and test without the prompt revealing either path;
- `repo.list` enumerates a subtree and the repository root, excluding ignored paths;
- `repo.snapshot` reports branch, HEAD and bounded diff;
- `repo.diff` reports the approved change after it lands;
- `file.read` returns the sentinel exactly;
- `verify.run` on the `unit` profile returns the baseline oracle: exit code 1, two tests, one pass, one fail;
- `mutation.preview` persists a record and performs no write — proven by re-reading the file;
- local operator approval causes exactly one write;
- `verify.run` after the approved change returns exit code 0 with two passes;
- final repository residue is exactly one modified tracked file, `src/lib/ticket-id.js`;
- `git.commit` persists a record, writes no ref and moves no branch — proven by re-reading HEAD;
- local operator approval produces exactly one ordinary single-parent commit whose tree contains exactly the approved
  change.

Reject flow and expiry flow are each proven to leave the file byte-identical.

## Gate 9 — Production-local gate

The distinguishing gate of this milestone. Everything above may run in-process; this must not.

Requirements:

- run the **built** artifact: `npm run build`, then `node dist/cli.js serve-stdio --config <absolute>`;
- spawn it as a real child process over a real stdio MCP transport, exactly as a tunnel client would;
- back it with the **real pinned DevSpace** at the revision recorded in `docs/benchmarks/devspace-pin.json`;
- use a **fresh copy of the committed fixture**, materialized to the deterministic baseline and verified before the
  run;
- perform the operator approval over the **real loopback HTTP operator server**, using the real bootstrap redemption,
  real session cookie and real CSRF token — no in-process shortcut, no direct coordinator call;
- execute R0, R1, R2, V1, C1, D1 and one reviewed commit in one session;
- for the commit: arm a canary for every hook class — `pre-commit`, `prepare-commit-msg`, `commit-msg`,
  `post-commit`, `post-index-change`, `reference-transaction` and the remaining names — in both `.git/hooks` and a
  hostile `core.hooksPath`, clear it immediately before the operation, prove the protected-branch refusal on `main`,
  then commit on a working branch and verify the exact commit SHA, parent and tree contents; that **no commit-class
  canary fired at all**; that any surviving index/ref canary is attributable to the execution backend's own
  `open_workspace` and is recorded as such rather than claimed away; that the real index is unchanged; and that
  unrelated dirty files are untouched;
- verify exact final repository residue;
- prove Remote Desktop Commander was not used: the measured path has no DC tool available, and the run is recorded as
  WAG-only.

Record: base SHA, DevSpace pin revision, Node version, fixture manifest hash, baseline HEAD and tree, the exact tool
inventory observed, the verify oracles before and after the change, the approval interaction count, and the final
`git status` of the fixture.

This gate is Layer A production evidence under the benchmark contract. It is **not** a Layer B WebChat result and must
never be recorded as one.

## Gate 10 — Full suite gate

All of the following, run in the default shell, with results recorded exactly:

```text
npm test
npm run typecheck
npm run build
npm run test:business
npm run test:dc-replacement
git diff --check
```

`npm test` must show zero failures. The historical local PowerShell `PSModulePath` contamination fixed in `7d85395`
must not reappear; if any environment-specific failure occurs it is classified from live evidence before any result is
accepted, and never silently excluded.

## Gate 11 — Secret-scan gate

Gitleaks over the exact committed range for this milestone, before any acceptance claim:

- record tool version, range, commit count, scanned size, findings and exit code;
- zero leaks required;
- no owner token, operator credential, machine-specific config path, provider credential or user data is committed.

## Gate 12 — Diff and reviewability gate

- `git diff --check` clean;
- the milestone is a small number of coherent commits: documentation/authority, implementation with tests, acceptance
  evidence;
- every production behavior change is covered by a test added in the same commit;
- no unrelated refactor, dependency change, or drive-by edit;
- the working tree is clean at acceptance.

## Local production acceptance decision

Recorded only when Gates 0–12 all pass:

```text
WAG_DC_REPLACEMENT_V1_LOCAL = PASS
WAG_PRIMARY_REPOSITORY_ENGINEERING_OPERATOR_LOCAL = ACCEPTED
TIER_R_LOCAL = R0 + R1 + R2 complete on the built production stdio path
TIER_V_LOCAL = V1 complete on the built production stdio path
TIER_C_LOCAL = C1 complete with real local operator approval
TIER_D_LOCAL = D1 complete as a composed loop
TIER_G_LOCAL = one reviewed commit complete with real local operator approval
```

Local acceptance explicitly does **not** authorize or claim:

- push, PR, merge, release, tag, or version change;
- code signing or native-host candidate publication;
- any provider or account action;
- any Layer B WebChat tier claim;
- Tier C or Tier D on any browser surface.

## Relationship to the browser milestones

Browser Verify Approval v1 remains `SOURCE = PASS`, `PRODUCTION_BROWSER_VERIFY = NOT_YET_ACCEPTED`. Its Gates 12–15
(exact native-host candidate, supported-host Tier R, supported-host V1, live security companion) are untouched by this
plan and remain outstanding. Nothing here rewrites, satisfies or substitutes for them.

## Stop conditions

Stop and return to design review if implementation requires:

- a new execution primitive, dependency, listener, tunnel, service or elevation;
- remote or model-driven approval;
- approval renewal, replay, or cross-session inheritance;
- exposing operator credentials, `statePath`, or internal backend identifiers to the MCP client;
- weakening caller/workspace ownership;
- changing the default five-tool stdio contract;
- changing any browser adapter identity, protocol revision or tool list;
- bypassing the local approval to make a gate pass;
- committing through `git commit` porcelain, mutating the real index, or moving a branch by anything but
  compare-and-swap.

## Decision markers

```text
ACCEPTANCE_MODEL = SOURCE_THEN_SECURITY_THEN_RESTART_THEN_INTEGRATION_THEN_PRODUCTION_LOCAL
PRODUCTION_LOCAL_REQUIRES_BUILT_ARTIFACT = TRUE
PRODUCTION_LOCAL_REQUIRES_REAL_DEVSPACE = TRUE
PRODUCTION_LOCAL_REQUIRES_REAL_OPERATOR_HTTP_APPROVAL = TRUE
LAYER_B_WEBCHAT_EVIDENCE = OUT_OF_SCOPE_SEPARATE_GATE
DISTRIBUTION_SIGNING_PROVIDER = OUT_OF_SCOPE
GIT_COMMIT_REQUIRES_REAL_OPERATOR_HTTP_APPROVAL = TRUE
GIT_COMMIT_HOOK_CANARY_EVIDENCE = REQUIRED
DEFAULT_STDIO_CONTRACT_CHANGE = FORBIDDEN
BROWSER_SURFACE_CHANGE = FORBIDDEN
```
