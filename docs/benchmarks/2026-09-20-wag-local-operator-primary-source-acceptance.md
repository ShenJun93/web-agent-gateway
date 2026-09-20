# WAG Local Operator PRIMARY — Source and Security Acceptance Receipt

Date: 2026-09-20
Status: PASS — local source and security acceptance only
Candidate: `a421216`
Base: `5246e0e`
Predecessor receipt: `docs/benchmarks/2026-09-20-wag-git-commit-v1-local-acceptance.md`
Decision authority: ADR-0018, ADR-0019, ADR-0023, ADR-0024, ADR-0025, ADR-0026
Research: `docs/research/2026-09-20-wag-git-execution-surface.md`

This is a successor, not an amendment. The predecessor receipt stands as written for `489715b`.

## Scope of this receipt

Source and security acceptance for the first three phases of the PRIMARY-cutover path. It is
**not** a cutover claim. It does not claim, authorize or substitute for:

- any statement that `WAG_LOCAL_OPERATOR = PRIMARY` — that requires the production bootstrap,
  the real production acceptance run, and the fresh-session dogfood that follow this receipt;
- a running installed native host, an HKCU registration, or a loaded browser extension;
- push, PR, merge, release, tag, version change, signing, or native-host publication;
- any provider or account action;
- any Layer B WebChat tier claim.

Under the benchmark contract this is Layer A source evidence.

## Environment

```text
host                = Microsoft Windows 11 Pro 10.0.26200, x64
node                = v24.20.0
npm                 = 12.0.2
git                 = 2.55.0.windows.2
devspace pin        = docs/benchmarks/devspace-pin.json
gitleaks            = 8.30.1
```

## Commits in range

```text
465cda2  docs: decide one git execution policy and record what it is for
966699e  feat: run every git subprocess through one policy
3810ecd  test: bound the proposal object-count assertion instead of pinning it
d5894c6  feat: run verifications through an argv runner with a built environment
b7f8446  feat: bound what a proposal costs and who learns what from it
a421216  feat: add a proposal-only browser operator adapter
```

## What changed

### Phase 1 — the git execution surface is isolated (ADR-0024)

```text
src/safe-git.ts                        one policy, exported twice from one set of constants
src/repository-inspection.ts           all four helpers converted to argv + the policy
src/executor/devspace-git-commit.ts    the commit path rebuilt around plumbing that takes bytes
test/safe-git.test.ts                  14 tests, incl. a wire-validity guard on every helper
```

A hostile repository must not cause WAG to execute a program merely because WAG opens, inspects,
diffs, verifies or commits it. Each of the following was **measured on git 2.55.0.windows.2**
before being defended against, and each has a regression test:

- config-defined hooks (`hook.<n>.command` / `.event`) fire from the repository's own config and
  `core.hooksPath` does **not** stop them — ADR-0023's hook claim was false and is corrected;
- a clean filter executes during `git diff`; `--no-ext-diff` and `--no-textconv` do not stop it;
- a driver name containing `=` escapes a `-c` override entirely, because git splits `-c` on the
  first `=`, so suppression goes through `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`;
- a driver named `__proto__` is dropped by a plain-object accumulator, so every driver map is
  `Object.create(null)`;
- an inherited `GIT_DIR` passes a `--show-toplevel` assertion, so the environment is now built
  upwards from an allowlist rather than filtered downwards.

**Byte fidelity.** `git add` did not commit the reviewed bytes: `text=auto` and
`working-tree-encoding` transformed them while `check-attr filter` reported `unspecified`, so the
filter gate never saw it. The commit path no longer uses `git add`. Content reaches the object
store through `hash-object -w --no-filters --stdin`, WAG performs the end-of-line conversion git
itself would have performed and reports exactly which paths it touched, and an encoding attribute
is refused rather than applied. `looksBinaryToGit` reproduces git's own `convert_is_binary`.

**Previews write nothing.** Planning builds its tree in a scratch object directory reached through
an alternates *file* — the `GIT_ALTERNATE_OBJECT_DIRECTORIES` variable splits on `;` on Windows
and git refuses a quoted value — and the directory is discarded unless the operator approves.
Measured as zero new objects in the repository.

