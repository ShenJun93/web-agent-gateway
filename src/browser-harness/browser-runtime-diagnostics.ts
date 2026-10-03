import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type BrowserDiagnosticAction =
  | 'open'
  | 'recover'
  | 'describe'
  | 'snapshot'
  | 'navigate'
  | 'click'
  | 'fill'
  | 'upload_file'
  | 'download'
  | 'dialog_get'
  | 'dialog_respond'
  | 'permission_set'
  | 'wait_for'
  | 'assert'
  | 'media_inspect'
  | 'press'
  | 'pause_for_user'
  | 'take_user_control'
  | 'resume_automation'
  | 'screenshot'
  | 'close';

export interface BrowserRuntimeDiagnosticEvent {
  sequence: number;
  started_at_utc: string;
  duration_ms: number;
  action_type: BrowserDiagnosticAction;
  success: boolean;
  browser_session_id?: string;
  target_id?: string;
  ownership_mode?: string;
  error_class?: string;
  target_changed: boolean;
  recovered: boolean;
}

export interface BrowserRuntimeDiagnosticsRecent {
  events: BrowserRuntimeDiagnosticEvent[];
  next_after_sequence: number;
  retained_events: number;
  capacity: number;
}

export interface BrowserRuntimeDiagnosticStart {
  actionType: BrowserDiagnosticAction;
  browserSessionId?: string;
  targetId?: string;
  ownershipMode?: string;
  recovered?: boolean;
}

export interface BrowserRuntimeDiagnosticCompletion {
  targetId?: string;
  ownershipMode?: string;
  targetChanged?: boolean;
  recovered?: boolean;
}

interface PersistedBrowserRuntimeDiagnostics {
  version: 1;
  next_sequence: number;
  events: BrowserRuntimeDiagnosticEvent[];
}

export interface BrowserRuntimeDiagnosticsOptions {
  capacity?: number;
  statePath?: string;
  now?: () => number;
  monotonicNow?: () => number;
}

const DEFAULT_CAPACITY = 256;
const MAX_CAPACITY = 2048;
const MAX_RECENT = 100;
const BROWSER_SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
const OWNERSHIP_MODES = new Set(['WAG_OWNED', 'ATTACHED_EXISTING']);
const ACTIONS = new Set<BrowserDiagnosticAction>([
  'open',
  'recover',
  'describe',
  'snapshot',
  'navigate',
  'click',
  'fill',
  'upload_file',
  'download',
  'dialog_get',
  'dialog_respond',
  'permission_set',
  'wait_for',
  'assert',
  'media_inspect',
  'press',
  'pause_for_user',
  'take_user_control',
  'resume_automation',
  'screenshot',
  'close',
]);

/**
 * Privacy-bounded Browser v2 diagnostics.
 *
 * Deliberately never stores URL/title/page text, semantic node names/values, form content,
 * arguments, idempotency keys, cookies, tokens, credentials, profile paths or exception messages.
 * Only opaque WAG/browser ids and coarse execution metadata are retained.
 */
export class BrowserRuntimeDiagnostics {
  readonly capacity: number;
  readonly statePath: string | undefined;
  readonly #now: () => number;
  readonly #mono: () => number;
  readonly #events: BrowserRuntimeDiagnosticEvent[] = [];
  #nextSequence = 1;

  constructor(options: number | BrowserRuntimeDiagnosticsOptions = DEFAULT_CAPACITY) {
    const normalized = typeof options === 'number' ? { capacity: options } : options;
    const capacity = normalized.capacity ?? DEFAULT_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 16 || capacity > MAX_CAPACITY) {
      throw new Error('Browser diagnostics capacity must be an integer in [16,2048]');
    }
    this.capacity = capacity;
    this.statePath = normalized.statePath;
    this.#now = normalized.now ?? Date.now;
    this.#mono = normalized.monotonicNow ?? performance.now.bind(performance);
    this.#load();
  }

  begin(input: BrowserRuntimeDiagnosticStart) {
    const safeStart = sanitizeStart(input);
    const startedWall = this.#now();
    const startedMono = this.#mono();
    let finished = false;
    return (
      success: boolean,
      error?: unknown,
      completion: BrowserRuntimeDiagnosticCompletion = {},
    ): void => {
      if (finished) return;
      finished = true;
      const safeCompletion = sanitizeCompletion(completion);
      const event: BrowserRuntimeDiagnosticEvent = {
        sequence: this.#nextSequence++,
        started_at_utc: new Date(startedWall).toISOString(),
        duration_ms: roundMillis(Math.max(0, this.#mono() - startedMono)),
        action_type: safeStart.actionType,
        success,
        ...(safeStart.browserSessionId === undefined ? {} : {
          browser_session_id: safeStart.browserSessionId,
        }),
        ...((safeCompletion.targetId ?? safeStart.targetId) === undefined ? {} : {
          target_id: safeCompletion.targetId ?? safeStart.targetId,
        }),
        ...((safeCompletion.ownershipMode ?? safeStart.ownershipMode) === undefined ? {} : {
          ownership_mode: safeCompletion.ownershipMode ?? safeStart.ownershipMode,
        }),
        ...(error === undefined ? {} : {
          error_class: boundedErrorClass(error),
        }),
        target_changed: safeCompletion.targetChanged === true,
        recovered: safeCompletion.recovered ?? safeStart.recovered ?? false,
      };
      this.#events.push(event);
      if (this.#events.length > this.capacity) {
        this.#events.splice(0, this.#events.length - this.capacity);
      }
      this.#persist();
    };
  }

  recent(options: { limit?: number; afterSequence?: number } = {}): BrowserRuntimeDiagnosticsRecent {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_RECENT);
    const after = Math.max(options.afterSequence ?? 0, 0);
    const selected = this.#events.filter((event) => event.sequence > after).slice(-limit);
    return {
      events: selected.map((event) => ({ ...event })),
      next_after_sequence: selected.at(-1)?.sequence ?? after,
      retained_events: this.#events.length,
      capacity: this.capacity,
    };
  }

  usage(): {
    total: number;
    successes: number;
    failures: number;
    recovered: number;
    target_changes: number;
    retained_events: number;
    capacity: number;
  } {
    return {
      total: this.#events.length,
      successes: this.#events.filter((event) => event.success).length,
      failures: this.#events.filter((event) => !event.success).length,
      recovered: this.#events.filter((event) => event.recovered).length,
      target_changes: this.#events.filter((event) => event.target_changed).length,
      retained_events: this.#events.length,
      capacity: this.capacity,
    };
  }

  #load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as unknown;
      if (!isPersisted(parsed)) return;
      const retained = parsed.events.slice(-this.capacity);
      this.#events.push(...retained.map((event) => ({ ...event })));
      const maxSequence = retained.reduce((max, event) => Math.max(max, event.sequence), 0);
      this.#nextSequence = Math.max(parsed.next_sequence, maxSequence + 1, 1);
    } catch {
      // Diagnostics are support data only; malformed state must never block Browser v2 startup.
    }
  }

  #persist(): void {
    if (!this.statePath) return;
    const temp = this.statePath + '.tmp';
    const payload: PersistedBrowserRuntimeDiagnostics = {
      version: 1,
      next_sequence: this.#nextSequence,
      events: this.#events,
    };
    writeFileSync(temp, JSON.stringify(payload, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temp, this.statePath);
  }
}

