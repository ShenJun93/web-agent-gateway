# WAG Local Productization + Desktop Commander Learning Plan v1

Date: 2026-09-30  
Status: PLANNED / SAVED BEFORE IMPLEMENTATION  
Branch at planning time: `feat/remote-effect-bypass-closure-v1`  
Baseline HEAD: `e9ab7ef493b35cae0f86b98d38d14910a6842cc5`

## 1. Purpose

Turn WAG from a powerful project-local system into a product that an external user can install,
understand, recover, update, and use without knowing WAG internals.

Desktop Commander remains the primary comparison product for WebChat -> local workflows, but it is a
benchmark and donor of product/UX lessons, not WAG's implementation foundation or feature checklist.

This plan deliberately separates:

1. **WAG Local productization** — make the current local product reliable and easy to adopt;
2. **Desktop Commander learning** — study mature onboarding, lifecycle, device, document and UX
   patterns and measure them against WAG;
3. **WAG Remote productization** — only after an explicit architecture decision updates the current
   product boundary and the local product is externally usable.

No implementation from this plan should begin before this file is committed.

## 2. Current baseline

As of this plan:

- WAG Local runs in `AUTONOMOUS_LOCAL` mode.
- The live MCP surface exposes 53 tools.
- WAG already has repository, filesystem, bounded command, process, terminal, browser, Git commit,
  bounded remote push, diagnostics and durable-result primitives.
- Local startup is now repository-owned and self-healing:
  - PowerShell 5.1 re-enters PowerShell 7;
  - DevSpace health is checked before tunnel startup;
  - the exact DevSpace pin can be restored if the managed checkout is missing;
  - WAG Local can auto-start at Windows login;
  - local promotion refreshes canonical launcher copies.
- The current accepted WAG mission remains defined by ADR-0018 and later local-automation work.
- ADR-0018 explicitly says Desktop Commander is a benchmark rather than a feature checklist and
  currently lists generic remote administration / multi-device brokering as a non-goal.
- Therefore a commercial multi-device WAG Remote product requires a new explicit architecture
  decision before promotion. This plan does not silently override ADR-0018.

Relevant existing evidence:

- `docs/adr/0018-lock-webchat-local-coding-mission.md`
- `docs/superpowers/specs/2026-09-24-wag-dc-replacement-v2-automation-first.md`
- `docs/benchmarks/2026-09-29-wag-local-self-healing-startup.md`

## 3. Product principles

### 3.1 The user must not need to know WAG internals

The intended user experience is:

```text
install WAG
  -> sign in / connect client
  -> WAG says Ready
  -> use it
```

The user should not need to understand or manually manage:

- DevSpace;
- the exact DevSpace commit;
- WSLENV;
- DPAPI secret files;
- tunnel-client;
- ports 7677 / 8080;
- PowerShell 5.1 vs PowerShell 7;
- runtime wrapper paths;
- promotion receipts.

These remain implementation details.

### 3.2 Reliability before tool-count growth

Do not add a new production tool only because Desktop Commander has one.

A new capability must either:

- close a measured user workflow gap;
- materially reduce onboarding or recovery friction;
- materially improve safety / evidence / debuggability;
- or enable the validated commercial product.

### 3.3 Health must mean executable, not merely connected

Never use one boolean such as `online=true` as the full readiness claim.

WAG should distinguish at least:

```text
ACCOUNT_AUTH_OK
RELAY_CONNECTED
DEVICE_TRANSPORT_OK
LOCAL_AGENT_OK
EXECUTOR_OK
TOOL_ROUNDTRIP_OK
```

A product may show an aggregate state such as Ready, Degraded or Offline, but the underlying layers
must remain separately observable.

### 3.4 Every remote call needs durable correlation

The target remote path is:

```text
request accepted
  -> relay accepted
  -> device received
  -> executor started
  -> local effect/result completed
  -> response returned
```

