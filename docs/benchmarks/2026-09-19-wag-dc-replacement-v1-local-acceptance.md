# WAG DC Replacement v1 — Local Production Acceptance Receipt

Date: 2026-09-19
Status: PASS — local production acceptance only
Candidate: `dbfa4ba`, extended by `c7d1991` (see the addendum)
Base: `7d85395`
Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`
Acceptance plan: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`
Decision authority: ADR-0018, ADR-0020, ADR-0021, ADR-0022
Research: `docs/research/2026-09-19-wag-dc-replacement-v1-surface-selection.md`
Measured gap: `docs/benchmarks/2026-09-17-dc-replacement-live-benchmark-v1-attempt-1.md`

## Scope of this receipt

This receipt records **local production acceptance only**. It does not claim, authorize or substitute for:

- push, PR, merge, release, tag or version change;
- code signing or native-host candidate publication;
- any provider or account action;
- any Layer B WebChat tier claim under the DC Replacement Workflow Benchmark v1 contract;
- Tier C or Tier D on any browser surface.

Under the benchmark contract this is Layer A production evidence. Layer A cannot establish that ChatGPT Web replaced
Remote Desktop Commander. What it does establish is that the capability and authority gap measured on 2026-09-17 is
closed on WAG's production stdio path, with the local approval boundary enforced end to end.

## Environment

```text
host                = Microsoft Windows 11 Pro 10.0.26200, x64
node                = v24.20.0
npm                 = 12.0.2
devspace pin        = 33d6d0bcc2256024484d2456da924af8afd814ed  (docs/benchmarks/devspace-pin.json)
gitleaks            = 8.30.1
dc npm latest       = 0.2.51  (resolved 2026-09-19; benchmark pinned 0.2.50)
```

## Fixture identity

The committed DC replacement fixture was re-materialized from its template and verified byte-for-byte against the
committed manifest before every run.

```text
fixture manifest sha256 = eb465cc898b879ffe4df9dfe157f06e68236c29169fbadc2b38d5e0567a7bed2
baseline branch         = main
baseline HEAD           = b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d
baseline tree           = e276f7b0d6ea9e606ac9c3683e27781d354f8ce9
```

Both values reproduce exactly the identity fixed by the approved benchmark suite design, so this milestone is measured
against the same fixture version as the 2026-09-17 DC reference run.

## What changed

Two capability projections onto the existing private/Business stdio surface, plus the production wiring that makes the
already-accepted local approval path reachable outside a test fixture.

```text
src/private-config.ts                  optional strict repositoryEngineering block, default absent
src/server.ts                          repoSearch/repoList/repoDiff + registration behind an explicit switch
src/stdio-server.ts                    forwards { inspect, mutationContext }
src/repository-engineering-runtime.ts  new: store + caller context + coordinator + operator server assembly
src/cli.ts                             wires the profile, emits local-only diagnostics, ordered teardown
```

No new dependency, listener, execution primitive, transport, service, elevation or OS boundary. No browser adapter
tool list, adapter id or protocol revision changed.

## Gate results

### Gate 0 — authority lock

ADR-0020 accepted before implementation. ADR-0017/0018/0019 browser restrictions unchanged. ADR-0008/0009/0011/0014/0015
mutation, approval and ownership contracts reused without relaxation. Base SHA `7d85395`; authority commit `171d87b`.

### Gate 1 — configuration

`test/dc-replacement-config.test.ts` — 6 tests, 0 failures.

Proves: absent block means both capabilities disabled; `inspect` defaults false; `mutation` absent by default;
`statePath` required and must be absolute; `ownerId` defaults to `local.private.stdio` and rejects space, slash, empty,
over-length and quote-injection values; strict schema rejects unknown keys at both levels; existing allowed-root,
DevSpace URL, verify-profile and `browserVerifyProfiles` behavior unchanged.

### Gate 2 — gateway inspection methods

Covered in `test/dc-replacement-surface.test.ts`.

Proves: delegation through the shared `DevspaceRepositoryInspectionBackend` using the same workspace binding as
`file.read` and `repo.snapshot`; defaults `ignoreCase=false`, `contextLines=1`; clamping to `[0,2]` context and
`[1,50]` results, matching the accepted browser projection; unknown `workspace_id` rejected; `repo.search` telemetry
traced on both success and failure.

