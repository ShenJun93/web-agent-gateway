import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface ToolUsageEvent {
  sequence: number;
  /** WAG-local MCP request identity. Optional only for pre-upgrade persisted events. */
  request_id?: string;
  tool: string;
  started_at_utc: string;
  duration_ms: number;
  success: boolean;
  error_class?: string;
  effect_id?: string;
  attempt_id?: string;
  mutation_id?: string;
  commit_id?: string;
}

export interface InFlightToolUsage {
  request_id: string;
  tool: string;
  started_at_utc: string;
  elapsed_ms: number;
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
  in_flight: InFlightToolUsage[];
  next_after_sequence: number;
  retained_events: number;
  capacity: number;
}

export interface ToolUsageBetaSummary {
  schema: 'WAG_LOCAL_BETA_USAGE_SUMMARY_V1';
  retained_events: number;
  capacity: number;
  window: {
    first_seen_at_utc: string | null;
    last_seen_at_utc: string | null;
    active_utc_days: number;
  };
  totals: {
    calls: number;
    successes: number;
    failures: number;
    success_rate: number | null;
  };
  useful_workflow: {
    completed: boolean;
    successful_calls: number;
  };
  repeat_usage_signal: {
    observed: boolean;
    repeated_tool_families: string[];
    definition: 'TWO_OR_MORE_SUCCESSFUL_CALLS_IN_RETAINED_WINDOW';
  };
  tool_families: Array<{
    family: string;
    calls: number;
    successes: number;
    failures: number;
  }>;
  privacy: {
    arguments_retained: false;
    paths_retained: false;
    contents_retained: false;
    owner_or_session_ids_retained: false;
    exception_messages_retained: false;
  };
}

export interface ToolUsageCorrelation {
  readonly effectId?: string;
  readonly attemptId?: string;
  readonly mutationId?: string;
  readonly commitId?: string;
}

export interface ToolUsageCompletion {
  (success: boolean, error?: unknown, correlation?: ToolUsageCorrelation): void;
  readonly requestId: string;
}

export interface ToolUsageDiagnosticsOptions {
  capacity?: number;
  /**
   * Optional durable state file. When provided, the bounded completed-event ring survives runtime
   * restart. In-flight calls are process-local because a restart makes them no longer in flight.
   */
  statePath?: string;
  /** Test seam for deterministic request ids. Production uses crypto.randomUUID. */
  randomUUID?: () => string;
}

interface PersistedToolUsage {
  version: 1;
  next_sequence: number;
  events: ToolUsageEvent[];
}

interface InFlightState {
  requestId: string;
  tool: string;
  startedWall: number;
  startedMono: number;
}

const DEFAULT_CAPACITY = 512;
const MAX_RECENT = 100;
const REQUEST_ID = /^request_[0-9a-f-]{36}$/;
const EFFECT_ID = /^effect_[0-9a-f-]{36}$/;
const ATTEMPT_ID = /^attempt_[0-9a-f-]{36}$/;
const MUTATION_ID = /^mut_[A-Za-z0-9-]+$/;
const COMMIT_ID = /^cmt_[A-Za-z0-9-]+$/;

/**
 * Bounded MCP usage diagnostics.
 *
 * Deliberately stores no arguments, paths, command text, file contents, output, owner/session ids,
 * credentials, idempotency keys, or exception messages. Completed calls can retain only opaque
 * WAG request/effect identities so a lost ChatGPT response stream can be reconciled without
 * replaying a consequential effect blindly. Mutation and commit correlations retain only their
 * opaque durable ids so interrupted callers can recover state through the existing result tools.
 */
export class ToolUsageDiagnostics {
  private readonly capacity: number;
  private readonly statePath: string | undefined;
  private readonly uuid: () => string;
  private readonly events: ToolUsageEvent[] = [];
  private readonly inFlight = new Map<string, InFlightState>();
  private nextSequence = 1;

