import { randomBytes } from 'node:crypto';
import type { GatewayAuthority } from './caller-context.js';
import type { HarnessEffectRecord } from './harness-effect-ledger.js';
import {
  createChildTraceContext,
  createRootTraceContext,
  type HarnessTraceContext,
} from './harness-trace-context.js';

export type HarnessSpanStatus = 'UNSET' | 'OK' | 'ERROR';

export interface HarnessSpanCorrelation {
  readonly requestId?: string;
  readonly workspaceId?: string;
  readonly browserSessionId?: string;
  readonly processId?: string;
  readonly artifactId?: string;
  readonly resourceId?: string;
  readonly effectId?: string;
  readonly attemptId?: string;
}

export interface HarnessSpanRecord {
  readonly name: string;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly traceFlags: string;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMs: number;
  readonly status: HarnessSpanStatus;
  readonly errorClass?: string;
  readonly authority?: GatewayAuthority;
  readonly correlation: HarnessSpanCorrelation;
}

export interface HarnessSpanExporter {
  export(record: HarnessSpanRecord): void | Promise<void>;
}

export interface HarnessSpanScope {
  readonly context: HarnessTraceContext;
  finish(status?: 'OK' | 'UNSET'): Promise<HarnessSpanRecord>;
  fail(errorClass: string): Promise<HarnessSpanRecord>;
}

const NAME = /^[A-Za-z0-9._:/-]{1,160}$/;
const CORRELATION = /^[A-Za-z0-9._:/-]{1,300}$/;

function safeOptional(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (!CORRELATION.test(value)) throw new Error(`Invalid harness span ${name}`);
  return value;
}

function cloneAuthority(authority: GatewayAuthority | undefined): GatewayAuthority | undefined {
  return authority === undefined ? undefined : Object.freeze({ ...authority });
}

function cleanCorrelation(value: HarnessSpanCorrelation | undefined): HarnessSpanCorrelation {
  const input = value ?? {};
  return Object.freeze({
    ...(safeOptional(input.requestId, 'requestId') === undefined ? {} : { requestId: input.requestId }),
    ...(safeOptional(input.workspaceId, 'workspaceId') === undefined ? {} : { workspaceId: input.workspaceId }),
    ...(safeOptional(input.browserSessionId, 'browserSessionId') === undefined ? {} : { browserSessionId: input.browserSessionId }),
    ...(safeOptional(input.processId, 'processId') === undefined ? {} : { processId: input.processId }),
    ...(safeOptional(input.artifactId, 'artifactId') === undefined ? {} : { artifactId: input.artifactId }),
    ...(safeOptional(input.resourceId, 'resourceId') === undefined ? {} : { resourceId: input.resourceId }),
    ...(safeOptional(input.effectId, 'effectId') === undefined ? {} : { effectId: input.effectId }),
    ...(safeOptional(input.attemptId, 'attemptId') === undefined ? {} : { attemptId: input.attemptId }),
  });
}

export class HarnessTracer {
  readonly #exporter: HarnessSpanExporter;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #sampled: boolean;

  constructor(options: {
    exporter: HarnessSpanExporter;
    now?: () => number;
    randomBytes?: (size: number) => Uint8Array;
    sampled?: boolean;
  }) {
    this.#exporter = options.exporter;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? randomBytes;
    this.#sampled = options.sampled ?? true;
  }

  startSpan(
    name: string,
    options: {
      parent?: HarnessTraceContext;
      authority?: GatewayAuthority;
      correlation?: HarnessSpanCorrelation;
    } = {},
  ): HarnessSpanScope {
    if (!NAME.test(name)) throw new Error('Invalid harness span name');
    const parent = options.parent;
    const context = parent === undefined
      ? createRootTraceContext({ randomBytes: this.#randomBytes, sampled: this.#sampled })
      : createChildTraceContext(parent, { randomBytes: this.#randomBytes });
    const startedAt = this.#now();
    const authority = cloneAuthority(options.authority);
    const correlation = cleanCorrelation(options.correlation);
    let finished = false;

    const complete = async (status: HarnessSpanStatus, errorClass?: string): Promise<HarnessSpanRecord> => {
      if (finished) throw new Error('Harness span is already finished');
      finished = true;
      if (errorClass !== undefined && !NAME.test(errorClass)) throw new Error('Invalid harness span error class');
      const endedAt = this.#now();
      const record = Object.freeze({
        name,
        traceId: context.traceId,
        spanId: context.spanId,
        ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
        traceFlags: context.traceFlags,
        startedAt,
        endedAt,
        durationMs: Math.max(0, endedAt - startedAt),
        status,
        ...(errorClass === undefined ? {} : { errorClass }),
        ...(authority === undefined ? {} : { authority }),
        correlation,
      }) satisfies HarnessSpanRecord;
      await this.#exporter.export(record);
      return record;
    };

    return Object.freeze({
      context,
      finish(status: 'OK' | 'UNSET' = 'OK') {
        return complete(status);
      },
      fail(errorClass: string) {
        return complete('ERROR', errorClass);
      },
    });
  }
}

export function correlationFromEffect(
  effect: HarnessEffectRecord,
  base: HarnessSpanCorrelation = {},
): HarnessSpanCorrelation {
  return cleanCorrelation({
    ...base,
    resourceId: effect.resourceId,
    effectId: effect.effectId,
    attemptId: effect.attemptId,
  });
}

export function createMemorySpanExporter(target: HarnessSpanRecord[] = []): HarnessSpanExporter & {
  readonly records: readonly HarnessSpanRecord[];
} {
  return Object.freeze({
    records: target,
    export(record: HarnessSpanRecord) {
      target.push(record);
    },
  });
}
