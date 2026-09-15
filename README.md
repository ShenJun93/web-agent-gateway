# Web Agent Gateway

Provider-neutral local execution gateway for Web AI clients.

## Goal
Use paid Web AI quota (initially ChatGPT Plus Web) as the reasoning surface while keeping repo/files/Git/process execution local, fast, observable, and policy-controlled.

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
- Cloudflare Tunnel: V0 transport candidate.
- Our code: thin gateway, policy, semantic tools, telemetry, compatibility.

## Current accepted state
Trusted Caller Context v1 and the internal Durable Verify Job Core v1 have passed their acceptance gates. Trusted Adapter Admission v1 has also passed the successor distribution, installation, and supported-browser-host gates for the read-only Browser Adapter v1 path.

Browser Adapter v1 remains server-side limited to exactly `health`, `workspace.open`, and `file.read`. Durable verify projection, mutation, public jobs, process/PTY, Git writes, and browser mutation remain unauthorized unless a later reviewed gate explicitly enables them.

The next evidence sequence is a bounded MCP v2 / protocol `2026-07-28` compatibility spike followed by a current-market viability re-benchmark. Evidence from those gates, rather than roadmap inertia, selects the next implementation milestone.

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
