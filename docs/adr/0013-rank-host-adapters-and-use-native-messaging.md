# ADR-0013: Rank Host Adapters and Use Native Messaging for Generic Web AI

Date: 2026-09-13
Status: Proposed

WAG host integration is capability-ranked rather than bound to one browser bridge.

Preferred order is: native MCP when the host supports the required semantics; WebMCP/site tools when the host and browser support them; a WAG-owned MV3 extension using Native Messaging for generic Web AI pages; Playwright only as an acceptance or last-resort adapter.

The generic browser adapter must not expose a localhost MCP endpoint, bearer token, approval credential, or transport configuration to the web page. Its content script is untrusted input relative to the extension service worker and WAG.

The MV3 service worker owns the Native Messaging connection and validates the provider/origin and bounded request envelope. The native host is a thin transport shim and does not own approval policy, durable jobs, filesystem authority, shell authority, or model execution.

Local mutation approval remains outside every Web AI adapter. Browser adapters may request `mutation.preview` and read `mutation.result`, but cannot approve or directly apply a mutation.

SuperAssistant remains donor and historical compatibility evidence only. It is not part of the canonical production adapter topology.

Windows native-host registration is a separate installation action and requires a separate authorization before writing HKCU or equivalent system configuration.
