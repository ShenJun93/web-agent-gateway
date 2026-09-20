# Browser automation

`E:\AI-BROWSER\PLAYWRIGHT_HANDOFF.md` is the canonical local policy. **Fresh-read it before any
browser automation** — it changes, and a remembered copy is not authority.

As of 2026-09-20 it requires, before allocating or touching any worker:

```bash
playwright-cli list --all --json
```

and, only if that is blocked by command-safety for its stale-descriptor pruning:

```bash
node E:\AI-BROWSER\PLAYWRIGHT_SAFE_INVENTORY.js
```

If neither produces a parseable global inventory, **stop fail-closed**. Do not allocate, open,
attach to, or reclaim a worker.

## Ownership

Inventory proves liveness and topology, never ownership. A profile is not free because its
browser is invisible, idle, or missing from the listing.

A new worker takes a unique session name and a **brand-new** profile under
`E:\AI-BROWSER\profiles\<session>`, with `OWNER.json` inside it. A previously used profile may be
reopened only by the same worker that already proved it owns it. Never open one profile from two
sessions. Never close or clean a worker you have not proven you own — other sessions' workers are
theirs. If ownership cannot be proven, leave it alone and say so.

## The acceptance browser is Edge, and stays Edge

WAG production and dogfood acceptance run on the dedicated Edge profile. Google Chrome cannot
side-load an unpacked extension at all, and Playwright's bundled Chromium is blocked by Windows
Application Control on this machine — both measured, both recorded in the cutover receipt.

Do not migrate WAG acceptance to Chrome. Claude in Chrome, where available, is a **secondary**
surface for DOM / console / network diagnostics only. Nothing done there may change extension
identity, native-host registration, Edge's accepted production authority, or WAG browser session
semantics without its own acceptance decision.

## The panel and the operator are not automation targets

Inspect them; do not drive them. See `human-presence-boundary.md` — the guard enforces it.
