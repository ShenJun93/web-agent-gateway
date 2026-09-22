# ChatGPT -> WAG direct MCP route

Date: 2026-09-22
Status: Current-source review for the direct ChatGPT <-> WAG MCP milestone
Supersedes the provider-capability section of `2026-09-10-openai-plugin-deployment-route.md`,
which reached the same conclusion from the same sources sixteen days earlier.

## Question

Can ChatGPT call WAG's tools directly and consume structured MCP results in the same conversation,
removing DOM scraping, `wag-tool` fenced blocks, manual result relay and Claude as intermediary —
and what, if anything, must WAG build for that?

## Sources read today

Fetched 2026-09-22 and read as primary text, not as summaries:

- Developer mode and MCP apps in ChatGPT — `help.openai.com/en/articles/12584461`
- Apps/connectors in ChatGPT — `help.openai.com/en/articles/11487775`
- Secure MCP Tunnel guide — `developers.openai.com/api/docs/guides/secure-mcp-tunnels`
- `openai/tunnel-client` README — the customer-run client's own documentation
- Making private MCP servers reachable — `developers.openai.com/blog/connect-private-mcp-servers-to-openai-products`

`help.openai.com` refuses the automated fetcher with HTTP 403; it was retrieved with an ordinary
HTTP client and parsed locally. The browser pane was declined for this session, so no page was
driven. Third-party blogs asserting that developer mode is available on Plus were read and are
**not** treated as evidence: they contradict the help centre article, and AGENTS.md ranks current
upstream/official sources above them.

## Finding 1 — the transport question is already solved, and not by us

OpenAI ships **Secure MCP Tunnel**: an OpenAI-hosted endpoint plus a customer-run `tunnel-client`
that makes only outbound HTTPS long-poll connections, receives queued MCP work and forwards it to a
local MCP server. No inbound port is opened and the server is never published.

The decisive detail for WAG is the client's two connection modes:

```text
--mcp-command "<argv>"        launch a stdio MCP server as a child process
--mcp-server-url <https url>  connect to an existing HTTP MCP server
```

The stdio mode is exactly WAG's private stdio surface (ADR-0020). It is documented for
localhost/private servers, and the sample profile is named `sample_mcp_stdio_local`.

Consequence: **WAG needs no new transport, no public endpoint, no relay, no OAuth deployment and
no HTTP exposure** for the direct path. `tunnel-client` spawns `node dist/cli.js serve-stdio`, and
WAG keeps listening on nothing.

## Finding 2 — the plan gate is real, current, and not a WAG problem

The developer-mode help article, today, states the eligibility this way (paraphrased; see source):

- Full MCP support, *including modify/write actions*, is described as rolling out in beta to
  ChatGPT **Business, Enterprise and Edu**.
- Apps, full MCP support and developer mode are listed as available for **Business and
  Enterprise/Edu** customers on ChatGPT web.
- The article's own FAQ answers the **Pro** case directly: Pro can build apps with the Apps SDK;
  full MCP is available only to Business and Enterprise/Edu "currently"; Pro can connect MCP
  servers with **read/fetch permissions only** in developer mode.
- On Business, only admins can enable developer mode; apps are published at the workspace level.

**Plus is not named anywhere in that article as eligible for custom MCP connectors** — neither for
full MCP nor for the read/fetch developer mode that Pro is granted. The strongest defensible
reading is therefore not "Plus can read but not write"; it is that Plus is undocumented for custom
MCP connectors altogether, and any read capability there would have to be established live rather
than assumed.

This reproduces the 2026-09-10 finding from the same publisher. It is an external product gate.

### The one check only the account holder can make

Documentation describes the product; the account shows the truth. Whether
`Settings -> Apps -> Advanced settings` offers a developer-mode toggle on this specific Plus
account is a single live observation, and it requires signing in. That is an account action, so it
is not automated here.

## Finding 3 — ChatGPT's confirmation composes *above* WAG, and no WAG authority can suppress it

The article states that for write or modify actions ChatGPT may ask the user to confirm, depending
on app permissions, the action's context and its potential impact — and that some especially risky
actions may be **blocked outright** rather than offered for approval.

That gate lives inside ChatGPT, before a tool call is ever emitted. It is therefore strictly
upstream of everything WAG does, and the composition is a conjunction:

```text
ChatGPT confirmation  AND  WAG authority  ->  effect
```

- A Goal Lease admits an action on **WAG's** side. It cannot reach into ChatGPT, because by the
  time WAG sees a request the client has already decided to send it. **A lease cannot suppress a
  ChatGPT-imposed confirmation, and nothing in this milestone should be read as claiming it can.**
- Conversely, a ChatGPT confirmation is not a substitute for WAG approval. It is the remote
  client's own risk control over its own user; WAG's local operator approval is the only boundary
  enforced on this machine, and it is unchanged.
- The failure directions are asymmetric and both safe: a ChatGPT confirmation with no WAG authority
  yields a proposal and no effect; WAG authority with a ChatGPT block yields no call at all.

ADR-0020 already recorded the provider's related warning that a **read-only annotation may cause
the client's confirmation to be skipped**, and that a write can still occur despite such a tag —
placing the trust burden explicitly on the MCP server. That is what makes annotation correctness on
this surface a security property rather than metadata, and it is why this milestone fixed
`workspace.open`, which declared `readOnlyHint: true` while minting a durable workspace record.

## Finding 4 — Codex is the nearest supported OpenAI surface on this plan

`tunnel-client` documents Codex as a first-class consumer, with managed runtimes
(`tunnel-client runtimes connect`) specifically for it, and Codex speaks MCP directly. Codex is
available on paid consumer plans including Plus.

This is recorded because it is the closest supported route to "an OpenAI agent drives WAG directly
with no Claude relay" on the current plan. It is **not** a substitute for the milestone's stated
goal, which names ChatGPT, and it is not adopted here. It is the obvious next question if the plan
gate is not purchased.

## Route matrix, current

| Route | Status today | Note |
| --- | --- | --- |
| Plus + custom MCP connector, write | **BLOCKED — plan** | Full MCP documented for Business/Enterprise/Edu only. |
| Plus + custom MCP connector, read | **UNDOCUMENTED** | Read/fetch dev mode is documented for Pro; Plus is unlisted. Live check needed. |
| Business/Enterprise/Edu + Secure MCP Tunnel + WAG stdio | **SUPPORTED** | Needs paid seats and an admin. No WAG engineering. |
| Codex + Secure MCP Tunnel + WAG stdio | **SUPPORTED, plan-available** | Not this milestone's target; recorded as the nearest route. |
| Public reviewed plugin usable on Plus | **SEPARATE PRODUCT TRACK** | Needs public HTTPS, OAuth 2.1, listing assets, review. Unchanged from 2026-09-10. |
| Exposing WAG on a public HTTPS endpoint | **REJECTED** | Would create the inbound surface the tunnel exists to avoid. |

## What this research does not establish

- That a tunnel-backed connector functions end to end. Nothing was connected: creating a tunnel and
  a runtime API key are account actions, and no external resource was created for this milestone.
- That Plus can attach a read-only custom connector. The documentation does not say so, and the
  absence of a statement is not a denial — only the account can settle it.
- Any change to WAG's local boundary. The tunnel is transport; it grants nothing.
