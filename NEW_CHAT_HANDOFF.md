# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, accepted ADR/spec authority, and the current browser research receipts before any decision or mutation.

Current research receipts:

- `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-2.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-3.md`
- `docs/research/2026-09-19-ai-native-browser-community-experience-scan-pass-4.md`
- `docs/research/2026-09-19-ai-native-browser-replacement-pressure-audit.md`

The user explicitly requested more research. **Do not run local benchmarks yet.**

Current direction:

- prefer provider-native browser paths when appropriate, but do not treat current OpenAI/Claude Windows lifecycle as a cleanup/ownership baseline;
- treat first-party Playwright CLI/MCP extension/`browser.bind()` as the primary provider-neutral substrate to research;
- treat WebMCP as a strategic semantic layer, not an authority layer;
- freeze expansion of custom generic browser mechanics;
- keep WAG authority/ADR-0019 approval/durable effects and bounded owner-aware cleanup until replacement evidence exists;
- keep Guardian focused on context/continuity rather than growing into browser automation;
- keep SessionCommander focused on exact-owned runtime supervision rather than browser semantics.

Sunk cost does not protect existing WAG/Guardian/SessionCommander browser code. The likely architecture is a thinner WAG above native/WebMCP/Playwright/cloud substrates, not a new AI-native browser.
