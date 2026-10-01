# Full Harness trust / observability upstream evidence — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE RECHECK / SOURCE DESIGN INPUT

## MCP 2026-07-28

The final MCP 2026-07-28 protocol is stateless at the protocol core. The release documentation says
W3C Trace Context propagation in _meta is documented with fixed traceparent, tracestate and baggage
key names so a trace can correlate through host, client, MCP server and downstream work.

Official sources:
- https://blog.modelcontextprotocol.io/posts/2026-07-28/
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://ts.sdk.modelcontextprotocol.io/v2/

Disposition:
- WAG observability must not depend on transport sessions;
- tracing is explicit context propagated per request;
- resource/session/effect handles remain WAG-owned explicit state, separate from trace identity;
- trace context is correlation only and never authority.

## W3C Trace Context

W3C Trace Context defines traceparent as version + 16-byte trace-id + 8-byte parent-id + flags.
All-zero trace/span identifiers are invalid. tracestate is optional vendor context. The privacy
section says traceparent/tracestate must not carry PII or sensitive information.

Official source:
- https://www.w3.org/TR/trace-context/

Disposition:
- parse/format strict lowercase version-00 traceparent;
- reject zero identifiers and malformed propagation;
- do not put authority, prompts, file content, credentials or exception messages into W3C fields.

## OpenTelemetry JavaScript

Current OpenTelemetry JavaScript documentation reports traces and metrics stable while logs remain
in development; browser client instrumentation remains experimental. Its Context API is the normal
mechanism for child-span propagation.

Official sources:
- https://opentelemetry.io/docs/languages/js/
- https://opentelemetry.io/docs/languages/js/context/

Disposition:
- WAG core defines a small exporter interface rather than adding an OpenTelemetry SDK dependency;
- an OpenTelemetry exporter/adapter can be composed later at the runtime boundary;
- local unit tests stay dependency-free and deterministic.

## Source-slice decision

This lane implements:
- strict W3C trace context parsing/formatting;
- MCP _meta extraction/injection helpers;
- root/child context creation;
- explicit HarnessTracer spans;
- correlation fields for request/workspace/browser/process/artifact/effect/attempt handles;
- exporter seam;
- exact effect-ledger correlation helper.

It does not change server.ts, runtime config, MCP publication, provider credentials, or any live
execution surface.
