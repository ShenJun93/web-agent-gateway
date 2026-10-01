# WAG Full Harness v1 — MCP trace bridge receipt

Date: 2026-09-24
Branch: feat/full-harness-trust-observability-v1
Parent: 27a0d7aec4e886526a36d8a34079791b0ac78abe
Status: SOURCE-GREEN / NOT SERVER-INTEGRATED

## Added behavior

- tolerant MCP trace extraction for runtime boundaries;
- invalid traceparent restarts a fresh WAG trace instead of failing the tool call;
- malformed tracestate and baggage are discarded independently from a valid traceparent;
- valid incoming trace becomes the parent of the WAG tool span;
- outgoing/downstream _meta receives the WAG child traceparent;
- local authority/resource correlation never leaks into propagated MCP metadata.

The strict extract/parse helpers remain available for tests/internal validation.

## Measured gate

Observability + MCP bridge + exact-once effects + Notebook99 acceptance regression:

```text
22 tests
22 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Integration boundary

No server.ts or provider adapter has been modified. Runtime integration must be a later single-writer
change after WAG-Core is green. Trace context is correlation only; it does not select authority,
workspace, browser, process, artifact or effect ownership.
