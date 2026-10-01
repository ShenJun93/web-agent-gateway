import type { GatewayAuthority } from './caller-context.js';
import {
  type HarnessSpanCorrelation,
  type HarnessSpanScope,
  HarnessTracer,
} from './harness-observability.js';
import {
  injectMcpTraceContext,
  tryExtractMcpTraceContext,
} from './harness-trace-context.js';

export type IncomingTraceDisposition = 'ABSENT' | 'ACCEPTED' | 'RESTARTED';

export interface McpObservedCall {
  readonly span: HarnessSpanScope;
  readonly incomingTrace: IncomingTraceDisposition;
  downstreamMeta(meta?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>;
}

export function startObservedMcpCall(
  tracer: HarnessTracer,
  input: {
    readonly name: string;
    readonly meta?: Readonly<Record<string, unknown>>;
    readonly authority?: GatewayAuthority;
    readonly correlation?: HarnessSpanCorrelation;
  },
): McpObservedCall {
  const hadTraceparent = typeof input.meta?.traceparent === 'string';
  const parent = tryExtractMcpTraceContext(input.meta);
  const span = tracer.startSpan(input.name, {
    ...(parent === undefined ? {} : { parent }),
    ...(input.authority === undefined ? {} : { authority: input.authority }),
    ...(input.correlation === undefined ? {} : { correlation: input.correlation }),
  });
  const incomingTrace: IncomingTraceDisposition = parent === undefined
    ? (hadTraceparent ? 'RESTARTED' : 'ABSENT')
    : 'ACCEPTED';

  return Object.freeze({
    span,
    incomingTrace,
    downstreamMeta(meta?: Readonly<Record<string, unknown>>) {
      return injectMcpTraceContext(meta, span.context);
    },
  });
}
