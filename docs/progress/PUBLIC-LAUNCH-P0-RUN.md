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

---

Task: Browser v2 STOP 4 / Task 5 — framework-safe fill
State: DONE / BRANCH ACCEPTED
Evidence:
- native input/textarea fill now prefers a WAG-owned fixed native prototype value-setter path;
- fixed fill dispatches bubbling input + change events so controlled frameworks observe replacement;
- returned element value is verified against requested text before semantic success;
- prior Ctrl+A/Input.insertText path remains only as bounded fallback for non-native editable surfaces;
- arbitrary Runtime.evaluate remains denied;
- Runtime.callFunctionOn remains exact-function allowlisted and exact-parameter bounded;
- real Edge acceptance proves exact replacement instead of append for pre-populated plain input and textarea;
- real React 19.2 controlled input state updates from react-old to react-new;
- rendered React state postcondition becomes react-state:react-new;
- controlled validation postcondition becomes validation:valid:valid-text;
- submit button becomes enabled from React state;
- AI_TAB_GROUP active user tab remains unchanged;
- Windows UIAutomation and OS pointer injection remain unused;
- ws direct dependency upgraded 8.18.3 -> 8.22.0 after production dependency audit;
- npm audit --omit=dev reports 0 vulnerabilities;
- dev-only React 19.2.0/react-dom 19.2.0 are used only to bundle the real-framework acceptance fixture;
- latest broad Browser/runtime regression = 143/143 PASS;
- real Edge framework-safe fill acceptance = PASS;
- real Edge AI_TAB_GROUP regression = PASS;
- typecheck/build/diff-check PASS.
Files changed:
- src/browser-harness/semantic-browser.ts
- browser/extension/existing-browser-control-v1.js
- test/browser-harness-semantic.test.ts
- test/browser-existing-control-v1.test.ts
- scripts/accept-browser-v2-framework-fill.ts
- package.json
- package-lock.json
- docs/benchmarks/2026-10-01-wag-browser-v2-stop4-framework-safe-fill.md
Tests:
- focused fill/browser suite = 22/22 PASS
- Browser/extension/WebSocket batch A = 76/76 PASS
- Browser MCP/semantic/private-browser batch B = 39/39 PASS
- control/runtime/claim-fencing batch C = 28/28 PASS
- total broad Browser regression = 143/143 PASS
- real Edge framework-safe fill acceptance = PASS
- real Edge AI_TAB_GROUP regression = PASS
- npm audit --omit=dev = 0 vulnerabilities
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- RICH_TEXT_CONTENTEDITABLE = NOT_PROVEN;
- PROSEMIRROR_TIPTAP = NOT_PROVEN;
- OAUTH_TARGET_CONTINUITY = NOT_IMPLEMENTED;
- BROWSER_SESSION_RECOVERY = NOT_IMPLEMENTED;
- CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN;
- PRODUCTION_PAIRING_UX = NOT_COMPLETE;
- USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED;
- AUTO_AI_TAB_GROUP_SELECTION = NOT_IMPLEMENTED;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 4 / Task 5;
- proceed to Task 6 rich-text/contenteditable acceptance.

---

