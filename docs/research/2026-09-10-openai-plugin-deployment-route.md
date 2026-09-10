# OpenAI Deployment Route Research

Date: 2026-09-10
Status: Current-source review for ChatGPT Plus/private deployment decision

## Question
What supported OpenAI deployment route can expose Web Agent Gateway's local read/verify capabilities to ChatGPT, especially for a user currently on Plus?

## Current official sources
- Developer mode and MCP apps in ChatGPT: https://help.openai.com/en/articles/12584461
- Plugins in ChatGPT and Codex: https://help.openai.com/en/articles/20001256
- Apps in ChatGPT: https://help.openai.com/en/articles/11487775
- ChatGPT Business release notes (Atlassian Rovo write-action example): https://help.openai.com/en/articles/11391654
- Submit plugins: https://developers.openai.com/plugins/deploy/submission
- MCP server review requirements: https://developers.openai.com/plugins/deploy/app-review
- Plugin authentication: https://developers.openai.com/plugins/build/auth
- Secure MCP Tunnel: https://developers.openai.com/api/docs/guides/secure-mcp-tunnels
- ChatGPT Business billing/seats: https://help.openai.com/en/articles/8792536-managing-billing-and-seats-in-chatgpt-business

## Findings: private custom MCP
OpenAI currently limits full custom MCP, including modify/write actions, to ChatGPT Business, Enterprise, and Edu. Pro may use read/fetch MCP in developer mode; Plus is not a supported private full-MCP developer-mode route.

ChatGPT cannot directly connect to a local MCP server. For supported private MCP usage, OpenAI provides Secure MCP Tunnel, an outbound-only connection suitable for private/developer-mode testing.

Therefore the earlier private-Plus deployment blocker remains valid: architecture feasibility does not make private full-write custom MCP available on Plus.

## Findings: published plugin route
The public Plugins Directory is visible across ChatGPT plans, but whether a particular plugin can be installed or invoked still depends on plan, workspace, region, surface, and the plugin/app capabilities. Publication does not guarantee Plus eligibility.

OpenAI nevertheless has reviewed integrations with write actions available to Plus. The Atlassian Rovo connector is an official example: it can create Jira issues and trigger workflows and is documented as available to Enterprise, Edu, Business, Pro, and Plus when connectors are enabled.

The supported public route is a reviewed plugin submission. An MCP-only plugin is allowed; custom UI is optional. After approval and publication, the plugin appears in the universal Plugins Directory shared by ChatGPT and Codex.

Public submission requirements materially differ from the V0 benchmark transport:
- production MCP server on a publicly accessible domain, not localhost/testing;
- usually one Universal MCP URL for all users/organizations;
- Template/workspace-specific URLs only when OpenAI has explicitly approved that pattern for a trusted developer;
- domain verification at `/.well-known/openai-apps-challenge` when requested;
- accurate `readOnlyHint`, `openWorldHint`, and `destructiveHint` on every tool;
- at least five positive and three negative reviewer test cases;
- public website, privacy policy, terms, and support URLs matching the publisher identity;
- verified developer/business identity and Apps Management write access;
- reviewer credentials that do not require MFA, email/SMS confirmation, or private-network access.

## Authentication finding
Customer-specific data and write actions should authenticate. OpenAI expects authenticated MCP servers to implement OAuth 2.1 according to the MCP authorization specification.

The current gateway's high-entropy static bearer token is appropriate benchmark boundary evidence, but it is not the publication auth architecture. A publication track needs an established OAuth identity provider or equivalent standards-compliant OAuth 2.1 deployment, resource metadata, token validation, scopes, and linking behavior.

## Secure MCP Tunnel does not solve public distribution
OpenAI explicitly states that Secure MCP Tunnel supports private MCP connections and developer-mode testing, but not public plugin submission or distribution. Public plugins require a stable publicly reachable HTTPS MCP endpoint; a private MCP can sit behind a public HTTPS proxy.

For this project, the public-distribution topology would therefore be conceptually:

```text
ChatGPT / published plugin
        |
 universal public HTTPS MCP relay
        |
 authenticated user/device routing
        |
 outbound local agent/session
        |
 localhost Web Agent Gateway
        |
 pinned localhost DevSpace
```

A direct Quick Tunnel or Secure MCP Tunnel per user's machine is not the default submission shape. A workspace-specific Template URL could reduce relay requirements, but OpenAI limits that model to approved trusted developers, so it cannot be assumed in the architecture.

## Supported private-use alternative: ChatGPT Business
ChatGPT Business supports full MCP developer mode for workspace admins/owners and can use Secure MCP Tunnel for a private developer-machine MCP server.

Current Standard seat pricing is USD 25/user/month monthly or USD 20/user/month billed annually, with a two-paid-seat minimum. That makes the minimum Standard-seat commitment USD 50/month on monthly billing or USD 40/month equivalent on annual billing, before taxes/currency differences.

For a single person's private local-development objective, Business therefore trades recurring seat cost for substantially less engineering, hosting, OAuth, legal/listing, and review work than a public universal-relay plugin.

## Route matrix
| Route | Current status | What it proves / requires |
| --- | --- | --- |
| Plus + private custom full-write MCP | **BLOCKED** | Current developer-mode plan access does not support it. |
| Business + private custom MCP + Secure MCP Tunnel | **SUPPORTED, EXTERNAL PURCHASE REQUIRED** | Fastest supported private-use route; requires at least two paid Business seats. |
| Reviewed public MCP plugin usable on Plus | **PLAUSIBLE OFFICIAL DISTRIBUTION TRACK, NOT YET PROVEN FOR THIS PLUGIN** | Public submission exists and reviewed write integrations can be Plus-available, but this plugin must be built, submitted, approved, published, and actually eligible on Plus. |
| Secure MCP Tunnel as public plugin endpoint | **NOT SUPPORTED** | Tunnel is for private/dev-mode connectivity, not public plugin distribution. |
| Template URL per local machine/workspace | **DO NOT ASSUME** | Requires OpenAI approval/trusted-developer relationship. |

## Current publication-readiness gaps
The merged V0/V0.1 architecture does not yet have:
- a stable universal public production MCP relay/domain;
- OAuth 2.1 end-user authorization suitable for customer-specific/write tools;
- complete publication annotations on every tool (`openWorldHint`, `destructiveHint` in addition to `readOnlyHint`);
- public legal/support/listing assets;
- verified publisher/submission-role evidence;
- reviewer-ready demo credentials without private-network requirements;
- the required five positive and three negative submission cases;
- evidence that an approved listing for this specific plugin is installable and action-capable on Plus.

## Recommendation
Do not build a universal relay solely to work around the user's current Plus private-MCP plan limit.

For the near-term personal/private objective, the lowest-engineering supported route is Business + Secure MCP Tunnel if the recurring two-seat cost is acceptable. Keep Plus/public-plugin support as a separate distribution/product track and authorize relay/OAuth/submission engineering only after deciding that broader distribution is worth that additional product surface.

No mutation capability is justified by this research. The existing bounded read/verify surface should remain the publication prototype until distribution feasibility is proven.
