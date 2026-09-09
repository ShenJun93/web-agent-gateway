# V0 Prerequisite Gate

Date: 2026-09-09
Status: ARCHITECTURE PASS / CHATGPT PLUS PRIVATE-WRITE DEPLOYMENT BLOCKED

## Host/access gate

Current OpenAI documentation was re-verified on 2026-09-09. Full MCP support including modify/write actions is currently available to ChatGPT Business and Enterprise/Edu, while Pro developer-mode custom MCP is limited to read/fetch. Therefore ChatGPT Plus must not be treated as having a supported private full-write custom MCP path. Published apps may expose supported write actions depending on the app, plan, region, rollout, and configuration; that remains a separate external deployment gate.

Decision: continue architecture and performance validation without claiming that a private ChatGPT Plus deployment path is available today.

## Executor gate

Pinned executor: Waishnav/devspace @ 33d6d0bcc2256024484d2456da924af8afd814ed, package version 1.0.8.

Windows evidence:
- dependency install with exact pnpm 11.25.0: PASS
- focused MCP/process/worktree/root suite: 18 tests, 17 pass, 0 fail, 1 environment skip
- production build: PASS
- CLI launch: PASS
- runtime bind: 127.0.0.1:7676 only
- allowed root: disposable fixture only
- anonymous MCP request: HTTP 401
- OAuth protected-resource discovery: HTTP 200
- OAuth authorization-server discovery: HTTP 200
- executor restart durability: NOT SUPPORTED; explicitly out of V0 scope

DevSpace is a policy-gated privileged executor, not a security sandbox.

## Transport gate

Cloudflared 2026.8.3 was downloaded from the official release and verified with SHA-256 83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae. It was not installed globally.

Quick Tunnel results against the unauthenticated MCP path:
- local 401 path: approximately 2-8 ms in observed probes
- first public probe: approximately 1.01 s
- subsequent 9 warm public probes: median approximately 216 ms; p95 approximately 281 ms
- OAuth metadata through public tunnel: HTTP 200

Transport interruption test:
1. DevSpace was running locally.
2. cloudflared was terminated.
3. public endpoint returned 502.
4. local DevSpace endpoint continued returning 401 and the DevSpace process remained alive.

Result: transport lifetime is independent from executor lifetime for this tested case.

A restarted Quick Tunnel received a different hostname and initially experienced DNS propagation delay. Therefore Quick Tunnel is accepted only for development/probing. A stable named tunnel or equivalent stable endpoint is required for later acceptance work.

## Gate result

- DevSpace Windows executor: PASS
- exact upstream pin: PASS
- modern MCP compatibility evidence: PASS
- basic OAuth/auth boundary: PASS
- transport prototype: PASS
- transport-loss/executor isolation: PASS
- Quick Tunnel as production transport: REJECTED
- ChatGPT Plus private full-write custom MCP: BLOCKED by current product access
- published-app route for ChatGPT Plus: NOT YET VALIDATED

Architecture work may continue because executor and transport premises passed. Any claim of live ChatGPT Plus deployment remains blocked until a supported write-capable host/app path is demonstrated.