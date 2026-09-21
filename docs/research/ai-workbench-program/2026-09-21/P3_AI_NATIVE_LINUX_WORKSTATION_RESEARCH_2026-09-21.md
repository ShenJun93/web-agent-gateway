# P3_AI_NATIVE_LINUX_WORKSTATION_RESEARCH_2026-09-21

**Role:** P3 — AI Native Linux Workstation Research Owner  
**Date:** 2026-09-21  
**Canonical future repository:** `E:\Projects\ai-native-linux`  
**Status:** Research complete enough for a bounded prototype decision; no migration decision yet.  
**Final result:** **strong case to prototype Linux**

> This verdict means “build a bounded benchmarkable P3 prototype when it does not delay P1/Windows.” It does **not** mean “migrate now.”

---

## Research labels

- **FACT** — directly supported by a primary/upstream source.
- **INFERENCE** — reasoned consequence of facts; not directly benchmarked here.
- **RECOMMENDATION** — proposed architecture/policy.
- **UNVERIFIED ASSUMPTION** — plausible but not established.
- **EMPIRICAL TEST NEEDED** — must be measured on the target workstation before promotion.

Evidence IDs are intentionally stable so other sessions can cite this report rather than repeat the research.

---

# 1. Executive summary

### Decision

**RECOMMENDATION — strong case to prototype Linux.** The strongest current P3 baseline is:

**Ubuntu 26.04 LTS → systemd transient service/slice per AI session → cgroups v2 for resource/lifecycle control → systemd-native namespace/hardening controls first → optional bubblewrap only where systemd mount layout is insufficient → dedicated persistent browser profile per authenticated session → Playwright-native browser connection → explicit host-owned network/authority brokers → WAG unchanged.**

The case for a prototype is architectural, not yet performance-proven.

Linux provides a unusually composable set of native primitives for the exact workload under study:

1. PID, mount, network, user, IPC and cgroup namespaces isolate process IDs, mount trees, network stacks/ports, identities/capabilities, IPC objects and cgroup views. [LINUX-NS-001, LINUX-USERNS-001]
2. cgroups v2 provide hard memory and PID ceilings, CPU bandwidth controls, accounting, and whole-cgroup termination semantics. [LINUX-CGROUP-001]
3. systemd exposes cgroup resource controls plus filesystem, namespace, capability and syscall hardening on **transient** services/scopes, allowing the session supervisor to create policy-bound runtime units without generating permanent unit files. [SYSTEMD-001, SYSTEMD-002]
4. Linux can make each session’s workspace, PID view, network view, resource budget, terminal and browser profile independently bounded without giving the model local authority.
5. Browser automation support is commercially ordinary on Linux: Playwright’s current official matrix includes Ubuntu 26.04; Chrome and Edge officially support Ubuntu; NVIDIA’s current CUDA 13.4 matrix validates Ubuntu 26.04.1. [BROWSER-PW-001, BROWSER-VENDOR-001, GPU-001]
6. Chromium/Playwright now strongly reinforce the “separate automation profile” design: Playwright forbids concurrent use of one user-data directory, and Chrome 136+ requires a non-default user-data directory for remote debugging of normal Chrome. [BROWSER-PROFILE-001, BROWSER-CHROME-001]

However:

- **FACT:** Windows is not devoid of equivalent mechanisms. Job Objects can enforce process-tree/resource policy and terminate job trees; AppContainer can isolate file/network/process/credentials. [WIN-JOB-001, WIN-APP-001]
- **EMPIRICAL TEST NEEDED:** no current measurement proves Linux uses less RAM/CPU at 1, 5 or 10 sessions on this workload.
- **EMPIRICAL TEST NEEDED:** browser credential/keyring behavior, outer-sandbox compatibility with Chromium’s own sandbox, GPU/headless behavior and per-session network brokering need direct tests.
- **FACT:** Ubuntu restricts unprivileged user namespaces through AppArmor policy, so a naive “just run bubblewrap/rootless namespaces” design can hit policy friction. [UBUNTU-USERNS-001]
- **FACT:** bubblewrap is a low-level toolkit, not a complete security policy, and versions before 0.12.0 are affected by a 2026 sandbox-setup escape advisory. [BWRAP-SEC-001]

Therefore the correct P3 outcome is:

**Prototype Linux, do not migrate to Linux yet.**  
The prototype should exist only to run the shared P2/P3 benchmark and test the unresolved browser/security integration points.

---

# 2. Exact problem being solved

We need to determine whether a mature-Linux-primitives workstation can materially outperform the Windows Workbench for **5–20 concurrent autonomous AI sessions** on:

- process/session isolation;
- filesystem isolation;
- network isolation;
- resource quotas;
- deterministic cleanup;
- crash recovery;
- long-running autonomy;
- browser/profile isolation;
- reproducibility/rollback;
- setup and maintenance burden;
- time-to-productivity.

The problem is **not** “Can Linux run AI agents?” It clearly can.

The decision question is:

> Does Linux provide enough **measurable system-level advantage** over the Windows architecture to justify the migration and maintenance cost for this operator?

### Conservative assumptions

1. The AI/model remains untrusted with respect to local authority.
2. WAG remains the external authority/execution backend and is not redesigned by P3.
3. The workstation is single-user but runs many independently auditable agent/session workloads.
4. Most sessions need terminal/process execution; some need browsers; fewer need persistent authenticated browser profiles.
5. NVIDIA GPU support matters, even if model inference remains primarily cloud-based.
6. Browser automation should retain Chromium’s native sandbox; disabling it is not an acceptable architecture shortcut.
7. P1/Windows remains the production/short-term path while P3 is research/prototype only.

---

# 3. Non-goals

- Designing a new kernel, container runtime, browser, compositor or Linux distribution.
- Replacing WAG or moving consequential authority into the AI control plane.
- Auto-clicking browser/OS security controls.
- Giving the model root, passwordless broad `sudo`, unrestricted container daemon control, or unrestricted namespace/network administration.
- Building Kubernetes or a multi-node cluster.
- Treating “immutable” as inherently superior regardless of browser/tool compatibility.
- Using full containers for every session merely because containers exist.
- Migrating the workstation before apples-to-apples evidence exists.
- Optimizing for maximal theoretical sandboxing while making browser/login workflows unusable.
- Claiming “lightweight” without measurements.

---

# 4. Current platform facts

## 4.1 Linux namespaces

**FACT — LINUX-NS-001.** Current Linux man-pages 6.19 document that namespaces isolate:

| Namespace | Session-relevant isolation |
|---|---|
| PID | process ID number space |
| mount | visible mount tree |
| network | devices, stacks, routes, firewall rules, ports and related network state |
| user | UID/GID mapping, capabilities and related security identity |
| IPC | System V IPC and POSIX message queues |
| cgroup | cgroup root/view |
| UTS | hostname/domain identity |

Source: Linux man-pages `namespaces(7)`, obtained 2026-09-09.

**FACT — LINUX-USERNS-001.** A process can be UID 0 inside a user namespace while remaining unprivileged outside it. This is the foundation for rootless use of many container/sandbox primitives; it is not equivalent to host root.

**FACT.** Mount namespaces allow distinct per-session filesystem views. Network namespaces isolate network devices/stacks/routes/ports and also the abstract UNIX-domain socket namespace. PID namespaces provide independent PID numbering, with PID 1 semantics inside a new namespace.

**INFERENCE.** These primitives map unusually cleanly onto the requested session identity model: workspace mount + process tree + network plane + audit identity can be established before agent code starts.

## 4.2 cgroups v2

**FACT — LINUX-CGROUP-001.** cgroups v2 provides native controls directly relevant to autonomous sessions:

