# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and current research receipts before any decision or mutation.

Current research now reaches:
- `docs/research/2026-09-20-ai-native-browser-research-pass-9.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-10.md`
plus all earlier receipts referenced by the detailed handoff.

The user explicitly requested more research. **Do not run local benchmarks yet.**

Pass 10 materially adds:
- MCP OAuth/EMA/machine auth can replace more WAG custom identity ingress;
- DPoP is the preferred standard bearer-theft hardening when supported;
- MCP WIF/SPIFFE are workload-identity donors, but not default solo-Windows infrastructure;
- MCP first-class agent-instance identity/delegation remains an evolving gap;
- UserConsentVerifier is lightweight local re-verification;
- Win32 WebAuthn can bind a signed assertion to a proposal challenge, but plain WebAuthn does not prove the human saw exact arbitrary effect text;
- exact-effect display therefore stays in an independent WAG-owned local UI;
- OAuth RAR/PAR are structured authorization prior art, not ADR-0019 replacements;
- Secure MCP Tunnel is explicitly reachability/data transport: MCP payloads/results and some auth artifacts can traverse OpenAI, so Tunnel is not strict-local-auth or consequential authority.

Current direction:
- standardize identity ingress;
- reduce WAG custom auth;
- keep WAG semantic capability/ownership/approval/effect core;
- keep Guardian continuity and SessionCommander exact-owned lifecycle;
- keep generic browser mechanics frozen.

Next action: **Pass 11 delegation + native approval-broker research, still no local benchmark.**
