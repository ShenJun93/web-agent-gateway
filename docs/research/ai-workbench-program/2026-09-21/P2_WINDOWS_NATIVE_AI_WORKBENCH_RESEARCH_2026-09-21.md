# P2_WINDOWS_NATIVE_AI_WORKBENCH_RESEARCH_2026-09-21

**Research owner:** P2 — Windows Native AI Workbench  
**Date:** 2026-09-21  
**Canonical future repository:** `E:\Projects\native-ai-workbench`  
**Status:** Research complete enough to authorize narrowly-scoped local benchmarks; **no product implementation authorized by this report**.

## Classification convention

- **FACT** — supported by a cited primary/upstream source.
- **INFERENCE** — derived from facts but not directly stated by the source.
- **RECOMMENDATION** — design choice proposed for this program.
- **UNVERIFIED ASSUMPTION** — plausible but not yet evidenced.
- **EMPIRICAL TEST NEEDED** — must be resolved by a local spike/benchmark.

Evidence IDs such as `[WEBVIEW2-001]` are stable references to the Evidence Ledger in §6. Other project sessions should cite those IDs rather than repeat the same primary-source research.

---

# 1. Executive summary

The highest-value local decision is **not** “WPF vs WinUI vs Tauri vs Electron.” The dominant unresolved architectural question is **embedded browser vs externally managed browser**, while terminal/process ownership and WAG integration can be kept constant.

The two architectures worth benchmarking locally are:

1. **TOP 1 — A/WPF:** `.NET 10 LTS + WPF native shell + WebView2 + ConPTY + Windows Job Objects + local structured IPC + WAG client`.
2. **TOP 2 — B/WPF:** `.NET 10 LTS + WPF native shell + externally launched Edge instances + CDP + ConPTY + Windows Job Objects + local structured IPC + WAG client`.

This pairing maximizes information gained per line of spike code because both candidates share the same native control plane, state model, terminal/process supervisor, WAG client, telemetry, and benchmark harness. Only the browser adapter changes.

**FACT:** WebView2 uses Chromium's multi-process model. WebViews using the same user data folder (UDF) can share a browser process; multiple WebView2 profiles under one UDF separate cookies/preferences/storage while avoiding one browser-process collection per profile. Microsoft explicitly warns that many UDFs consume additional memory and disk. `[WEBVIEW2-001]` `[WEBVIEW2-002]`

**FACT:** A WebView2 main browser-process failure closes all WebView2 controls in the affected process group/environment; the native host process is expected to handle `ProcessFailed` / `BrowserProcessExited` and recreate controls. A renderer failure can be recovered by reload or control recreation. `[WEBVIEW2-003]`

**FACT:** WebView2 exposes direct Chrome DevTools Protocol (CDP) calls/events and network request/response observation, so DOM/network/console access does not require UI Automation. Microsoft deprecated its separate typed CDP extension package in 2026 and recommends the direct WebView2 CDP APIs. `[WEBVIEW2-004]` `[WEBVIEW2-005]`

**FACT:** External Edge can be launched with a distinct `--user-data-dir` and a DevTools endpoint. Microsoft documents the CDP WebSocket connection as **no authentication**, and enterprise policy can disable remote debugging. Edge policy also recognizes `--remote-debugging-pipe`, but Microsoft's normal Edge CDP tutorial documents TCP/WebSocket, not a complete .NET pipe-client flow. `[EDGE-CDP-001]` `[EDGE-CDP-002]`

**FACT:** Windows Job Objects provide the correct ownership primitive for CLI trees. Child processes normally remain associated with the parent's job, nested jobs are supported on current Windows, `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills associated processes when the last job handle closes, and a job can expose accounting/notifications via an I/O completion port. A process can be assigned to a job at creation via `PROC_THREAD_ATTRIBUTE_JOB_LIST`. `[JOB-001]` `[JOB-002]` `[JOB-003]` `[JOB-004]`

**RECOMMENDATION:** Do not solve stale Node/Python/esbuild processes by periodic process-name scanning. All workbench-launched terminal/tool processes should cross one spawn boundary and enter a session Job Object **before they execute**. Default policy: no breakaway, no detached children, kill-on-owner-close. Detached workloads, if ever added, must be an explicit capability with a different owner.

**FACT:** ConPTY is the supported Windows pseudoterminal primitive and transmits UTF-8 text plus VT sequences. On Windows 11 24H2+, `ReleasePseudoConsole` improves clean shutdown by allowing the pseudoconsole to exit after all clients disconnect. `[CONPTY-001]` `[CONPTY-002]`

**FACT:** The Windows Terminal repository contains WPF terminal-control code, but the upstream “productize” issue remains open in 2026; a March 2026 maintainer response explicitly says the WPF control is still not a finished product. `[WT-CTRL-001]` `[WT-CTRL-002]`

**RECOMMENDATION:** Do not make the unproductized Windows Terminal WPF control a v1 architectural dependency. The first benchmark may use a deliberately minimal transcript/VT test surface. Terminal-renderer selection should be a separate bounded spike after the browser/process architecture is selected.

**FACT:** WinUI 3 is Microsoft's recommended UI framework for new native Windows apps, and Windows App SDK 2.5.1 was released 2026-09-16. WPF remains a supported .NET Windows UI framework. WinUI 3 introduces Windows App SDK runtime/deployment variables that are irrelevant to the first browser/process benchmark. `[WINUI-001]` `[WASDK-001]` `[WPF-001]`

**RECOMMENDATION:** Use WPF for the first A/B benchmark to reduce variables. This is **not** a claim that WPF is faster or lighter than WinUI 3. A later shell-only microbenchmark can revisit the UI framework if product UX or Windows App SDK features justify it.

**FACT:** Tauri 2 on Windows also uses WebView2, and its capability/scope model is security-positive. Tauri 2.11.6 was current on 2026-09-19. It does not remove the main WebView2 process/UDF questions; it adds Rust + web-frontend IPC and build/deployment surfaces. `[TAURI-001]` `[TAURI-002]` `[TAURI-003]`

**FACT:** Electron 44.4.3 was current on 2026-09-18 and uses Chromium's browser/renderer multi-process model with a Node.js main process. Electron's own security guide treats arbitrary remote content as high-risk and requires strict Node isolation/sandboxing. `[ELECTRON-001]` `[ELECTRON-002]`

**RECOMMENDATION:** Keep Tauri and Electron as comparison baselines, not top-two local implementation candidates. Neither should be rejected with an unmeasured “heavy” label. Their actual RAM/startup behavior remains benchmarkable, but they currently add architectural surface without resolving the highest-value uncertainty.

The likely long-term shape is **E — a native .NET control plane with a replaceable `BrowserSurface` adapter**, using WebView2 by default if benchmarks validate it and external Edge/CDP as a provider-specific or compatibility escape hatch. This allows ChatGPT/Claude browser surfaces to remain replaceable dependencies rather than the workstation's orchestration center.

---

# 2. Exact problem being solved

Build the smallest reliable Windows-native control plane that can coordinate:

- up to five concurrent browser AI sessions;
- native interactive terminals;
- explicit process ownership and cleanup;
- structured browser inspection/control;
- WAG as an external authority/execution backend;
- durable local session metadata;
- crash/restart recovery;
- measurable CPU/RAM/process/startup behavior.

The target is not “a browser with extra buttons.” The target is a **local workstation host** in which browser tabs are replaceable views controlled by a native owner.

The control plane must guarantee, as far as Windows primitives permit:

1. Browser page content is untrusted and cannot acquire arbitrary local authority.
2. A renderer/site crash does not kill the native workbench.
3. A workbench-owned terminal/tool process has a deterministic owner and cleanup path.
4. App restart does not resurrect stale PIDs as if they were valid state.
5. Structured access (CDP/WebView2/WAG/native APIs) wins over UI Automation.
6. Five-session resource scaling is measured, not inferred from framework marketing.
7. Browser-provider implementation details are contained behind adapters.
8. WAG remains the authority boundary; the workbench does not silently duplicate or expand WAG policy.

### Conservative scope assumptions

- Primary platform: Windows 11 x64 workstation.
- Normal execution integrity: non-elevated desktop user.
- Interactive single-user product, not a Windows service.
- Five AI browser sessions is the initial scale target.
- ChatGPT/Claude web surfaces may change at any time; no page DOM is canonical state.
- WAG contract is external/canonical elsewhere; this project only needs a client adapter.
- Browser account authentication is performed by the human through normal provider UX. No automation of MFA, security challenges, consent, or other security controls.

---

# 3. Non-goals

This research does **not** authorize:

- rewriting or expanding WAG;
- auto-clicking browser or OS security controls;
- building a browser engine;
- forking Chromium;
- building a custom terminal emulator before proving it is necessary;
- long-lived daemon/service architecture merely to preserve terminal processes;
- cross-platform UI parity in v1;
- automating ChatGPT/Claude login, MFA, captcha, consent, or account-recovery flows;
- promising terminal-process survival across a workbench crash;
- treating UI Automation as the primary browser-control mechanism;
- embedding arbitrary Node/native APIs into untrusted remote pages;
- selecting an architecture based on package size or “lightweight” reputation alone.