- `memory.high` for throttling/reclaim pressure;
- `memory.max` as a hard memory limit;
- `pids.max` as a hard task/process limit;
- CPU bandwidth controls (`cpu.max`);
- hierarchical accounting;
- cgroup-level OOM behavior;
- whole-cgroup lifecycle operations including `cgroup.kill`.

**INFERENCE.** A session supervisor can enforce “this session may use at most X RAM / Y tasks / Z CPU” without relying on cooperative agent behavior.

**Important comparison:** Windows Job Objects already provide process limits, memory/resource constraints, CPU controls and process-tree termination. Linux’s advantage is therefore not merely “resource quotas exist”; the hypothesis is that **cgroups + namespaces + systemd policy compose more naturally as one per-session unit**. That hypothesis must be benchmarked operationally. [WIN-JOB-001]

## 4.3 systemd scopes, services and slices

**FACT — SYSTEMD-001.** systemd maps services/scopes/slices onto the cgroup hierarchy:

- `.service`: systemd starts and owns the process workload.
- `.scope`: systemd adopts an already-started workload; scopes are transient.
- `.slice`: hierarchy node used to organize resource policy.

**FACT — SYSTEMD-002.** Current systemd transient-unit interfaces expose resource controls including `MemoryHigh`, `MemoryMax`, `MemorySwapMax`, `TasksMax`, `CPUWeight`, `CPUQuota`, `AllowedCPUs`, I/O controls, IP allow/deny and more. Execution settings available to transient units include `NoNewPrivileges`, `CapabilityBoundingSet`, `SystemCallFilter`, `PrivateNetwork`, `PrivateUsers`, `ProtectSystem`, `ProtectHome`, `ReadWritePaths`, `ReadOnlyPaths`, `InaccessiblePaths`, `BindPaths`, `PrivateTmp`, `PrivateDevices`, `RestrictAddressFamilies` and related controls.

**FACT — SYSTEMD-LIFECYCLE-001.** systemd’s current source defaults an empty `KillMode=` to `control-group`; it explicitly warns that `KillMode=none` is unsafe because it disables process lifecycle management.

**RECOMMENDATION.** Make a **systemd transient service**, not a shell PID, the authoritative lifecycle boundary for each AI session. Put all P3 sessions under an `ai.slice` hierarchy.

This gives the supervisor one standard object for:

- start/stop/restart;
- resource budget;
- descendant accounting;
- audit metadata;
- cleanup;
- policy attachment.

## 4.4 seccomp, capabilities and Landlock

**FACT — SECCOMP-001.** seccomp-BPF filters syscalls and reduces exposed kernel attack surface. Kernel documentation explicitly says seccomp **is not a complete sandbox**. If `fork`/`clone`/`execve` are allowed, descendants inherit the filters.

**FACT — CAP-001.** Linux capabilities split traditional root privilege into discrete capabilities. Capability bounding sets constrain capabilities that may be gained across `execve`.

**FACT — LANDLOCK-001.** Current August 2026 kernel documentation describes Landlock as an unprivileged, stackable LSM for restricting ambient filesystem and network rights. It is intended as an additional sandbox layer and can be used by unprivileged processes.

**RECOMMENDATION.**

- `NoNewPrivileges=yes`
- empty/minimal `CapabilityBoundingSet`
- systemd `SystemCallFilter` only after browser compatibility testing
- Landlock as defense-in-depth for workers/tools that can opt into it

Do not deploy an aggressive syscall allowlist first. Chromium already uses a sophisticated multi-process sandbox; an outer seccomp policy can break required browser behavior.

## 4.5 Bubblewrap

**FACT — BWRAP-001.** Bubblewrap creates a new empty mount namespace and can add user, IPC, PID, network and cgroup namespaces plus seccomp restrictions. `--unshare-net` creates a network namespace containing only loopback.

**FACT — BWRAP-SEC-001.** Bubblewrap’s maintainers explicitly state that bubblewrap is a **toolkit**, not a complete sandbox policy. Security depends on the arguments chosen by the caller.

**FACT.** On 2026-08-26, bubblewrap 0.12.0 fixed CVE-2026-87766, a high-severity sandbox-setup symlink traversal issue affecting versions `<0.12.0`. The release also removed setuid mode.

**RECOMMENDATION.** Do **not** make bubblewrap the first architectural layer. systemd can already apply most required namespace, filesystem, resource and lifecycle controls. Use bubblewrap only when P3 needs a filesystem view that is materially easier to express with bwrap.

If used, require:

- `bubblewrap >= 0.12.0`;
- pinned/monitored version;
- centrally generated policy;
- no agent-controlled bwrap argument construction.

## 4.6 Rootless Podman

**FACT — PODMAN-001.** Rootless Podman creates a user namespace and relies on `/etc/subuid` and `/etc/subgid` mappings. Current Podman documentation recommends `fuse-overlayfs`; otherwise rootless storage may fall back to VFS with higher disk/performance cost.

**FACT — PODMAN-NET-001.** `pasta` is the current default rootless networking tool. By default it copies host-facing addressing/routes into the container namespace; this is connectivity, not a deny-by-default egress policy. `--network=none` creates an isolated namespace with no connectivity.

**INFERENCE.** Rootless Podman is attractive where a session must be an OCI image with a reproducible dependency closure. It is not automatically the best default for 5–20 interactive sessions because it may add image/storage/network-helper/process overhead.

**EMPIRICAL TEST NEEDED.** Compare systemd-native sessions vs rootless Podman on:

- startup latency;
- resident memory;
- process count;
- storage growth;
- browser launch;
- cleanup.

## 4.7 UNIX sockets and local IPC

**FACT — IPC-001.** Linux pathname UNIX sockets respect directory/socket filesystem permissions. `SO_PEERCRED` exposes peer PID/UID/GID; `SO_PASSCRED`/`SCM_CREDENTIALS` support credential passing. Abstract UNIX sockets do not have meaningful filesystem permissions and are isolated by network namespaces rather than mount namespaces.

**RECOMMENDATION.** For host-authority IPC, prefer a **pathname UNIX socket in a host-owned runtime directory**, bind-mounted only into the assigned session. Validate peer credentials and protocol-level session/audit identity.

This is a strong fit for the existing security model:

`AI/model → untrusted client → bounded local adapter → existing WAG authority`

No WAG mutation is required if the local adapter simply proxies the existing WAG protocol/API.

## 4.8 PTYs and process lifecycle

**FACT — PTY-001.** Linux UNIX98 pseudoterminals are the standard modern PTY mechanism. A PTY master/slave pair provides the terminal semantics needed for interactive CLI agents.

**FACT.** `setsid()` establishes a new session/process group but does not itself create a complete descendant lifecycle boundary.

**RECOMMENDATION.** Per AI session:

- one PTY pair for interactive terminal semantics;
- one systemd unit/cgroup for authoritative lifecycle;
- never treat PTY/process-group ownership alone as orphan prevention.

The cgroup should remain authoritative even if a child daemonizes, forks or changes process groups.

## 4.9 Browser availability and automation

### Playwright

**FACT — BROWSER-PW-001.** Current Playwright documentation lists these supported Linux distributions for the current toolchain:

- Debian 12 / 13
- Ubuntu 22.04 / 24.04 / 26.04
- x86-64 or arm64

Current docs also list Node.js 22.x, 24.x or 26.x.

**FACT — FEDORA-PW-001.** A June 16, 2026 upstream Playwright feature request for Fedora/RHEL official support was closed as a duplicate of the still-open RHEL/Oracle support request. Its description notes Fedora is outside the official system-requirements matrix and `install-deps` lacks native dnf support.

### Chrome / Edge

**FACT — BROWSER-VENDOR-001.**

Google Chrome officially supports 64-bit Ubuntu 18.04+, Debian 10+, openSUSE 15.5+ and Fedora 39+.