Task: Browser v2 STOP 5 / Task 6 — rich-text/contenteditable
State: DONE / BRANCH ACCEPTED
Evidence:
- AX semantic parser now accepts editable=true, plaintext and richtext tokens;
- real Chromium ProseMirror richtext node is discovered as semantic editable;
- background Ctrl+A fallback was rejected by real contenteditable postcondition failure;
- rich editable replacement now uses exact WAG-owned contenteditable selection inside the attached target followed by bounded Input.insertText;
- fixed selection function is exact allowlisted; extra arguments or modified arbitrary function bodies are rejected;
- Runtime.evaluate remains denied;
- real Edge plain contenteditable model postcondition PASS;
- real ProseMirror EditorState.doc.textContent replacement PASS;
- real TipTap editor.getText replacement PASS;
- replacement-not-append PASS;
- active user tab remains stable; no Windows UIAutomation or OS pointer injection;
- Task 5 native/React fill regression remains PASS;
- AI_TAB_GROUP snapshot/fill/click regression remains PASS;
- broad Browser/runtime regression = 145/145 PASS;
- focused rich-text/security tests = 17/17 PASS;
- typecheck/build/diff-check PASS;
- npm audit --omit=dev = 0 vulnerabilities.
Files changed:
- src/browser-harness/semantic-browser.ts
- browser/extension/existing-browser-control-v1.js
- test/browser-harness/semantic.test.ts
- test/browser-existing-control-v1.test.ts
- scripts/accept-browser-v2-rich-text.ts
- package.json
- package-lock.json
- docs/benchmarks/2026-10-01-wag-browser-v2-stop5-rich-text.md
Tests:
- Browser/extension/WebSocket batch A = 77/77 PASS
- Browser MCP/semantic/private-browser batch B = 40/40 PASS
- control/runtime/claim-fencing batch C = 28/28 PASS
- total broad Browser regression = 145/145 PASS
- real Edge rich-text/contenteditable/ProseMirror/TipTap = PASS
- real Edge framework-safe fill = PASS
- real Edge AI_TAB_GROUP regression = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
- npm audit --omit=dev = 0 vulnerabilities
Known remaining risk:
- OAUTH_TARGET_CONTINUITY = NOT_IMPLEMENTED;
- BROWSER_SESSION_RECOVERY = NOT_IMPLEMENTED;
- CROSS_PROCESS_WEBSOCKET_CONTROL = NOT_PROVEN;
- PRODUCTION_PAIRING_UX = NOT_COMPLETE;
- USER_REAL_PROFILE_ACCEPTANCE = NOT_EXECUTED;
- AUTO_AI_TAB_GROUP_SELECTION = NOT_IMPLEMENTED;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 5 / Task 6;
- proceed to OAuth/new-target continuity.

---

Task: Browser v2 STOP 6 — OAuth / successor-target continuity
State: DONE / BRANCH ACCEPTED
Evidence:
- added bounded `target.watch` + `target.continuity` protocol for existing-tab workflow continuity;
- extension observes same-tab URL changes plus new tabs/windows through bounded tab activity and opener ancestry;
- successor selection ignores unrelated new tabs and strips query/hash/credentials from target metadata;
- one logical `browser_session_id` now preserves `rootTargetId` while current `targetId` may change;
- `targetGeneration` increments on root -> successor -> root transitions;
- successor targets are claimed with the existing per-target claim_epoch fencing model before debugger attach;
- AI_TAB_GROUP groups successor targets without intentionally activating user tabs;
- previous debugger target detaches only after successor claim/group/attach succeeds;
- all retained root/successor claims are released on logical session close;
- Browser MCP refreshes target/claim fencing after continuity-changing snapshot/screenshot observations;
- fixed DOM click gains exact bounded CDP `userGesture:true` only for the WAG-owned click function so OAuth popup/new-window flows can launch without OS pointer injection;
- arbitrary Runtime.evaluate remains denied and Runtime.callFunctionOn remains exact-function/shape allowlisted;
- real Edge local OAuth-shaped flow PASS: root app -> popup successor -> callback -> root;
- same browser_session_id preserved, successor generation 1, final generation 2;
- authenticated app session preserved and original user holder tab stayed active;
- latest broad Browser/runtime regression = 149/149 PASS;
- real Edge AI_TAB_GROUP/framework-fill/rich-text regression reruns PASS;
- typecheck/build/diff-check PASS.
Files changed include:
- browser/extension/existing-browser-control-v1.js + d.ts
- browser/extension/native-browser-control-v1.js + d.ts
- src/browser-adapter/existing-browser-control-protocol.ts
- src/browser-harness/attached-existing-browser-port.ts
- src/browser-harness/browser-control-websocket-server.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/browser-port.ts
- src/browser-harness/existing-browser-control-client.ts
- src/browser-harness/semantic-browser.ts
- scripts/accept-browser-v2-oauth-continuity.ts
- test/browser-oauth-continuity.test.ts
- related Browser/WebSocket/native/fencing integration fixtures
- docs/benchmarks/2026-10-01-wag-browser-v2-stop6-oauth-continuity.md
Tests:
- browser/extension/OAuth batch A = 76/76 PASS
- Browser MCP/semantic batch B = 44/44 PASS
- control/runtime/fencing batch C = 29/29 PASS
- total broad Browser/runtime regression = 149/149 PASS
- real Edge OAuth successor-target continuity = PASS
- real Edge AI_TAB_GROUP regression = PASS
- real Edge framework-safe fill regression = PASS
- real Edge rich-text/ProseMirror/TipTap regression = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- REAL_EXTERNAL_OAUTH_PROVIDER = NOT_EXECUTED;
- USER_DAILY_EDGE_PROFILE = NOT_EXECUTED;
- CROSS_RUNTIME_SESSION_RECOVERY = NOT_IMPLEMENTED;
- PRODUCTION_PAIRING_UX = NOT_COMPLETE;
- AUTO does not yet automatically select AI_TAB_GROUP;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 6;
- proceed to Browser v2 runtime/session recovery without public push or live promotion.

