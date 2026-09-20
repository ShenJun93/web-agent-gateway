# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and current research receipts before any decision or mutation.

Current research now reaches:
- `docs/research/2026-09-20-ai-native-browser-research-pass-11.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-12.md`
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

Next action: **Pass 13 WIMSE evidence + Windows native-approval maturity research, still no local benchmark.**


Pass 11 adds:
- MCP connection/process is not application ownership under 2026 stateless semantics.
- Delegated/agentic access, tool scopes and RAR remain active MCP standardization work.
- Biscuit is a strong future capability-token donor but not an adoption decision.
- Windows Hello KeyCredential is a lightweight local-only exact-challenge signing donor; WebAuthn remains the portable/FIDO path.
- DPoP over Secure MCP Tunnel is unproven because of target-URI binding versus tunnel URL rewriting.


Pass 12 adds:
- stable MCP OAuth/EMA can replace more custom ingress;
- WIMSE is the primary future delegation/evidence standards watch;
- Biscuit stays prior-art/watch rather than trust core;
- KeyCredential remains promising but unpackaged/native-host support needs proof;
- DPoP over Secure MCP Tunnel remains unproven and must not be claimed.
