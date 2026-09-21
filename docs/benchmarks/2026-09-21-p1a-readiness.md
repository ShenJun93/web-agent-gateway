# P1A Option A — readiness, evidence, and the task set

Date: 2026-09-21
Status: **READY, STOPPED AT THE RUN BOUNDARY.** No human gesture has been made and none was simulated.
Canonical main read: `5d18812b88d0021bb705f522324b7f435a21a90b`
Local HEAD at capture: `122a194`
Spec: `docs/superpowers/specs/2026-09-21-p1-chatgpt-wag-direct-access-v1.md`

## Scope actually in force

```text
P1A_OPTION            = A, shipped v4 browser surface
GOAL_LEASE            = OFF        (verified: zero gateway.goalLease lines)
MUTATION_INVOCATION   = FORBIDDEN
GIT_WRITE             = FORBIDDEN
OPERATOR_APPROVE      = NOT USED
DESKTOP_COMMANDER     = not used
RUN                   = the measured human gesture, not yet made
```

## The tool inventory, measured rather than read

A source-read gave the wrong answer first: counting `registerTool` calls produced **11**, and the
surface is **12**. `verify.result` is registered in a branch the grep window missed. The count
below comes from a real MCP `tools/list` against the built artifact
(`npm run p1a:tools`), and was reconciled against canonical main's own pinned list — identical,
no extras, nothing missing.

| | tools |
| --- | --- |
| Permitted for P1A (7) | `health` `workspace.open` `repo.search` `repo.snapshot` `file.read` `verify.preview` `verify.result` |
| Present but forbidden (5) | `mutation.preview` `file.create` `mutation.result` `git.commit` `git.commit.result` |
| Unclassified | none |

The inventory tool is built so it cannot cheat: the coordinators it hands the server throw on
every call, and it exits non-zero if any tool on the surface is classified by neither list —
because P1A's whole claim is that it knows what it did *not* call.

## Documentation divergence, recorded as such

The spec's prose lists a **five**-tool read surface. The accepted read/verify surface is
**seven**: the five plus `verify.preview` and `verify.result`, which the same spec separately
permits ("use only the already accepted browser verification proposal/result path"). This is a
documentation divergence, not an implementation blocker, and it is recorded rather than resolved.

## Environment findings

### 1. Computer-use cannot observe on this machine — blank capture

Instructed to use computer-use as the primary observer, it returns a uniformly blank frame. This
is not a permissions or display problem; the surrounding facts were measured:

```text
Edge grant      granted, tier "read"; Edge not among the masked applications
P1A window      pid 57420 · handle 3871836 · IsWindowVisible=True · IsIconic=False
                rect L=10 T=10 R=1060 B=806 — real, on-screen, not minimized
display         one monitor, 1536x864, primary
session         console, PACMAP, Active
foreground      an Edge window, i.e. a granted app was frontmost
screenshot      blank at 0.5 and 0.6 scale, three attempts
```

A granted, visible, foreground application capturing as empty means the screenshot pipeline is
not delivering pixels here. Structured observation through the narrow Playwright lane was used
instead, with the operator's authorization.

### 2. A side effect caused while diagnosing it

`open_application "Microsoft Edge"` resolved to the **operator's own personal Edge** and opened a
new window there, not the task-owned worker — Windows resolves an application, not a window. That
profile is explicitly out of scope: it was not navigated, not read, and not closed (closing needs
a click, correctly denied at read tier). It is reported for the operator to close. `open_application`
was not called again.

### 3. The read-only browser surface has no CLI entry point

Measured, not inferred: `serve-browser-operator` refuses a read-only config
(`BROWSER_OPERATOR_START_FAILED`, nothing bound, no process left) because it requires
`repositoryEngineering.mutation` and `gitCommit`. The v3 read-only adapter
(`startBrowserAdapterRuntime`) exposes exactly P1A's surface but is reachable only from tests, and
the shipped extension speaks v4 only. This is why Option A exists. No v3 path was built.

### 4. Admission happens at the first Run, not before

`native.ensureReady()` is called inside the `panel.execute` handler — the Run path. So the native
host connection, the session correlation, the adapter admission and the workspace record all come
into existence at the first human Run. Nothing further can be prepared on the browser side, which
is why this document stops here.

