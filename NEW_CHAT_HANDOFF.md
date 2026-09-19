# Current handoff

Read `NEW_CHAT_HANDOFF_2026-09-19_AI_NATIVE_BROWSER_COMMUNITY_SCAN.md` first.

Do not use prior chat as canonical authority. Fresh-check `main`, remote HEAD, `README.md`, ADR-0018, ADR-0019, and all current browser research receipts before any decision or mutation.

Current research receipts now include:
- `docs/research/2026-09-20-ai-native-browser-research-pass-6.md`
- `docs/research/2026-09-20-ai-native-browser-research-pass-7.md`
plus all earlier Pass 1–5/replacement-pressure receipts referenced by the detailed handoff.

The user explicitly requested more research. **Do not run local benchmarks yet.**

Pass 7 material changes:
- Browser Controller's application auth remains strong, but Windows token-file and named-pipe ACL protection is unproven; Node `0600` is not owner-only NTFS ACL proof.
- LAPSrj/browser-mcp is stronger Windows lifecycle prior art than previously recorded: kill-then-finalize, orphan adoption, stale-relay repair.
- Chrome DevTools #2431 memory issue is fixed in 1.7.0; Windows autoConnect #2675 remains open and new #2778 adds a consent/readiness timeout loop; #2621 abnormal-exit claim is narrowed to reproducible temp-profile cleanup gap on current stable.
- Playwright #1631 and #42608 are closed; explicit isolated BrowserContext-per-owner is the safer multi-client topology, while shared context is intentional shared state rather than authority isolation.
- whg517/browser-bridge #192 remains open without Windows Job Object evidence.
- Agent360 #19 remains open; effect truth should be tri-state: CONFIRMED / FAILED / UNKNOWN, with no blind retry after UNKNOWN.
- codex-browser-bridge is valuable provider-specific reuse but inherits opaque upstream pipe ACL/lifecycle and is not WAG ownership.
- Hronaut is promoted as an authority/effect-verification donor (generation fences, OUTCOME_UNKNOWN, observer-context idea), but is too new and its multi-agent lease/observer work remains open.
- Hark/Polar remain product/UX comparators, not infrastructure authority.

Current direction:
- do not build a new AI-native browser;
- freeze generic browser mechanics;
- retain WAG ADR-0019 authority/durable effects;
- retain Guardian continuity;
- retain SessionCommander/Cleanup exact-owned lifecycle supervision;
- strengthen Windows ACL evidence and explicit effect truth.

Next action: **Pass 8 Windows security + effect-truth research, still no local benchmark.**
