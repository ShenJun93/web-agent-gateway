# WAG Browser Adapter v1 — Design

Date: 2026-09-13
Status: Proposed for written review
Decision authority: ADR-0010, ADR-0011, ADR-0013
Depends on: durable local control plane accepted locally on `feat/durable-mutation-control-plane`

## Goal

Replace the third-party browser bridge/proxy choreography with a WAG-owned host adapter while preserving the control-plane trust boundary already proven by the durable mutation slice.

The browser adapter is transport and provider integration only. It does not become a second control plane, an approval surface, a shell, or a generic machine-access service.

The first implementation targets Chromium-family browsers on Windows and proves a read-only path before enabling durable mutation preview/result through the adapter.

## Adapter ranking

WAG selects the highest-capability host path that satisfies the required semantics:

1. native MCP;
2. WebMCP/site tools when the host and browser support them;
3. WAG MV3 extension plus Native Messaging for generic Web AI pages;
4. Playwright as acceptance automation or last resort.

Adapter choice must not change WAG durable ids, tool semantics, policy, local review, mutation lifecycle, or audit records.

## Target topology

`Web AI page -> provider content adapter -> MV3 service worker -> Native Messaging -> wag-native-host -> LocalAdapterLink -> WAG control plane`

The Web AI page is outside the trusted local control plane. The content adapter observes provider UI and renders bounded tool results.

The MV3 service worker is the browser-side boundary. It validates provider identity, page origin, request shape, size limits, tool allowlists and session binding before forwarding requests locally.

`wag-native-host` is a thin bridge process. It accepts only the browser-adapter protocol, connects to the existing WAG local runtime, and forwards bounded semantic requests and results.

WAG remains the authority for durable state, workspace ownership, policy, review, mutation execution, reconciliation and audit.

## Browser-side trust model

Provider DOM, model output, content-script observations and page-derived conversation identifiers are inputs, not authority.

The content adapter does not own local credentials or durable identity. The service worker derives trusted adapter context from installed configuration plus the verified sender tab and origin.

Provider conversation metadata may be retained for correlation, but it cannot replace WAG owner, session, workspace or operation ids.

The extension side panel is a status and execution-control surface for browser tool calls. It is not the local mutation approval surface.

Local mutation approval remains exclusively in the WAG operator surface defined by the durable control-plane design.

## Native Messaging boundary

The extension service worker opens one long-lived Native Messaging port to `wag-native-host` while a supported adapter session is active.

The native-host manifest allowlists only the expected extension origin. Windows registration is per-user and is not part of this spec's implementation authority; installation or registry mutation requires a separate explicit authorization.

The native host does not expose filesystem, process, shell, arbitrary URL, operator-review or generic MCP forwarding operations.

Its protocol is intentionally narrow: connection hello, session bind/unbind, tool list, bounded tool call, bounded result/error and liveness messages.

Messages carry request ids and versioned envelopes. Unknown versions, unknown message types, oversized payloads and calls outside the configured remote-safe tool set fail closed.

Native Messaging framing is a transport detail only. The native host does not persist WAG jobs or become the source of truth for browser sessions.

## LocalAdapterLink

`wag-native-host` connects to WAG through an internal `LocalAdapterLink` abstraction. Browser code never sees the local WAG endpoint, transport credential or discovery record.

The first implementation may reuse the authenticated loopback runtime already proven by the durable-mutation spike, provided discovery state is local-only and the browser-facing protocol does not expose its address or credential.

Named pipes or another same-user local IPC mechanism may replace that implementation after measurement. The architecture does not depend on a specific local IPC primitive.

Closing the browser or Native Messaging port must not terminate durable WAG state. Reconnect creates a new adapter transport binding to existing durable records rather than reconstructing state from the page.

`wag-native-host` owns only resources it creates. It must not terminate a separately owned WAG runtime, DevSpace process, browser process or unrelated native-host instance during cleanup.

## Provider adapters

Provider integration is isolated behind a small `ProviderAdapter` contract for structured request detection, bounded result delivery, non-authoritative conversation correlation and capability reporting.

The first provider is ChatGPT Web only. Gemini Web and Kimi Web are separate follow-up adapters after the core extension/native-host path passes.

Provider adapters contain no WAG policy, local credentials, approval logic, backend logic or durable persistence.

Provider-specific parsing and UI bindings use dedicated fixtures and contract tests. Cross-provider assumptions are avoided.

## Version 1 scope

Version 1 proves the browser-to-WAG transport with the existing remote-safe read path only:

- connection health;
- remote-safe tool discovery;
- `workspace.open`;
- `file.read`.

`repo.snapshot` and `verify.run` may be enabled after the same transport contract passes their existing policy tests. Durable mutation tools are not enabled in the first transport milestone.