Microsoft Edge’s Linux support page, updated 2026-08-31, lists Ubuntu 18.04+, Debian 10+, openSUSE 15.5+ and Fedora 39+.

Therefore Ubuntu and Fedora have strong branded-browser support. NixOS may run these browsers through packaging/wrappers, but is outside these vendors’ explicit distro lists.

### CDP and Playwright protocol

**FACT — BROWSER-CDP-001.** Playwright documents `connectOverCDP()` as Chromium-only and “significantly lower fidelity” than Playwright’s native protocol connection.

**RECOMMENDATION.** Use Playwright-native launch/connect for P3 when possible. Reserve CDP for interoperability with externally managed Chromium instances, not as the default browser-control architecture.

## 4.10 Browser profile isolation

**FACT — BROWSER-PROFILE-001.** Playwright’s persistent context uses a `userDataDir`; browsers do not allow multiple instances to share the same user-data directory concurrently.

**FACT — BROWSER-CHROME-001.** Since Chrome 136, `--remote-debugging-port` / `--remote-debugging-pipe` are not honored against the default Chrome data directory. Chrome requires a non-standard `--user-data-dir` and recommends a custom automation profile; Chrome for Testing is recommended for automation scenarios.

**RECOMMENDATION.**

- Persistent authenticated autonomous session → dedicated profile directory + dedicated browser process.
- Stateless low-risk automation → ephemeral BrowserContext, potentially pooled.
- Never automate the human’s everyday Chrome/Edge profile.
- Never mount one persistent profile into multiple concurrent sandboxes.

### Browser pool design consequence

A single browser with many Playwright BrowserContexts can reduce process/RAM duplication, but contexts share one browser failure domain. Dedicated browser processes cost more but isolate crashes/profile locks better.

**EMPIRICAL TEST NEEDED.** Benchmark two modes:

1. dedicated browser process per session;
2. shared browser process + isolated ephemeral contexts.

Authenticated sessions should default to mode 1 until evidence supports otherwise.

## 4.11 Browser credentials/session storage

**FACT — BROWSER-CRED-001.** Current Chromium Linux documentation supports GNOME Libsecret, KWallet 4/5/6 and plain-text password storage. Chromium can fall back to `basic` if the selected/autodetected secure store is unavailable; `basic` is plain text.

**SECURITY CONSEQUENCE.** A headless/session sandbox must not assume Chromium secrets are encrypted simply because it is Linux.

**RECOMMENDATION.**

- Explicitly verify keyring backend in the prototype.
- Treat persistent browser profile directories as secrets even when a keyring is used.
- Prefer session cookies/tokens already bound to the assigned profile over copying cookies between profiles.
- Avoid `--password-store=basic` for profiles containing consequential credentials.
- Do not expose keyring or profile paths to sibling sessions.

**EMPIRICAL TEST NEEDED.** Confirm whether the chosen headless/Wayland session can use Libsecret/KWallet non-interactively without weakening isolation.

## 4.12 Wayland, headless and compositor choices

**FACT — WAYLAND-001.** Chromium’s Ozone Linux builds support X11, Wayland and Headless backends. Chromium documents `--ozone-platform=wayland` for Wayland.

**FACT.** Chromium’s documented Ozone “headless” platform is software-rendered and has no GPU support.

**Important limitation:** that statement is about the Ozone headless backend; it does **not** prove every Playwright/Chrome headless mode is GPUless.

**RECOMMENDATION.**

- Default automation: modern browser headless mode, no per-session compositor unless required.
- Headed debugging/session: shared host Wayland desktop or a bounded nested/headless compositor experiment.
- Do not launch one full compositor per AI session by default.

**EMPIRICAL TEST NEEDED.**

Measure:

- headless GPU process behavior;
- GPU acceleration under Wayland;
- headed browser memory with one shared compositor;
- memory/process overhead of one nested compositor per session if that mode is required.

## 4.13 Ubuntu 26.04 LTS

**FACT — UBUNTU-001.** Ubuntu 26.04 LTS was released April 2026. Canonical’s release-cycle page lists standard security maintenance through May 2031, Expanded Security Maintenance through May 2036 and legacy coverage options beyond that.

**FACT — UBUNTU-USERNS-001.** Ubuntu’s current security documentation says AppArmor can deny unprivileged applications the use of user namespaces, and applications requiring them must be explicitly permitted by AppArmor policy.

**FACT — GPU-001.** NVIDIA CUDA 13.4 Update 1’s current Linux installation guide validates Ubuntu 26.04.1 LTS and Fedora 44 on x86-64. NixOS is not in that validated distro table.

**INFERENCE.** Ubuntu 26.04 currently has the best support intersection for this project:

- Playwright official Linux matrix;
- Chrome official Linux matrix;
- Edge official Linux matrix;
- NVIDIA current CUDA validation;
- systemd/cgroups/namespaces;
- long LTS maintenance window.

### Immutable Ubuntu option

**FACT — UBUNTU-CORE-001.** Ubuntu Core 26 is immutable and transactional, but Canonical describes Ubuntu Core primarily for cloud, embedded and IoT/fixed-function deployments.

**RECOMMENDATION.** Do not use Ubuntu Core as the P3 workstation baseline. Its immutability is attractive, but its deployment/package model adds friction irrelevant to this desktop/browser-heavy R&D workload.

For P3, “Ubuntu” means **classic Ubuntu 26.04 LTS**, with reproducible host configuration maintained in the project repository.

## 4.14 Fedora Atomic / Silverblue

**FACT — FEDORA-ATOMIC-001.** Fedora Silverblue 44 is current in 2026. Fedora describes Atomic Desktop updates as atomic, applied on reboot, with a previous deployment kept for rollback. Fedora states each Silverblue version is updated for approximately 13 months.

**FACT.** Podman is a first-class part of the Fedora ecosystem, and NVIDIA CUDA 13.4 currently validates Fedora 44.

**FACT — FEDORA-PW-001.** Playwright still does not list Fedora in the official Linux system-requirements matrix.

**INFERENCE.** Fedora Silverblue has an excellent host rollback story but creates more browser-automation integration risk than Ubuntu for this project. Its faster OS cadence also creates more maintenance events.

## 4.15 NixOS

**FACT — NIXOS-001.** NixOS 26.05 is declaratively configured through Nix expressions. `nixos-rebuild test/switch/boot` creates system generations, and prior generations can be selected or rolled back.

**FACT — NIXOS-LIFECYCLE-001.** NixOS 26.05 was released 2026-05-30 and receives bug/security updates for seven months, through 2026-12-31.

**FACT — NIXOS-PW-001.** The official NixOS wiki documents special handling for Playwright: use packaged Playwright browsers, align Playwright/npm and nixpkgs versions, set `PLAYWRIGHT_BROWSERS_PATH`, and in some examples bypass host validation/override platform metadata.

**INFERENCE.** NixOS offers the best host-configuration reproducibility and generation rollback of the three candidates, but its browser/toolchain integration requires more project-specific ownership. That works against “time-to-productivity” for a browser-heavy solo workstation.

---

# 5. Candidate architectures

## Candidate A — Ubuntu 26.04 LTS + systemd-native per-session sandbox **(leading)**

Concept:

```text
Ubuntu 26.04 LTS host
  ├─ AI control plane (unprivileged orchestration logic)
  ├─ privileged/bounded session supervisor
  │    └─ ai.slice
  │         ├─ ai-session-<id>.service
  │         │    ├─ cgroup v2 CPU/RAM/PID limits
  │         │    ├─ mount/filesystem policy
  │         │    ├─ PID/user/network/IPC isolation as required
  │         │    ├─ PTY
  │         │    ├─ assigned workspace mount
  │         │    ├─ assigned browser profile
  │         │    └─ goal/audit identity
  │         └─ ...
  ├─ browser pool
  │    ├─ dedicated persistent browsers for authenticated sessions
  │    └─ optional shared ephemeral contexts for stateless work
  ├─ network broker
  └─ host-owned WAG adapter → existing WAG
```