### Gate 3 — capability profile

`test/dc-replacement-surface.test.ts` — 9 tests, 0 failures.

Final surface, after ADR-0021 and ADR-0022:

```text
default         health, workspace.open, repo.snapshot, file.read, verify.run
inspect only    health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                file.read, verify.run
mutation only   health, workspace.open, repo.snapshot, file.read, verify.run,
                mutation.preview, file.create, mutation.result
both            health, workspace.open, repo.list, repo.search, repo.snapshot, repo.diff,
                file.read, verify.run, mutation.preview, file.create, mutation.result
```

`inspect: false` yields the default list, so the switch is an explicit `true` rather than a truthy value. In every
combination the surface is asserted free of `verify.preview`, `verify.result`, `job.*`, shell, process, terminal, pty,
exec, Git write, file write/patch/move/delete, directory, configuration-mutation and forwarding tools. Control
characters, NUL and over-length search queries are denied on the stdio surface, not only on the browser surface.

### Gate 4 — runtime assembly

`test/repository-engineering-runtime.test.ts` — 9 tests, 0 failures (shared with Gate 5).

Proves: disabled mode opens no store, binds no port and builds no caller context, and `attach` is inert;
`openWorkspaceId` persists a durable record owned by the WAG-generated caller tuple; adapter id is the fixed
`private.stdio.v1`; each process gets a distinct `sid_…` session; the operator server binds loopback only;
`reconcile()` runs before the surface serves; a failed `attach` exposes no mutation authority and releases the store
(proven on Windows by deleting the state file, which would fail with EBUSY on a leaked handle); `attach` is single-use;
`close()` is idempotent and ordered.

### Gate 5 — CLI

Proves: the resolved profile reaches the stdio surface; teardown order is stdio, engineering runtime, privileged
runtime on success and on every failure path; stdout carries MCP framing only; the operator origin is emitted on
stderr while the single-use bootstrap token goes to `<statePath>.operator-url`; the DevSpace owner token never
appears in diagnostics; `doctor` is a read-only preflight
that reports the profile without binding the operator port or issuing a bootstrap URL; nothing at all is emitted for
the shipped default profile; a repository-engineering or attach failure fails closed with a sanitized code and never
starts the surface.

### Gate 6 — security

`test/dc-replacement-security.test.ts` — 8 tests, 0 failures.

Proves: foreign `ownerId`, `sessionId` or `adapterId` denied on `mutation.result`; unknown `mutation_id` denied;
a restarted process cannot read a prior session's record; preview writes nothing; operator reject is terminal with no
write; review-deadline expiry is terminal with no write; three concurrent approvals collapse to exactly one write and a
later replay is refused; MCP responses never carry the operator bootstrap, session cookie, CSRF value, state path or
canonical root; `file.read`, `repo.search` and `mutation.preview` all fail closed on `../`, `..\\`, absolute POSIX,
absolute Windows and embedded-traversal paths, and the outside-workspace canary is never disclosed; the strict schema
rejects any client-supplied authority field.

### Gate 7 — restart

Window A proven directly in `test/dc-replacement-security.test.ts`: a proposal that survives a restart keeps its
original, never-refreshed deadline, does not execute on restart alone, and cannot be read by the new session; an
already-expired record is expired by `reconcile()` and can never be approved afterwards.

Windows B, C and D are properties of the accepted durable mutation core, which this milestone reuses without
relaxation. They remain covered by the committed `test/durable-mutation.test.ts` and
`test/durable-mutation.acceptance.test.ts` (queued-replay safety, claimed-then-restart becoming `OUTCOME_UNKNOWN`, and
refusal to rewrite divergent content), both of which run in the full suite. Projecting the coordinator onto stdio
changed none of those semantics.

Recorded precisely rather than overclaimed: local operator authority is deliberately independent of the caller session,
so a pending record that survives a restart inside its original deadline stays locally reviewable. What a restart can
never do is let a remote caller read, approve, resume or replay a record.

### Gate 8 — integration

