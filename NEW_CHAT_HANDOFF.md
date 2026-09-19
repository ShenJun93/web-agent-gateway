# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and all current browser research receipts before any decision or mutation.

Current research receipts:

- `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-2.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-3.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-4.md`
- `docs/research/2026-09-19-ai-native-browser-replacement-pressure-audit.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-5.md`

The user explicitly requested more research. **Do not run local benchmarks yet.**

Pass 5 found material new prior art:
- Browser Controller: promote to source-review tier for authenticated local multi-agent/tab ownership.
- Chrome Agent Bridge: promote as ownership/cleanup donor.
- Agent360 Browser MCP: promote for targeted research; current false-success issue is a hard blocker.
- codex-browser-bridge: high-value OpenAI-specific adapter; freeze duplicate WAG implementation of ChatGPT Desktop browser pipe by default.
- Vibe MCP: demote current Windows local lane due reproducible relay instability/current E2E hang.
- BrowserMCP/browsermcp.io and hangwin/mcp-chrome: demote due maintenance/security evidence.

Current direction remains:
- Playwright first-party is the primary provider-neutral browser substrate;
- WebMCP is a semantic fast path, not authority;
- do not build a new AI-native browser;
- freeze custom generic browser mechanics;
- retain WAG authority/ADR-0019/durable effects and bounded owner-aware cleanup;
- keep Guardian on continuity;
- keep SessionCommander on exact-owned runtime supervision.

Next action: Pass 6 deep source/community narrowing, still no local benchmark.
