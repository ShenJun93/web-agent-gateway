export interface ToolUsageEvent {
  sequence: number;
  tool: string;
  started_at_utc: string;
  duration_ms: number;
  success: boolean;
  error_class?: string;
}

export interface ToolUsageSummary {
  tool: string;
  calls: number;
  successes: number;
  failures: number;
  total_ms: number;
  average_ms: number;
  last_sequence: number;
  last_seen_at_utc: string;
}

export interface RecentToolUsage {
  events: ToolUsageEvent[];
  next_after_sequence: number;
  retained_events: number;
  capacity: number;
}

const DEFAULT_CAPACITY = 512;
const MAX_RECENT = 100;

/**
 * Process-local, bounded MCP usage diagnostics.
 *
 * Deliberately stores no arguments, paths, command text, file contents, output, owner/session ids,
 * credentials, or exception messages. It is safe to surface through private stdio because each row
 * contains only the tool name, timing, outcome, sequence and error class.
 */
export class ToolUsageDiagnostics {
  private readonly capacity: number;
  private readonly events: ToolUsageEvent[] = [];
  private nextSequence = 1;

  constructor(capacity = DEFAULT_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 16 || capacity > 10_000) {
      throw new Error('Tool usage diagnostics capacity must be an integer in [16,10000]');
    }
    this.capacity = capacity;
  }

  begin(tool: string): (success: boolean, error?: unknown) => void {
    const startedWall = Date.now();
    const startedMono = performance.now();
    let finished = false;
    return (success, error) => {
      if (finished) return;
      finished = true;
      const event: ToolUsageEvent = {
        sequence: this.nextSequence++,
        tool,
        started_at_utc: new Date(startedWall).toISOString(),
        duration_ms: roundMillis(performance.now() - startedMono),
        success,
        ...(error === undefined ? {} : {
          error_class: error instanceof Error ? error.constructor.name : typeof error,
        }),
      };
      this.events.push(event);
      if (this.events.length > this.capacity) {
        this.events.splice(0, this.events.length - this.capacity);
      }
    };
  }

  recent(options: { limit?: number; afterSequence?: number } = {}): RecentToolUsage {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_RECENT);
    const after = Math.max(options.afterSequence ?? 0, 0);
    const selected = this.events.filter((event) => event.sequence > after).slice(-limit);
    return {
      events: selected.map((event) => ({ ...event })),
      next_after_sequence: selected.at(-1)?.sequence ?? after,
      retained_events: this.events.length,
      capacity: this.capacity,
    };
  }

  usage(): {
    total_calls: number;
    successes: number;
    failures: number;
    retained_events: number;
    capacity: number;
    tools: ToolUsageSummary[];
  } {
    const byTool = new Map<string, {
      calls: number;
      successes: number;
      failures: number;
      totalMs: number;
      lastSequence: number;
      lastSeenAtUtc: string;
    }>();

    for (const event of this.events) {
      const current = byTool.get(event.tool) ?? {
        calls: 0,
        successes: 0,
        failures: 0,
        totalMs: 0,
        lastSequence: 0,
        lastSeenAtUtc: event.started_at_utc,
      };
      current.calls += 1;
      current.successes += event.success ? 1 : 0;
      current.failures += event.success ? 0 : 1;
      current.totalMs += event.duration_ms;
      current.lastSequence = event.sequence;
      current.lastSeenAtUtc = event.started_at_utc;
      byTool.set(event.tool, current);
    }

    const tools = [...byTool.entries()]
      .map(([tool, value]): ToolUsageSummary => ({
        tool,
        calls: value.calls,
        successes: value.successes,
        failures: value.failures,
        total_ms: roundMillis(value.totalMs),
        average_ms: value.calls === 0 ? 0 : roundMillis(value.totalMs / value.calls),
        last_sequence: value.lastSequence,
        last_seen_at_utc: value.lastSeenAtUtc,
      }))
      .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));

    return {
      total_calls: this.events.length,
      successes: this.events.filter((event) => event.success).length,
      failures: this.events.filter((event) => !event.success).length,
      retained_events: this.events.length,
      capacity: this.capacity,
      tools,
    };
  }
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}