`test/dc-replacement.integration.test.ts` — 2 tests, 0 failures, real pinned DevSpace, fresh fixture copy.

```text
R0  file.read docs/sentinel.txt        -> SENTINEL=WAG-DC-BENCH-V1
R1  repo.search canonicalizeTicketId   -> src/lib/ticket-id.js AND test/ticket-id.test.js
R2  repo.snapshot                      -> branch main, HEAD b3ca9b3b…, dirty false
V1  verify.run unit (baseline)         -> exit 1, tests 2, pass 1, fail 1
C1  mutation.preview                   -> approval_required, file byte-identical, status clean
    local approval                     -> exactly one write
D1  verify.run unit (after)            -> exit 0, pass 2, fail 0
    repo.snapshot                      -> HEAD unchanged, dirty true
    residue                            -> M src/lib/ticket-id.js  (only)
```

The reject flow leaves the fixture byte-identical and `git status --porcelain` empty.

### Gate 9 — production-local

`npm run test:dc-replacement` — 1 test, 0 failures.

The measured path is the **built** artifact, spawned as a real child process over a real stdio MCP transport, backed by
the real pinned DevSpace, approved over the **real loopback HTTP operator server**. No in-process shortcut and no
direct coordinator call were used for the approval.

Recorded run output:

```json
{"acceptance":"WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL",
 "builtCli":"<repo>/dist/cli.js",
 "tools":["health","workspace.open","repo.search","repo.snapshot","file.read","verify.run","mutation.preview","mutation.result"],
 "fixtureHead":"b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d",
 "fixtureTree":"e276f7b0d6ea9e606ac9c3683e27781d354f8ce9",
 "baselineExitCode":1,"afterFixExitCode":0,
 "operatorApprovals":1,
 "finalStatus":["M src/lib/ticket-id.js"]}
```

Negative operator evidence recorded in the same run:

```text
anonymous POST to the operator origin        -> 401
bootstrap URL replayed after redemption      -> 403  (single use)
approval with Origin: http://evil.invalid    -> 403, file unchanged
approval replayed after success              -> 409, one write total
file.read ../outside-canary.txt              -> denied, canary never disclosed
DevSpace owner token in gateway stderr       -> absent
```

Remote Desktop Commander was not used and was not available on the measured path: the gateway's entire tool inventory
is the eight tools listed above.

### Gate 10 — full suite

Run in the default shell at the candidate, after the final source edit:

```text
npm test                     362 pass / 0 fail   exit 0   631.1 s
npm run typecheck            exit 0
npm run build                exit 0
npm run test:business        1 pass / 0 fail     exit 0
npm run test:dc-replacement  1 pass / 0 fail     exit 0
git diff --check             exit 0
```

`npm test` grew 350 -> 362 across this milestone; the added tests are the pagination, list/diff and
security regressions described above. No test was weakened, skipped or excluded, and the PowerShell
`PSModulePath` contamination fixed in `7d85395` did not reappear.

The full suite was re-run after the last source change. An earlier run that overlapped an edit to
`src/cli.ts` was discarded rather than reported, because a suite that spans two versions of the code
proves nothing.

### Gate 11 — secret scan

```text
gitleaks 8.30.1
range    7d85395..dbfa4ba
commits  4
scanned  ~198409 bytes (198.41 KB)
findings 0
exit     0
```

No owner token, operator credential, machine-specific config path, provider credential or user data
is committed. The operator bootstrap token is written at runtime to `<statePath>.operator-url`, which
lives outside the repository and is removed on shutdown.

### Gate 12 — diff and reviewability

Four coherent commits, each green on its own terms:

```text
171d87b docs: decide WAG DC replacement v1 surface and acceptance
b9dfad3 feat: complete the DC repository-engineering loop on private stdio
3240bd8 fix: read whole files past the executor's first page
dbfa4ba feat: complete bounded repository inspection and harden it
```

`git diff --check` is clean and the working tree holds only this receipt. Every production behavior
change is covered by a test added in the same commit. No dependency was added, removed or upgraded;
`package.json` gained one script.

## Workflow coverage against the 2026-09-17 measurement

