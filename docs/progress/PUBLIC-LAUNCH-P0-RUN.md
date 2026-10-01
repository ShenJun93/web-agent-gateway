# PUBLIC-LAUNCH-P0-RUN

## Baseline

Task: initialize public-launch P0 lane  
State: DONE  
Evidence:
- base branch: feat/wag-local-m7-remote-architecture-gate-v1
- base HEAD: ae5417937650600055bd2363cd663097bc279ac0
- live runtime source HEAD: 12ea8315b650e8df11ddc1483c4ee4d2e764a48e
- merge-base(live, base) = live HEAD, so base contains the live runtime lineage
- lane: feat/wag-public-launch-p0-v1
- WAG Local authority: AUTONOMOUS_LOCAL
Files changed:
- docs/superpowers/plans/2026-10-01-wag-public-community-launch-p0-v1.md
- docs/superpowers/plans/2026-10-01-wag-browser-v2-hybrid-local-hardening.md
- docs/progress/PUBLIC-LAUNCH-P0-RUN.md
Tests:
- not run yet
Known remaining risk:
- Remote Ref Inspect not implemented yet.
- Browser v2 feasibility not executed yet.
Next:
- implement bounded read-only git.remote.inspect using existing remote-push Git safety policy.

---

Task: Remote Git Read / Ref Inspect v1  
State: DONE  
Evidence:
- implemented `git.remote.inspect` as a read-only open-world MCP tool;
- exact configured remote name only; caller cannot inject a URL;
- explicit `refs/heads/*` list, max 32; missing ref returns `null`;
- reuses bounded remote-push safe Git environment/config/credential/URL policy;
- backend observation uses `ls-remote --symref` and performs no fetch/local-ref mutation;
- real `origin` dogfood read `refs/heads/main=033a913c2f05b8b9a62c376a70832e7ae9f9e91c`;
- feature ref `refs/heads/feat/wag-public-launch-p0-v1` correctly observed as absent;
- focused suite 50/50 PASS;
- production-local/runtime acceptance 25/25 PASS;
- typecheck PASS;
- build PASS;
- git diff --check PASS.
Files changed:
- src/remote-git-push.ts
- src/remote-git-push-backend.ts
- src/server.ts
- test/remote-git-push-backend.test.ts
- test/remote-git-push.test.ts
- test/remote-git-push-mcp.test.ts
- test/dc-replacement-surface.test.ts
- test/dc-replacement.acceptance.ts
- docs/benchmarks/2026-10-01-wag-remote-git-inspect-v1.md
Tests:
- 50/50 focused remote Git/surface PASS
- 25/25 production-local/runtime acceptance PASS
Known remaining risk:
- implementation is not promoted to the currently live 53-tool runtime;
- authentication capability does not assert remote write permission.
Next:
- commit Remote Git Inspect and canonical public-launch plans;
- begin Browser v2 baseline + extension/nativeMessaging ATTACH_EXISTING feasibility spike.

---

Task: Browser v2 STOP 0 — baseline architecture and regression lock
State: DONE
Evidence:
- current BrowserPort remains seven semantic/effect tools;
- current production browser backend is WAG-owned dedicated headless Edge over loopback CDP;
- semantic snapshot/click/fill/press implementation inventoried;
- exact-once effect ledger/recovery behavior confirmed;
- shipped extension has nativeMessaging but no debugger/tabs permission and only ChatGPT tab scanning;
- ATTACH_EXISTING, WAG_VISIBLE, per-target fencing, OAuth target continuity and browser-session recovery are NOT IMPLEMENTED;
- one stale fixed total-tool-count assertion was converted to a delta invariant (current surface + exactly seven BrowserPort tools);
- focused browser/extension baseline rerun = 71/71 PASS;
- architecture does not materially contradict Browser v2 plan.
Files changed:
- test/browser-harness-mcp-surface.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop0-baseline.md
- docs/progress/PUBLIC-LAUNCH-P0-RUN.md
Tests:
- 71/71 focused BrowserPort/CDP/extension/native-messaging baseline PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- debugger permission/attach feasibility has not yet been exercised against real Edge;
- native control bridge for runtime-initiated existing-tab actions is not implemented;
- current live runtime remains legacy and is not promoted from this lane.
Next:
- STOP 0 report;
- after continuation, execute Browser v2 extension/nativeMessaging ATTACH_EXISTING feasibility spike before BrowserBroker implementation.

---