---

# 4. Current platform facts

## 4.1 Current version anchors as of 2026-09-21

| Component | Current/relevant release evidence | Classification |
|---|---|---|
| .NET | .NET 10 LTS, latest patch 10.0.12 on 2026-09-08; support through 2028-11-14 | **FACT** `[DOTNET-001]` |
| Windows App SDK | 2.5.1 released 2026-09-16 | **FACT** `[WASDK-001]` |
| WebView2 Runtime | Stable Runtime 153.0.4234.32 released 2026-09-11 | **FACT** `[WEBVIEW2-006]` |
| WebView2 SDK | Stable 1.0.4191.47 (2026-08-28); prerelease 1.0.4255 (2026-09-11) | **FACT** `[WEBVIEW2-007]` |
| Tauri | v2.11.6 released 2026-09-19 | **FACT** `[TAURI-003]` |
| Electron | v44.4.3 marked latest, released 2026-09-18 | **FACT** `[ELECTRON-003]` |

Version anchors are recorded so future researchers know what “current” meant in this report. They should be refreshed only when implementation actually starts or when a material platform change is suspected.

## 4.2 WebView2 process and storage model

**FACT:** WebView2 is multi-process. A UDF corresponds to a WebView2 browser-process collection. WebViews with identical environment configuration and the same UDF can share that collection. Each additional UDF creates additional runtime process collections and consumes extra memory/disk. `[WEBVIEW2-001]`

**FACT:** Multiple profiles under one UDF separate browser data such as cookies, preferences, permissions, and storage. This is specifically Microsoft's recommended alternative to using many UDFs when the goal is browser-data separation. `[WEBVIEW2-002]`

**FACT:** `CoreWebView2Environment.GetProcessInfos()` returns WebView2 process information for the same UDF (except crashpad), which gives the benchmark harness an official way to enumerate the browser-process group instead of relying only on parent-PID heuristics. `[WEBVIEW2-008]`

### Implication for five sessions

Three WebView2 partition topologies deserve measurement:

- **A-UDF1:** one UDF, five profiles — minimum browser-process-group count, maximum shared browser-process failure domain.
- **A-UDF2:** two UDFs grouped by provider, profiles within each — likely compromise between sharing and failure containment.
- **A-UDF5:** five UDFs — strongest browser-process-group separation, highest expected process/memory overhead.

The word “expected” is intentional. Microsoft confirms the direction of resource sharing but does not provide workstation-specific RAM numbers. **EMPIRICAL TEST NEEDED.**

## 4.3 WebView2 crash/restart behavior

**FACT:** If a renderer fails, WebView2 raises `ProcessFailed`; the affected content can be reloaded or the control can be recreated. `[WEBVIEW2-003]`

**FACT:** If the main WebView2 browser process exits unexpectedly, all controls using that environment/process group are closed; the host must recreate them. `[WEBVIEW2-003]`

**INFERENCE:** A native host containing WebView2 is a materially better control-plane boundary than putting process authority inside page JavaScript because the host remains a separate native process while Chromium renderer failures are explicitly surfaced as recoverable events.

**EMPIRICAL TEST NEEDED:** How quickly actual ChatGPT/Claude sessions recover after renderer kill, browser-process kill, and control recreation, and whether all expected login/session state survives.

## 4.4 Structured browser access

**FACT:** WebView2 can issue direct CDP methods and subscribe to CDP events. `[WEBVIEW2-004]`

**FACT:** CDP provides runtime evaluation, DOM queries, network events, and console/log events. `[CDP-001]`

**FACT:** WebView2 also has native request/response APIs (`WebResourceRequested`, `WebResourceResponseReceived`) for observing/intercepting network traffic. `[WEBVIEW2-005]`

**FACT:** Microsoft's typed `Microsoft.Web.WebView2.DevToolsProtocolExtension` package was deprecated in 2026; direct WebView2 CDP APIs are the recommended replacement. `[WEBVIEW2-009]`

**RECOMMENDATION:** Do not create a general “execute arbitrary JavaScript sent by the model” API. Provider adapters should expose typed operations and keep raw CDP behind a local diagnostic/developer boundary.

A minimal browser abstraction should resemble:

```text
BrowserSurface
  Navigate(Uri)
  GetHealth()
  Query(ProviderQuerySpec) -> structured result
  Subscribe(BrowserEventSpec) -> structured events
  CaptureSnapshot(SnapshotSpec)
  Restart(RestartMode)
  GetProcessSnapshot()
```

Raw `Runtime.evaluate`, selector strings, and provider-specific DOM details belong **inside the provider/browser adapter**, not in the model-facing control protocol.

## 4.5 External Edge + CDP

**FACT:** Microsoft documents launching Edge with `--remote-debugging-port`, optionally with a distinct `--user-data-dir`, enumerating `/json/list`, then attaching to `webSocketDebuggerUrl`. `[EDGE-CDP-001]`

**FACT:** Microsoft documents the Chrome DevTools Protocol WebSocket connection used by Visual Studio as **“no authentication.”** `[EDGE-CDP-002]`

**FACT:** Enterprise policy can disable Edge remote debugging. The `RemoteDebuggingAllowed` policy recognizes both `--remote-debug-port` and `--remote-debugging-pipe`. `[EDGE-CDP-003]`

**FACT:** Edge's `UserDataDir` policy can override a `--user-data-dir` command-line choice. `[EDGE-PROFILE-001]`

**FACT:** Edge supports multiple user profiles with separate personalized browser settings/data. `[EDGE-PROFILE-002]`

### Security consequence

A listening CDP TCP endpoint is a powerful local control interface. It must not be treated as “safe because localhost.” If B wins:

- first test `--remote-debugging-pipe`;
- if pipe is operationally viable, prefer it;
- if TCP is required, bind only for the owned browser lifetime, use unpredictable per-session ports, never expose outside loopback, and keep a strict process/port ownership registry;
- do not expose the CDP endpoint to remote page content;
- fail closed if enterprise policy disables debugging.

**EMPIRICAL TEST NEEDED:** Microsoft documents that the Edge flag exists, but this research did not find a complete official .NET client recipe for `--remote-debugging-pipe`. Do not assume it works for the intended architecture without a spike.

## 4.6 WPF, WinUI 3, and Windows App SDK

**FACT:** Microsoft recommends WinUI 3 / Windows App SDK for new native Windows desktop apps. WinUI 3 is a desktop process model, not UWP/AppContainer. `[WINUI-001]`

**FACT:** Windows App SDK 2.5.1 is current as of 2026-09-16. `[WASDK-001]`

**FACT:** WPF remains a .NET Windows-only UI framework with hardware-accelerated vector rendering. `[WPF-001]`

**FACT:** WinUI 3 apps are MSIX-packaged by default. Unpackaged WinUI 3 apps require Windows App SDK runtime deployment or self-contained bundling; self-contained deployment increases output size and single-file builds extract dependencies. WPF does not require Windows App SDK merely to exist as a UI framework. `[PACKAGING-001]`

**INFERENCE:** For this benchmark, WPF removes one nonessential deployment/runtime variable while preserving direct .NET/Win32 access.

**RECOMMENDATION:** Use WPF in the first browser/process benchmark. Revisit WinUI 3 only after A/B data, unless a required WinUI-only feature is identified.

## 4.7 ConPTY

**FACT:** `CreatePseudoConsole` is the supported Windows pseudoterminal API since Windows 10 1809. Its input/output streams are UTF-8 with VT control sequences; the host is responsible for display and input handling. `[CONPTY-001]`

**FACT:** `ReleasePseudoConsole` is available on Windows 11 24H2+ and allows the pseudoconsole to exit automatically after clients disconnect; the host then closes the remaining HPCON resources. `[CONPTY-002]`

**RECOMMENDATION:** Treat the pseudoterminal as a transport/session primitive. Keep terminal rendering behind a separate `TerminalRenderer` boundary.

## 4.8 Windows Terminal reusable components

**FACT:** The Windows Terminal repository includes reusable core/control source, including a WPF terminal control. `[WT-CTRL-003]`

**FACT:** The upstream issue to “Productize the WPF, UWP Terminal Controls” remains open; packaging/API stabilization work remains listed. `[WT-CTRL-001]`

**FACT:** In March 2026, a Windows Terminal maintainer stated that the WPF control is still built/supported in the repository but is not considered a finished product, and recommended a community integration for current consumers. `[WT-CTRL-002]`

**RECOMMENDATION:** Do not anchor v1 reliability on an upstream component that its maintainer still does not call productized. Use it only in a later terminal-renderer spike if its UX/value justifies accepting source/vendor maintenance.

## 4.9 Windows Job Objects and process ownership

**FACT:** On current Windows, child processes of a job-associated process are associated with the job by default; nested jobs are supported. `[JOB-001]`

**FACT:** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates all processes associated with the job when the last job handle closes. `[JOB-002]`

**FACT:** Nested jobs aggregate resource accounting and termination through the hierarchy. Jobs can send notifications through an associated I/O completion port. `[JOB-003]`