### Phase 2 — verification runs through an argv runner (ADR-0025)

```text
src/verify-runner.ts                   argv, allowlisted environment, tree-reaping cancellation
```

The argv reaches the process directly rather than through a shell. The environment is built
upwards from an allowlist; `NODE_OPTIONS` is excluded by construction because it injects
`--require` into every Node-based run. `.cmd` and `.bat` are invoked through `ComSpec` with
verbatim arguments. Cancellation, abandonment and the deadline all reap the whole process tree.

`taskkill /T /F` was measured reaping a three-deep tree, so **no native dependency was added for
Job Objects**, as the mission required to be proven rather than assumed.

Note recorded rather than claimed away: `sanitizeDevspaceEnvironment` is test-only. In production
WAG does not launch DevSpace, so that guarantee had to move into the verify runner, and did.

### Phase 3 — a proposal-only browser operator adapter (ADR-0026)

```text
src/browser-adapter/protocol-v4.ts     protocol 4, 12-tool union, bounded text
src/browser-adapter/local-link-v4.ts   exact extension origin pin, bounded replay tracking
src/browser-adapter/native-host-v4.ts  the same, host side
src/server.ts                          createBrowserOperatorAdmittedMcpServer
scripts/browser-operator-runtime.ts    the parallel assembly
browser/extension/*-v4.{js,d.ts}       parser, core, native session, worker entry
src/adapter-admission.ts               the v4 identity and its required correlation shape
```

Identity: `browser.chatgpt.native.operator.v4`, protocol 4. Surface:

```text
health  workspace.open  repo.search  repo.snapshot  file.read
verify.preview  verify.result
mutation.preview  file.create  mutation.result
git.commit  git.commit.result
```

`browser.chatgpt.native.verify.v3` and protocol 3 are **frozen**: their files, tool list, adapter
id, protocol revision and tests are unchanged, and the shipped `service-worker.js` still points at
the v3 modules. The successor convention is parallel `-v4` files, never an edit to a frozen one.

ADR-0026 resolves the real tension it inherited. ADR-0019 allowed a proposal only when creating it
"does not execute a process", and a commit preview must run git. The criterion is refined to what
it stood in for — **no durable effect** — which is only honest because Phase 1 stopped previews
writing objects.

## Gates

All run against `a421216`, after the last source edit in the range.

```text
npm test                     444 pass / 0 fail   exit 0   743.9s
npm run typecheck                                exit 0
npm run build                                    exit 0
npm run test:business        1 pass / 0 fail     exit 0
npm run test:dc-replacement  1 pass / 0 fail     exit 0
git diff --check                                 exit 0
gitleaks 8.30.1  5246e0e..a421216  6 commits, 263.15 KB, 0 leaks, exit 0
```

`npm run test:dc-replacement` is production-local: the **built** `dist/cli.js` ran as a real child
process over a real stdio MCP transport, against the real pinned DevSpace and a fresh copy of the
committed fixture, with every approval performed over the real loopback operator HTTP server.

```json
{"acceptance":"WAG_DC_REPLACEMENT_V1_PRODUCTION_LOCAL",
 "fixtureHead":"b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d",
 "baselineExitCode":1,"afterFixExitCode":0,"operatorApprovals":3,
 "commitBranch":"wag-work",
 "commitSha":"ad00da5a65fad11039a8cbbe0247728ae0c0989a",
 "commitParent":"b3ca9b3bbc5da5a1cd8ad46f188905ebaaf53c8d",
 "commitClassHooksFired":false,"backendHookInvocations":18,
 "finalStatus":["MM src/lib/ticket-id.js","D  test/ticket-id.extra.test.js",
                "?? test/ticket-id.extra.test.js","?? unrelated-dirty.txt"]}
```

`backendHookInvocations: 18` is again `post-index-change` and `reference-transaction` fired by the
execution backend's own `openWorkspace`, not by WAG. The attribution test in
`test/git-commit.test.ts` proves that separately.