  constructor(options: number | ToolUsageDiagnosticsOptions = DEFAULT_CAPACITY) {
    const normalized = typeof options === 'number' ? { capacity: options } : options;
    const capacity = normalized.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 16 || capacity > 10_000) {
      throw new Error('Tool usage diagnostics capacity must be an integer in [16,10000]');
    }
    this.capacity = capacity;
    this.statePath = normalized.statePath;
    this.uuid = normalized.randomUUID ?? randomUUID;
    this.loadPersisted();
  }

  begin(tool: string): ToolUsageCompletion {
    const requestId = `request_${this.uuid()}`;
    if (!REQUEST_ID.test(requestId)) throw new Error('Tool usage diagnostics request id is invalid');
    const startedWall = Date.now();
    const startedMono = performance.now();
    this.inFlight.set(requestId, { requestId, tool, startedWall, startedMono });

    let finished = false;
    const complete = ((success: boolean, error?: unknown, correlation?: ToolUsageCorrelation) => {
      if (finished) return;
      finished = true;
      this.inFlight.delete(requestId);
      const safeCorrelation = sanitizeCorrelation(correlation);
      const event: ToolUsageEvent = {
        sequence: this.nextSequence++,
        request_id: requestId,
        tool,
        started_at_utc: new Date(startedWall).toISOString(),
        duration_ms: roundMillis(performance.now() - startedMono),
        success,
        ...(error === undefined ? {} : {
          error_class: error instanceof Error ? error.constructor.name : typeof error,
        }),
        ...(safeCorrelation.effectId === undefined ? {} : { effect_id: safeCorrelation.effectId }),
        ...(safeCorrelation.attemptId === undefined ? {} : { attempt_id: safeCorrelation.attemptId }),
        ...(safeCorrelation.mutationId === undefined ? {} : { mutation_id: safeCorrelation.mutationId }),
        ...(safeCorrelation.commitId === undefined ? {} : { commit_id: safeCorrelation.commitId }),
      };
      this.events.push(event);
      if (this.events.length > this.capacity) {
        this.events.splice(0, this.events.length - this.capacity);
      }
      this.persist();
    }) as ToolUsageCompletion;
    Object.defineProperty(complete, 'requestId', {
      value: requestId,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    return complete;
  }

  recent(options: { limit?: number; afterSequence?: number } = {}): RecentToolUsage {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_RECENT);
    const after = Math.max(options.afterSequence ?? 0, 0);
    const selected = this.events.filter((event) => event.sequence > after).slice(-limit);
    const nowMono = performance.now();
    return {
      events: selected.map((event) => ({ ...event })),
      in_flight: [...this.inFlight.values()].map((entry) => ({
        request_id: entry.requestId,
        tool: entry.tool,
        started_at_utc: new Date(entry.startedWall).toISOString(),
        elapsed_ms: roundMillis(Math.max(0, nowMono - entry.startedMono)),
      })),
      next_after_sequence: selected.at(-1)?.sequence ?? after,
      retained_events: this.events.length,
      capacity: this.capacity,
    };
  }

  betaSummary(): ToolUsageBetaSummary {
    const families = new Map<string, { calls: number; successes: number; failures: number }>();
    let usefulSuccessfulCalls = 0;
    const activeDays = new Set<string>();
    for (const event of this.events) {
      const family = toolFamily(event.tool);
      const current = families.get(family) ?? { calls: 0, successes: 0, failures: 0 };
      current.calls += 1;
      current.successes += event.success ? 1 : 0;
      current.failures += event.success ? 0 : 1;
      families.set(family, current);
      if (event.success && isUsefulWorkflowTool(event.tool)) usefulSuccessfulCalls += 1;
      const day = event.started_at_utc.slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) activeDays.add(day);
    }
    const successes = this.events.filter((event) => event.success).length;
    const failures = this.events.length - successes;
    const toolFamilies = [...families.entries()]
      .map(([family, value]) => ({ family, ...value }))
      .sort((a, b) => b.calls - a.calls || a.family.localeCompare(b.family));
    const repeatedFamilies = toolFamilies
      .filter((entry) => entry.successes >= 2 && !['system', 'product', 'diagnostics', 'other'].includes(entry.family))
      .map((entry) => entry.family)
      .sort();
    return {
      schema: 'WAG_LOCAL_BETA_USAGE_SUMMARY_V1',
      retained_events: this.events.length,
      capacity: this.capacity,
      window: {
        first_seen_at_utc: this.events[0]?.started_at_utc ?? null,
        last_seen_at_utc: this.events.at(-1)?.started_at_utc ?? null,
        active_utc_days: activeDays.size,
      },
      totals: {
        calls: this.events.length,
        successes,
        failures,
        success_rate: this.events.length === 0 ? null : roundRate(successes / this.events.length),
      },
      useful_workflow: {
        completed: usefulSuccessfulCalls > 0,
        successful_calls: usefulSuccessfulCalls,
      },
      repeat_usage_signal: {
        observed: repeatedFamilies.length > 0,
        repeated_tool_families: repeatedFamilies,
        definition: 'TWO_OR_MORE_SUCCESSFUL_CALLS_IN_RETAINED_WINDOW',
      },
      tool_families: toolFamilies,
      privacy: {
        arguments_retained: false,
        paths_retained: false,
        contents_retained: false,
        owner_or_session_ids_retained: false,
        exception_messages_retained: false,
      },
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
      // ignored and replaced atomically on the next ordinary completed tool event.
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

function toolFamily(tool: string): string {
  const prefix = tool.split('.')[0] ?? '';
  if (prefix === 'machine') return 'machine';
  if (prefix === 'browser') return 'browser';
  if (prefix === 'artifact') return 'artifact';
  if (['repo', 'file', 'mutation', 'change', 'git', 'verify', 'command'].includes(prefix)) return 'repository';
  if (prefix === 'product') return 'product';
  if (prefix === 'diagnostics') return 'diagnostics';
  if (['health', 'workspace', 'capabilities', 'result'].includes(prefix)) return 'system';
  return 'other';
}

function isUsefulWorkflowTool(tool: string): boolean {
  const family = toolFamily(tool);
  return !['system', 'product', 'diagnostics', 'other'].includes(family);
}

function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function sanitizeCorrelation(value: ToolUsageCorrelation | undefined): ToolUsageCorrelation {
  if (!value || typeof value !== 'object') return {};
  const effectId = typeof value.effectId === 'string' && EFFECT_ID.test(value.effectId)
    ? value.effectId
    : undefined;
  const attemptId = effectId !== undefined
    && typeof value.attemptId === 'string'
    && ATTEMPT_ID.test(value.attemptId)
    ? value.attemptId
    : undefined;
  const mutationId = typeof value.mutationId === 'string' && MUTATION_ID.test(value.mutationId)
    ? value.mutationId
    : undefined;
  const commitId = typeof value.commitId === 'string' && COMMIT_ID.test(value.commitId)
    ? value.commitId
    : undefined;
  return {
    ...(effectId === undefined ? {} : { effectId }),
    ...(attemptId === undefined ? {} : { attemptId }),
    ...(mutationId === undefined ? {} : { mutationId }),
    ...(commitId === undefined ? {} : { commitId }),
  };
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
      || (candidate.request_id !== undefined
        && (typeof candidate.request_id !== 'string' || !REQUEST_ID.test(candidate.request_id)))
      || typeof candidate.tool !== 'string' || candidate.tool.length < 1 || candidate.tool.length > 128
      || typeof candidate.started_at_utc !== 'string'
      || !Number.isFinite(candidate.duration_ms) || (candidate.duration_ms ?? -1) < 0
      || typeof candidate.success !== 'boolean'
      || (candidate.error_class !== undefined
        && (typeof candidate.error_class !== 'string' || candidate.error_class.length > 128))
      || (candidate.effect_id !== undefined
        && (typeof candidate.effect_id !== 'string' || !EFFECT_ID.test(candidate.effect_id)))
      || (candidate.attempt_id !== undefined
        && (typeof candidate.attempt_id !== 'string' || !ATTEMPT_ID.test(candidate.attempt_id)))
      || (candidate.attempt_id !== undefined && candidate.effect_id === undefined)
      || (candidate.mutation_id !== undefined
        && (typeof candidate.mutation_id !== 'string' || !MUTATION_ID.test(candidate.mutation_id)))
      || (candidate.commit_id !== undefined
        && (typeof candidate.commit_id !== 'string' || !COMMIT_ID.test(candidate.commit_id)))) {
      return false;
    }
    previous = candidate.sequence!;
  }
  return true;
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}