A request must have a stable opaque request/effect identifier so WAG can say exactly which stage
failed rather than returning only `Session terminated` or a generic timeout.

## 4. Desktop Commander learning program

Research snapshot for this plan: 2026-09-30.

Official references:

- Local project / README:
  https://github.com/wonderwhy-er/DesktopCommanderMCP
- Remote product:
  https://github.com/desktop-commander/remote-desktop-commander
- Remote setup:
  https://github.com/desktop-commander/remote-desktop-commander/blob/main/docs/SETUP.md
- Remote device implementation docs:
  https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/main/src/remote-device/README.md
- Current public pricing page:
  https://desktopcommander.app/pricing/

Reliability failure references to study:

- OAuth reconnect while the device remains healthy:
  https://github.com/desktop-commander/remote-desktop-commander/issues/1
- Accepted tool call not delivered to an otherwise healthy device:
  https://github.com/desktop-commander/remote-desktop-commander/issues/2
- Device can appear online while its local execution child is dead:
  https://github.com/desktop-commander/remote-desktop-commander/issues/4
- Additional false-green device-state / config race report:
  https://github.com/wonderwhy-er/DesktopCommanderMCP/issues/697

### 4.1 Patterns WAG should learn from

Study and benchmark:

1. **Installation UX**
   - one obvious command;
   - automatic client setup where possible;
   - clear update and remove flows;
   - minimal prerequisite knowledge.

2. **Remote pairing UX**
   - browser-assisted OAuth device authorization;
   - a short pairing code visible in both terminal and browser;
   - explicit revoke flow;
   - no secret copy/paste through chat.

3. **Device management**
   - named devices;
   - online/last-seen information;
   - ping;
   - revoke;
   - multiple machines addressed from one account.

4. **Search lifecycle**
   - start search;
   - continue/paginate;
   - stop/cancel;
   - active-search inventory.

5. **Document workflows**
   - Word/Excel/PDF work where the files already live;
   - preserve source files and support in-place edits where practical.

6. **In-memory execution**
   - useful short Python/Node/R workflows without writing scratch files when the authority boundary
     allows it.

7. **Configuration / support**
   - get/set configuration;
   - recent tool activity;
   - usage statistics;
   - feedback path;
   - prompt/workflow library.

8. **Dedicated application UX**
   - visible file previews;
   - change review;
   - context / MCP management;
   - later background jobs and reusable skills.

### 4.2 Patterns WAG should improve on rather than copy

Do not copy:

- ambient broad OS authority as the default product boundary;
- a foreground-only agent that disappears when a terminal closes;
- a single `online` bit that can remain green when execution is dead;
- generic 60-second-style timeouts without delivery/effect correlation;
- connector auth behavior that repeatedly requires manual reconnect without a precise reason;
- feature-count growth that weakens WAG's caller/workspace/effect ownership model.

WAG should preserve its stronger traits:

- caller-owned workspaces;
- path/root validation;
- secret redaction;
- exact-content / exact-HEAD CAS;
- PID identity checks;
- durable effect receipts;
- explicit remote-effect bounds;
- kill-switch revalidation;
- separate browser trust plane;
- diagnostics with stable correlation.

## 5. Roadmap

Implementation order is normative for this plan unless a measured blocker justifies reordering.

---

## M0 — Freeze baseline and define product acceptance

### Objective

Make the current WAG Local state reproducible before adding product layers.

### Tasks

- Record current source HEAD, live runtime HEAD, tool inventory and local launcher hashes.
- Record the exact DevSpace pin and package/toolchain prerequisites.
- Define one machine-readable local product health receipt.
- Define one versioned `WAG_LOCAL_PRODUCT_ACCEPTANCE_V1` checklist.
- Keep all secrets value-free in evidence.

### Acceptance

A fresh reviewer can answer:

- which WAG source is installed;
- which runtime is active;
- which DevSpace revision is active;
- whether WAG is Ready / Degraded / Offline;
- which layer is unhealthy;
- whether the worktree is clean.