**FACT:** `PROC_THREAD_ATTRIBUTE_JOB_LIST` can assign job handles to a child as part of process creation on Windows 10+. `[JOB-004]`

### Consequence for stale processes

A workbench spawn must not be equivalent to:

```text
Process.Start("npm ...")
```

It should be conceptually:

```text
CreateSessionJob(kill_on_close=true, breakaway=false)
CreateProcess(
  executable,
  argv,
  explicit_handle_list,
  job_list=[session_job],
  pseudoconsole=HPCON
)
RegisterLease(session_id, pid, job)
```

This ensures ownership exists at process creation rather than relying on a later “discover and attach” race.

**RECOMMENDATION:** Use one parent Workbench Job (for global accounting if useful) plus one child Job per terminal/tool session. Keep browser process groups separate from CLI Job ownership unless local testing proves browser assignment safe and useful.

## 4.10 Named pipes and localhost IPC

**FACT:** Named pipes are securable Windows objects. A caller can provide a security descriptor/DACL. The default descriptor is too permissive for this design because it grants read access to Everyone and anonymous users. Microsoft specifically recommends a logon SID in the DACL to block other sessions/remote users. `[IPC-001]`

**FACT:** Windows App SDK desktop/full-trust apps can use named pipes. Packaged loopback IPC has additional capability/rule requirements. `[IPC-002]`

**RECOMMENDATION:** Prefer:
- in-process calls when components do not need fault isolation;
- named pipes for local cross-process control-plane IPC;
- localhost HTTP/TCP only where an existing external system such as WAG already defines that transport.

For a named pipe, use:
- per-instance random pipe name;
- explicit DACL to current logon SID (not default ACL);
- protocol version + typed messages;
- expected client PID/process identity where practical;
- no arbitrary shell strings;
- no native handle exposure to browser page content.

A same-user DACL does **not** defend against every malicious process running as the same user. That is acceptable only if the threat model is explicit. If hostile same-user processes are in scope, add process identity/capability binding or inherited-handle IPC and test it separately.

## 4.11 Windows credential storage

**FACT:** `CredWrite`/`CredRead` store credentials in the credential set associated with the current logon session/token. `[CRED-001]`

**FACT:** DPAPI `CryptProtectData` normally restricts decryption to the same user's logon credentials and usually the same computer. `[CRED-002]`

**RECOMMENDATION:** Store WAG tokens or other app secrets in Windows Credential Manager or DPAPI-protected storage, never plaintext session JSON. Store only a credential reference/name in workbench state.

Browser login cookies remain in the browser's profile/UDF and should not be copied into the workbench state store.

## 4.12 AppContainer

**FACT:** AppContainer provides least-privilege isolation over credentials, devices, files, network, processes, and windows. `[APPCONTAINER-001]`

**INFERENCE:** Putting the entire workbench in an AppContainer conflicts with its core duty to launch terminals, inspect processes, use development tools, and access local workspaces.

**RECOMMENDATION:** Do not AppContainer the primary control plane in v1. Consider AppContainer only for future untrusted helper processes with intentionally narrow capabilities.

## 4.13 UI Automation/accessibility fallback

**FACT:** Windows UI Automation provides structured accessibility/control access to desktop UI, but Windows integrity isolation can block automation across privilege levels. `[UIA-001]`

**RECOMMENDATION:** UI Automation is fallback tier 3:

1. structured native/provider API;
2. CDP/DOM/network/console;
3. UI Automation/accessibility;
4. coordinate/image automation only as a last resort.

Do not enable UIAccess or elevate the whole workbench merely to automate elevated windows. Security controls/UAC remain human/OS authority.

## 4.14 Tauri 2

**FACT:** Tauri 2 uses Microsoft Edge WebView2 to render content on Windows. `[TAURI-001]`

**FACT:** Tauri has capabilities/scopes that restrict which windows/webviews can invoke core/plugin commands; the shell plugin requires scoped commands/arguments. `[TAURI-002]`

**FACT:** Tauri's updater requires signed updates and supports MSI/NSIS on Windows. `[TAURI-004]`

**INFERENCE:** Tauri has a good explicit privilege model, but for this Windows-specific workstation it adds Rust + web-frontend IPC and does not eliminate WebView2's UDF/process/crash topology questions.

## 4.15 Electron baseline

**FACT:** Electron uses Chromium's multi-process architecture with a Node.js main process plus renderer processes. `[ELECTRON-001]`

**FACT:** Electron ships a bundle containing Electron, Chromium and Node.js; its security guide explicitly warns against remote content with Node integration and recommends context isolation/process sandboxing. `[ELECTRON-002]`

**FACT:** Electron's main process is the application's “control tower” and UI thread; long-running work must not block it. `[ELECTRON-004]`

**FACT:** Electron provides Windows update mechanisms through MSIX/Squirrel depending on packaging. `[ELECTRON-005]`

**EMPIRICAL TEST NEEDED:** Actual startup/RAM/process count versus A/C on this workstation. “Electron is heavier” is not accepted as a measured finding in this report.

---

# 5. Candidate architectures

## A. .NET native shell + WebView2 + ConPTY + Job Objects + structured IPC + WAG

### Proposed benchmark realization

- .NET 10 LTS
- WPF shell for the benchmark
- WebView2 stable SDK
- WebView2 Evergreen Runtime
- browser partition/profile abstraction
- ConPTY for terminal sessions
- Windows Job Objects for every workbench-launched CLI tree
- local named pipe only if a helper process is necessary
- WAG typed client
- local state store
- provider adapters for ChatGPT/Claude browser surfaces

### Strengths

- Direct Windows primitives and WebView2 APIs from one runtime.
- Browser renderer failures are explicitly recoverable.
- Direct CDP plus native WebView2 network events.
- WebView2 UDF/profile topology can trade resource sharing against blast radius.
- No separate browser window management.
- No browser-debugging TCP endpoint required.

### Risks/unknowns

- Real ChatGPT/Claude login compatibility inside WebView2.
- Shared UDF browser-process crash blast radius.
- Actual five-session memory.
- Terminal renderer choice remains unresolved.
- Page/provider DOM drift still requires adapters.

### Decision status

**TOP 1 benchmark candidate.**

---

## B. .NET native shell + external Edge profiles/UDDs + CDP + ConPTY + Job Objects + WAG

### Proposed benchmark realization

- Same .NET 10/WPF/control-plane code as A.
- Each browser session launched as an owned Edge instance with its own UDD for the first benchmark.
- CDP attachment through pipe if proven; otherwise local TCP/WebSocket.
- Edge root process assigned to an owner Job Object only if compatibility testing proves nested/job behavior correct.

### Strengths

- Browser engine/window is fully out of the workbench UI process.
- Maximum compatibility with normal Edge login/browser behavior.
- Browser instance can be killed/relaunched independently.
- CDP offers structured DOM/network/console control.

### Risks/unknowns

- CDP TCP endpoint is unauthenticated if used.
- Enterprise policy can disable remote debugging.
- External window focus/z-order/lifecycle management adds complexity.
- Five separate UDDs likely create more browser-process groups; actual cost must be measured.
- `--remote-debugging-pipe` operational integration requires a spike.
- Edge may create/organize Windows jobs in ways that affect attempted parent Job ownership; must test.

### Decision status

**TOP 2 benchmark candidate.**

---

## C. Tauri 2 + WebView2 + Rust process supervisor + WAG

### Strengths

- OS WebView rather than bundled browser.
- Explicit capability/scoping model.
- Rust is strong for a native process supervisor.
- Cross-platform shell path is more plausible than WPF.

### Costs

- Windows still uses WebView2, so UDF/profile/process questions remain.
- Adds Tauri IPC/capability configuration plus Rust and potentially frontend JavaScript/tooling.
- The current problem is Windows-first; cross-platform UI is not yet the dominant requirement.
- Tauri-specific WebView2 integration becomes another dependency layer.

### Decision status

**Do not benchmark before A/B unless cross-platform UI becomes a hard requirement.**

---

## D. Electron baseline

### Strengths

- Mature desktop web application ecosystem.
- Strong browser/content tooling.
- Explicit main/renderer separation.
- Mature packaging/update paths.

### Costs

- Bundles Chromium + Node + Electron rather than using the system WebView.
- Remote AI pages demand strict isolation from Node/native APIs.
- Native Windows process ownership still needs Windows-specific integration.
- Does not reduce the embedded-vs-external-browser uncertainty.
- Adds Node/npm runtime/tooling to a workstation already trying to reduce stale Node process risk.

### Decision status

**Measured comparison baseline only. Do not assume it loses on RAM before measurement, but do not build it first.**

---

## E. Hybrid strategic architecture — native control plane + replaceable BrowserSurface

This is the **leading long-term architecture shape**, not a third benchmark codebase.

```text
+-----------------------------------------------------+
| Native Workbench Host (.NET)                        |
|                                                     |
|  Session Registry      State / Audit                |
|  Process Supervisor    WAG Client                   |
|  ConPTY Manager        Benchmark Telemetry          |
|        |                    |                       |
|        +---- BrowserSurface Abstraction ------------+
|                 |                    |              |
|          WebView2 Adapter      Edge/CDP Adapter     |
+-----------------------------------------------------+
                  |                    |
          WebView2 process group    Edge processes
                  |
          remote AI web pages (untrusted)
```

