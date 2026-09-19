# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and all current browser research receipts before any decision or mutation.

Current research receipts now include:
- `docs/research/2026-09-20-ai-native-browser-research-pass-5.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-6.md`
plus all earlier Pass 1–4/replacement-pressure receipts referenced by the detailed handoff.

The user explicitly requested more research. **Do not run local benchmarks yet.**

Pass 6 material changes:
- Chrome DevTools for agents promoted to first-party Chrome comparator, but current orphan/memory/Windows autoConnect evidence blocks lifecycle-baseline status.
- Playwright remains provider-neutral primary; shared BrowserContext is explicitly not an ownership/authority boundary.
- Browser Controller remains high source-review candidate.
- LAPSrj/browser-mcp promoted as Windows root-PID/shared-profile lifecycle donor.
- browser-rs-mcp promoted as per-owner capability/managed-mode authority donor, but no Windows support.
- uiuing/browser-agent promoted as post-action effect-verification/risk-tier donor.
- Agent360 effect verification improved in v1.29.2, but issue #19 class is not fully closed.
- whg517/browser-bridge Windows Job Object broker-lifetime gate remains open.
- Polar/Hark/Aside/Phi are product/UX comparators, not replacements for WAG authority.

Current direction:
- do not build a new AI-native browser;
- freeze generic browser mechanics;
- retain WAG ADR-0019 authority/durable effects;
- retain Guardian continuity;
- retain SessionCommander/Cleanup exact-owned lifecycle supervision;
- strengthen explicit effect verification.

Next action: **Pass 7 targeted source/fix-velocity research, still no local benchmark.**