No code feature work should be promoted until this baseline receipt exists.

---

## M1 — Cold-start and recovery acceptance

### Objective

Prove WAG recovers without manual PowerShell relay.

### Required failure matrix

Test at least:

1. normal Windows login;
2. WAG tunnel stopped, DevSpace alive;
3. DevSpace stopped, tunnel stopped;
4. exact DevSpace managed checkout deleted;
5. stale WAG launcher PID receipt;
6. stale DevSpace PID receipt;
7. PowerShell 5.1 invocation;
8. PowerShell 7 invocation;
9. WSL temporarily unavailable;
10. tunnel-client missing or non-executable;
11. port 7677 collision by an unrelated process;
12. port 8080 collision by an unrelated process;
13. network offline during startup;
14. network returns after startup failure;
15. connector/account authorization expired while local stack is otherwise healthy.

### Required behavior

For every case WAG must do one of:

- self-recover to Ready;
- remain safely Degraded with an exact reason and repair action;
- fail closed with no duplicate process or hidden authority widening.

It must not:

- loop indefinitely;
- spawn duplicate DevSpace/tunnel processes;
- print credentials;
- delete unrelated processes;
- silently adopt an unexpected listener.

### Acceptance

- destructive cold-start receipt survives reboot;
- Ready is based on an end-to-end executable probe, not only process presence;
- no human shell intervention is required in the success path.

---

## M2 — Installer and onboarding

### Objective

An external Windows user can install WAG without understanding the repository.

### Target UX

Preferred public bootstrap shape:

```text
npx web-agent-gateway setup
```

or an equivalent signed installer if packaging constraints make the npx bootstrap only a thin
installer.

The public bootstrap may remain small while the proprietary/commercial runtime remains closed.

### Installer responsibilities

- prerequisite detection;
- install or clearly explain required prerequisites;
- install canonical WAG launchers;
- install/start the local runtime;
- install the WAG Local login-start entry;
- create local state directories with correct permissions;
- establish required local secret stores without printing secrets;
- connect supported MCP clients where an official supported mechanism exists;
- run first health check;
- print one concise success receipt.

### First-run onboarding

The user should see:

```text
WAG Local
Version: ...
Device: ...
Status: Ready
Client: connected / action required
Doctor: PASS
```

### Acceptance

On a clean supported Windows machine, a non-project contributor can:

1. install WAG;
2. connect one supported AI client;
3. ask it to list/read a local test directory;
4. restart Windows;
5. repeat the task;

without repository knowledge or manual DevSpace/tunnel commands.

---

## M3 — `wag doctor` and self-repair

### Objective

Replace ad hoc debugging with one supported diagnosis surface.

### Required checks

`wag doctor` should report at least:

- WAG version and installed source/runtime identity;
- PowerShell version;
- Node version;
- WSL availability;
- DevSpace pin presence and exact HEAD;
- DevSpace OAuth discovery health;
- tunnel-client presence/version;
- tunnel profile presence;
- WAG local tunnel health;
- connector-facing MCP health where testable;
- stale PID/state files;
- port collisions;
- local launcher drift;
- startup registration state;
- update availability;
- last meaningful failure reason.

### Repair policy

`wag doctor --repair` may automatically repair only bounded known-safe states such as:

- missing canonical launcher copies;
- missing exact DevSpace managed checkout;
- stale WAG-owned PID files;
- stopped WAG-owned services/processes;
- known local config drift with an exact canonical replacement.

It must not:

- overwrite user repositories;
- kill unknown processes;
- rotate credentials without an explicit credential-flow decision;
- modify account/billing/cloud state.

### Acceptance

Every M1 failure case has:

- a stable diagnostic code;
- a human-readable explanation;
- a bounded repair or a precise external action.

---

## M4 — Update, rollback and uninstall

### Objective

Make upgrades safer than manual runtime promotion.

### Update design

Provide channels such as:

- stable;
- beta;
- development/internal.