Benchmark A and B implement the two browser adapters against the same core. If A wins decisively, B remains a compatibility escape hatch. If B wins for real provider compatibility/reliability, the control plane remains native and the browser remains external.

---

# 6. Evidence Ledger

| evidence_id | claim | source | source type / authority | date/version | confidence | applies_to | implementation consequence |
|---|---|---|---|---|---|---|---|
| WEBVIEW2-001 | Same-UDF WebViews can share a browser process; many UDFs add memory/disk/process cost | [Manage user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | Benchmark UDF topology; do not default to 5 UDFs without measurement |
| WEBVIEW2-002 | Multiple profiles under one UDF separate cookies/preferences/storage | [Multi-profile support](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support) and [CoreWebView2Profile](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2profile) | Microsoft primary docs | current API/docs | High | P2, COMMON | Five sessions can isolate auth state without requiring five browser process groups |
| WEBVIEW2-003 | Renderer/browser process failures raise recoverable events; browser-process failure closes controls in group and requires recreation | [Handling process-related events](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-related-events) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | Control plane must subscribe to failure events and recreate controls |
| WEBVIEW2-004 | WebView2 supports direct CDP method calls/event subscriptions | [Overview of WebView2 APIs](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis), [CallDevToolsProtocolMethodAsync](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.calldevtoolsprotocolmethodasync) | Microsoft primary docs | stable SDK family through 1.0.4191.47 | High | P2, COMMON | DOM/console inspection should use structured APIs before UI automation |
| WEBVIEW2-005 | WebView2 exposes request/response observation/interception | [Custom management of network requests](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | Browser adapter can observe network structurally; redact auth data |
| WEBVIEW2-006 | Stable WebView2 Runtime 153.0.4234.32 released 2026-09-11 | [Runtime release notes](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/runtime/) | Microsoft primary release notes | Runtime 153.0.4234.32 | High | P2, COMMON | Pin benchmark metadata to actual runtime version |
| WEBVIEW2-007 | Latest listed stable SDK is 1.0.4191.47; prerelease 1.0.4255 | [SDK release notes](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/) | Microsoft primary release notes | 2026-08-28 / 2026-09-11 | High | P2, COMMON | Use stable SDK for benchmark unless a prerelease-only API is required |
| WEBVIEW2-008 | `GetProcessInfos()` enumerates WebView2 process info for a UDF | [GetProcessInfos](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.getprocessinfos) | Microsoft primary API docs | current stable API family | High | P2 | Use official process enumeration in benchmark harness |
| WEBVIEW2-009 | Typed DevToolsProtocolExtension NuGet is deprecated; direct CDP APIs recommended | [SDK 1.0.4071 prerelease notes](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-4071-prerelease) | Microsoft primary release notes | updated 2026-08-14 | High | P2, COMMON | Do not add deprecated typed CDP package |
| WEBVIEW2-010 | Evergreen is the recommended/shared runtime model; Fixed Version adds >250 MB | [Distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) | Microsoft primary docs | accessed 2026-09-21 | High | P2 | Use Evergreen for workstation unless a proven compatibility reason requires fixed |
| EDGE-CDP-001 | Edge supports `--remote-debugging-port`, distinct `--user-data-dir`, `/json/list`, WebSocket CDP | [Microsoft Edge DevTools Protocol](https://learn.microsoft.com/en-us/microsoft-edge/devtools/protocol/) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | External Edge adapter is feasible without UI automation |
| EDGE-CDP-002 | Visual Studio attaches to Edge via “Chrome devtools protocol websocket (no authentication)” | [Visual Studio for web development](https://learn.microsoft.com/en-us/microsoft-edge/visual-studio/) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | Treat listening CDP port as privileged local attack surface |
| EDGE-CDP-003 | Enterprise policy can disable remote debugging; policy recognizes port and pipe flags | [RemoteDebuggingAllowed](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/remotedebuggingallowed) | Microsoft primary policy docs | current 2026 | High | P2, COMMON | B must detect policy failure and fail closed; test pipe |
| EDGE-PROFILE-001 | Edge policy can control/override user data directory | [UserDataDir policy](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/userdatadir) | Microsoft primary policy docs | updated 2026-05-21 | High | P2 | External browser launcher must verify actual profile path |
| EDGE-PROFILE-002 | Edge supports multiple profiles with separate browser settings/data | [Microsoft Edge profiles](https://support.microsoft.com/en-us/edge/sign-in-and-create-multiple-profiles-in-microsoft-edge) | Microsoft official support | accessed 2026-09-21 | High | P2 | Browser account isolation can be profile-based |
| CDP-001 | CDP exposes Runtime/DOM/Network/Log domains | [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/), [DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/), [Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) | Upstream protocol spec | current tip-of-tree | High | P2, COMMON | Browser automation can be structured and provider-adapted |
| DOTNET-001 | .NET 10 is active LTS; 10.0.12 current 2026-09-08 | [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy) | Microsoft primary policy | 2026-09-08 | High | P2, COMMON | New .NET spike should target .NET 10 LTS |
| WASDK-001 | Windows App SDK 2.5.1 current stable, 2026-09-16 | [Latest Windows App SDK downloads](https://learn.microsoft.com/en-us/windows/apps/windows-app-sdk/downloads) | Microsoft primary docs | 2.5.1 | High | P2 | Version anchor for WinUI evaluation |
| WINUI-001 | WinUI 3 is Microsoft's recommended native UI for new Windows apps and uses Windows App SDK runtime | [Choose a Windows development path](https://learn.microsoft.com/en-us/windows/apps/get-started/), [Get started with WinUI 3](https://learn.microsoft.com/en-us/windows/apps/get-started/winui-get-started-overview) | Microsoft primary docs | accessed 2026-09-21 | High | P2 | WinUI remains product-shell option, but not required for A/B browser benchmark |
| WPF-001 | WPF is a Windows-only .NET UI framework | [WPF overview](https://learn.microsoft.com/en-us/dotnet/desktop/wpf/overview/) | Microsoft primary docs | accessed 2026-09-21 | High | P2 | Low-variable native shell for benchmark |
| PACKAGING-001 | WinUI 3 defaults to MSIX; unpackaged/self-contained paths have Windows App SDK runtime implications; WPF does not package by default | [Publish your first Windows app](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/publish-first-app), [Unpackaged WinUI 3](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/unpackage-winui-app) | Microsoft primary docs | accessed 2026-09-21 | High | P2 | Keep packaging out of initial performance decision; benchmark unpackaged dev builds first |
| CONPTY-001 | ConPTY is supported pseudoconsole; UTF-8 + VT, host owns presentation/input | [CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole), [Pseudoconsoles](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles) | Microsoft primary docs | Windows 10 1809+ | High | P2, COMMON | Use ConPTY, not hidden console-window scraping |
| CONPTY-002 | `ReleasePseudoConsole` supports clean client-disconnect completion on Win11 24H2+ | [ReleasePseudoConsole](https://learn.microsoft.com/en-us/windows/console/releasepseudoconsole) | Microsoft primary docs | Win11 24H2+ | High | P2 | Use when available; retain older fallback if older OS remains in scope |
| WT-CTRL-001 | Productization of WPF/UWP Windows Terminal controls remains open | [microsoft/terminal #6999](https://github.com/microsoft/terminal/issues/6999) | Upstream issue tracker | open as checked 2026-09-21 | High | P2, COMMON | Do not depend on an official stable NuGet/control contract |
| WT-CTRL-002 | Maintainer says WPF control still not a finished product in Mar 2026 | [microsoft/terminal discussion #19948](https://github.com/microsoft/terminal/discussions/19948) | Upstream maintainer statement | 2026-03-05/06 | High | P2 | Terminal renderer stays separate/bounded |
| WT-CTRL-003 | WPF terminal-control source exists in upstream repository | [WpfTerminalControl project](https://github.com/microsoft/terminal/blob/main/src/cascadia/WpfTerminalControl/WpfTerminalControl.csproj) | Upstream source | main, checked 2026-09-21 | High | P2 | Candidate for later source-based spike only |
| JOB-001 | Child processes normally inherit job association; nested jobs supported | [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject) | Microsoft primary API docs | current Windows | High | P2, COMMON | Job-based ownership follows spawned CLI trees |
| JOB-002 | `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` kills associated processes when last job handle closes | [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information) | Microsoft primary API docs | current Windows | High | P2, COMMON | Crash/exit cleanup primitive for workbench-owned CLI trees |
| JOB-003 | Nested jobs aggregate accounting/termination; completion ports provide notifications | [Nested Jobs](https://learn.microsoft.com/en-us/windows/win32/procthread/nested-jobs), [JOBOBJECT_ASSOCIATE_COMPLETION_PORT](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port) | Microsoft primary docs | updated 2025 / current | High | P2, COMMON | Implement observable process leases without process-name polling |
| JOB-004 | `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns jobs during process creation | [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) | Microsoft primary API docs | Windows 10+ | High | P2, COMMON | Eliminate attach-after-start race at spawn boundary |
| IPC-001 | Named pipes accept explicit DACLs; default ACL gives Everyone/anonymous read; logon SID can scope access | [Named Pipe Security](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights) | Microsoft primary docs | current | High | P2, COMMON | Never use default named-pipe ACL for control plane |
| IPC-002 | Full-trust desktop apps can use named pipes; packaged loopback has capability/rule constraints | [Windows IPC](https://learn.microsoft.com/en-us/windows/apps/develop/communication/interprocess-communication) | Microsoft primary docs | accessed 2026-09-21 | High | P2, COMMON | Prefer named pipes for private local helper IPC |
| CRED-001 | CredWrite/CredRead operate on user's credential set/logon token | [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew), [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) | Microsoft primary API docs | current | High | P2, COMMON | Store local secrets outside state JSON |
| CRED-002 | DPAPI usually binds protected data to same user and machine | [CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata) | Microsoft primary API docs | current | High | P2, COMMON | Viable fallback for small local secret blobs |
| APPCONTAINER-001 | AppContainer provides least-privilege isolation across local resources | [AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) | Microsoft primary docs | current | High | P2, COMMON | Consider only for narrow helpers, not whole workstation host |
| UIA-001 | Windows integrity/UIPI can block UI automation across privilege levels | [UIPI issues with UI/browser automation](https://learn.microsoft.com/en-us/troubleshoot/power-platform/power-automate/desktop-flows/ui-automation/uipi-issues) | Microsoft primary troubleshooting | current | High | P2, COMMON | Keep workbench non-elevated; UIA cannot be the primary deterministic control path |
| TAURI-001 | Tauri 2 on Windows uses Edge WebView2 | [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) | Upstream official docs | accessed 2026-09-21 | High | P2 | Tauri does not eliminate WebView2 process/UDF concerns |
| TAURI-002 | Tauri capabilities/scopes constrain webview access to native/plugin commands | [Tauri security](https://v2.tauri.app/security/), [Capabilities](https://tauri.app/security/capabilities/), [Shell plugin](https://v2.tauri.app/reference/javascript/shell/) | Upstream official docs | Tauri 2 | High | P2, COMMON | Security-positive baseline if C is revisited |
| TAURI-003 | Tauri v2.11.6 released 2026-09-19 | [Tauri releases](https://github.com/tauri-apps/tauri/releases) | Upstream release feed | 2.11.6 | High | P2 | Current comparison anchor |
| TAURI-004 | Tauri updater requires signed updates and supports Windows MSI/NSIS | [Tauri updater](https://v2.tauri.app/plugin/updater/) | Upstream official docs | Tauri 2 | High | P2 | Packaging/update path is mature enough; not a blocker |
| ELECTRON-001 | Electron uses Chromium multi-process architecture with Node main process | [Electron Process Model](https://www.electronjs.org/docs/latest/tutorial/process-model) | Upstream official docs | current / 44.x | High | P2 | Main/renderer separation exists, but remote content remains privileged-risk boundary |
| ELECTRON-002 | Electron bundles Chromium+Node+Electron and requires strict isolation for remote content | [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) | Upstream official docs | current | High | P2, COMMON | Never expose Node/native APIs to remote AI pages |
| ELECTRON-003 | Electron 44.4.3 latest on 2026-09-18 | [Electron releases](https://github.com/electron/electron/releases) | Upstream release feed | 44.4.3 | High | P2 | Current comparison anchor |
| ELECTRON-004 | Electron main process is control tower/UI thread and must not be blocked | [Electron Performance](https://www.electronjs.org/docs/latest/tutorial/performance) | Upstream official docs | current | High | P2 | Native/process work would need careful isolation |
| ELECTRON-005 | Electron supports Windows updates via MSIX/Squirrel paths | [autoUpdater](https://www.electronjs.org/docs/latest/api/auto-updater) | Upstream official docs | current | High | P2 | Packaging/update is not the reason Electron loses |
| WAG-BOUNDARY-001 | WAG is an external authority/execution backend and must not be expanded by this project | P2 program research brief, 2026-09-21 | Program constraint | 2026-09-21 | High | P2, WAG, COMMON | Workbench is client/orchestrator only; no WAG policy duplication |

---

# 7. Security implications

## 7.1 Trust boundaries

The workbench should model these principals separately:

```text
[Human]
   |
[Native Workbench Host] ----typed----> [WAG external authority]
   |
   +----typed browser adapter----> [Browser engine]
                                     |
                                     +--> [Remote page content: UNTRUSTED]
   |
   +----process lease----> [Terminal/tool process tree]
```

### Required invariant

**Remote page content must never receive a general-purpose bridge to:**
- spawn processes;
- invoke WAG arbitrary tools;
- read arbitrary files;
- open arbitrary named pipes;
- execute arbitrary native commands;
- acquire Credential Manager secrets.

This applies equally to WebView2, Tauri, and Electron.

## 7.2 Browser structured access is privileged

CDP can execute JavaScript, read DOM/state, observe network traffic, and subscribe to logs. Treat the browser adapter as a privileged local component.

Rules:

1. Browser adapter is invoked only by trusted native control-plane code.
2. Provider adapters expose typed semantic operations.
3. Raw CDP is diagnostics/development only.
4. Never log auth headers/cookies/tokens by default.
5. Do not expose CDP endpoints to page JavaScript.
6. Do not use CDP to auto-approve security prompts.

## 7.3 External Edge CDP endpoint

If B uses TCP CDP, the endpoint is locally powerful and unauthenticated at the protocol connection layer `[EDGE-CDP-002]`.

Minimum controls:
- loopback only;
- random port per session;
- lifetime bound to owned Edge process;
- detect unexpected listeners/bind failure;
- no firewall opening;
- no remote bind;
- no static known port such as 9222 in production;
- process registry maps session -> PID -> UDD -> endpoint;
- prefer `--remote-debugging-pipe` if the spike validates it.

## 7.4 Process spawn authority

The model should never emit a raw shell string that bypasses the supervisor.

Preferred schema:

```text
SpawnSpec {
  executable: absolute-or-resolved tool id
  argv: string[]
  cwd: workspace path
  env: allowlisted delta
  session_id: UUID
  detached: false
}
```

The process supervisor performs validation, creates the Job Object/ConPTY, and records the lease.

## 7.5 Elevation

**RECOMMENDATION:** The workbench runs non-elevated. If a future operation truly requires elevation, delegate it through a separately designed bounded broker/WAG capability with explicit user approval. Do not elevate the whole workbench merely to make UI Automation work.

## 7.6 Secrets

- WAG token/secret -> Credential Manager/DPAPI.
- Browser cookies -> browser profile only.
- Session JSON/SQLite -> no plaintext tokens.
- Logs -> redact Authorization/Cookie headers.
- Crash dumps -> treat as potentially sensitive because browser/process state can contain tokens or user text.

---

# 8. Performance implications

No candidate is called “lightweight” by this report.

## 8.1 What is structurally known

- WebView2 shared UDF/profile design can share a browser process and is specifically documented as resource-saving relative to many UDFs. `[WEBVIEW2-001]`
- Tauri on Windows still consumes WebView2 runtime processes. `[TAURI-001]`
- Electron uses its bundled Chromium process model. `[ELECTRON-001]`
- External Edge with distinct UDDs is intentionally creating stronger browser-instance isolation.

These facts explain **what to measure**, not the final RAM/CPU ordering.

## 8.2 Primary benchmark resource metric

Use both:
- **Private Bytes / private commit** summed across the candidate's owned/associated process set — primary memory metric.
- **Working Set** — secondary metric because shared code/pages can make cross-architecture comparisons misleading.

For WebView2, enumerate process IDs using `GetProcessInfos()` rather than relying only on process-parent relationships. `[WEBVIEW2-008]`

## 8.3 Five-session scaling matters more than one-window marketing numbers

Record:
- shell/control-plane process;
- browser main/browser manager processes;
- renderer processes;
- GPU/utility processes;
- terminal child processes;
- helper/runtime processes;
- total private bytes;
- total working set;
- CPU over fixed windows.

Measure both a deterministic local test page and real provider pages so engine overhead can be separated from provider workload.

## 8.4 Do not optimize before baseline

WebView2 exposes memory-target APIs and Chromium has many tuning switches, but initial A/B data must use supported defaults. Otherwise the benchmark becomes a comparison of different tuning policies rather than architectures.

---

# 9. Architecture decision matrix

Legend: **Strong / Medium / Weak / Unknown** are structural judgments from current evidence, **not performance measurements**.

| Dimension | A: .NET + WebView2 | B: .NET + external Edge/CDP | C: Tauri 2 | D: Electron | E: Native control plane + pluggable browsers |
|---|---|---|---|---|---|
| Windows primitive access | **Strong** direct .NET/Win32 | **Strong** direct .NET/Win32 | **Strong** through Rust/Win32 | **Medium** native modules/Node APIs | **Strong** |
| Browser structured control | **Strong** direct WebView2 CDP + native events | **Strong** Edge CDP | **Medium/Strong** WebView2 under Tauri, extra integration layer | **Strong** Chromium/webContents ecosystem | **Strong** per adapter |
| Remote-page/native privilege separation | **Strong if no host object bridge** | **Strong** browser external to host | **Strong** with Tauri capabilities | **Requires strict Electron hardening** | **Strong** |
| Browser crash containment | **Medium/Strong** renderer isolated; browser-process failure affects UDF group | **Strong** separate Edge process/instance | **Medium/Strong**, needs local validation | **Strong** renderer separation; main remains critical | **Strong** with adapter-specific recovery |
| Session storage isolation | **Strong** profiles/UDFs | **Strong** profiles/UDDs | **Strong** via WebView2 profile strategy, integration details TBD | **Strong** Electron sessions/partitions | **Strong** |
| Five-session RAM | **Unknown — benchmark** | **Unknown — benchmark** | **Unknown — benchmark** | **Unknown — benchmark** | Determined by selected adapter |
| Terminal/process ownership | **Strong** Job Objects + ConPTY | **Strong** same | **Strong** possible in Rust | **Medium/Strong** but Windows-specific native integration still needed | **Strong** |
| Process cleanup correctness potential | **Strong** | **Strong** | **Strong** | **Medium/Strong** | **Strong** |
| IPC attack-surface simplicity | **Strong** in-process + named pipes | **Strong**, except CDP endpoint | **Medium** Tauri IPC/capabilities | **Medium** Electron IPC/preload boundary | **Strong** |
| Packaging/update simplicity for internal spike | **Strong** | **Strong** plus Edge dependency | **Medium/Strong** | **Medium/Strong** | **Strong** |
| Cross-platform UI reuse | **Weak** | **Weak** | **Strong** | **Strong** | **Medium**: core contracts shared, native shells differ |
| Implementation variables in first spike | **Lowest** | **Low/Medium** | **Higher** | **Higher** | Built from A/B result |
| Resolves embedded vs external question | Embedded side | External side | Embedded side again | Embedded side again | Encodes winner/fallback |
| Local benchmark priority | **1** | **2** | 3 | baseline only | post-benchmark strategic shape |

### Decision

Benchmark **A vs B**, not A/B/C/D simultaneously.

C and D do not provide enough additional decision information to justify parallel spike code before the core embedded-vs-external question is answered.

---

# 10. Unknowns requiring empirical spikes

1. **WebView2 provider compatibility:** Can ChatGPT and Claude authenticate normally inside WebView2 and remain signed in through 10+ app restarts?
2. **WebView2 UDF topology:** What are RAM/process/recovery differences among 1 UDF/5 profiles, 2 provider UDFs, and 5 UDFs?
3. **External Edge pipe:** Is `--remote-debugging-pipe` reliable and practical from the intended .NET adapter?
4. **External Edge Job ownership:** Can an Edge instance and its descendants be cleanly job-owned without interfering with Chromium sandbox/job behavior?
5. **Five-session actual resource use:** Real private bytes, working set, CPU, renderer count.
6. **Browser crash recovery:** p50/p95 recovery time for renderer kill and browser-process kill.
7. **Application crash recovery:** Whether all terminal descendants are gone after abrupt host death and browser session descriptors recover cleanly.
8. **Terminal renderer:** Which supported/maintainable renderer gives acceptable VT fidelity without adding disproportionate runtime/process cost?
9. **ConPTY shutdown edge cases:** Behavior across `cmd`, PowerShell, node/npm, Python, long-running child trees, and Windows 11 24H2 `ReleasePseudoConsole`.
10. **WAG client overhead:** Incremental local latency through the workbench client versus direct WAG call.
11. **Provider DOM stability:** Which semantic hooks are stable enough for typed provider adapters, and which operations need accessibility/UIA fallback?
12. **WPF vs WinUI shell delta:** Only if UI framework remains material after browser/process data.

---

# 11. Minimal benchmark/spike plan

## Benchmark discipline

All A/B runs must record:

```text
timestamp
Windows build
CPU/RAM machine identity
power mode
Defender status (do not disable merely for benchmark)
.NET version
WebView2 Runtime version
WebView2 SDK version
Edge version
candidate commit
browser partition topology
provider page set
test scenario id
```

For each scenario:
- 5 warm-up runs;
- 20 measured runs for startup/recovery latency;
- 60-second settled sampling windows for idle CPU/RAM;
- p50/p95/p99 where enough samples exist;
- preserve raw JSON/CSV, not screenshots only.

## Spike S1 — shared process supervisor

**Hypothesis:** Job Objects + ConPTY can provide deterministic ownership with zero orphaned terminal descendants after normal close or abrupt host death.

**Estimated code:** 350–550 LOC C# + P/Invoke, excluding benchmark harness.

**Implementation constraints:**
- `PROC_THREAD_ATTRIBUTE_JOB_LIST` or create-suspended/assign-before-resume;
- kill-on-job-close;
- explicit inherited handle list;
- one session job per terminal;
- ConPTY;
- unique run token propagated only for test identification.

**Measurements:**
- terminal input->echo latency;
- 100 spawn/close cycles;
- 100 forced-host-kill cycles;
- process survivors at +1s/+3s/+10s;
- job accounting counts;
- `cmd -> node -> python -> child` nested test tree;
- npm/esbuild-style child tree if available.

**Success criterion:**
- **0 owned-process survivors after 3 seconds in 100/100 forced-kill cycles**;
- no breakaway child without explicit policy;
- terminal local echo/command round trip p95 <= 25 ms on the test workstation for a trivial command.

**Failure criterion:**
- any reproducible orphan;
- job assignment conflicts that require broad breakaway;
- cleanup depends on process-name scanning.

## Spike S2 — A/WebView2 one-session vertical slice

**Hypothesis:** A native WPF host can keep one provider WebView2 session, one ConPTY terminal, process ownership, and WAG health under one control plane without exposing local authority to page content.

**Estimated code:** 500–800 LOC beyond S1.

**Measurements:**
- cold shell start;
- WebView2 environment ready;
- provider page interactive;
- idle private bytes/working set;
- WebView2 process count via `GetProcessInfos`;
- CDP DOM-query p50/p95;
- WAG health/request overhead;
- renderer kill recovery;
- browser-process kill recovery;
- app restart recovery.

**Success criterion:**
- provider can be manually authenticated and remains signed in through 10 app restarts;
- 100/100 typed CDP DOM queries succeed on deterministic local page;
- renderer failure recovers without restarting native host;
- browser-process failure is detected and session re-created automatically;
- no browser page can invoke process/WAG authority through an injected bridge.

**Failure criterion:**
- provider login/security UX is systematically incompatible with embedded WebView2;
- recovery requires restarting the entire native host;
- architecture requires exposing general native APIs to page JavaScript.

## Spike S3 — A/WebView2 five-session topology

**Hypothesis:** Profile-based isolation under fewer UDFs materially reduces process/memory cost while preserving account separation.

**Estimated code:** 150–250 LOC on top of S2.

Test topologies:
1. 1 UDF + 5 profiles;
2. 2 UDFs grouped by provider + profiles;
3. 5 UDFs.

**Measurements:**
- idle private bytes and working set after 120s settle;
- process count by kind;
- CPU with all idle;
- CPU with one active session;
- browser-process-kill blast radius;
- recovery time;
- cookie/storage separation checks.

**Decision criterion:**
- reject any topology with cross-profile auth/storage leakage;
- among safe topologies, choose the lowest-resource topology whose browser-process crash blast radius/recovery remains operationally acceptable;
- if shared topology saves <10% total private bytes versus a more isolated topology, prefer isolation;
- if it saves >=20%, shared/provider-group topology becomes favored unless recovery blast radius is materially worse.

The 10%/20% thresholds are program decision thresholds, **not platform facts**.

## Spike S4 — B/external Edge browser adapter

**Hypothesis:** External Edge gives better provider compatibility/failure isolation without unacceptable memory/start/reconnect or control-security cost.

**Estimated code:** 300–500 LOC using the same BrowserSurface contract.

**Measurements:**
- manual provider login and persistence;
- cold browser start;
- CDP attach/reconnect;
- DOM-query latency;
- 1/5 session private bytes/process count;
- browser kill/restart;
- workbench restart;
- window/focus recovery;
- process cleanup.

**Pipe subtest:**
1. Attempt `--remote-debugging-pipe`.
2. If reliable, use it for the benchmark.
3. If not, use loopback TCP with random per-run port and record the security downgrade.

**Success criterion:**
- CDP connect/reconnect succeeds in 100/100 cycles;
- actual provider login is at least as reliable as normal Edge;
- browser kill/relaunch does not disrupt native terminal/control-plane state;
- all browser instances close on owner shutdown;
- no fixed unauthenticated CDP port remains listening after session close.

**Failure criterion:**
- enterprise/browser policy prevents required control;
- Edge process/job ownership is unreliable;
- window-management complexity dominates the UX;
- five-session cost is materially worse than A without a reliability/compatibility benefit.

## Spike S5 — A vs B head-to-head

Use identical session/provider scripts and process supervisor.

Required metrics:

| Metric | Definition |
|---|---|
| Cold start | process launch -> shell visible; shell -> first browser ready; launch -> provider interactive |
| Idle RAM | total private bytes + working set after 120s settle |
| Five-session idle RAM | same with five authenticated sessions |
| Renderer/process count | all associated browser/runtime/helper processes |
| One active CPU | 60s CPU with one session performing deterministic workload |
| Five sessions, one active | 60s CPU while four idle + one active |
| Terminal latency | host timestamp write -> expected terminal output marker |
| DOM-query latency | typed adapter request -> structured result |
| Browser crash reconnect | deliberate browser/renderer kill -> healthy browser surface |
| App restart recovery | forced host kill -> restored logical sessions/clean processes |
| WAG latency | direct WAG baseline vs workbench-client call |
| Cleanup correctness | owned process count after normal and forced owner exit |

### Relative selection rule

A wins if it has:
- no provider compatibility blocker;
- equal or better cleanup/security;
- materially lower five-session resource cost **or** materially lower operational complexity;
- acceptable browser-process crash recovery.

B wins if:
- embedded provider compatibility is unreliable;
- external Edge failure isolation/recovery is materially better;
- resource delta is acceptable;
- CDP control can be secured without a persistent broad local endpoint.

Do not select based on a single RAM snapshot.

## Spike S6 — terminal renderer (only after A/B decision)

Candidates for a bounded renderer test:
- upstream Windows Terminal WPF control/source integration;
- a maintained proven OSS native control;
- local web terminal rendering only if it can avoid adding a problematic extra WebView/process model;
- minimal custom renderer only as a last resort.

**Estimated code:** 200–500 LOC adapters, not a terminal rewrite.

**Measurements:** VT fidelity test corpus, IME, resize, copy/paste, alternate buffer, 5-terminal RAM, input latency.

**Success criterion:** passes required VT/IME scenarios with no dependency that is clearly unsupported/unmaintainable.

---

# 12. Recommended architecture / current leading candidate

## Recommended strategic shape: E, instantiated first as A

```text
NativeAIWorkbench.exe (.NET 10, WPF first)
|
+-- SessionRegistry
|    +-- durable logical session IDs
|    +-- provider/browser partition mapping
|    +-- terminal launch descriptors
|    +-- UI layout
|
+-- BrowserManager
|    +-- IBrowserSurface
|         +-- WebView2BrowserSurface     <-- default candidate
|         +-- EdgeCdpBrowserSurface      <-- benchmark challenger / escape hatch
|    +-- ProviderAdapter
|         +-- ChatGPTAdapter
|         +-- ClaudeAdapter
|
+-- ProcessSupervisor.Windows
|    +-- Job Objects
|    +-- ConPTY
|    +-- process leases / accounting
|
+-- WagClient
|    +-- health
|    +-- typed request/response
|    +-- correlation IDs
|    +-- NO policy duplication
|
+-- LocalState
|    +-- metadata store
|    +-- credential references only
|
+-- Telemetry/Bench
     +-- process snapshots
     +-- latency histograms
     +-- crash/recovery events
```

### UI shell

**Initial:** WPF/.NET 10.

**Why:** fewer deployment/runtime variables for the research spike, excellent Win32 interop, no need to introduce Windows App SDK solely for a benchmark.

**Not claimed:** WPF is not declared faster/lighter than WinUI 3.

### Browser default

**Initial leading browser:** WebView2.

**Why:** direct structured API, no unauthenticated external CDP listener, native embedding, official process/crash events, profile support under shared UDF.

### Browser escape hatch

**Edge/CDP adapter:** retained from day one at the interface level, but implemented only in the B spike.
Use when:
- provider login/browser behavior is incompatible with WebView2;
- browser failure isolation benefit is worth the process/window cost;
- user explicitly wants normal Edge behavior for a provider.

### Terminal/process ownership

Every workbench-launched CLI session:
- obtains a logical `ProcessLease`;
- owns a ConPTY;
- is created inside a session Job Object;
- defaults to `KILL_ON_JOB_CLOSE`;
- has no breakaway unless explicitly authorized;
- exposes accounting/exit events to the control plane.

### State ownership

**Belongs in workbench:**
- logical session ID;
- provider ID;
- browser partition/profile mapping;
- last intended URL/workspace;
- UI layout;
- terminal launch descriptors and optional transcript metadata;
- process lease history/audit metadata;
- WAG endpoint profile/reference;
- benchmark/health data;
- credential **references**, not secret blobs.

**Belongs in browser profile:**
- cookies;
- browser login state;
- browser local storage/cache;
- provider page ephemeral state.

**Belongs in WAG:**
- execution authority;
- tool semantics;
- approval/policy;
- WAG-owned capability state;
- execution result canonicality where WAG defines it.

**Does not survive restart as authoritative state:**
- raw PID;
- browser target ID;
- renderer ID;
- window handle;
- DOM node ID;
- CDP object handle.

These are ephemeral and must be re-discovered.

### Crash policy

- Renderer crash -> recover browser surface only.
- WebView2 browser-process crash -> recreate controls in affected partition.
- External Edge crash -> relaunch that browser session if policy allows.
- Native workbench crash -> Job Objects clean up owned terminal/tool trees by default; restart restores **logical descriptors**, not live PIDs.
- WAG unavailable -> workbench remains usable for browser/terminal but authority-required actions fail closed.

### Why not preserve terminal processes through a host crash?

Preserving them requires a separate long-lived supervisor/service, which adds exactly the orphan/background-process complexity this workstation is trying to eliminate. V1 should prefer deterministic cleanup over hidden continuity.

If future evidence shows important multi-hour workloads need survival, add a deliberately separate **persistent job host** with explicit ownership/lease semantics; do not accidentally turn the UI app into one.

---

# 13. Reasons alternatives lost

## C/Tauri 2 — lost the first benchmark slot, not rejected

It uses WebView2 on Windows, so it does not answer the highest-value question better than A. It adds Rust + Tauri IPC/capability configuration + optional JS toolchain. Those may be justified for a cross-platform product, but cross-platform UI is not yet a hard requirement.

Tauri remains the strongest framework alternative if:
- Linux/macOS UI parity becomes a near-term requirement;
- Rust supervision yields a demonstrated reliability benefit;
- WPF/WinUI browser integration hits blockers.

## D/Electron — baseline, not current candidate

Electron is not rejected because of an unmeasured “RAM tax.” It loses on **architectural surface**:
- bundled Chromium + Node + Electron servicing;
- strict remote-content hardening requirements;
- additional Node/npm ecosystem in a workstation explicitly trying to control stale Node process trees;
- Windows Job/ConPTY ownership still needs Windows-specific work.

If A/B both fail or Electron's mature browser embedding solves a concrete provider compatibility problem, benchmark it then.

## WinUI 3 — not the first shell

Microsoft recommends it for new Windows apps, but UI framework choice is not the high-risk architectural unknown. Introducing Windows App SDK packaging/runtime behavior into the first benchmark would confound the browser/process decision.

Revisit when:
- native Windows design/features matter;
- shell UX is stable enough to invest;
- there is evidence WPF blocks a required feature.

## Windows Terminal WPF control — not production dependency

Upstream still does not call it a finished product in 2026. Depending on it now would convert an upstream productization risk into a foundational workstation risk.

## AppContainer for whole workbench — loses on capability fit

The workbench is a local development control plane that must launch tools, access workspaces, and supervise processes. AppContainer is better suited to narrow untrusted helpers.

## Pure localhost HTTP for all internal IPC — loses on unnecessary network surface

Named pipes provide Windows-native ACLs and avoid adding another listening TCP server for private helper IPC. WAG may remain localhost HTTP if that is its existing external contract.

---

# 14. Near-term implementation consequences

Do **not** implement the product. The next implementation owner should create only a benchmark branch/harness.

Suggested future repo structure after repository creation:

```text
native-ai-workbench/
  docs/
    research/
      P2_WINDOWS_NATIVE_AI_WORKBENCH_RESEARCH_2026-09-21.md
  src/
    Workbench.App.Wpf/
    Workbench.Core/
    Workbench.Browser.Abstractions/
    Workbench.Browser.WebView2/
    Workbench.Browser.EdgeCdp/        # only during B spike
    Workbench.Process.Windows/
    Workbench.Wag/
    Workbench.State/
  bench/
    Workbench.Bench/
    scenarios/
    results/
```

### Dependency policy

For the spike:
- .NET 10 LTS;
- Microsoft WebView2 stable SDK;
- no deprecated DevTools protocol wrapper;
- minimal P/Invoke or a narrowly audited Windows interop dependency for Job/ConPTY;
- no general automation framework unless a benchmark specifically needs it;
- no terminal emulator dependency before S6.

### Browser/provider separation

Do not allow code such as this to leak into `Workbench.Core`:

```text
document.querySelector("...ChatGPT-specific-selector...")
```

Provider-specific selectors/queries belong in provider adapters.

Core consumes semantic operations such as:

```text
GetConversationState()
GetVisibleMessages()
FocusComposer()
SubmitUserText(text)   // only when user-authorized workflow requires it
```

Even these operations must be treated as best-effort page adapters, not authority.

### Process policy

A code review rule should eventually be:

> No direct general-purpose process spawn outside `ProcessSupervisor.Windows`.

This is the most important implementation rule for eliminating stale Node/Python/esbuild descendants.

---

# 15. Reusable findings for the other projects

## COMMON-1 — process ownership should be created, not discovered

Job Objects show a reusable Windows principle: ownership must be established at spawn time and represented as a lease. Process-name cleanup is a fallback diagnostic, not architecture.

Applicable to: P1/P2/P3/COMMON.

## COMMON-2 — separate logical durable state from OS/browser ephemeral identifiers

Never persist PID/window handle/renderer ID/CDP object ID as canonical restart state. Persist a logical descriptor and re-discover runtime objects.

Applicable to: P1/P2/P3/WAG.

## COMMON-3 — browser storage isolation and browser process isolation are different dimensions

Profiles can isolate browser storage while sharing a browser process. Separate UDFs/instances increase failure isolation but cost more resources.

Applicable to any browser-native project.

## COMMON-4 — structured browser control exists below UI Automation

CDP/WebView2 APIs expose DOM/runtime/network/log domains. UI Automation should not be the default for Chromium surfaces.

Applicable to browser agents, WAG clients, session guardians.

## COMMON-5 — local IPC still needs an authority model

“localhost” and “same machine” are not authorization. Named pipes need explicit DACLs; CDP TCP is documented as unauthenticated.

Applicable to WAG and all local agents.

## COMMON-6 — security boundary should not depend on page cooperation

Remote page JavaScript must not receive privileged native bridges. The trusted host should inspect/control the page from outside the page's authority boundary.

## COMMON-7 — framework “lightness” claims are not evidence

WebView2, Tauri, Electron, external Edge must be compared using the same process-set accounting and workload.

## COMMON-8 — crash recovery is an API contract

Browser adapters need explicit `Health`, `Restart`, and re-discovery behavior. Recovery cannot be scattered across UI event handlers.

## COMMON-9 — cross-platform reuse should happen at protocol/state layers

Share:
- session descriptors;
- WAG client;
- benchmark schema;
- browser/provider abstraction;
- process-lease semantics.

Replace:
- Windows Job Objects/ConPTY with Linux cgroups/namespaces/PTY;
- Windows UI shell with platform-native shell if that remains the performance/reliability optimum.

## COMMON-10 — do not preserve processes by accident

Survival across UI/app restart is a product capability that needs its own owner, lease, and security semantics. Default should be deterministic cleanup.

---

# 16. Open questions

1. Is Windows 11 24H2+ an acceptable hard minimum for v1, allowing `ReleasePseudoConsole` to be assumed?
2. Do any target provider login flows reject or degrade WebView2 in practice?
3. Is one UDF/five profiles stable enough under five real AI sessions, or is provider-level UDF partitioning better?
4. Can external Edge's `--remote-debugging-pipe` be consumed cleanly from the chosen .NET CDP client without a custom fragile transport?
5. Does job-owning external Edge conflict with Chromium sandbox/job behavior?
6. What terminal renderer has the best maintenance/reliability profile after browser architecture is selected?
7. Does the workstation require terminal survival across workbench crashes, or is deterministic cleanup preferable?
8. What exact WAG client transport/auth contract should the workbench consume?
9. Should durable local state be an atomic JSON document or SQLite? This depends on whether audit/event history becomes a requirement; either is sufficient for the first one-session spike.
10. Which provider operations actually need DOM/CDP control versus simple human interaction in the embedded/external browser?
11. What five-session memory ceiling is acceptable on the target workstation? Architecture selection should use a user-defined ceiling after first measurements.
12. Is cross-platform UI a real 6–12 month requirement? If yes, Tauri deserves an earlier revisit.

---

# 17. Handoff capsule

## 10 most important confirmed facts

1. **WebView2 is Chromium multi-process; same-UDF WebViews can share a browser process.** `[WEBVIEW2-001]`
2. **Multiple WebView2 profiles under one UDF separate cookies/preferences/storage without requiring separate UDFs.** `[WEBVIEW2-002]`
3. **A WebView2 browser-process crash closes controls in that process group, but the native host can recreate them via documented failure events.** `[WEBVIEW2-003]`
4. **WebView2 exposes direct CDP plus native network events; UI Automation is not required for normal DOM/network/console access.** `[WEBVIEW2-004]` `[WEBVIEW2-005]`
5. **External Edge CDP is feasible with distinct user-data directories, but the normal WebSocket connection is documented as unauthenticated and policy can disable remote debugging.** `[EDGE-CDP-001]` `[EDGE-CDP-002]` `[EDGE-CDP-003]`
6. **Windows Job Objects are the correct process-tree ownership primitive; kill-on-job-close and child inheritance directly address stale CLI descendants.** `[JOB-001]` `[JOB-002]`
7. **`PROC_THREAD_ATTRIBUTE_JOB_LIST` lets ownership be applied at process creation, avoiding an attach-after-spawn race.** `[JOB-004]`
8. **ConPTY is the supported pseudoterminal API; Windows 11 24H2 adds `ReleasePseudoConsole` for cleaner lifecycle handling.** `[CONPTY-001]` `[CONPTY-002]`
9. **Windows Terminal's WPF terminal control exists but remains unproductized upstream in 2026.** `[WT-CTRL-001]` `[WT-CTRL-002]`
10. **Tauri uses WebView2 on Windows; Electron bundles Chromium+Node. Neither has measured five-session superiority in this report.** `[TAURI-001]` `[ELECTRON-002]`

## 5 remaining uncertainties

1. Actual ChatGPT/Claude login/session compatibility inside WebView2.
2. Actual five-session RAM/CPU and best WebView2 UDF/profile topology.
3. Practical/security viability of Edge `--remote-debugging-pipe`.
4. External Edge behavior when launched inside a Windows Job Object.
5. Production terminal renderer choice.

## Recommended next action

Create a **benchmark-only** repository/worktree and implement **S1 + S2**, then S3/S4 using the same core. Do not build product UI, updater, plugin system, or long-lived service.

Order:

```text
S1 ProcessSupervisor(Job Objects + ConPTY)
 -> prove zero orphan cleanup
S2 A one-session WebView2 vertical slice
 -> prove provider/login + structured control + crash recovery
S3 A five-session UDF topology
 -> measure resource/failure tradeoff
S4 B external Edge adapter
 -> measure same scenarios
S5 A/B decision
```

## Exact artifacts another session should consume

Current artifact from P2:

- `P2_WINDOWS_NATIVE_AI_WORKBENCH_RESEARCH_2026-09-21.md` — this file, including Evidence Ledger and spike criteria.

When implementation starts, the implementation owner should also consume the **canonical WAG interface/authority documentation from the WAG repository** rather than infer it from this report. This report intentionally does not duplicate WAG's contract.

Benchmark artifacts do **not** exist yet. When created, use deterministic names such as:

- `bench/results/P2_S1_PROCESS_OWNERSHIP.json`
- `bench/results/P2_S3_WEBVIEW2_5SESSION.json`
- `bench/results/P2_S4_EDGE_CDP_5SESSION.json`
- `docs/adr/ADR_BROWSER_SURFACE_SELECTION.md`

These names are recommendations for future artifacts, not claims that they already exist.

## Research that SHOULD NOT be repeated

Do not re-research these questions unless a relevant upstream release materially changes or a local test contradicts the docs:

- whether WebView2 is multi-process;
- whether shared UDF + multiple profiles can separate browser storage;
- whether multiple UDFs add browser-process/resource cost;
- whether WebView2 exposes direct CDP;
- whether WebView2 has documented process-failure recovery events;
- whether Edge supports external CDP and distinct user-data directories;
- whether Edge CDP WebSocket is authenticated;
- whether Edge policy can disable remote debugging;
- whether ConPTY exists/is the supported pseudoterminal primitive;
- whether Job Objects support child inheritance, nested jobs, kill-on-close, and completion-port notifications;
- whether named pipes can be protected with DACLs;
- whether Windows Terminal's WPF control is officially productized;
- whether Tauri on Windows uses WebView2;
- whether Electron bundles Chromium and Node.

Repeat research only to:
- refresh versions at implementation time;
- challenge a high-confidence claim with new upstream evidence;
- narrow a fact after empirical test results expose a specific discrepancy.

---

## Final research decision

**Benchmark locally only these two architectures first:**

1. **A — .NET 10/WPF + embedded WebView2 + ConPTY + Job Objects + structured local IPC + WAG client.**
2. **B — .NET 10/WPF + external Edge/CDP + ConPTY + Job Objects + structured local IPC + WAG client.**

**Current leading strategic architecture:** native .NET control plane with a replaceable browser-surface adapter; WebView2 is the default candidate, external Edge/CDP is the challenger/escape hatch.

No claim that A is lighter than B, Tauri, or Electron is made until the defined local measurements exist.