Task: Browser v2 Task 0.5 — extension debugger ATTACH_EXISTING feasibility spike
State: DONE
Evidence:
- added bounded existing-tab controller using extension `tabs` + `debugger` APIs;
- shipped extension branch now declares `debugger` and `tabs` permissions;
- no raw CDP surface added to MCP;
- discovery strips credentials/query/fragment and rejects non-http(s) targets;
- focused controller/extension suite = 26/26 PASS;
- real Microsoft Edge smoke with a temporary profile = PASS;
- real smoke target was inactive before attach and active tab remained stable;
- debugger attach/probe/detach succeeded;
- query secret did not leak through discovery/probe output;
- release preserved the target tab/browser;
- initial headless harness attempts exposed an Edge limitation (multiple initial headless targets); harness was corrected to create the inactive target through the extension and run the final proof in an off-screen visible temporary Edge window.
Files changed:
- browser/extension/existing-browser-control-v1.js
- browser/extension/existing-browser-control-v1.d.ts
- browser/extension/manifest.json
- browser/extension/service-worker.js
- test/browser-existing-control-v1.test.ts
- test/browser-extension-core.test.ts
- scripts/spike-existing-browser-attach.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-existing-tab-attach-spike.md
Tests:
- 26/26 focused controller/extension PASS
- real Edge temporary-profile attach smoke PASS
Known remaining risk:
- user's actual authenticated profile acceptance NOT EXECUTED;
- enterprise/debugger policy behavior NOT MEASURED;
- native runtime -> extension Browser v2 control bridge NOT IMPLEMENTED;
- target ownership/fencing NOT IMPLEMENTED.
Next:
- commit feasibility spike;
- proceed to BrowserBroker Task 1 with EXTENSION_DEBUGGER_FIRST as the ATTACH_EXISTING transport.

---

Task: Browser v2 Task 1 — BrowserBroker + managed visible/headless modes
State: DONE
Evidence:
- introduced one BrowserBroker routing layer over shared BrowserPort/semantic infrastructure;
- `AUTO` remains conservative and resolves to `WAG_HEADLESS` until existing-target discovery is implemented;
- `WAG_HEADLESS` preserves the current dedicated WAG-owned Edge behavior;
- `WAG_VISIBLE` uses the same owned Edge/CDP/semantic stack without `--headless=new`;
- visible Pause -> Take Control -> Resume is implemented without adding MCP tools;
- control transitions are bounded `browser.exec` actions and remain exact-once effects;
- resume revalidates through a fresh snapshot before automation returns to RUNNING;
- `ATTACH_EXISTING` fails closed until the extension/native runtime bridge lands;
- real Windows Edge mode smoke PASS;
- broad relevant regression = 101/101 PASS across two non-overlapping batches;
- typecheck/build/diff-check PASS.
Files changed:
- src/browser-harness/browser-broker.ts
- src/browser-harness/browser-port.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/edge-launch-plan.ts
- src/browser-harness/owned-edge-launcher.ts
- src/server.ts
- scripts/spike-browser-broker-modes.ts
- test/browser-harness-broker.test.ts
- test/browser-harness-edge-launch-plan.test.ts
- test/browser-harness-mcp-surface.test.ts
- test/browser-harness-owned-edge-cdp-backend.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop1-browser-broker.md
Tests:
- focused Task 1 = 10/10 PASS
- BrowserPort/extension regression batch A = 71/71 PASS
- BrowserPort/private-browser regression batch B = 30/30 PASS
- real Edge BrowserBroker smoke = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- ATTACH_EXISTING runtime bridge NOT IMPLEMENTED;
- authenticated user-profile attach acceptance NOT EXECUTED;
- enterprise debugger policy behavior NOT MEASURED;
- per-target claim epoch/fencing NOT IMPLEMENTED;
- total Chromium process-tree memory NOT MEASURED.
Next:
- STOP 1 report;
- after continuation, implement Tasks 2-3 existing-target discovery + native runtime/extension attach/release bridge.

---