function sanitizeStart(input: BrowserRuntimeDiagnosticStart): BrowserRuntimeDiagnosticStart {
  if (!ACTIONS.has(input.actionType)) throw new Error('Browser diagnostics action type is invalid');
  return {
    actionType: input.actionType,
    ...(validBrowserSessionId(input.browserSessionId) ? { browserSessionId: input.browserSessionId } : {}),
    ...(validTargetId(input.targetId) ? { targetId: input.targetId } : {}),
    ...(validOwnershipMode(input.ownershipMode) ? { ownershipMode: input.ownershipMode } : {}),
    recovered: input.recovered === true,
  };
}

function sanitizeCompletion(
  input: BrowserRuntimeDiagnosticCompletion,
): BrowserRuntimeDiagnosticCompletion {
  return {
    ...(validTargetId(input.targetId) ? { targetId: input.targetId } : {}),
    ...(validOwnershipMode(input.ownershipMode) ? { ownershipMode: input.ownershipMode } : {}),
    targetChanged: input.targetChanged === true,
    ...(input.recovered === undefined ? {} : { recovered: input.recovered === true }),
  };
}

function validBrowserSessionId(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_SESSION_ID.test(value);
}

function validTargetId(value: unknown): value is string {
  return typeof value === 'string' && TARGET_ID.test(value);
}

function validOwnershipMode(value: unknown): value is string {
  return typeof value === 'string' && OWNERSHIP_MODES.has(value);
}

function boundedErrorClass(error: unknown): string {
  const value = error instanceof Error ? error.constructor.name : typeof error;
  return value.slice(0, 128);
}

function isPersisted(value: unknown): value is PersistedBrowserRuntimeDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Partial<PersistedBrowserRuntimeDiagnostics>;
  const rootKeys = Object.keys(value);
  if (rootKeys.length !== 3
      || !rootKeys.includes('version')
      || !rootKeys.includes('next_sequence')
      || !rootKeys.includes('events')) return false;
  if (row.version !== 1 || !Number.isInteger(row.next_sequence)
      || (row.next_sequence ?? 0) < 1 || !Array.isArray(row.events)) return false;
  let previous = 0;
  const allowedEventKeys = new Set([
    'sequence',
    'started_at_utc',
    'duration_ms',
    'action_type',
    'success',
    'browser_session_id',
    'target_id',
    'ownership_mode',
    'error_class',
    'target_changed',
    'recovered',
  ]);
  for (const event of row.events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (Object.keys(event).some((key) => !allowedEventKeys.has(key))) return false;
    const candidate = event as Partial<BrowserRuntimeDiagnosticEvent>;
    if (!Number.isInteger(candidate.sequence) || (candidate.sequence ?? 0) <= previous
        || typeof candidate.started_at_utc !== 'string'
        || !Number.isFinite(candidate.duration_ms) || (candidate.duration_ms ?? -1) < 0
        || typeof candidate.action_type !== 'string'
        || !ACTIONS.has(candidate.action_type as BrowserDiagnosticAction)
        || typeof candidate.success !== 'boolean'
        || (candidate.browser_session_id !== undefined
          && !validBrowserSessionId(candidate.browser_session_id))
        || (candidate.target_id !== undefined && !validTargetId(candidate.target_id))
        || (candidate.ownership_mode !== undefined && !validOwnershipMode(candidate.ownership_mode))
        || (candidate.error_class !== undefined
          && (typeof candidate.error_class !== 'string' || candidate.error_class.length > 128))
        || typeof candidate.target_changed !== 'boolean'
        || typeof candidate.recovered !== 'boolean') {
      return false;
    }
    previous = candidate.sequence!;
  }
  return true;
}

function roundMillis(value: number): number {
  return Math.round(value * 1000) / 1000;
}
