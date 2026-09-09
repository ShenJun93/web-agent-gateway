import { randomUUID } from 'node:crypto';

export interface GatewayTelemetryEvent {
  requestId: string;
  tool: string;
  success: boolean;
  ingressMs: number;
  policyMs: number;
  executorMs: number;
  aggregationMs: number;
  totalMs: number;
  errorClass?: string;
}

export interface TelemetrySink { record(event: GatewayTelemetryEvent): void; }
export const NOOP_TELEMETRY: TelemetrySink = { record() {} };

export class MemoryTelemetry implements TelemetrySink {
  private readonly events: GatewayTelemetryEvent[] = [];
  record(event: GatewayTelemetryEvent): void { this.events.push({ ...event }); }
  snapshot(): GatewayTelemetryEvent[] { return this.events.map((event) => ({ ...event })); }
}

export type TimedPhase = 'policyMs' | 'executorMs' | 'aggregationMs';

export function startTrace(tool: string, sink: TelemetrySink = NOOP_TELEMETRY) {
  const started = performance.now();
  const event: GatewayTelemetryEvent = { requestId: randomUUID(), tool, success: false, ingressMs: 0, policyMs: 0, executorMs: 0, aggregationMs: 0, totalMs: 0 };
  return {
    markIngress() { event.ingressMs = performance.now() - started; },
    async phase<T>(name: TimedPhase, operation: () => T | Promise<T>): Promise<T> {
      const phaseStarted = performance.now();
      try { return await operation(); } finally { event[name] += performance.now() - phaseStarted; }
    },
    finish(success: boolean, error?: unknown) {
      event.success = success;
      event.totalMs = performance.now() - started;
      if (error) event.errorClass = error instanceof Error ? error.constructor.name : typeof error;
      sink.record(event);
    },
  };
}
