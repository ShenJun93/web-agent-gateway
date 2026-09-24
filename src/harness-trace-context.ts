import { randomBytes } from 'node:crypto';

export interface HarnessTraceContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: string;
  readonly tracestate?: string;
  readonly baggage?: string;
}

export interface ParsedTraceparent {
  readonly version: '00';
  readonly traceId: string;
  readonly parentId: string;
  readonly traceFlags: string;
}

const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;
const FLAGS = /^[0-9a-f]{2}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);
const SAFE_PROPAGATION = /^[\x20-\x7E]*$/;

function nonZeroHex(bytes: number, source: (size: number) => Uint8Array): string {
  for (;;) {
    const hex = Buffer.from(source(bytes)).toString('hex');
    if ((bytes === 16 && hex !== ZERO_TRACE) || (bytes === 8 && hex !== ZERO_SPAN)) return hex;
  }
}

function boundedPropagation(value: unknown, name: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes || !SAFE_PROPAGATION.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

export function parseTraceparent(value: string): ParsedTraceparent {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(value);
  if (!match || match[1] === ZERO_TRACE || match[2] === ZERO_SPAN) {
    throw new Error('Invalid W3C traceparent');
  }
  return Object.freeze({
    version: '00',
    traceId: match[1],
    parentId: match[2],
    traceFlags: match[3],
  });
}

export function formatTraceparent(context: Pick<HarnessTraceContext, 'traceId' | 'spanId' | 'traceFlags'>): string {
  if (!TRACE_ID.test(context.traceId) || context.traceId === ZERO_TRACE
      || !SPAN_ID.test(context.spanId) || context.spanId === ZERO_SPAN
      || !FLAGS.test(context.traceFlags)) {
    throw new Error('Invalid W3C trace context');
  }
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags}`;
}

export function createRootTraceContext(options: {
  randomBytes?: (size: number) => Uint8Array;
  sampled?: boolean;
  tracestate?: string;
  baggage?: string;
} = {}): HarnessTraceContext {
  const source = options.randomBytes ?? randomBytes;
  return Object.freeze({
    traceId: nonZeroHex(16, source),
    spanId: nonZeroHex(8, source),
    traceFlags: options.sampled === false ? '00' : '01',
    ...(boundedPropagation(options.tracestate, 'tracestate', 512) === undefined
      ? {} : { tracestate: options.tracestate }),
    ...(boundedPropagation(options.baggage, 'baggage', 4096) === undefined
      ? {} : { baggage: options.baggage }),
  });
}

export function createChildTraceContext(
  parent: HarnessTraceContext,
  options: { randomBytes?: (size: number) => Uint8Array } = {},
): HarnessTraceContext {
  formatTraceparent(parent);
  const source = options.randomBytes ?? randomBytes;
  return Object.freeze({
    traceId: parent.traceId,
    spanId: nonZeroHex(8, source),
    traceFlags: parent.traceFlags,
    ...(parent.tracestate === undefined ? {} : { tracestate: parent.tracestate }),
    ...(parent.baggage === undefined ? {} : { baggage: parent.baggage }),
  });
}

export function extractMcpTraceContext(meta: Readonly<Record<string, unknown>> | undefined): HarnessTraceContext | undefined {
  if (!meta || typeof meta.traceparent !== 'string') return undefined;
  const parsed = parseTraceparent(meta.traceparent);
  const tracestate = boundedPropagation(meta.tracestate, 'tracestate', 512);
  const baggage = boundedPropagation(meta.baggage, 'baggage', 4096);
  return Object.freeze({
    traceId: parsed.traceId,
    spanId: parsed.parentId,
    traceFlags: parsed.traceFlags,
    ...(tracestate === undefined ? {} : { tracestate }),
    ...(baggage === undefined ? {} : { baggage }),
  });
}

export function injectMcpTraceContext(
  meta: Readonly<Record<string, unknown>> | undefined,
  context: HarnessTraceContext,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(meta ?? {}),
    traceparent: formatTraceparent(context),
    ...(context.tracestate === undefined ? {} : { tracestate: context.tracestate }),
    ...(context.baggage === undefined ? {} : { baggage: context.baggage }),
  });
}
