# Landscape and Donor Audit — 2026-09-09

## Research lanes
1. Desktop Commander donor/remote failure modes.
2. ChatGPT/Claude/Gemini MCP compatibility.
3. Security and threat model.
4. Transport/latency architecture.
5. Existing-project landscape.

## Findings
- Desktop Commander local engine is useful donor material; hosted remote/session layer is the main dependency to avoid.
- DevSpace is the strongest execution donor/base candidate: modern MCP compatibility, process sessions, file/patch tools, Git/worktrees, coding-agent integrations.
- LocalAnt is the strongest policy/security donor: risk engine, approvals, audit, redaction, path/command guards.
- `localmcpcoder` proves Web chat -> remote MCP -> local execution via Cloudflare Tunnel is practical.
- Docker MCP Gateway is a useful future isolation donor; do not invent sandbox primitives.
- Browser/DOM bridges prove multi-provider feasibility but are too fragile/policy-sensitive for the production core.

## Provider direction
- ChatGPT Web: initial user-facing target; plan capability constraints must be empirically tested.
- Claude Web: strong second provider for remote MCP compatibility.
- Gemini Web: architecture target; custom MCP regional/product availability must be re-verified before activation.

## Opportunity gap
Existing projects solve pieces, but the useful gap is FAST + PROVIDER-NEUTRAL + LOCAL-FIRST + CODING-AWARE + SECURE + OBSERVABLE in one bounded system.

## Research rule
All provider capabilities and upstream behavior are time-sensitive. Re-verify official docs/upstream source before consequential implementation decisions.

## Primary references
- https://github.com/Waishnav/devspace
- https://github.com/yuga-hashimoto/localant
- https://github.com/desktop-commander/remote-desktop-commander
- https://github.com/wonderwhy-er/DesktopCommanderMCP
- https://github.com/juansegzz/localmcpcoder
- https://github.com/docker/mcp-gateway
- https://github.com/modelcontextprotocol/modelcontextprotocol
- https://help.openai.com/en/articles/12584461
- https://support.anthropic.com/en/articles/11175166
- https://support.google.com/gemini/answer/17209137