Task: Browser v2 Tasks 2-3 — existing-target discovery + safe attach/release
State: PARTIAL / VERIFICATION BLOCKED
Evidence:
- added read-only `browser.targets` with sanitized target metadata and no focus mutation;
- `browser.open(ATTACH_EXISTING)` now requires an exact `target_id`;
- added a dedicated Browser Control protocol/channel separate from operator v4 and delegation v5;
- added loopback bearer-authenticated native-host bridge with multi-client request multiplexing;
- added AttachedExistingBrowserPort so attached tabs reuse the same semantic Browser layer;
- internal CDP transport is strict allowlist only; `Runtime.evaluate` is denied;
- release detaches and does not close the target/browser;
- Browser/extension regression batch A = 72/72 PASS;
- Browser/private-runtime regression batch B = 30/30 PASS;
- new Browser Control contract tests = 10/10 PASS;
- full source ATTACH_EXISTING integration = 1/1 PASS;
- typecheck/build/diff-check PASS before receipt write;
- dedicated Browser Control SEA build PASS;
- built artifact sha256 = 8a74004bb4611bb1bcf6e22ed3f5b91c69a384afad999834077ce7278c67d014;
- real Edge native-host acceptance attempted but Windows Code Integrity events 3033/3077 denied the unsigned executable for Enterprise signing level policy {d8809ec6-f1a7-485c-bd87-9e2fd18c8bec};
- no security policy was weakened;
- temporary Edge native-host registry key restored to ABSENT;
- browser-control-v1 discovery file absent after cleanup.
Files changed:
- browser/extension/existing-browser-control-v1.js
- browser/extension/existing-browser-control-v1.d.ts
- browser/extension/native-browser-control-v1.js
- browser/extension/native-browser-control-v1.d.ts
- browser/extension/service-worker.js
- package.json
- scripts/accept-browser-v2-existing-runtime.ts
- scripts/build-browser-control-native-host.ts
- src/browser-adapter/existing-browser-control-protocol.ts
- src/browser-adapter/native-host-browser-control.ts
- src/browser-adapter/native-host-browser-control-main.ts
- src/browser-adapter/native-host-manifest-browser-control.ts
- src/browser-harness/attached-existing-browser-port.ts
- src/browser-harness/existing-browser-control-client.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/browser-port.ts
- src/repository-engineering-runtime.ts
- src/server.ts
- test/browser-existing-runtime.integration.test.ts
- test/browser-harness-attached-existing-port.test.ts
- test/browser-harness-broker.test.ts
- test/browser-harness-mcp-surface.test.ts
- test/browser-native-control-host.test.ts
- test/browser-native-control-manifest.test.ts
- test/browser-native-control-v1.test.ts
- test/existing-browser-control-protocol.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop2-existing-attach.md
Tests:
- 72/72 browser/extension regression PASS
- 30/30 private-browser regression PASS
- 10/10 Browser Control new contract PASS
- 1/1 full source ATTACH_EXISTING integration PASS
- typecheck PASS
- build PASS
Known remaining risk:
- real Edge native-host end-to-end acceptance VERIFICATION BLOCKED by Windows signing policy;
- per-target claim epoch/fencing NOT IMPLEMENTED;
- actual user's authenticated profile acceptance NOT EXECUTED;
- installer registration for Browser Control native host NOT IMPLEMENTED.
Next:
- commit Tasks 2-3 implementation and STOP 2 receipt;
- do not promote or treat STOP 2 as PASS until trusted/signed host execution can be verified.

---

Task: Browser v2 STOP 2B — AI Tab Group + loopback WebSocket transport
State: DONE / BRANCH ACCEPTED
Evidence:
- added `AI_TAB_GROUP` as an attached-existing-browser execution mode;
- exact existing tabs can be grouped with `chrome.tabs.group` + `chrome.tabGroups.update` while preserving the active user tab;
- group metadata is carried on the logical browser session;
- grouping fails closed if active-tab identity changes;
- Browser v2 control transport pivoted from a dedicated unsigned native executable to authenticated `ws://127.0.0.1` between the extension and WAG Local;
- WebSocket server is loopback-only, exact-extension-Origin checked, pairing-token authenticated, payload bounded and request-correlated;
- Browser v2 no longer requires `wag-native-browser-control.exe` for the accepted AI Tab Group path;
- semantic fill/click operate inside the exact browser target and do not use Windows UIAutomation or operating-system pointer injection;
- semantic click prefers a WAG-owned fixed `element.click()` function via bounded `DOM.resolveNode` + exact `Runtime.callFunctionOn`; arbitrary runtime JavaScript remains denied;
- target-scoped CDP pointer input remains only a fallback for DOM nodes without a click method;
- real Microsoft Edge temporary-profile acceptance PASS with authenticated local fixture;
- acceptance verified target initially inactive, active user tab stable, fill/click SUCCEEDED, final state observed, target/browser preserved after release;
- native Browser Control executable used = NO;
- user real profile used = NO;
- latest broad Browser/runtime regression = 136/136 PASS;
- final typecheck/build/diff-check PASS.
Files changed include:
- browser/extension/browser-control-websocket-v1.js + d.ts
- browser/extension/existing-browser-control-v1.js + d.ts
- browser/extension/manifest.json
- browser/extension/service-worker.js
- browser/extension/native-browser-control-v1.js + d.ts (legacy protocol parity)
- src/browser-harness/browser-control-websocket-server.ts
- src/browser-harness/attached-existing-browser-port.ts
- src/browser-harness/browser-broker.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/browser-port.ts
- src/browser-harness/existing-browser-control-client.ts
- src/browser-harness/semantic-browser.ts
- src/browser-adapter/existing-browser-control-protocol.ts
- src/repository-engineering-runtime.ts
- src/server.ts
- package.json / package-lock.json
- scripts/accept-browser-v2-ai-tab-group.ts
- focused Browser/WebSocket/semantic tests
- docs/benchmarks/2026-10-01-wag-browser-v2-stop2b-ai-tab-group-websocket.md
Tests:
- Browser/extension/WebSocket batch A = 75/75 PASS
- Browser MCP/semantic/private-browser batch B = 38/38 PASS
- control protocol/runtime assembly batch C = 23/23 PASS
- total latest broad regression = 136/136 PASS
- real Edge AI_TAB_GROUP acceptance = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED;
- PRODUCTION_PAIRING_UX = NOT_COMPLETE;
- PER_TARGET_FENCING = NOT_IMPLEMENTED;
- CROSS_PROCESS_MULTI_SESSION = NOT_PROVEN;
- AUTO does not yet automatically select AI_TAB_GROUP;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 2B;
- Task 4: per-target claim epoch / fencing / stale-owner recovery before multi-session acceptance.