---

Task: Browser v2 STOP 7 — runtime/session recovery
State: DONE / BRANCH ACCEPTED
Evidence:
- added durable attached-browser session store keyed by logical browser_session_id;
- persisted execution mode, control state, root/current target, target_generation, claim epochs, retained OAuth target claims, AI tab group metadata and lifecycle state;
- graceful restart uses suspendForRestart: detach target, release retained claims, mark session RECOVERABLE, close runtime-local stores;
- successor runtime recovers the same browser_session_id at fresh claim epochs and restores target/group/continuity binding;
- second runtime is blocked while the prior lease is still live and cannot steal/detach the target;
- crash semantics fail closed until lease expiry; exact stale epoch is fenced after a successor claim;
- multi-target OAuth recovery is atomic in one SQLite transaction so partial epoch advancement cannot occur;
- prior durable exact-once receipts survive restart and completed consequential effects are not replayed;
- real Edge runtime/control-plane recovery acceptance PASS: browser_session_id stable, epoch 1->2, extension reconnect PASS, old effect replay blocked, consequential click count remained exactly 1, active tab stable, target/browser preserved;
- real Edge AI_TAB_GROUP regression PASS after recovery changes;
- real Edge OAuth continuity regression PASS after recovery changes;
- broad Browser/runtime regression = 152/152 PASS;
- focused recovery suite = 19/19 PASS;
- typecheck/build/diff-check PASS.
Files changed:
- src/browser-harness/browser-attached-session-store.ts
- src/browser-harness/browser-target-claim-store.ts
- src/browser-harness/attached-existing-browser-port.ts
- src/browser-harness/browser-broker.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/repository-engineering-runtime.ts
- scripts/accept-browser-v2-runtime-recovery.ts
- test/browser-attached-session-store.test.ts
- test/browser-runtime-session-recovery.test.ts
- test/browser-target-claim-store.test.ts
- test/browser-harness-attached-existing-port.test.ts
- test/browser-harness-mcp-runtime.test.ts
- test/browser-harness-mcp-surface.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop7-runtime-recovery.md
Tests:
- Browser/extension/WebSocket batch A = 77/77 PASS
- Browser MCP/semantic/recovery batch B = 43/43 PASS
- control/private-runtime/assembly batch C = 32/32 PASS
- total broad Browser/runtime = 152/152 PASS
- focused recovery = 19/19 PASS
- real Edge runtime recovery = PASS
- real Edge AI_TAB_GROUP = PASS
- real Edge OAuth continuity = PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- user daily Edge profile recovery NOT EXECUTED;
- real OS-process SIGKILL recovery NOT EXECUTED;
- AUTO authenticated-target selection NOT FINALIZED;
- production pairing UX NOT COMPLETE;
- P2 diagnostics/resource bounds PENDING;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 7;
- after continuation, implement P2 sanitized diagnostics/resource bounds and final Browser v2 public-launch gate.

---

