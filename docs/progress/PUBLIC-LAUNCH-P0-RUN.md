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
