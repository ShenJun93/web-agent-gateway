# New Chat Handoff — AI-native Browser Community Scan

Date: 2026-09-19
Repository: `ShenJun93/web-agent-gateway`
Canonical branch: `main`
Checkpoint after research receipt: `142f53a6ff6090e6f335d9232b5733ba71299961`

## User directive

Do not preserve our own code because of sunk cost. If an external project/service is materially better, prefer adopting it and retire/freeze overlapping custom code.

Before practical benchmarking, research **community experience** and real failure modes broadly enough to eliminate weak candidates without wasting local test time.

## Canonical authority

Fresh-read, in order:

1. Git `main` / remote HEAD.
2. `README.md` canonical authority section.
3. Relevant accepted specs/ADRs, especially:
   - `docs/adr/0018-lock-webchat-local-coding-mission.md`
   - `docs/adr/0019-separate-browser-proposal-from-consequential-authority.md`
4. Research receipt:
   - `docs/research/2026-09-19-ai-native-browser-community-experience-scan.md`
5. Chat history last.

Do not use this handoff as authority when Git disagrees.

## Verified state

A first community-experience pass was completed for:

1. BrowserOS neo
2. open-browser-use
3. Cloudflare Browser Run / Kitesurf

No local install/benchmark was performed.

Research receipt commit:
`142f53a6ff6090e6f335d9232b5733ba71299961`

### BrowserOS neo

Community evidence is mixed but substantive.

Positive:
- real daily-use reports;
- useful with Claude Code / MCP;
- logged-in account workflows are a real differentiator;
- some users report good results with Hermes/Claude and credentialed sites.

Negative:
- still described as early/rough;
- long multi-step agent workflows can be slow or fail;
- current GitHub issues show MCP compatibility, migration, platform, UI, and hardening problems.

Disposition:
**credible local replacement candidate, but not yet assumed production-boring.**

### open-browser-use

Architecture is highly relevant:
- real Chrome/profile;
- extension + native messaging;
- MCP/SDK/CLI;
- local-first;
- MIT license.

But independent community evidence is still sparse relative to adoption claims. Public footprint is small and rapidly changing.

Disposition:
**watch/code-review first; insufficient community proof for a migration decision.**

### Cloudflare Browser Run / Kitesurf

Browser Run has the strongest infrastructure/offload story:
- cloud execution;
- CDP;
- Live View;
- recordings;
- human takeover;
- high paid-tier concurrency.

Kitesurf is interesting for agent-native stateless work and vendor benchmarks claim materially lower CPU/RAM than Chromium, but:
- beta;
- stateless;
- fidelity trade-offs;
- bot/challenge limitations reported by community;
- not a replacement for persistent local authenticated browsing.

Disposition:
**strong offload lane, not primary local browser replacement.**

## Important correction to previous strategy

Do **not** immediately run a three-way empirical benchmark.

First broaden the community/prior-art scan. The goal is to avoid testing projects that public evidence already disqualifies.

## Next exact research pass

Research community experience and public failure evidence for:

1. Vercel `agent-browser`
2. Browser Use / BrowserCode / Browser Harness
3. Steel
4. Browserbase
5. Kernel
6. Hyperbrowser
7. Opera Neon CLI
8. Puma Browser / Puma OS
9. Open Interpreter
10. any strong local real-profile MCP/browser bridge discovered during the scan

For each candidate collect:

- sustained-use community reports;
- Windows reliability;
- authenticated-profile behavior;
- session/process cleanup;
- concurrency behavior;
- bot/challenge behavior;
- security/privacy incidents;
- issue velocity and unresolved blockers;
- pricing/lock-in;
- license;
- which WAG/Guardian/SessionCommander functionality it could eliminate.

## Decision discipline

Use:
`NATIVE -> STANDARD -> PROVEN OSS/SERVICE -> COMPOSE -> WRAP -> EXTEND -> BUILD`

Do not protect:
- WAG browser-specific code,
- ChatGPTSessionGuardian browser-control scope,
- SessionCommander browser/process lifecycle logic,
- Cleanup Sidecar architecture,

merely because we already built them.

However, do not retire components until evidence shows the replacement preserves the required trust/ownership boundary.

ADR-0019 remains important: browser-side proposal authority must not silently become consequential execution authority.

## Community-evidence rule

Prefer:
1. repeated independent reports;
2. detailed GitHub issues/reproductions;
3. maintainer responses/fixes;
4. official docs for capabilities/limits;
5. vendor benchmarks only when labeled as vendor claims.

Do not rank a project from star count or one Reddit comment.

## Stop condition for next session

Continue research until the candidate field can be reduced to a small shortlist on community evidence alone.

Only then recommend the minimum empirical test needed to resolve remaining uncertainty.