Task: Browser v2 STOP 8 — sanitized diagnostics + resource bounds
State: DONE / BRANCH ACCEPTED
Evidence:
- added dedicated persistent Browser v2 diagnostics ring with exact-key schema validation;
- diagnostics store only sequence/time/duration/action/success, opaque browser/target ids, ownership mode, bounded error class, target-changed and recovered booleans;
- diagnostics never store URL/title/page text/node text/form content/arguments/idempotency keys/cookies/tokens/OAuth codes/credentials/profile paths/exception messages/screenshots;
- injected password/token/URL/form-shaped exception content confirmed absent from serialized diagnostics;
- diagnostics capacity default 256, configurable only 16..2048, recent read capped at 100;
- raw AX-tree processing capped at 2,000 source nodes before semantic refs are created;
- public browser snapshot remains capped at 500 nodes and propagates truncated=true;
- active Browser MCP sessions capped at 32, with the 33rd denied before backend open;
- browser screenshot capped at 8 MiB decoded data with pre-decode base64 length guard;
- Browser Control WebSocket pending requests capped at 128;
- targets.list capped at 512 entries;
- non-screenshot Browser Control responses capped at 256 KiB;
- screenshot WebSocket envelope remains separately bounded to the 8 MiB screenshot policy;
- recovery diagnostics distinguish blocked live-lease recovery from successful successor recovery without content leakage;
- latest broad Browser/runtime regression = 161/161 PASS;
- focused P2 resource/diagnostics/transport = 11/11 PASS;
- final recovery/diagnostics/resource gate = 8/8 PASS;
- real Edge AI_TAB_GROUP, OAuth continuity and runtime recovery all PASS after final P2 code;
- typecheck/build/diff-check PASS.
Files changed:
- src/browser-harness/browser-runtime-diagnostics.ts
- src/browser-harness/browser-control-websocket-server.ts
- src/browser-harness/browser-mcp-runtime.ts
- src/browser-harness/semantic-browser.ts
- src/repository-engineering-runtime.ts
- test/browser-runtime-diagnostics.test.ts
- test/browser-resource-bounds.test.ts
- test/browser-control-websocket-server.test.ts
- test/browser-runtime-session-recovery.test.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop8-diagnostics-resource-bounds.md
Tests:
- Browser/extension/WebSocket A = 80/80 PASS
- Browser MCP/managed B1 = 17/17 PASS
- semantic/recovery/P2 B2 = 32/32 PASS
- control/private-runtime/assembly C = 32/32 PASS
- total = 161/161 PASS
- real Edge AI_TAB_GROUP PASS
- real Edge OAuth continuity PASS
- real Edge runtime recovery PASS
- typecheck PASS
- build PASS
- git diff --check PASS
Known remaining risk:
- AUTO authenticated-existing-target selection NOT FINALIZED;
- production first-time pairing UX NOT COMPLETE;
- user daily Edge profile acceptance NOT EXECUTED;
- real OS-process SIGKILL recovery NOT EXECUTED;
- live runtime remains older and is not promoted from this branch.
Next:
- commit STOP 8;
- continue to Browser v2 final public-launch gate without public push or live promotion.


Task: Browser v2 STOP 9 — AUTO + first-time pairing + final technical precheck
State: DONE / BRANCH ACCEPTED / USER PROFILE GATE PENDING
Evidence:
- AUTO routing finalized:
  - AUTO without exact target_id -> WAG_HEADLESS;
  - AUTO with exact target_id -> AI_TAB_GROUP;
  - no cookie/token inspection is used to infer authentication.
- real Microsoft Edge AUTO acceptance PASS:
  - requestedMode=AUTO;
  - executionMode=AI_TAB_GROUP;
  - ownershipMode=ATTACHED_EXISTING;
  - authenticated fixture session preserved;
  - target initially inactive;
  - user active tab stable;
  - semantic snapshot/fill/click PASS;
  - release kept target and browser open;
  - no Windows UI Automation or OS pointer injection.
- first-time pairing implementation added:
  - read-only `browser-pairing --config <absolute-path>` CLI;
  - side-panel Pair / state / Forget flow;
  - configure/state/clear restricted to derived sidepanel actor;
  - loopback-only endpoint validation retained;
  - pasted pairing payload cleared from DOM after Pair;
  - token not rendered back in status/result UI;
  - pairing CLI does not bootstrap a second runtime.
- focused AUTO/pairing gate = 35/35 PASS.
- latest broad Browser/runtime regression = 162/162 PASS:
  - 81/81 Browser/extension/WebSocket/broker;
  - 17/17 Browser MCP/CDP/owned Edge;
  - 32/32 profile/semantic/fencing/recovery;
  - 32/32 protocol/runtime assembly.
- WAG product/non-browser suite = 58/58 PASS.
- pre-existing packaged runtime lock drift was repaired and committed separately:
  - `57a4fea7896fe9a0213b0af36cf5b35047cc4ffc chore: sync packaged runtime lock`;
  - focused setup after repair = 7/7 PASS.
- real Edge managed-mode smoke PASS:
  - WAG_HEADLESS PASS;
  - WAG_VISIBLE PASS;
  - Pause -> Take Control -> Resume PASS.
- real Edge framework-safe fill PASS:
  - plain input/textarea replacement;
  - React controlled DOM/state/validation/submit state;
  - no append-instead-of-replace.