Why it leads:

- Uses OS-native lifecycle/resource manager first.
- No container image/storage/network layer unless justified.
- Strong direct mapping to the session model.
- Best current Playwright/vendor/NVIDIA support combination.
- Long LTS maintenance window.
- Easy to instrument through cgroup/systemd APIs.

Unresolved:

- exact user-namespace policy under Ubuntu AppArmor;
- Chromium sandbox interaction with `PrivateUsers`/seccomp;
- online network-namespace egress design;
- credential/keyring integration;
- measured overhead.

## Candidate B — Ubuntu 26.04 + rootless Podman per session

Advantages:

- strong image-level dependency reproducibility;
- explicit rootless user namespace;
- mature container lifecycle;
- easy “network=none” offline mode;
- OCI ecosystem.

Costs/risks:

- image/storage lifecycle;
- `pasta`/network helper behavior;
- extra processes;
- possible FUSE/overlay overhead;
- browser + persistent profile mounts add container-specific complexity;
- systemd already supplies most non-image isolation requirements.

**Position:** keep as a benchmark challenger, not default.

## Candidate C — Fedora Silverblue 44 + systemd/Podman

Advantages:

- atomic host updates/rollback;
- container-focused workflow;
- current NVIDIA/Chrome/Edge support.

Costs/risks:

- Playwright outside official supported distro matrix;
- approximately 13-month Fedora version support cadence;
- more frequent rebases;
- browser dependency integration becomes P3-owned.

**Position:** technically strong, currently loses on browser-automation support and maintenance cadence.

## Candidate D — NixOS 26.05 + systemd/Nix-defined session stack

Advantages:

- strongest declarative host configuration;
- system generations and rollback;
- precise package closure/pinning.

Costs/risks:

- Playwright requires Nix-specific browser/version handling;
- Chrome/Edge/NVIDIA do not list NixOS in their normal supported distro matrices;
- seven-month stable release support for NixOS 26.05;
- higher learning/maintenance burden for a solo operator.

**Position:** attractive for infrastructure reproducibility research, but not the lowest-risk browser workstation.

## Candidate E — Windows P2 baseline

Not a P3 implementation candidate, but mandatory comparator.

Windows already has:

- Job Objects for process/resource accounting and termination;
- AppContainer/Win32 isolation for file/network/process/credential boundaries;
- mature Chrome/Edge/Playwright support.

P3 must beat a well-designed Windows implementation, not a straw-man Windows shell supervisor.

---

# 6. Evidence Ledger