After the read-only milestone passes, a second acceptance milestone may expose only `mutation.preview` and `mutation.result`. Local review and execution remain unchanged from the durable control-plane design.

The existing default and Business surfaces are not widened by implementing the browser adapter.

## Lifecycle and failure behavior

The browser adapter is reconnectable and disposable. Loss of a tab, service worker, Native Messaging port or native-host process does not erase WAG durable state.

On reconnect, the service worker establishes a fresh adapter binding and requests current tool metadata from WAG. It does not replay previously observed requests automatically.

Duplicate browser request ids are rejected or resolved idempotently within the active adapter binding. Consequential WAG operations still rely on their own durable operation ids and state transitions.

If provider detection is uncertain, the adapter reports unsupported state rather than guessing selectors or tool intent.

If the native host or LocalAdapterLink is unavailable, calls fail closed with bounded diagnostics and no fallback to a broader local authority path.

## Verification strategy

Tests are layered so transport, provider binding and WAG policy failures are distinguishable.

Native-host protocol tests cover framing, version mismatch, unknown messages, payload bounds, disconnects and reconnects without a real browser.

Extension service-worker tests cover sender-origin validation, adapter-session binding, request correlation, tool allowlists and native-port lifecycle with a fake native transport.

Provider-adapter tests use saved DOM fixtures and prove parsing/result-delivery behavior without starting WAG.

Integration tests use the real WAG runtime and a test native host to prove `health`, `workspace.open` and `file.read` while verifying that browser closure does not remove durable WAG records.

Supported-host acceptance uses the owned Playwright browser policy and a fresh disposable fixture. Playwright drives only documented browser UI; it does not replace the extension-to-native transport under test.

## Acceptance gates

Read-only Browser Adapter v1 passes only when a supported ChatGPT Web session can reach WAG through the WAG-owned extension and native host, open a fresh disposable workspace, read the expected file, reconnect the browser adapter, and read the same durable workspace again without using SuperAssistant or a browser-to-local proxy.

The adapter must demonstrate that the provider page never receives the local WAG address, local transport credential or operator-review credential.

The later durable-mutation adapter gate requires the supported host to create `mutation.preview`, a local operator to review the exact record, WAG to execute locally, and the host to retrieve `mutation.result`, followed by read-back and repository snapshot evidence.

A direct MCP/HTTP call, page-script shortcut, or Playwright-only local call cannot substitute for the adapter under test.

Failure at any adapter or browser-control safety boundary is recorded fail-closed and does not authorize a broader fallback path.

## Installation and migration

The repository may contain extension/native-host build artifacts and installer logic, but installation is a separate operational step from implementation.

Creating or changing Windows Native Messaging registration, browser enterprise policy, or other machine configuration requires separate explicit authorization. No administrator elevation is assumed.

During migration, SuperAssistant remains external historical evidence only. The new adapter is benchmarked independently and must not depend on SuperAssistant configuration, proxy state or extension storage.

The historical `file.patch` compatibility spike remains untouched until the WAG-owned adapter completes the durable-mutation supported-host gate.

WebMCP remains a parallel future adapter for hosts that support it. It does not share provider DOM code with the MV3 adapter and does not change WAG control-plane semantics.

## First implementation milestone

The first implementation milestone creates only the components needed for a read-only ChatGPT Web proof:

- a minimal MV3 extension manifest and service worker;
- one ChatGPT provider adapter;
- one versioned browser/native message protocol;
- a thin `wag-native-host` process;
- a `LocalAdapterLink` implementation backed by the existing authenticated local WAG runtime;
- tests and disposable installation fixtures.

No durable-mutation browser tool is enabled in this milestone. A separate acceptance checkpoint decides whether to add `mutation.preview` and `mutation.result` afterward.

## Non-goals

This design does not add arbitrary browser automation, generic shell or filesystem commands, browser credential scraping, operator approval in the extension, autonomous model execution, Git mutation, production Business mutation, or a multi-provider extension in the first milestone.

It does not make Native Messaging itself a sandbox. WAG policy and capability boundaries remain mandatory even when the browser transport is local.

## Browser UI boundary

Adapter status and configuration belong to extension-owned browser UI. Provider-page markup is not the canonical control or transport-configuration surface.

## Protocol limits and extension identity

Serialized browser/native protocol envelopes are capped at 256 KiB in either direction for v1. Tool-specific limits may be lower and remain authoritative.

Acceptance uses a stable extension id so the Native Messaging host can allowlist one exact extension origin. The repository may contain public identity material needed to make the development id deterministic, but it must not contain private signing material.

A different production extension id requires an explicit installed-host manifest for that id; wildcard extension origins are not permitted.