- real Edge rich-text PASS:
  - contenteditable;
  - ProseMirror;
  - TipTap.
- real Edge OAuth continuity PASS:
  - stable logical session;
  - successor observed and returned to root;
  - authenticated state preserved;
  - user active tab stable.
- real Edge runtime recovery/exact-once PASS:
  - claim epoch 1 -> 2;
  - extension reconnect;
  - durable receipt preserved;
  - completed effect replay blocked;
  - consequential click count exactly 1.
- legacy dedicated Browser Control native-host acceptance remains historically Code-Integrity blocked;
  STOP 2B replaced it with the accepted loopback WebSocket product path, so it is not treated as a
  current Browser v2 WebSocket failure.
- typecheck PASS.
- build PASS.
- git diff --check PASS.
- receipt:
  `docs/benchmarks/2026-10-01-wag-browser-v2-stop9-auto-pairing-final-precheck.md`.
Not claimed:
- USER_DAILY_EDGE_PROFILE_ACCEPTANCE = NOT_EXECUTED;
- LIVE_FIRST_TIME_PAIRING_BY_REAL_USER = NOT_EXECUTED;
- PUBLIC_LAUNCH = NO;
- LIVE_RUNTIME_PROMOTION = NO;
- PUBLIC_PUSH = NO.
Next:
- commit STOP 9 AUTO/pairing implementation + receipt;
- perform bounded user-daily-profile pairing/attach/release acceptance;
- only after that evidence decide final public-launch/promotion steps.
- DC replacement production-local acceptance = 1 / 1 PASS; operatorApprovals=0; autonomousLocalEffects=true; prior 30-second wrapper timeouts occurred before verdict and are not test failures.


---

Task: Browser v2 STOP 10 — final public-launch technical gate
State: DONE / FINAL TECHNICAL GATE PASS / PUBLICATION STOP
Evidence:
- user daily Microsoft Edge profile acceptance = PASS;
- live first-time pairing by the real user = PASS;
- AUTO exact active target -> AI_TAB_GROUP on the daily profile = PASS;
- daily-profile bounded flow used snapshot + Pause + Resume + release only;
- no navigate/fill/click/submit/cookie/token read was performed on the daily-profile gate;
- no Windows UI Automation or OS pointer injection was used;
- user active tab remained stable;
- target and Edge remained open after release;
- real daily page exposed an Accessibility tree above the old generic 256 KiB response limit;
- first daily-profile attempt therefore failed boundedly at SNAPSHOT with Browser control response exceeds size limit;
- transport was corrected without widening all commands:
  - ordinary Browser Control response <= 256 KiB;
  - Accessibility.getFullAXTree response <= 4 MiB;
  - screenshot <= 8 MiB;
  - pending requests <= 128;
  - targets <= 512;
  - semantic AX source nodes <= 2,000;
  - MCP snapshot nodes <= 500;
- rerun daily-profile acceptance = PASS with semanticNodeCountObserved=500 and snapshotTruncated=true;
- broad Browser/runtime regression after fix = 163/163 PASS;
- real Edge AUTO/AI_TAB_GROUP regression after fix = PASS;
- real Edge OAuth continuity regression after fix = PASS;
- real Edge runtime recovery/exact-once regression after fix = PASS;
- WAG product/non-browser = 58/58 PASS;
- prior DC replacement production-local gate remains 1/1 PASS with operatorApprovals=0;
- typecheck/build/git diff --check = PASS;
- acceptance secret cleanup:
  - Windows clipboard cleared;
  - temporary server stopped;
  - port 17841 free;
  - temporary pairing/claim/effect/session/diagnostic files deleted;
  - only sanitized result.json/status.json retained locally.
Files changed:
- src/browser-harness/browser-control-websocket-server.ts
- test/browser-control-websocket-server.test.ts
- scripts/accept-browser-v2-user-profile.ts
- docs/benchmarks/2026-10-01-wag-browser-v2-stop10-final-public-launch-gate.md
- docs/progress/PUBLIC-LAUNCH-P0-RUN.md
Decision:
- BROWSER_V2_FINAL_TECHNICAL_GATE = PASS_FOR_BRANCH;
- READY_FOR_EXPLICIT_PUBLICATION_OR_PROMOTION_DECISION = YES;
- PUBLIC_PUSH = NO;
- LIVE_RUNTIME_PROMOTION = NO;
- PUBLIC_NPM_PUBLISH = NO;
- PUBLIC_LAUNCH = NO.
Next:
- commit STOP 10 locally;
- stop before public push/live promotion/npm publish until the user explicitly authorizes the irreversible/public action.