## Independent security review of the browser operator change

An independent adversarial review was run against the architecture, the final diff, the protocol,
the git execution policy, session isolation and the process/environment policy. Every finding was
reproduced or re-derived here before being acted on; one of my own reproduction probes was invalid
and was discarded rather than counted.

| # | Finding | Disposition |
| --- | --- | --- |
| H1 | Proposal creation was bounded by live *records*, and a proposal that fails while being computed creates none — 300 `git.commit` proposals ran the planner 300 times with the counter at zero | **Fixed.** A per-caller attempt window, charged before any backend work. Regression test. |
| M1 | `mutation.preview` had no live-proposal cap at all, though `git.commit` did | **Fixed.** Eight per caller, as for commits. Regression test. |
| M2 | Author and committer, read from `.git/config` and `~/.gitconfig` — which the path policy makes unreadable through `file.read` and `repo.search` — were returned in the remote preview | **Fixed.** Moved to the local review view only. Regression test asserts the wire projection withholds them. |
| M3 | The mutation review page named a path and not a repository | **Fixed.** Repository rendered and escaped. Regression test. |
| M4 | The side panel actor was a hard-coded literal, and a content script reaches the same message listener | **Fixed.** Derived from the `sender` Chrome fills in. Regression test. |
| M5 | Any caller-chosen correlation was accepted on the adapter that can propose changes, and a correlation is the session key | **Fixed for v4 only.** A server-minted `session_<uuid>` is required. Regression test. |
| L1–L4 | Bounded-text, id-shape, replay-tracking and discovery-content nits | **Fixed.** |

### Two review items deliberately not implemented as written

- The reviewer proposed refusing a second `admit` for a correlation that already has a live token.
  That rebinding **is** the accepted service-worker-restart reconnect path, and the phases that
  follow depend on it. Only the correlation *shape* was pinned instead.
- The shape pin applies to v4 only. v1, v2 and v3 keep their permissive correlation shape, because
  narrowing an accepted contract is not a security fix.

### Negative evidence

- a v3 envelope cannot acquire v4 authority, and a v3 adapter identity fails a v4 handshake;
- `mutation.approve`, `git.commit.approve`, `verify.run`, `job.*`, `repo.list`, `repo.diff`,
  `terminal.exec` and every argv or environment input are unreachable from the page parser and
  refused by the extension core;
- a lookalike origin (`https://chatgpt.com.evil.test`) is not the trusted origin;
- a second browser session that knows a `cmt_` id cannot read the record, reuse the workspace, or
  propose against it;
- the discovery file contains exactly four keys and no operator port, bootstrap path, cookie name,
  CSRF token or backend owner token;
- a well-formed extension id that is not the accepted one is refused by the native host;
- a replayed request id is refused, and the tracked-id set is bounded;
- a refused proposal reaches no backend, measured as zero backend reads across the refusal.

## Residual limitations, stated exactly

```text
the browser operator runtime has not yet been installed, registered or loaded into a browser
the shipped service-worker.js still points at the frozen v3 modules
WAG's process is not network-isolated; approval and process ownership are not a network sandbox
the commits table is not an append-only transition log, and terminal rows are not pruned
the real index still holds the pre-commit tree until the operator refreshes it (ADR-0023)
```

## Acceptance decision

```text
WAG_GIT_EXECUTION_SURFACE_ISOLATED = PASS
WAG_VERIFY_ARGV_RUNNER = PASS
WAG_BROWSER_OPERATOR_V4_SOURCE = PASS
BROWSER_VERIFY_V3 = FROZEN_AND_UNCHANGED
BROWSER_DIRECT_CONSEQUENCE = NONE
INDEPENDENT_SECURITY_REVIEW = COMPLETED_AND_REMEDIATED
NEW_NATIVE_DEPENDENCY = NONE
WAG_LOCAL_OPERATOR_PRIMARY = NOT_YET_CLAIMED
```

Not authorized and not claimed by this receipt: push, PR, merge, remote branch mutation, release,
tag, signing, any provider or account action, any machine-wide change, and any Layer B WebChat
result.