| Scenario | DC 0.2.50 (2026-09-17, Layer B) | WAG private stdio before | WAG private stdio now (Layer A, built artifact) |
| --- | --- | --- | --- |
| R0 | COMPLETE | available | COMPLETE |
| R1 | COMPLETE | **absent** | COMPLETE via `repo.search` |
| R2 | COMPLETE | available | COMPLETE |
| V1 | COMPLETE | available | COMPLETE, baseline oracle exact |
| C1 | COMPLETE | **unreachable** | COMPLETE behind one real local approval |
| D1 | COMPLETE | **unreachable** | COMPLETE as a composed loop |

DC needed two failed shell calls for C1 and two failed mutation calls for D1 in the 2026-09-17 reference run. The WAG
path needed none, because the change is expressed as a bounded before/after replacement rather than shell quoting.

## Authority comparison

WAG remains strictly narrower than the surface it replaces, and that is the point of the replacement claim.

```text
                                  DC 0.2.51 (documented)     WAG private stdio (extended)
arbitrary shell / commands        yes                        no
interactive process sessions      yes                        no
process list / terminate          yes                        no
file create / move / delete       yes                        no
directory create / list           yes                        no
full-file rewrite                 yes                        no (bounded before/after only)
Git writes                        via shell                  no
runtime config mutation           yes (set_config_value)     no
filesystem scope                  guardrail, shell escapes   enforced allowedRoots
write approval                    provider prompt only       mandatory local operator approval
```

Upstream states its own controls are "safety guardrails that reduce accidental or unintended actions, not a security
sandbox", and that `allowedDirectories` "only restricts filesystem operations, not terminal commands". Current OpenAI
documentation states that "it is possible for write actions to occur even if the MCP server has tagged the action as
read only". WAG's local operator approval is therefore the only write boundary actually enforced on this machine.

## Independent security review

An independent reviewer examined the whole `7d85395..working tree` diff against a hostile-caller and
hostile-repository threat model, with no authority to change the source. It found no command
injection, no path escape, no route to a write without local approval and no approval replay, and
confirmed the browser surfaces were untouched. Four findings were actioned before this receipt:

| Finding | Disposition |
| --- | --- |
| Status-line strip was unanchored at the start; a file named `Process exited with code 0.txt` silently emptied a `repo.list` result with `truncated: false` | Fixed — strip removed as both harmful and dead; regression test with that exact file name |
| `repo.diff` returned bodies of path-policy-sensitive files (`.env`, `.npmrc`) that every other tool withholds | Fixed — per-file sections withheld by the same policy, and withholding sets `truncated`; regression test |
| Single-use operator bootstrap token written to stderr, which the remote-facing tunnel client inherits and may forward | Fixed — only the origin is announced; the token goes to `<statePath>.operator-url`, removed on shutdown |
| A supplied path normalizing to nothing (`/`, `\\`, `.//`) fell through to the whole-workspace branch | Fixed — refused; regression test |

Two hardening items were taken although the reviewer judged them not currently exploitable: both new
tools now apply the same realpath confinement `file.read` applies instead of relying on git's symlink
behaviour, and paths reach git as `:(literal)` pathspecs so wildmatch cannot expand a prefix.

Findings left open deliberately, all informational: `doctor` creates the state database as a side
effect before closing it; `workspace.open` inserts a durable row per call with no reaping, which is a
disk-growth question rather than an authority one; and `mutation.result` accepts an unconstrained id
string where `verify.result` uses a shape regex — cosmetic, since `assertIdentity` gates access.

## Contract change worth stating plainly

Commit `3240bd8` changed `file.read` on **all three** surfaces, including Browser Inspect v2 and
Browser Verify v3, which this milestone otherwise leaves untouched. A file longer than one executor
page now returns complete instead of returning page one with a continuation footer glued on as
content, and a file over 64 KiB now errors instead of silently returning a partial read. Both are
strictly more correct, and the 64 KiB ceiling was already the documented contract — but it is a
behaviour change visible to a v2/v3 client and is recorded here rather than left to be discovered.

## Decision