| evidence_id | type | claim | source | source type / authority | date/version | confidence | applies_to | implementation consequence |
|---|---|---|---|---|---|---|---|---|
| LINUX-NS-001 | FACT | Linux namespaces isolate cgroup root, IPC, network, mount, PID, user and related resources. | [namespaces(7)](https://man7.org/linux/man-pages/man7/namespaces.7.html) | upstream Linux man-pages | man-pages 6.19; fetched 2026-09-09 | High | P3, COMMON | Per-session OS isolation is natively expressible. |
| LINUX-USERNS-001 | FACT | A process can be UID 0 inside a user namespace while unprivileged outside. | [user_namespaces(7)](https://man7.org/linux/man-pages/man7/user_namespaces.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3, COMMON | Rootless namespace construction is feasible without host-root identity. |
| LINUX-MOUNT-001 | FACT | Mount namespaces give processes distinct mount hierarchies. | [mount_namespaces(7)](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3 | Mount only assigned workspace/profile into a session. |
| LINUX-NETNS-001 | FACT | Network namespaces isolate devices, stacks, routes, firewall rules, ports and abstract UNIX socket namespace. | [network_namespaces(7)](https://man7.org/linux/man-pages/man7/network_namespaces.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3, COMMON | Strong per-session network boundary is possible. |
| LINUX-IPCNS-001 | FACT | IPC namespaces isolate System V IPC and POSIX message queues and destroy them when namespace ends. | [ipc_namespaces(7)](https://man7.org/linux/man-pages/man7/ipc_namespaces.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3 | IPC cleanup can follow session lifecycle. |
| LINUX-CGROUP-001 | FACT | cgroups v2 supplies hard memory/PID constraints, CPU controls, accounting and workload-level lifecycle control. | [cgroup v2](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html) | Linux kernel docs | current docs checked 2026-09-21 | High | P3, COMMON | Make cgroup the resource accounting/enforcement boundary. |
| SYSTEMD-001 | FACT | systemd services/scopes/slices map workloads into the cgroup tree; transient units are programmatically creatable. | [CGROUP_DELEGATION](https://systemd.io/CGROUP_DELEGATION/) | upstream systemd | current | High | P3 | Session supervisor should create transient units. |
| SYSTEMD-002 | FACT | Transient units expose resource and hardening properties including MemoryMax, TasksMax, CPUQuota, NoNewPrivileges, SystemCallFilter, PrivateNetwork/Users, ProtectSystem/Home and path controls. | [TRANSIENT-SETTINGS](https://systemd.io/TRANSIENT-SETTINGS/) | upstream systemd | current; checked 2026-09-21 | High | P3 | Most session policy can be native systemd. |
| SYSTEMD-LIFECYCLE-001 | FACT | systemd defaults empty KillMode to control-group and warns KillMode=none is unsafe. | [systemd source](https://github.com/systemd/systemd/blob/main/src/core/load-fragment.c) | upstream source | current main | High | P3 | Never use shell PID alone; stop the whole service cgroup. |
| SECCOMP-001 | FACT | seccomp-BPF reduces syscall attack surface but kernel docs say it is not a complete sandbox. | [seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html) | Linux kernel docs | current | High | P3, COMMON | Use only as one layer; do not overclaim. |
| CAP-001 | FACT | Capability bounding sets limit privileges processes can gain across exec. | [capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3 | Drop capabilities by default. |
| LANDLOCK-001 | FACT | Landlock is an unprivileged stackable LSM for restricting ambient filesystem/network access. | [Landlock](https://docs.kernel.org/userspace-api/landlock.html) | Linux kernel docs | Aug 2026 | High | P3, COMMON | Optional in-process defense-in-depth layer. |
| BWRAP-001 | FACT | Bubblewrap can construct mount/user/PID/IPC/network/cgroup namespace sandboxes and seccomp policy. | [bubblewrap README](https://github.com/containers/bubblewrap) | upstream repo | current | High | P3 | Useful optional low-level sandbox builder. |
| BWRAP-SEC-001 | FACT | Bubblewrap is not a complete policy; CVE-2026-87766 affected `<0.12.0` and was fixed in 0.12.0 on 2026-08-26. | [security policy](https://github.com/containers/bubblewrap/security), [advisory](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx) | upstream security advisory | 0.12.0 / 2026-08-26 | High | P3, COMMON | Do not hand policy construction to agents; require patched version. |
| PODMAN-001 | FACT | Rootless Podman uses user namespaces/subuid/subgid; fuse-overlayfs is recommended for rootless storage. | [podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html) | upstream docs | current | High | P3 | OCI sessions are feasible but have a distinct storage stack. |
| PODMAN-NET-001 | FACT | `pasta` is current default rootless networking; `network=none` removes connectivity. | [podman network](https://docs.podman.io/en/latest/markdown/podman-network.1.html), [podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html) | upstream docs | current | High | P3 | Default rootless connectivity is not equivalent to deny-by-default. |
| IPC-001 | FACT | UNIX pathname sockets can use filesystem permissions and peer credential APIs. | [unix(7)](https://man7.org/linux/man-pages/man7/unix.7.html) | upstream Linux man-pages | 6.19 / 2026 | High | P3, WAG, COMMON | Good local boundary for host-owned WAG adapter. |
| PTY-001 | FACT | UNIX98 PTYs are the modern Linux pseudoterminal API. | [pty(7)](https://man7.org/linux/man-pages/man7/pty.7.html) | upstream Linux man-pages | 6.19 / 2026-07-02 | High | P3, COMMON | One PTY per interactive session; cgroup remains lifecycle owner. |
| BROWSER-PW-001 | FACT | Current Playwright supports Debian 12/13 and Ubuntu 22.04/24.04/26.04 on Linux. | [Playwright installation](https://playwright.dev/docs/intro) | official product docs | checked 2026-09-21 | High | P3, COMMON | Ubuntu is lowest-friction P3 browser baseline. |
| BROWSER-CDP-001 | FACT | Playwright says CDP connection is Chromium-only and lower fidelity than Playwright protocol. | [BrowserType](https://playwright.dev/docs/api/class-browsertype) | official product docs | current | High | P3, WAG, COMMON | Do not default to CDP when Playwright-native launch/connect is available. |
| BROWSER-PROFILE-001 | FACT | Persistent Playwright context uses `userDataDir`; multiple browser instances cannot share the same directory. | [BrowserType](https://playwright.dev/docs/api/class-browsertype) | official product docs | current | High | P3, COMMON | One persistent profile per concurrent authenticated browser. |
| BROWSER-CHROME-001 | FACT | Chrome 136+ requires non-default user-data dir for remote-debugging switches and recommends custom automation profiles. | [Chrome developer blog](https://developer.chrome.com/blog/remote-debugging-port) | official product source | Chrome 136 policy | High | P3, COMMON | Never attach automation to the human default profile. |
| BROWSER-CRED-001 | FACT | Chromium Linux can use Libsecret/KWallet or plaintext; it may fall back to basic/plaintext if secure backend unavailable. | [Chromium Linux Password Storage](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/password_storage.md) | upstream source docs | current main | High | P3, COMMON | Keyring operation is a mandatory security spike. |
| WAYLAND-001 | FACT | Chromium Ozone Linux supports X11, Wayland and Headless; Ozone headless backend is software-rendered. | [Ozone overview](https://chromium.googlesource.com/chromium/src/+/main/docs/ozone_overview.md) | upstream Chromium docs | current main | High | P3 | Do not assume headed/compositor or GPU behavior; benchmark. |
| BROWSER-VENDOR-001 | FACT | Chrome and Edge officially support Ubuntu and Fedora families on 64-bit Linux. | [Chrome requirements](https://support.google.com/chrome/answer/95346), [Edge supported OS](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems) | vendor docs | Edge updated 2026-08-31 | High | P3 | Ubuntu/Fedora lower browser vendor-support risk than NixOS. |
| GPU-001 | FACT | CUDA 13.4 Update 1 validates Ubuntu 26.04.1 LTS and Fedora 44; NixOS is not in NVIDIA’s supported distro table. | [CUDA Linux guide](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/) | NVIDIA official docs | CUDA 13.4 Update 1 | High | P3, COMMON | Ubuntu/Fedora reduce NVIDIA integration risk. |
| UBUNTU-001 | FACT | Ubuntu 26.04 LTS has standard maintenance to 2031 and extended options afterward. | [Ubuntu release cycle](https://ubuntu.com/about/release-cycle) | Canonical official | 26.04 LTS | High | P3 | Long host maintenance horizon. |
| UBUNTU-USERNS-001 | FACT | Ubuntu AppArmor can restrict unprivileged user namespaces; required apps must be explicitly allowed. | [Ubuntu AppArmor docs](https://documentation.ubuntu.com/security/security-features/privilege-restriction/apparmor/) | Canonical security docs | updated 2026-03-09 | High | P3 | Rootless bwrap/browser namespace use must be tested/policied. |
| UBUNTU-CORE-001 | FACT | Ubuntu Core 26 is immutable/transactional but positioned for cloud/embedded/IoT/fixed-function deployments. | [Ubuntu Core docs](https://documentation.ubuntu.com/core/) | Canonical official | UC26 / 2026 | High | P3 | Do not pick Core merely for immutability. |
| FEDORA-ATOMIC-001 | FACT | Silverblue 44 has atomic updates/rollback; Fedora says each version is updated ~13 months. | [Fedora Silverblue](https://www.fedoraproject.org/atomic-desktops/silverblue/) | Fedora official | Fedora 44 / 2026 | High | P3 | Strong rollback, higher upgrade cadence. |
| FEDORA-PW-001 | FACT | Fedora is outside Playwright’s current official Linux matrix; 2026 upstream request asks for Fedora/RHEL support. | [Playwright system requirements](https://playwright.dev/docs/intro), [issue #41318](https://github.com/microsoft/playwright/issues/41318) | official docs + upstream issue | 2026-06-16 issue | High | P3 | Browser automation dependency work becomes project-owned. |
| NIXOS-001 | FACT | NixOS has declarative system configuration and generation rollback via `nixos-rebuild`. | [NixOS manual](https://nixos.org/manual/nixos/stable/) | official docs | 26.05 | High | P3 | Strongest host declaration/rollback model among candidates. |
| NIXOS-LIFECYCLE-001 | FACT | NixOS 26.05 receives fixes through 2026-12-31 (7 months). | [26.05 announcement](https://nixos.org/blog/announcements/2026/nixos-2605/) | official project | 2026-05-30 | High | P3 | Requires frequent stable upgrade ownership. |
| NIXOS-PW-001 | FACT | NixOS Playwright setup requires matching packaged browsers/Playwright versions and environment wiring. | [Official NixOS Wiki: Playwright](https://wiki.nixos.org/wiki/Playwright) | official distro wiki | current 2026 | Medium-High | P3 | Extra browser integration/maintenance burden. |
| WIN-JOB-001 | FACT | Windows Job Objects support nested process groups, resource limits and whole-job termination including kill-on-close behavior. | [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs) | Microsoft official | updated 2025/current | High | P2, P3, COMMON | P3 must benchmark against a competent Windows supervisor. |
| WIN-APP-001 | FACT | Windows AppContainer provides file/network/process/credential and related isolation. | [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) | Microsoft official | updated 2025-07-08 | High | P2, P3, COMMON | Linux isolation advantage is composability/operations, not exclusivity. |
| ARCH-P3-001 | RECOMMENDATION | Ubuntu + systemd-native session units should be the first P3 prototype. | synthesis of evidence above | research synthesis | 2026-09-21 | Medium-High | P3 | Build only enough to benchmark this architecture. |
| BENCH-CROSSOS-001 | RECOMMENDATION | Primary memory comparison should use whole-host used-memory delta from a clean baseline; native cgroup/job metrics should be secondary. | cgroup + Windows Job semantics | research synthesis | 2026-09-21 | Medium | P2, P3, COMMON | Avoid comparing non-equivalent OS-specific memory counters as if identical. |

---

# 7. Security implications

## 7.1 Authority boundary

The central rule remains:

```text
model output != local authority
browser page content = untrusted
structured authority > UI automation
UI automation is not authority
```

The session supervisor may be privileged enough to create namespaces/cgroups/network boundaries, but **the model must not control the supervisor’s policy surface directly**.

### Recommended control path

```text
AI session
  │
  ├─ unprivileged PTY/process/browser
  │
  └─ bounded local client
        │
        └─ pathname UNIX socket
              │  peer identity + session/audit ID
              ▼
        host-owned authority adapter
              │
              ▼
        existing WAG API/backend
```

WAG remains unchanged.

## 7.2 Default-deny session policy

For a general-purpose prototype, start with policy classes rather than arbitrary per-agent flags:

### `terminal-offline`

- assigned workspace only;
- no persistent browser;
- isolated network namespace/no egress;
- CPU/RAM/PID caps;
- PTY;
- no device access except minimal `/dev`;
- no host home visibility.

### `web-ephemeral`

- assigned workspace;
- ephemeral browser context/profile;
- explicit web egress;
- no LAN/host service access except approved broker;
- no credential store.

### `web-authenticated`

- dedicated persistent browser profile;
- dedicated browser process;
- explicit web egress;
- profile mounted only into assigned session;
- keyring verified;
- stronger audit requirements.

### `hermetic-oci`

- rootless Podman image;
- only where dependency closure/image reproducibility materially helps.

This keeps agent-selected capability escalation out of the design.

## 7.3 Network isolation

**FACT:** network namespaces can isolate ports/stacks/routes; `PrivateNetwork`/container `network=none` can remove external connectivity.

The hard case is a browser session that needs public Internet while being denied host/LAN access.

**RECOMMENDATION.** Treat egress as a brokered resource.

Required properties:

- session-specific network namespace;
- no direct host loopback access;
- no automatic RFC1918/LAN access;
- explicit DNS path;
- explicit public web egress;
- independent WAG authority path;
- auditable policy.

**EMPIRICAL TEST NEEDED:** choose between:

1. supervisor-created veth + nftables policy;
2. user-mode helper such as pasta with explicit restrictions;
3. a narrow proxy/gateway.

Do not adopt Podman’s default `pasta` behavior as the security policy merely because it is the default.

## 7.4 Filesystem isolation

Session view should be built from explicit mounts:

```text
/opt/ai-runtime        RO
/workspace              RW (assigned project only)
/profile                RW (only authenticated browser session)
/tmp                    private tmpfs
/run/ai/wag.sock        explicit host-authority socket
/home                   absent or minimal synthetic home
```

Host SSH keys, general home directory, password stores, unrelated project trees and other browser profiles should not be visible.

## 7.5 Browser sandbox stacking

Do not use `--no-sandbox`.

Outer sandboxing must be compatible with Chromium’s own user namespace/seccomp/sandbox model. Ubuntu’s AppArmor user-namespace restrictions make this an explicit spike.

Security layers should be:

1. Chromium’s own sandbox;
2. session OS boundary;
3. minimal filesystem view;
4. network policy;
5. cgroup limits;
6. host authority broker.

## 7.6 Credential risk

Persistent browser profiles are secrets.

A session profile should have:

- single concurrent owner;
- restrictive host permissions;
- no sibling mounts;
- no cookie export by default;
- verified encrypted password/key backend;
- wipe/revoke procedure for compromised profile;
- audit identity binding.

---

# 8. Performance implications

No performance conclusion is accepted without measurements.

## 8.1 Likely cost centers

**INFERENCE, not measured:**

1. Chromium renderer/GPU/network processes will likely dominate session memory more than namespaces themselves.
2. Dedicated browser-per-session gives better failure isolation but may be the major 5/10/20-session RAM multiplier.
3. Rootless Podman may add runtime, storage and network-helper overhead relative to systemd-native sessions.
4. One nested compositor per session is likely wasteful unless headed UI is mandatory.
5. systemd-native transient services avoid a separate container image lifecycle and should be the lowest-complexity Linux baseline.

All five require measurement before being treated as fact.

## 8.2 Metrics that matter

### Memory

Primary cross-platform metric:

`host_used_memory_during_test - host_used_memory_clean_baseline`

Why: Linux `memory.current` and Windows Job/process counters do not account for all caches/kernel memory in identical ways. Whole-host delta is more defensible cross-OS.

Secondary:

- Linux cgroup `memory.current`, `memory.peak`;
- per-process RSS/PSS where available;
- Windows P2 equivalent job/process aggregate.

### CPU

- host CPU utilization;
- CPU time/core-seconds consumed by workload;
- p50/p95 active CPU during scripted workload;
- background idle CPU after stabilization.

### Process count

- total host process count delta;
- processes/tasks per session;
- orphan count after stop/crash.

### Startup

Measure timestamps:

`supervisor request → session service active → PTY ready → browser ready → first automation command complete`

### Recovery

- browser process killed;
- agent process killed;
- supervisor restarted;
- session stop during high child-process fanout;
- profile lock recovery.

---

# 9. Architecture decision matrix

Scores below are **research-fit scores**, not benchmark results.  
5 = strongest current fit; 1 = weakest. “?” means performance must be measured.

| Dimension | Ubuntu 26.04 + systemd-native | Ubuntu + rootless Podman | Fedora Silverblue 44 | NixOS 26.05 | Windows P2 baseline |
|---|---:|---:|---:|---:|---:|
| Namespace/isolation composability | 5 | 5 | 5 | 5 | 4 |
| Resource quota model | 5 | 5 | 5 | 5 | 4–5 |
| Deterministic process-tree ownership | 5 | 5 | 5 | 5 | 5 |
| Official Playwright distro support | 5 | 5 | 2 | 2 | 5 |
| Chrome/Edge vendor support | 5 | 5 | 5 | 2–3 | 5 |
| NVIDIA current validated distro | 5 | 5 | 5 | 2 | 5 |
| Host rollback | 3 | 3 | 5 | 5 | 3–4 |
| Declarative host reproducibility | 3–4 | 3–4 | 4 | 5 | 3 |
| Long maintenance horizon | 5 | 5 | 2–3 | 2–3 | 4–5 |
| Browser integration complexity | 5 | 4 | 3 | 2 | 5 |
| Expected per-session overhead | ? likely lowest Linux baseline | ? | ? | ? | ? |
| Solo-operator maintenance burden | 4–5 | 4 | 3 | 2–3 | 5 current familiarity |
| Time-to-productivity | 5 among Linux candidates | 4 | 3 | 2–3 | 5 current |
| Best use | **P3 baseline** | hermetic challenger | rollback-focused challenger | reproducibility challenger | production/P2 comparator |

### Matrix interpretation

Ubuntu does not win because it is aesthetically simpler. It wins the **prototype selection** because it has the fewest unsupported intersections across Playwright, branded browsers, NVIDIA and long-term maintenance while retaining the same Linux kernel/systemd primitives.

---

# 10. Unknowns requiring empirical spikes

1. **Ubuntu AppArmor + user namespaces:** Which systemd/bwrap/Chromium namespace combinations work without broadening user-namespace permissions too far?
2. **Chromium sandbox stacking:** Do `PrivateUsers`, mount restrictions or seccomp filters interfere with Chromium sandbox startup?
3. **Authenticated keyring:** Can an isolated persistent browser profile use Libsecret securely and unattended in the chosen headless/Wayland mode?
4. **Browser GPU path:** Which Chrome/Chromium headless mode actually uses GPU acceleration on the target NVIDIA hardware, and what is the RAM/process impact?
5. **Network egress:** Which implementation gives public-web access while reliably blocking host/LAN access with the least process/CPU overhead?
6. **systemd-native vs Podman overhead:** startup, RAM, CPU, process count and cleanup.
7. **Browser pooling:** dedicated browser process per session vs shared browser + BrowserContexts.
8. **Five/ten-session scaling:** no evidence yet establishes a Linux advantage.
9. **Crash recovery:** profile locks and browser state after forced process death.
10. **GPU contention:** browser GPU-process sharing/VRAM behavior across many sessions.
11. **Filesystem I/O:** whether private overlays/tmpfs materially improve or worsen concurrent coding workloads.
12. **Host reproducibility:** how much of NixOS’s advantage can be captured with a plain Ubuntu manifest/bootstrap plus pinned tool environments.

---

# 11. Minimal benchmark/spike plan

The prototype exists to run this benchmark; no feature work beyond it.

## 11.1 Shared P2/P3 benchmark contract

Use the **same physical workstation** if dual-boot is practical. Otherwise use hardware-identical machines.

Pin:

- browser product/channel/version;
- Playwright version;
- Node/runtime version;
- test repository commit;
- model/client session script;
- WAG endpoint/config;
- browser URLs;
- workspace contents;
- number of tabs;
- credentials/profile class;
- screen/headless mode;
- sampling interval;
- run duration.

Run cold and warm trials.

Minimum repetitions: **5 runs per condition**. Report median and p95 where sample size permits; preserve raw measurements.

## 11.2 Workloads

### W0 — session shell only

- PTY
- workspace
- process supervisor
- no browser

Purpose: isolate session-management overhead.

### W1 — coding/terminal active

Scripted:

- repository scan;
- file reads;
- build/test process;
- child-process fanout;
- controlled CPU burst.

### W2 — stateless browser

- browser launch;
- 3 fixed public pages;
- navigation/DOM reads;
- screenshot/trace;
- no authentication.

### W3 — authenticated persistent browser

- dedicated profile;
- fixed authenticated test account where permissible;
- repeated navigation;
- browser restart and profile reuse.

### W4 — mixed autonomous session

- terminal + browser + WAG client;
- repeated for 1, 5 and 10 concurrent sessions.

20 sessions are an optional stress ceiling after 10 is stable.

## 11.3 Mandatory comparison dimensions

| Dimension | Measurement |
|---|---|
| one-session RAM | whole-host baseline delta + per-session native counter |
| five-session RAM | same |
| ten-session RAM | measured preferred; projection only if hard capacity limit is documented |
| idle CPU | stabilized host CPU after all sessions ready |
| active CPU | scripted W1/W4 core-seconds + p50/p95 utilization |
| process cleanup | orphan processes/sockets/profile locks after 100 stop/crash cycles |
| browser crash recovery | time + failure rate after forced browser termination |
| session isolation | sibling PID/workspace/socket visibility tests |
| filesystem isolation | attempted read/write outside assigned mounts |
| network isolation | host loopback/LAN/RFC1918/public Internet matrix |
| resource quotas | deliberate RAM/CPU/PID pressure, verify enforcement |
| reproducibility | clean-host bootstrap and version drift check |
| setup/maintenance cost | operator steps, exceptions, update interventions |
| time-to-productivity | clean install → first successful W4 benchmark |

## 11.4 Cleanup test

For each platform:

1. start session;
2. spawn process tree;
3. include detached/grandchild process;
4. start browser;
5. open profile/socket/files;
6. stop session through supervisor;
7. verify no descendants;
8. verify no profile lock;
9. verify socket cleanup;
10. repeat 100 cycles.

Pass criterion:

**0 surviving task-owned processes after the bounded cleanup window.**

Do not “fix” survivors with a global process killer; that would invalidate ownership semantics.

## 11.5 Isolation test

From session A attempt:

- read session B workspace;
- write session B workspace;
- inspect B’s process details;
- connect to B’s local service;
- connect to host-only service;
- access host SSH/private key path;
- access B browser profile;
- access public Internet in offline mode;
- access LAN in web mode.

Expected: all forbidden paths fail by kernel/OS policy, not application convention.

## 11.6 Resource stress

Per session:

- CPU quota stress;
- memory pressure to `MemoryHigh`;
- memory pressure to `MemoryMax`;
- PID/fork stress to `TasksMax`/`pids.max`.

Verify sibling sessions and host control plane remain responsive.

## 11.7 Recommended migration gate

This is a **RECOMMENDATION**, not a measured result.

Do not consider Linux migration unless P3 meets all security/reliability gates and shows at least one **material operational win**, such as:

- **≥20% lower whole-host RAM delta at 5 or 10 equivalent mixed sessions**, or
- **≥25% greater stable session density at the same RAM budget**, or
- a major reliability gain that Windows P2 cannot match (for example deterministic cleanup/recovery under the agreed tests),

while:

- active CPU is not materially worse;
- browser compatibility is not degraded;
- setup/maintenance burden is acceptable for one operator;
- WAG authority boundaries remain unchanged.

The 20%/25% thresholds are decision thresholds chosen to justify migration cost, not claims about expected Linux performance.

---

# 12. Recommended architecture / current leading candidate

## Current leading candidate

**Ubuntu 26.04 LTS + systemd-native session services + cgroups v2 + native systemd sandboxing.**

### Layering order

Follow the minimum-mechanism principle:

```text
1. systemd service/slice lifecycle
2. cgroup v2 quotas/accounting
3. systemd filesystem/network/user namespace controls
4. capability drop + NoNewPrivileges
5. browser's own sandbox
6. optional Landlock
7. optional bubblewrap only for filesystem layouts systemd cannot express cleanly
8. rootless Podman only for explicitly hermetic OCI workloads
```

### Conceptual session specification

Not implementation code; protocol sketch only:

```yaml
session_id: s-20260921-001
goal_id: g-...
audit_id: a-...
policy_class: web-authenticated

workspace:
  host_path: /srv/ai/workspaces/project-x
  mode: rw

browser:
  mode: dedicated-persistent
  profile: /srv/ai/profiles/s-20260921-001

resources:
  memory_max: <benchmark-selected>
  tasks_max: <benchmark-selected>
  cpu_quota: <benchmark-selected>

network:  mode: public-web-brokered
  host_lan: deny
  host_loopback: deny

authority:
  wag_socket: /run/ai/s-20260921-001/wag.sock
```

Supervisor translates this **validated schema** into OS policy. The model does not submit raw systemd/bwrap/Podman arguments.

### Minimal WAG interface requirement

**No WAG mutation is required for the prototype.**

The Linux side needs only a host-owned adapter that can:

1. accept a local authenticated session request;
2. bind the request to `session_id` + `audit_id`;
3. forward the already-supported WAG operation;
4. return structured result;
5. write auditable logs.

If a future WAG change is unavoidable, the smallest requirement is a stable local transport/authentication interface; do not move sandbox policy into WAG.

---

# 13. Reasons alternatives lost

## Fedora Silverblue lost the baseline slot

Not because Atomic is weak.

It loses because:

- Playwright does not officially support Fedora in the current distro matrix;
- browser automation dependency ownership moves onto P3;
- Fedora’s ~13-month release cadence means more host rebases than Ubuntu LTS;
- Ubuntu already provides the same kernel/systemd primitives.

Silverblue remains a useful later challenger if host rollback becomes a dominant operational problem.

## NixOS lost the baseline slot

Not because reproducibility is unimportant.

It loses because:

- browser automation has Nix-specific packaging/version coupling;
- branded browser/vendor/CUDA support is less directly aligned;
- current stable release support is seven months;
- the operator would own more integration complexity;
- most desired runtime isolation still comes from the same Linux kernel/systemd primitives.

NixOS should be revisited only if reproducibility failures on Ubuntu become materially costly.

## Rootless Podman-everywhere lost

It loses as default because the target unit is an **interactive AI session**, not primarily a deployable service image.

Podman remains valuable when:

- exact OCI dependency closure matters;
- the workload needs a foreign userspace;
- image portability is worth runtime/storage/network complexity.

For ordinary local coding/browser sessions, systemd-native isolation should be measured first.

## Bubblewrap-everywhere lost

Bubblewrap is intentionally low-level and policy-neutral. Current 2026 security history reinforces that versioning/policy need active ownership.

Use it as a tool, not as the architecture.

## Ubuntu Core lost

It provides immutability/transactional recovery, but Canonical’s current positioning is embedded/IoT/cloud/fixed-function. The browser-heavy workstation would pay packaging/integration cost without clear P3 benefit.

## Immediate Linux migration lost

There are no 1/5/10-session measurements yet. Architecture alone justifies a prototype, not a migration.

---

# 14. Near-term implementation consequences

No large implementation should begin.

The next implementation owner should create only a **benchmark scaffold** with these properties:

1. **One Ubuntu 26.04.1 LTS test installation.**
2. **One transient systemd session launcher** supporting:
   - unit identity;
   - cgroup memory/task/CPU controls;
   - PTY;
   - explicit workspace;
   - deterministic stop.
3. Add hardening one class at a time:
   - private tmp;
   - protected host filesystem;
   - explicit workspace bind;
   - no-new-privileges;
   - network-off mode;
   - user namespace mode.
4. Launch Playwright/Chromium **without disabling its own sandbox**.
5. Add dedicated persistent automation profile.
6. Verify keyring backend.
7. Add browser kill/restart test.
8. Add WAG local adapter transport without modifying WAG.
9. Run W0–W4 at 1 and 5 sessions.
10. Only then run 10 sessions and compare with P2.

### Do not implement yet

- GUI control center;
- new browser;
- custom compositor;
- custom container runtime;
- orchestration cluster;
- full immutable image;
- automatic policy generator from model text;
- network broker beyond what benchmark requires;
- NixOS production configuration.

---

# 15. Reusable findings for the other projects

## COMMON

1. **Lifecycle ownership should be an OS grouping primitive, not a remembered PID.** On Linux that is a cgroup/systemd unit; on Windows it is naturally a Job Object. [SYSTEMD-LIFECYCLE-001, WIN-JOB-001]
2. **Persistent browser profiles are single-owner concurrent resources.** Do not share one user-data directory across simultaneous browser instances. [BROWSER-PROFILE-001]
3. **Chrome’s default human profile should not be an automation target.** Chrome 136+ actively enforces separation for remote debugging. [BROWSER-CHROME-001]
4. **CDP is an interoperability path, not Playwright’s highest-fidelity control channel.** [BROWSER-CDP-001]
5. **A sandbox primitive is not a policy.** This is explicit in both seccomp and bubblewrap documentation. [SECCOMP-001, BWRAP-SEC-001]
6. **Cross-platform memory comparisons need a common metric.** Whole-host baseline delta is safer as the primary metric than comparing cgroup memory with Windows process counters directly. [BENCH-CROSSOS-001]

## P1 / P2

- Do not under-design Windows on the assumption Linux alone can own process trees. Job Objects should be the Windows comparison baseline.
- AppContainer/Win32 isolation deserves consideration for untrusted helper processes if P2 can integrate it without breaking browser/tool compatibility.
- P2 should implement the same session/audit identity and benchmark schema so results are comparable.

## WAG

- WAG does not need to become a sandbox orchestrator.
- A small local transport adapter can preserve explicit authority while allowing sessions to be network-isolated.
- A pathname local IPC endpoint with OS peer identity is a reusable pattern for authority adapters.

---

# 16. Open questions

1. Does Ubuntu 26.04’s AppArmor user-namespace policy require a specific profile for the intended systemd/bwrap/browser combination?
2. Can `PrivateUsers` coexist cleanly with Chromium’s own sandbox?
3. Which systemd hardening settings can be enabled without reducing Playwright fidelity?
4. Is a dedicated browser process per authenticated session affordable at 10 concurrent sessions?
5. Can stateless sessions safely share one Chromium process using BrowserContexts and still meet crash-isolation goals?
6. What browser profile/keyring arrangement works unattended without plaintext fallback?
7. Which network broker is lowest overhead while preventing host/LAN access?
8. Does browser GPU acceleration reduce CPU enough to justify the added GPU-process/VRAM complexity?
9. How much RAM/process overhead does Podman+pasta add compared with systemd-native sessions?
10. Can Ubuntu host reproducibility be made sufficiently strong with a repository manifest + pinned tooling, avoiding NixOS host complexity?
11. How do Windows P2 Job Object/AppContainer implementations score under the exact same cleanup/isolation tests?
12. Does Linux actually improve 10-session time-to-productivity after counting setup and maintenance?

---

# 17. Handoff capsule

## 10 most important confirmed facts

1. Linux natively exposes PID, mount, network, user, IPC and cgroup namespaces. [LINUX-NS-001]
2. cgroups v2 can enforce memory, PID and CPU policy at workload level. [LINUX-CGROUP-001]
3. systemd can create transient services/scopes/slices and apply cgroup policy programmatically. [SYSTEMD-001, SYSTEMD-002]
4. systemd-native hardening already covers many requirements otherwise delegated to a container wrapper. [SYSTEMD-002]
5. Bubblewrap is policy-neutral, and `<0.12.0` has a 2026 high-severity sandbox-setup advisory. [BWRAP-SEC-001]
6. Playwright currently officially supports Ubuntu 26.04, but not Fedora/NixOS in its published Linux matrix. [BROWSER-PW-001, FEDORA-PW-001]
7. Chrome/Edge officially support Ubuntu and Fedora; CUDA 13.4 validates Ubuntu 26.04.1 and Fedora 44. [BROWSER-VENDOR-001, GPU-001]
8. Persistent Playwright browser profiles cannot be shared concurrently; Chrome also requires separate automation profile handling for remote debugging. [BROWSER-PROFILE-001, BROWSER-CHROME-001]
9. Chromium on Linux can fall back to plaintext password storage if secure keyring backend is unavailable. [BROWSER-CRED-001]
10. Windows Job Objects and AppContainer are real comparators; Linux must win through measurable composability/operations/performance, not a false claim that Windows lacks isolation. [WIN-JOB-001, WIN-APP-001]

## 5 remaining uncertainties

1. 1/5/10-session RAM and CPU comparison versus P2.
2. Browser sandbox + Ubuntu AppArmor/user-namespace compatibility.
3. Secure unattended keyring/profile operation.
4. Best isolated public-web egress design.
5. Dedicated-browser vs pooled-browser scaling and crash behavior.

## Recommended next action

**Build a bounded Ubuntu 26.04.1 P3 benchmark prototype only after/alongside P1 without delaying it.** Implement only enough of Candidate A to execute W0–W4, then run the shared P2/P3 benchmark.

Do not expand into a full Linux workstation product before the benchmark.

## Exact artifacts another session should consume

1. This report: `P3_AI_NATIVE_LINUX_WORKSTATION_RESEARCH_2026-09-21.md`
2. P2’s matching Windows architecture/benchmark report when available.
3. WAG’s existing authority/interface documentation — read-only; do not mutate it from P3.
4. A future shared benchmark manifest containing pinned browser/Playwright/workload versions.
5. Raw benchmark output, not only summaries.

## Research that SHOULD NOT be repeated

Do not re-research unless a version materially changes:

- what PID/mount/network/user/IPC/cgroup namespaces isolate;
- whether cgroups v2 supports memory/PID/CPU control;
- whether systemd transient units expose resource/sandbox settings;
- whether seccomp alone is a sandbox;
- whether bubblewrap is a complete policy;
- bubblewrap CVE-2026-87766 fix version (0.12.0);
- Playwright’s current Ubuntu 26.04 support;
- Chrome 136+ custom-profile remote-debugging policy;
- Edge/Chrome Ubuntu/Fedora distro support;
- current Chromium Linux password-store fallback behavior;
- NixOS generation rollback model;
- Fedora Silverblue atomic rollback model;
- Windows Job Object/AppContainer existence.

Repeat only to update a changed version, challenge a primary-source fact, or narrow an empirical issue.

---

# Final result

## **strong case to prototype Linux**

**Leading prototype:** Ubuntu 26.04 LTS + systemd-native per-session isolation/resource control.

**Migration status:** **NOT APPROVED by this research.** Promotion requires the apples-to-apples P2/P3 benchmark and the security/browser spikes above.

**Short-term priority:** P1/Windows remains unblocked and remains the production path until P3 produces a material measured win.