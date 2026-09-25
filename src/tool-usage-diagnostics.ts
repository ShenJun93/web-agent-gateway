import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

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

export interface ToolUsageDiagnosticsOptions {
  capacity?: number;
  /**
   * Optional durable state file. When provided, the bounded event ring survives runtime restart.
   * The file stores only the same sanitized fields exposed by diagnostics.recent.
   */
  statePath?: string;
}

interface PersistedToolUsage {
  version: 1;
  next_sequence: number;
  events: ToolUsageEvent[];
}

const DEFAULT_CAPACITY = 512;
const MAX_RECENT = 100;

/**
 * Bounded MCP usage diagnostics.
 *
 * Deliberately stores no arguments, paths, command text, file contents, output, owner/session ids,
 * credentials, or exception messages. A durable state file is optional; stable private-local
 * sessions use one so operational history survives a WAG runtime restart.
 */
export class ToolUsageDiagnostics {
  private readonly capacity: number;
  private readonly statePath: string | undefined;
  private readonly events: ToolUsageEvent[] = [];
  private nextSequence = 1;

  constructor(options: number | ToolUsageDiagnosticsOptions = DEFAULT_CAPACITY) {
    const normalized = typeof options === 'number' ? { capacity: options } : options;
    const capacity = normalized.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 16 || capacity > 10_000) {
      throw new Error('Tool usage diagnostics capacity must be an integer in [16,10000]');
    }
    this.capacity = capacity;
    this.statePath = normalized.statePath;
    this.loadPersisted();
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
      this.persist();
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

  private loadPersisted(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
      if (!isPersistedToolUsage(parsed)) return;
      const retained = parsed.events.slice(-this.capacity);
      this.events.push(...retained.map((event) => ({ ...event })));
      const maxSequence = retained.reduce((max, event) => Math.max(max, event.sequence), 0);
      this.nextSequence = Math.max(parsed.next_sequence, maxSequence + 1, 1);
    } catch {
      // Diagnostics must never make the gateway unavailable. A malformed diagnostics file is
      // ignored and replaced atomically on the next ordinary tool event.
    }
  }

  private persist(): void {
    if (!this.statePath) return;
    const payload: PersistedToolUsage = {
      version: 1,
      next_sequence: this.nextSequence,
      events: this.events,
    };
    const temp = this.statePath + '.tmp';
    writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temp, this.statePath);
  }
}

function isPersistedToolUsage(value: unknown): value is PersistedToolUsage {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<PersistedToolUsage>;
  if (row.version !== 1 || !Number.isInteger(row.next_sequence) || (row.next_sequence ?? 0) < 1
    || !Array.isArray(row.events)) {
    return false;
  }
  let previous = 0;
  for (const event of row.events) {
    if (!event || typeof event !== 'object') return false;
    const candidate = event as Partial<ToolUsageEvent>;
    if (!Number.isInteger(candidate.sequence) || (candidate.sequence ?? 0) <= previous
      || typeof candidate.tool !== 'string' || candidate.tool.length < 1 || candidate.tool.length > 128
      || typeof candidate.started_at_utc !== 'string'
      || !Number.isFinite(candidate.duration_ms) || (candidate.duration_ms ?? -1) < 0
      || typeof candidate.success !== 'boolean'
      || (candidate.error_class !== undefined
        && (typeof candidate.error_class !== 'string' || candidate.error_class.length > 128))) {
      return false;
    }
    previous = candidate.sequence!;
  }
  return true;
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}