---

Task: Post STOP 10 — live WAG browser dogfood
State: DONE / LIVE_BROWSER_DOGFOOD_PASS
Evidence:
- live runtime source HEAD = d9f7c27ce85b462a0280aab88f8faa81943c7505;
- live health = ok; authority = AUTONOMOUS_LOCAL; MCP tools = 71;
- browser.targets = PASS on the user's existing Edge profile;
- direct AI_TAB_GROUP attach = PASS;
- active WAG chat exact target discovery = PASS;
- AUTO + exact target_id -> AI_TAB_GROUP = PASS;
- semantic snapshot on attached ChatGPT target = PASS;
- release detached WAG without closing the user's tabs or Edge;
- AUTO + no target_id -> WAG_HEADLESS is the accepted contract, not a foreground-inference mode;
- temporary no-target headless validation session was closed;
- no Edge restart and no intentional user-tab-group destruction occurred.
Receipt:
- docs/benchmarks/2026-10-01-wag-live-browser-dogfood-post-stop10.md
Publication boundary:
- PUBLIC_PUSH = NO;
- LIVE_RUNTIME_PROMOTION = NO;
- PUBLIC_NPM_PUBLISH = NO.
Next:
- reconcile this live receipt locally and keep public publication/promotion stopped until explicitly authorized.


---

Task: P0 — Immutable Multi-File Change Set
State: DONE / LOCAL ACCEPTANCE PASS / PUBLICATION STOP
Implementation commit:
- 860ed6998ab5818f5bb8b4ca9a6088d977ed17f9
Surface:
- change.preview
- change.apply
- change.result
Operations:
- replace
- create
- delete
- move
Safety/effect contract:
- immutable workspace + exact base HEAD + ordered operation set + base/result hashes + destination vacancy + plan digest;
- 1..32 operations;
- per-content bound <= 32 KiB;
- aggregate caller content <= 256 KiB;
- every precondition is checked before the first effect;
- workspace identity and local autonomy kill switch are revalidated;
- VERIFIED replay is durable/idempotent;
- APPLYING/APPLIED recovery never blindly replays;
- mixed post-effect state -> PARTIAL_EFFECT_DETECTED;
- filesystem-level perfect transactions are not claimed.
Backend/runtime:
- local-machine exact delete = implemented;
- pinned DevSpace exact delete = implemented and focused acceptance PASS;
- stdio wiring = PASS;
- direct MCP tunnel projection = PASS;
- remote relay wiring = PASS;
- measured full projection = 70 tools without BrowserPort / 78 with BrowserPort.
Verification:
- focused change-set = 6/6 PASS;
- focused DevSpace mutation backend = 5/5 PASS;
- direct MCP/runtime/stdio focused gates = PASS;
- DesktopPort semantic-delta harness = PASS;
- private BrowserPort assembly harness = PASS;
- typecheck = PASS;
- build = PASS;
- git diff --check = PASS.
Broad-suite classification:
- initial broad run = 1187 total / 1177 pass / 4 fail / 6 todo;
- stale DesktopPort absolute-count failure fixed; isolated rerun PASS;
- private BrowserPort live-port collision fixed by test seam; isolated rerun PASS;
- browser-adapter native-host acceptance remains environment-blocked by Windows spawn UNKNOWN;
- native-host artifact acceptance remains environment-blocked by the same Windows spawn UNKNOWN;
- no Application Control bypass or production-policy weakening was added.
Receipt:
- docs/benchmarks/2026-10-01-wag-immutable-multi-file-change-set-p0.md
Publication boundary:
- PUBLIC_PUSH = NO;
- LIVE_RUNTIME_PROMOTION = NO;
- PUBLIC_NPM_PUBLISH = NO;
- PUBLIC_LAUNCH = NO.
Remote truth:
- origin/main = 033a913c2f05b8b9a62c376a70832e7ae9f9e91c;
- origin/feat/wag-public-launch-p0-v1 = absent.
Next:
- commit receipt/progress locally;
- keep public publication/promotion stopped until explicitly authorized.