```text
WAG_DC_REPLACEMENT_V1_LOCAL = PASS
WAG_PRIMARY_REPOSITORY_ENGINEERING_OPERATOR_LOCAL = ACCEPTED
TIER_R_LOCAL = R0 + R1 + R2 complete on the built production stdio path
TIER_V_LOCAL = V1 complete on the built production stdio path
TIER_C_LOCAL = C1 complete with one real local operator approval over loopback HTTP
TIER_D_LOCAL = D1 complete as a composed loop
```

On this machine, with the extended profile configured, WAG can navigate, search, read, inspect
state, verify, propose a reviewed change, obtain a real local approval, apply exactly one write and
review the resulting diff — without Desktop Commander, without a shell, and without arbitrary argv.

This is Layer A production evidence under the benchmark contract. It does not establish that
ChatGPT Web replaced Remote Desktop Commander; that requires Layer B, which is out of scope here.

## Addendum — reviewed file creation (`c7d1991`)

After the acceptance above, one further gap was closed, because a session that cannot create a file
still depends on another tool for ordinary work. ADR-0022 adds `file.create` as a mutation whose
base is the empty file, which needs no store migration and no change to the state machine.

Re-run at `c7d1991`:

```text
npm test                     373 pass / 0 fail   exit 0   369.8 s
npm run typecheck            exit 0
npm run build                exit 0
npm run test:business        1 pass / 0 fail     exit 0
npm run test:dc-replacement  1 pass / 0 fail     exit 0
git diff --check             exit 0
```

The production-local run now also proposes a new test file, approves it over the real loopback
operator server, and re-verifies: the suite goes from 2 tests to 3 passing, proving the created file
landed usable rather than merely present. Final residue is exactly
`M src/lib/ticket-id.js` plus `?? test/ticket-id.extra.test.js`, from two separate approvals.

Creation-specific negative evidence: proposing over an existing path is refused; a path that appears
between proposal and approval is refused at execution with the pre-existing content intact; an empty
file is refused; `.env`, `.git/…`, traversal, absolute and Windows-reserved targets are refused; and
a symlinked parent directory cannot place a file outside the workspace.

One suite run was discarded during this milestone: a failing assertion left a real DevSpace and a
real loopback server alive, which hung the runner. The stale expectation was fixed, only this
worktree's processes were terminated, and the suite was re-run clean. That trap is now recorded in
`.claude/skills/wag-acceptance-gates/SKILL.md`.

## Residual capability limits

WAG is accepted as the primary repository-engineering operator for the workflows above. It is not a
Desktop Commander replacement for everything DC can do, and the following are genuinely absent:

```text
file deletion / move                 NOT AVAILABLE
directory create / remove            NOT AVAILABLE
git log / blame / branch / worktree  NOT AVAILABLE — only snapshot and working-tree diff
git commit or any Git write          NOT AUTHORIZED
arbitrary argv or shell execution    NOT AVAILABLE — only named verify profiles
background jobs, job ids, caller-    NOT EXPOSED — verify.run is synchronous and bounded, with
visible cancellation                 timeout and interrupt handled inside the gateway
```

A session doing ordinary WAG work can therefore inspect, verify, make reviewed edits and create new
files through WAG alone, but still needs another tool to commit.

## Explicitly still outstanding

```text
BROWSER_VERIFY_APPROVAL_V1_SOURCE            = PASS (unchanged by this milestone)
PRODUCTION_BROWSER_VERIFY                    = NOT_YET_ACCEPTED
BROWSER_EXACT_NATIVE_HOST_CANDIDATE          = NOT_PRODUCED
SUPPORTED_HOST_TIER_R / TIER_V (Layer B)     = NOT_RUN
TIER_C / TIER_D ON ANY BROWSER SURFACE       = FORBIDDEN
REVIEWED_FILE_CREATION                       = ACCEPTED (ADR-0022, c7d1991)
GIT_MUTATION                                 = NOT_AUTHORIZED
PUSH / PR / MERGE / RELEASE / TAG / SIGNING  = NOT_PERFORMED
PROVIDER OR ACCOUNT ACTIONS                  = NOT_PERFORMED
NATIVE_HOST_INSTALL / HKCU_REGISTRATION      = NOT_PERFORMED (not required by this surface)
```