---

Task: Browser v2 STOP 3 / Task 4 — per-target ownership, claim epoch and fencing
State: DONE / BRANCH ACCEPTED
Evidence:
- durable SQLite per-target claim store; no global browser Goal Lease;
- claim identity binds target_id + owner/session/adapter + browser_session_id + monotonic claim_epoch;
- claim is acquired before group/debugger attach;
- active same-target conflict fails TARGET_OWNED_BY_OTHER_SESSION before debugger attach;
- expired exact owner reports TARGET_STALE; a superseded epoch reports TARGET_FENCED;
- expired/released claims may be succeeded only at claim_epoch + 1;
- heartbeat keeps active attached sessions alive; process death permits expiry/recovery;
- attached describe/snapshot/exec/screenshot/close revalidate the exact claim before browser dispatch;
- stale owner exec is fenced before control.exec;
- stale owner close is fenced before control.release, so it cannot detach a successor debugger session;
- release preserves the row as RELEASED, so epoch never resets across release or SQLite reopen;
- two independent DatabaseSync connections to one claim database prove cross-process durable exclusion/succession;
- attached-browser effect fingerprints include target_id + claim_epoch;
- same browser session/idempotency key with changed epoch conflicts instead of replaying;
- WAG_VISIBLE/WAG_HEADLESS exact-once paths remain unchanged;
- real Edge AI_TAB_GROUP regression remains PASS after fencing;
- latest broad Browser/runtime regression = 141/141 PASS;
- focused claim/fencing = 5/5 PASS;
- effect fingerprint epoch-binding regression PASS;
- typecheck/build/diff-check PASS.
Files changed:
- src/browser-harness/browser-target-claim-store.ts
- src/browser-harness/attached-existing-browser-port.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/browser-port.ts
- src/repository-engineering-runtime.ts
- test/browser-target-claim-store.test.ts
- test/browser-target-fencing.integration.test.ts
- test/browser-harness-attached-existing-port.test.ts
- test/browser-harness-mcp-runtime.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop3-target-fencing.md
Tests:
- Browser/extension/WebSocket batch A = 75/75 PASS
- Browser MCP/semantic/private-browser batch B = 38/38 PASS
- control/runtime/claim-fencing batch C = 28/28 PASS
- total broad Browser regression = 141/141 PASS
- final claim store + fencing integration = 5/5 PASS
- real Edge AI_TAB_GROUP regression = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN;
- FRAMEWORK_SAFE_FILL = NOT PROVEN;
- RICH_TEXT_FILL = NOT PROVEN;
- OAUTH_TARGET_CONTINUITY = NOT IMPLEMENTED;
- BROWSER_SESSION_RECOVERY = NOT IMPLEMENTED;
- PRODUCTION_PAIRING_UX = NOT_COMPLETE;
- USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED;
- AUTO does not yet select AI_TAB_GROUP;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 3 / Task 4;
- proceed to framework-safe fill acceptance without changing the public seven-tool BrowserPort surface.