## Before-state evidence

```text
git    local HEAD 122a194 · canonical main 5d18812b
       src tree 2efc899e68195afc6f7b6181f4bba44bad7c3d11  (identical to canonical main)
       test tree ed554f02b2ad0f539cf602086f66fd786ea030da

production store   mutations 5 · commits 1 · workspaces 13 · adapter_sessions 9 · audit 14
                   states EXPIRED:3, SUCCEEDED:2
                   mutation_authority / commit_authority / goal_leases: no such table
                   (that store was last opened by a runtime built before those tables existed)
p1a store          absent at capture; created by the P1A runtime

fixture            5 files, hashed; src/ticket-id.js 247c0a24a0a58318…
processes          1 task-owned: pinned DevSpace pid 61036
                   0 wag-op-* browsers · 0 native hosts · 0 serve-browser-operator
```

Full JSON: `E:\AI-BROWSER\wag-acceptance\p1a\evidence\state-before.json`.

## Live environment, task-owned

```text
DevSpace              127.0.0.1:7676            pinned, task-owned
P1A operator runtime  admission 127.0.0.1:57655 · operator 127.0.0.1:57654
                      Goal Lease OFF (0 gateway.goalLease lines)
                      store E:\AI-BROWSER\wag-acceptance\p1a\state\p1a-operator.sqlite
browser worker        wag-p1a-1, brand-new profile, OWNER.json written
                      extension loaded via --load-extension, 10 msedge processes
                      one tab: https://chatgpt.com/
extension state       service worker alive (runtimeId present), sees the tab
                      storage keys: none · queue: null · seen: null · correlations: 0
                      native host: 0 — expected, it connects at the first Run
```

The mandatory `playwright-cli list --all --json` probe was run first and returned a parseable
global inventory. `wag-p1a-1` is a brand-new profile; `wag-op-2` belongs to another session and
was never touched; `wag-op-3` was this session's P0 worker and was closed earlier.

## The task set — 12 tasks, all inside the permitted seven

Ordered so that the two snapshots bracket everything, which is what makes "no unexpected
repository effect" measurable rather than asserted.

| id | goal | tools |
| --- | --- | --- |
| t01 | confirm the gateway/executor contract before trusting any result | `health` |
| t02 | open the approved fixture workspace | `workspace.open` |
| t03 | baseline the repository before any work | `repo.snapshot` |
| t04 | find every caller of `ticketId` | `repo.search` |
| t05 | read `src/ticket-id.js` exactly, to see the implementation | `file.read` |
| t06 | find the test covering `ticketId` | `repo.search` |
| t07 | read `ticket-id.test.js` to see what it asserts | `file.read` |
| t08 | read `src/parse-range.js`, an unrelated module, to test bounded reads | `file.read` |
| t09 | search for a term that should match nothing, to see a clean negative | `repo.search` |
| t10 | propose the `unit` verification through the accepted path | `verify.preview` |
| t11 | read the verification outcome | `verify.result` |
| t12 | final snapshot; compare against t03 | `repo.snapshot` |

Plus two friction cases the spec asks for, measured opportunistically rather than forced:
extension reload / reattach, and a service-worker restart, each recorded with whether a manual
repair was needed.

Per task the recorder requires, with no defaults: `taskId`, `goal`, `surface`, `tools`,
`success`, `dcFallback` (+ reason if true), `humanRun`, `humanApprove`, `reconnectNeeded`,
`elapsedMs`, `unexpectedRepair`, identifiers, and any security anomaly.

## What happens next, and what will be proven

The first Run both admits the session and executes t01. After the batch the after-snapshot is
taken and the negative claim is checked by diff, not by assertion:

```text
forbidden-tool invocations      must be 0
mutations delta                 must be 0
mutation_authority delta        must be 0
commits / commit_authority      must be 0
fixture file hashes             must be unchanged
operator Approve                must be 0
```

## What this does not authorize

No push, PR, merge, release, tag, signing, provider or account action. No mutation, no Git write,
no Goal Lease, no operator Approve, and no automated Run.
