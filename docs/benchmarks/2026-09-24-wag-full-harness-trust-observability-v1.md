# WAG Full Harness v1 — Trust / Observability source receipt

Date: 2026-09-24
Branch: feat/full-harness-trust-observability-v1
Base: e6c76550993ea4f1b6e406fcb3a9816abb78346b
Status: SOURCE-GREEN / NOT MCP-INTEGRATED / NOT RUNTIME-PROMOTED

## Added source

- src/harness-trace-context.ts
- src/harness-observability.ts
- test/harness-trace-context.test.ts
- test/harness-observability.test.ts

## Proven properties

Trace propagation:
- strict W3C version-00 traceparent parsing/formatting;
- zero trace/span ids fail closed;
- root and child spans retain one trace id and rotate span id;
- MCP _meta uses traceparent/tracestate/baggage keys without mutating caller metadata;
- propagation values are length/control-character bounded.

Local observability:
- spans carry explicit parent relationship;
- exact owner/session/adapter may be recorded locally as authority evidence;
- correlation is limited to bounded opaque ids for request/workspace/browser/process/artifact/
  resource/effect/attempt;
- failures record an error class, not arbitrary exception/message text;
- effect correlation copies only resource/effect/attempt ids and never effect arguments/result
  content;
- exporter is dependency-injected, so OpenTelemetry remains an outer adapter rather than a core
  dependency.

## Measured gates

Focused observability + exact-once effect / Notebook99 regression:

```text
18 tests
18 pass
0 fail
```

Repository source build:

```text
npm run build
PASS
```

## Non-claims

This slice does not claim:
- server.ts integration;
- automatic instrumentation of every MCP tool;
- OpenTelemetry SDK/exporter installation;
- a telemetry backend;
- browser instrumentation;
- provider-side trace ingestion;
- production trace sampling policy;
- runtime promotion.

## Integration gate

When WAG-Core is integration-green, compose tracing at the private MCP request boundary:
1. extract incoming W3C context from request _meta when valid;
2. start a WAG child span for tool execution;
3. correlate explicit WAG resource/effect handles;
4. inject child context only into supported downstream MCP/HTTP calls;
5. export through an outer OpenTelemetry-compatible adapter;
6. never use trace identity as authority or resource ownership.
