# ADR-0007: Separate Private Business Route from Public Plugin Distribution

Date: 2026-09-10
Status: Accepted

## Context
ADR-0004 correctly separated local architecture feasibility from Web-host deployment. Fresh OpenAI product and submission documentation now resolves the deployment routes more precisely.

Private full custom MCP, including write/modify actions, is currently supported in ChatGPT Business, Enterprise, and Edu developer mode, not Plus. Secure MCP Tunnel can connect a private developer-machine MCP to supported OpenAI products without making that server public.

Separately, OpenAI accepts public MCP-backed plugin submissions. Reviewed plugins are distributed through the Plugins Directory, and some reviewed write-capable integrations are available on Plus. However, availability of any particular plugin still depends on plan, workspace, region, surface, app capabilities, review, and publication.

Public plugin submission normally requires one universal public production MCP URL. Secure MCP Tunnel cannot be used as the public submission endpoint, and workspace-specific Template URLs cannot be assumed without prior OpenAI approval.

## Decision
Maintain two independent deployment tracks:

1. **Private-use track:** ChatGPT Business + Secure MCP Tunnel is the preferred supported route when the goal is to use this gateway privately with the least additional engineering.
2. **Public-distribution track:** a reviewed public plugin is the only currently identified official path that may bring this project to Plus while retaining actions, but it is a separate productization effort requiring a universal public relay, OAuth 2.1, submission assets, review, and actual Plus-eligibility proof.

Do not build a universal relay solely to evade the Plus private-MCP plan boundary. Authorize that work only when broader distribution is an explicit project goal.

## Consequences
- `PRIVATE_PLUS_FULL_MCP` remains **BLOCKED_PRODUCT_ACCESS**.
- `BUSINESS_PRIVATE_FULL_MCP` is **SUPPORTED_EXTERNAL_PURCHASE**, currently requiring at least two paid Business seats.
- `PUBLIC_PLUGIN_PLUS_DISTRIBUTION` is **OFFICIAL_PATH_NOT_YET_PROVEN_FOR_THIS_PLUGIN**; approval/publication and Plus action availability must be demonstrated, not inferred.
- `SECURE_MCP_TUNNEL_PUBLIC_SUBMISSION` is **NOT_SUPPORTED**.
- The current static bearer transport remains benchmark-only; publication requires standards-compliant end-user authentication, expected to be OAuth 2.1 for authenticated MCP.
- Mutation, raw shell, Git mutation, gateway-restart task durability, and OS sandbox claims remain outside this decision.
- ADR-0004 is not reversed: its private developer-mode blocker remains correct. This ADR refines it by distinguishing public reviewed-plugin distribution from private custom MCP.

## Revisit conditions
Revisit this decision when any of the following changes:
- OpenAI makes private full MCP available on Plus/Pro;
- the user explicitly chooses the Business two-seat route;
- the project becomes a distribution product rather than primarily a private local tool;
- OpenAI grants Template MCP URL eligibility or another supported per-user local-host routing mechanism;
- publication requirements materially change.