Each release must carry:

- version;
- source provenance;
- package hashes;
- compatibility floor/ceiling;
- migration version;
- rollback target.

### Update acceptance

An update must:

1. stage without destroying the previous known-good runtime;
2. run local acceptance;
3. switch atomically;
4. verify end-to-end health;
5. roll back automatically when health fails.

### Uninstall acceptance

A supported uninstall must remove:

- WAG runtime/bootstrap files;
- startup registration;
- WAG-owned local state requested by the user;
- WAG-owned DevSpace managed checkout when selected;
- client config entries installed by WAG where safely identifiable.

It must preserve user workspaces and unrelated tools.

---

## M5 — Desktop Commander parity / gap matrix v2

### Objective

Measure product gaps after WAG Local productization instead of guessing them.

### Matrix categories

Compare WAG Local vs current Desktop Commander for:

- setup time;
- number of manual steps;
- restart/reconnect behavior;
- first useful tool call;
- file read/write;
- large-tree search;
- terminal/process lifecycle;
- document workflows;
- binary/media workflows;
- in-memory execution;
- diagnostics;
- update/uninstall;
- client support;
- device management;
- recovery from injected failures;
- secret leakage risk;
- effect/result correlation.

### Output

Create a scored evidence matrix only for engineering measurement. Do not implement a gap simply
because Desktop Commander wins one row.

Each proposed capability must state:

- user workflow blocked;
- evidence;
- existing WAG alternative;
- authority increase;
- implementation cost;
- acceptance test;
- commercial value.

---

## M6 — Selective local capability expansion

### Objective

Add only high-value gaps demonstrated by M5 or beta users.

Candidate families, not pre-approved features:

### A. Search lifecycle

Potential additions:

- search cancel;
- active-search inventory;
- durable/resumable large searches.

### B. Office/document operations

Potential additions:

- DOCX inspect/create/edit;
- XLSX inspect/create/edit;
- richer PDF create/edit.

Prefer well-bounded document-specific operations over generic shell glue.

### C. In-memory execution

Potential bounded execution for short Python/Node/R snippets only if:

- output and runtime are bounded;
- environment/credential inheritance is controlled;
- filesystem/network authority is explicit;
- it solves measured workflows better than existing argv execution.

### D. Product UX APIs

Potential:

- configuration read/update;
- recent activity;
- usage;
- feedback;
- help/prompt/workflow discovery.

### Acceptance

Every promoted capability has a measured workflow, negative tests and no regression of WAG's
authority/effect model.

---

## M7 — WAG Remote architecture decision gate

### Objective

Decide whether and how WAG becomes a hosted remote/multi-device commercial product.

### Mandatory architecture gate

Before multi-device or generic remote administration is promoted, write and accept a new ADR that
explicitly updates the ADR-0018 product boundary.

The ADR must decide:

- account identity;
- device identity;
- pairing flow;
- device revoke;
- per-device keys;
- hosted relay trust boundary;
- transport protocol;
- end-to-end request correlation;
- replay / duplicate suppression;
- exactly-once effect semantics where possible;
- offline/reconnect behavior;
- multi-device routing;
- client/provider neutrality;
- remote pricing/usage accounting boundary;
- what remains free/local;
- what belongs to the paid hosted service.

### Preferred pairing UX to evaluate

A short-code OAuth device authorization flow is the leading UX benchmark because it avoids sending
device credentials through chat.

### Health model

Remote readiness must expose separate layers:

```text
ACCOUNT_AUTH
HOSTED_RELAY
DEVICE_SESSION
DEVICE_TRANSPORT
LOCAL_EXECUTOR
TOOL_ROUNDTRIP
```

The hosted service must never call a device Ready solely because a heartbeat/presence process is
alive.

### Failure acceptance derived from current competitor evidence

Inject and verify:

- connector access-token expiry and refresh;
- relay delivery loss;
- device transport reconnect;
- executor child crash;
- local agent restart;
- duplicate delivery;
- delayed response;
- provider retry;
- concurrent calls;
- device revoked mid-call;
- wrong-device routing attempt.

