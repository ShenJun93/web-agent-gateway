# Web Agent Gateway

Provider-neutral local execution gateway for Web AI clients.

## What WAG is

Web Agent Gateway (WAG) is an open-source, local-first, least-authority gateway for AI clients that need bounded access to user-approved developer resources. WAG keeps identity, policy, approvals, secrets, durable ownership, and capability admission under local control instead of exposing a generic remote-machine surface.

### Current public surface

The current Browser Inspect v2 profile is intentionally read-only and exposes exactly five methods: `health`, `workspace.open`, `repo.search`, `repo.snapshot`, and `file.read`. It does not expose raw shell/process access, Git writes, file mutation, browser mutation, or generic forwarding.

The Windows x64 native-host preview is currently **unsigned** and must not be treated as Authenticode-trusted. Supported preview downloads come from the immutable GitHub Release, not from transient GitHub Actions artifacts.

### Start here

- [Latest preview release](https://github.com/ShenJun93/web-agent-gateway/releases/tag/v0.1.0-preview.1)
- [Windows native-host installation and removal](docs/native-host-installation.md)
- [Security policy](SECURITY.md)
- [Privacy policy](docs/policies/privacy.md)
- [Code-signing policy](docs/policies/code-signing-policy.md)
- [Contributing](CONTRIBUTING.md)

## Goal
Provide a provider-neutral, least-authority local trust/capability gateway for AI hosts that need bounded access to local resources, while keeping identity, policy, approvals, secrets, durable ownership, and audit under WAG control.

## Product mission lock
WAG has two normative product goals:

1. Replace Remote Desktop Commander on selected WebChat -> local development workflows. Replacement is workflow-scoped; WAG is not a clone of Desktop Commander's generic remote-machine surface.
2. Give WebChat agents local development outcomes comparable to Claude Code/Codex where WAG grants capability: inspect, locate, read, make reviewable changes, verify/build/test, inspect results, and only separately reviewed Git/process effects when a measured workflow requires them.

ChatGPT Web is the current reference provider and first direct DC-replacement target. Provider neutrality is architectural: future WebChat providers must reuse the same WAG authority/capability contracts through the best available native/standard adapter. "Claude Code/Codex-like" means outcome parity, not raw-shell or agent-platform parity.

Approved mission design: `docs/superpowers/specs/2026-09-17-webchat-local-coding-mission-lock-design.md`. Normative ADR: `docs/adr/0018-lock-webchat-local-coding-mission.md`. Dated evidence base: `docs/research/2026-09-17-wag-webchat-local-coding-mission-lock.md`.
## Canonical authority
1. Git history and tagged evidence.
2. `docs/superpowers/specs/` approved designs.
3. `docs/adr/` architecture decisions.
4. `docs/research/` dated research receipts.
5. `docs/benchmarks/` empirical evidence.
6. Chat history is never canonical project state.

## Current decision
COMPOSE, do not fork wholesale:
- DevSpace: upstream local execution backend/donor.
- LocalAnt: security/policy/approval donor.
- Official MCP SDK: protocol boundary.
- Host-native/local MCP where available; Cloudflare Quick Tunnel remains historical benchmark infrastructure only.
- Our code: thin gateway, policy, semantic tools, telemetry, compatibility.

## Current accepted state
Trusted Caller Context v1 and the internal Durable Verify Job Core v1 have passed their acceptance gates. Trusted Adapter Admission v1 remains the authority boundary for browser callers, and Browser Adapter v1 is preserved as historical three-tool evidence.

The current read-only browser profile is Browser Inspect v2. It uses a distinct adapter identity/protocol revision and exposes exactly `health`, `workspace.open`, `repo.search`, `repo.snapshot`, and `file.read`. It does not expose `verify.run`, mutation, public jobs, process/PTY, Git writes, browser mutation, or generic forwarding.

The Windows native-host pipeline now records strict unsigned-candidate provenance, normalizes WAG-owned PE VersionInfo before candidate recording, verifies runtime/license inputs, and independently verifies signed-candidate Authenticode continuity. WAG has not yet published or accepted a trusted signed native-host release; Windows application-control acceptance remains gated on an externally signed candidate that passes the existing verifier without relaxation.

The MCP v2 compatibility spike passed for the core/dual-era path, and the later MCP SDK v2 Production Migration v1 moved production to the split v2 TypeScript SDK packages without separately opting into protocol `2026-07-28`. Current-market re-benchmarking and thin-gateway host conformance narrowed WAG to its provider-neutral trust/capability role. Browser Admission HTTP Mode Split v1 removed the unreachable browser generic bearer, the historical `file.patch` protocol was retired after durable-mutation acceptance, MCP v1 experimental Tasks were retired after revalidation, and the remaining generic bearer HTTP compatibility mode was subsequently removed after its consumers were reduced to historical benchmark/spike harnesses. Current HTTP remains Browser Admission only; Business/private MCP remains stdio. Feature and authority growth remain frozen by default pending new evidence.

## Business private MCP readiness
The supported private deployment direction is ChatGPT Business + OpenAI Secure MCP Tunnel + the production-built Gateway stdio command. DevSpace remains a separately supervised loopback-only process; the Gateway does not expose a public listener.

Local pre-upgrade verification uses placeholders only:

```powershell
npm ci
npm run build
$env:DEVSPACE_OAUTH_OWNER_TOKEN = '<local-owner-secret>'
node .\dist\cli.js doctor --config C:\path\to\private.json
node .\dist\cli.js serve-stdio --config C:\path\to\private.json
```

The private JSON config is non-secret and contains only approved roots, the loopback DevSpace base/resource URLs, and bounded verify profiles. `DEVSPACE_OAUTH_OWNER_TOKEN` is accepted only from the environment; access and refresh tokens remain in process memory.

After a Business upgrade and Secure MCP Tunnel provisioning, the intended external setup is:

```powershell
tunnel-client init --profile web-agent-gateway --tunnel-id <tunnel-id> --mcp-command "node C:\path\to\web-agent-gateway\dist\cli.js serve-stdio --config C:\path\to\private.json"
tunnel-client doctor --profile web-agent-gateway --explain
tunnel-client run --profile web-agent-gateway
```

Those tunnel/account steps are a post-upgrade acceptance gate, not local pre-upgrade evidence. Do not commit owner tokens, control-plane API keys, tunnel credentials, or machine-specific private config files.

## Repository-engineering profile (DC replacement)

By default `serve-stdio` exposes exactly five tools: `health`, `workspace.open`, `repo.snapshot`, `file.read`, `verify.run`.

A local operator may opt in to the repository-engineering profile that carries WAG's Desktop Commander replacement scope. It is off unless the private config asks for it, and it can never be requested by the model, the provider, the transport, or repository content:

```jsonc
"repositoryEngineering": {
  "inspect": true,
  "mutation": { "statePath": "C:\\path\\to\\control-plane.sqlite", "ownerId": "local.private.stdio" }
}
```

`inspect` adds the read-only set `repo.list`, `repo.search` and `repo.diff`. `mutation` adds `mutation.preview` and `mutation.result`, and starts the loopback operator review server. `mutation.preview` writes nothing: a separate, locally authenticated operator must approve the exact record before any file changes, approval is single-use and TTL-bounded, and reject or expiry leaves the repository byte-identical.

The operator review server's **origin** is announced on stderr; its single-use bootstrap token is not. A stdio gateway's stderr belongs to whichever process spawned it — in the supported deployment that is the remote-facing tunnel client — so the token is written to `<statePath>.operator-url` instead and removed on shutdown. Open that URL locally to review and approve.

With both enabled the surface is exactly:

```text
health  workspace.open  repo.list  repo.search  repo.snapshot  repo.diff  file.read  verify.run
mutation.preview  mutation.result
```

`repo.list` returns the immediate tracked and untracked-not-ignored entries of one directory. `repo.diff` returns the bounded working-tree diff against `HEAD`, with the bodies of path-policy-sensitive files (`.env`, `.npmrc`, `.git-credentials` and the rest of the denylist) withheld. Every response is capped at 64 KiB and reports whether it was truncated. A caller-supplied path is never interpolated into a shell command: it reaches git as a single literal argv pathspec.

WAG stays deliberately narrower than Desktop Commander on every profile. It exposes no shell, process control, PTY, arbitrary argv, file create/move/delete, directory tools, Git writes, or runtime configuration mutation, and `allowedRoots` is enforced rather than advisory.

Authority: `docs/adr/0020-make-private-stdio-the-dc-replacement-surface.md` and `docs/adr/0021-complete-the-bounded-repository-inspection-set.md`. Design: `docs/superpowers/specs/2026-09-19-wag-dc-replacement-v1-design.md`. Acceptance: `docs/superpowers/plans/2026-09-19-wag-dc-replacement-v1-acceptance.md`.

## Windows native host
The Windows native host is currently a development/pre-release component. Installation changes one per-user Chromium Native Messaging registration and stores exact-owned files under `%LOCALAPPDATA%`.

See `docs/native-host-installation.md` for the system-change warning, preparation, verification, and ownership-safe removal procedure.

## Code signing policy
See `docs/policies/code-signing-policy.md` for signing scope, manual approval, provenance, official-release rules, and the current pre-SignPath status.

## Contributing
External changes require maintainer review. See `CONTRIBUTING.md` for contribution, verification, security, and code-signing expectations.

## Security and privacy
Security reports: `SECURITY.md`.

Privacy behavior: `docs/policies/privacy.md`.

## License
Web Agent Gateway is licensed under the Apache License 2.0. See `LICENSE`.

The Windows native-host executable incorporates Node.js and bundled MIT-licensed JavaScript dependencies. See `THIRD_PARTY_NOTICES.md` and `third_party/native-host/` for exact tracked license material.
