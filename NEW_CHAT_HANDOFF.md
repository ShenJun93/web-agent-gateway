# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and current browser research receipts before any decision or mutation.

Current research now reaches:
- `docs/research/2026-09-20-ai-native-browser-research-pass-8.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-9.md`
plus all earlier receipts referenced by the detailed handoff.

The user explicitly requested more research. **Do not run local benchmarks yet.**

Pass 9 materially adds:
- MCP 2026-era Streamable HTTP/OAuth/CIMD as the preferred remote protocol/auth direction;
- OpenAI Secure MCP Tunnel as the preferred OpenAI-native private reachability path rather than a custom WAG relay;
- browserControl as the strongest current device-scoped OAuth/observation/lease donor;
- Vibe as reachability prior art but not an authority model because its remote UUID/URL is browser-wide bearer authority;
- Cloudflare Tunnel/Access as a strong provider-neutral managed transport + identity donor;
- Tailscale Serve as a strong private operator/admin transport, not direct hosted-WebChat reachability;
- MCP URL-mode elicitation as a standard out-of-band interaction lane;
- Windows Hello/UserConsentVerifier and WebAuthn as local approval prior art outside browser DOM authority.

Current direction:
- remote transport is replaceable;
- tunnel/network reachability is never consequential authority;
- retain WAG capability reduction, ADR-0019 approval/effect split and durable effect truth;
- retain Guardian continuity and SessionCommander exact-owned lifecycle;
- continue freezing generic browser mechanics.

Next action: **Pass 10 agent identity + local approval standardization research, still no local benchmark.**