Every failure returns a stable correlation identifier and stage-specific status.

---

## M8 — Private beta and commercial validation

### Objective

Prove users want the product before expensive hosted expansion.

### Suggested local/free beta gate

Track at minimum:

- successful installs;
- activation rate;
- first useful workflow completion;
- weekly active users;
- repeat workflows;
- recovery rate;
- uninstall reasons;
- support incidents;
- tool families actually used.

### Commercial validation gate

Do not make public-plugin / marketplace submission the primary milestone until there is evidence of
real demand.

The existing commercial direction remains:

```text
Free Local
  -> real users
  -> repeated useful workflows
  -> paid private beta / Remote value
  -> Remote subscription
  -> marketplace/public-plugin expansion
```

Concrete pricing is a later experiment and is not locked by this plan.

---

## M9 — Native WAG desktop experience

### Objective

Only after M1-M8 prove the core product.

Candidate functions:

- Ready / Degraded / Offline status;
- device list;
- file previews;
- diff/change review;
- terminal/process activity;
- recent tool calls;
- durable effects;
- update status;
- doctor/repair;
- account/session management;
- remote device revoke;
- usage/billing view where applicable.

The desktop app should expose WAG state; it must not become a second policy engine.

## 6. What not to do yet

Until the corresponding gates above are satisfied:

- do not add a large batch of new raw tools;
- do not build multi-device routing as an implicit extension of the local plane;
- do not weaken WAG boundaries to match Desktop Commander;
- do not make Azure/VPS/domain spend a prerequisite for WAG Local validation;
- do not make public-plugin submission the immediate milestone;
- do not push commercial/private material to a public repository;
- do not claim cold-start reliability until destructive acceptance has actually run.

## 7. Implementation sequence

When implementation begins, use this order:

```text
M0 baseline receipt
  -> M1 cold-start/recovery acceptance
  -> M2 installer/onboarding
  -> M3 doctor/repair
  -> M4 update/rollback/uninstall
  -> M5 DC parity/gap matrix
  -> M6 only measured local feature gaps
  -> M7 remote ADR + prototype
  -> M8 private beta/commercial validation
  -> M9 native desktop UX
```

M0-M4 are the immediate **WAG Local Productization P0** milestone.

## 8. P0 completion definition

WAG Local Productization P0 is complete only when an external Windows user can:

1. install from one supported entry point;
2. receive a clear Ready state;
3. use one supported WebChat/MCP client;
4. complete a real local workflow;
5. reboot and recover automatically;
6. run `wag doctor` and understand failures;
7. update with automatic rollback on failed health;
8. uninstall without damaging user workspaces.

And the project can prove:

- no secret value leaked;
- no unexpected process was killed;
- no unknown listener was adopted;
- no duplicate executor/tunnel remained;
- all important startup failures have stable diagnostic codes;
- repository and installed runtime identities are recorded.

## 9. STOP points

Implementation should stop for explicit review when:

1. M0 acceptance contract is finalized;
2. destructive M1 cold-start/reboot testing is ready;
3. an installer intends to make account/system-wide changes beyond the WAG-owned user scope;
4. a new capability materially expands local authority;
5. the project reaches the M7 remote/multi-device ADR;
6. hosted billing/domain/publication is required;
7. public release or public Git push is proposed.

Local implementation, tests, documentation and local commits between these STOP points may proceed
autonomously under the current WAG local authority model.

## 10. First implementation task after plan approval

Do **not** start by adding tools.

Start with:

```text
M0 + M1
WAG_LOCAL_PRODUCT_ACCEPTANCE_V1
+
destructive cold-start / recovery harness
```

The first implementation receipt should prove that the self-healing startup added on 2026-09-29
works when the existing WAG/DevSpace/tunnel stack is intentionally absent, stale or damaged in the
bounded test cases above.
