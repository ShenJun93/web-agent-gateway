/**
 * P1A evidence recorder.
 *
 * P1A is a *measurement*, so the thing that matters most about this file is that it records what
 * happened rather than what was hoped. Two consequences shape it:
 *
 *   - **gestures are counted, never hidden.** `humanRun` and `humanApprove` are required fields
 *     with no default. The spec says P1A must measure these rather than hide them, and a field
 *     that defaults to zero is a field that quietly reports success;
 *   - **and since ADR-0028/0029, a zero is ambiguous unless the other authority is recorded too.**
 *     `humanRun: 0` used to mean only one thing. It can now mean a Goal UI Delegation authorised
 *     the Run, and `humanApprove: 0` can mean a Goal Lease admitted the effect — both legitimate,
 *     both deliberately granted by a person out of band, and neither the same measurement as "no
 *     gesture was needed". `delegatedRun` and `policyApproved` record which, so a reader who was
 *     not present can tell a task that needed no help from one that was helped by a grant;
 *   - **a record is append-only.** Evidence is JSONL; nothing here rewrites a prior line. A
 *     measurement you can edit after seeing the total is not a measurement.
 *
 * It also refuses to write anything that looks like a credential. The receipts are meant to be
 * readable by someone who was not present, which is exactly when a pasted operator URL or a
 * bootstrap token does damage.
 *
 *   npm run p1a:record -- --task t01 --goal "..." --tools repo.search --ok --run 1 --approve 0 --ms 4210
 *   npm run p1a:summary
 */
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface P1ATaskRecord {
  /** Stable id, so a re-run of the same task is comparable rather than additive. */
  taskId: string;
  /** What a human was trying to accomplish, in their words, not the tool's. */
  goal: string;
  /** The WAG surface and the tools actually invoked. */
  surface: string;
  tools: string[];
  success: boolean;
  /** Desktop Commander is permitted only as an explicitly recorded fallback. */
  dcFallback: boolean;
  dcReason?: string;
  /** The two gestures, counted. Required — see the module header. */
  humanRun: number;
  humanApprove: number;
  /**
   * The two *other* authorities, counted: `DELEGATED_RUN` rows and `POLICY_APPROVED` admissions.
   *
   * Optional where the gestures are required, and the asymmetry is the point. A gesture count that
   * defaulted to zero would hide a gesture that happened; a grant count that defaults to zero says
   * "no grant was in play", which is the truth for every record written before these authorities
   * existed and for every task run without one. Defaulting here is therefore accurate rather than
   * flattering, which is the only reason it is allowed.
   */
  delegatedRun?: number;
  policyApproved?: number;
  reconnectNeeded: boolean;
  /** Transport/tool time, not wall-clock including human thinking. */
  elapsedMs: number;
  unexpectedRepair: boolean;
  repairNote?: string;
  /** Workspace ids, request ids, result hashes — identifiers, never content. */
  identifiers?: Record<string, string>;
  securityAnomaly?: string;
  recordedAt: string;
}

/**
 * Shapes that must never reach a receipt.
 *
 * Deliberately shape-based rather than an exact-value list: the recorder does not know the
 * session's tokens, and should refuse a credential it has never seen.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\.operator-url/i, 'the operator credential file path'],
  [/[?&]token=/i, 'a token query parameter'],
  [/bootstrap[=/][A-Za-z0-9._-]{16,}/i, 'a bootstrap credential'],
  [/wag_operator_session=/i, 'an operator session cookie'],
  [/\bcsrf\b\s*[=:]\s*\S{8,}/i, 'a CSRF token'],
  [/DEVSPACE_OAUTH_OWNER_TOKEN\s*[=:]\s*\S+/i, 'the DevSpace owner token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
];

export function assertNoSecrets(record: P1ATaskRecord): void {
  const serialized = JSON.stringify(record);
  for (const [pattern, what] of FORBIDDEN) {
    if (pattern.test(serialized)) {
      throw new Error(`P1A evidence refused: the record appears to contain ${what}`);
    }
  }
}

/** Required fields that must be stated rather than defaulted. */
export function assertComplete(record: Partial<P1ATaskRecord>): asserts record is P1ATaskRecord {
  for (const field of ['taskId', 'goal', 'surface'] as const) {
    if (!record[field]) throw new Error(`P1A evidence requires ${field}`);
  }
  if (!Array.isArray(record.tools) || record.tools.length === 0) {
    throw new Error('P1A evidence requires at least one tool');
  }
  for (const field of ['delegatedRun', 'policyApproved'] as const) {
    const value = record[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} must be a non-negative integer when present`);
    }
  }
  for (const field of ['humanRun', 'humanApprove', 'elapsedMs'] as const) {
    if (!Number.isInteger(record[field]) || (record[field] as number) < 0) {
      // No defaults: a gesture count that defaults to zero reports success by omission.
      throw new Error(`P1A evidence requires ${field} as a non-negative integer, stated explicitly`);
    }
  }
  for (const field of ['success', 'dcFallback', 'reconnectNeeded', 'unexpectedRepair'] as const) {
    if (typeof record[field] !== 'boolean') throw new Error(`P1A evidence requires ${field} as a boolean`);
  }
  if (record.dcFallback && !record.dcReason) {
    throw new Error('a Desktop Commander fallback must record why WAG could not complete the task');
  }
}

export function appendRecord(logPath: string, record: P1ATaskRecord): void {
  assertComplete(record);
  assertNoSecrets(record);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');
}

export function readRecords(logPath: string): P1ATaskRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as P1ATaskRecord);
}

export interface P1ASummary {
  tasks: number;
  distinctTasks: number;
  succeeded: number;
  withoutDcFallback: number;
  totalHumanRun: number;
  totalHumanApprove: number;
  reconnects: number;
  unexpectedRepairs: number;
  securityAnomalies: number;
  medianElapsedMs: number;
  /** The six P1A criteria, each with the measurement behind it. */
  criteria: Array<{ id: number; met: boolean; statement: string; measured: string }>;
  passes: boolean;
}

/**
 * Evaluates the six P1A criteria.
 *
 * Criteria 3, 4 and 6 are judgement calls a human makes from the evidence, not arithmetic. They
 * are reported as *unmet until explicitly recorded*, because the alternative — assuming them true
 * when nothing contradicts them — is how a measurement turns into a rubber stamp.
 */
export function summarize(records: readonly P1ATaskRecord[]): P1ASummary {
  const distinct = new Set(records.map((r) => r.taskId));
  const succeeded = records.filter((r) => r.success).length;
  const withoutDc = records.filter((r) => !r.dcFallback).length;
  const elapsed = [...records.map((r) => r.elapsedMs)].sort((a, b) => a - b);
  const median = elapsed.length === 0 ? 0 : (elapsed[Math.floor(elapsed.length / 2)] ?? 0);
  const anomalies = records.filter((r) => r.securityAnomaly).length;
  const reconnects = records.filter((r) => r.reconnectNeeded).length;
  const repairs = records.filter((r) => r.unexpectedRepair).length;

  const criteria = [
    {
      id: 1,
      met: distinct.size >= 10,
      statement: 'at least 10 representative tasks measured',
      measured: `${distinct.size} distinct tasks, ${records.length} records`,
    },
    {
      id: 2,
      met: records.length > 0 && withoutDc >= Math.ceil(records.length * 0.9),
      statement: 'at least 9 of 10 complete without Desktop Commander fallback',
      measured: `${withoutDc}/${records.length} without DC fallback`,
    },
    {
      id: 3,
      met: false,
      statement: 'no task required raw shell, generic filesystem authority or authority widening',
      measured: 'a human judgement from the evidence; not asserted by this tool',
    },
    {
      id: 4,
      met: anomalies === 0 && records.length > 0,
      statement: 'no ownership failure, secret exposure, unexpected effect or fail-open behaviour',
      measured: `${anomalies} recorded security or isolation anomalies`,
    },
    {
      id: 5,
      met: records.length > 0 && reconnects <= Math.floor(records.length * 0.2),
      statement: 'reconnect/reload failures are exceptional rather than the normal workflow',
      measured: `${reconnects}/${records.length} tasks needed a reconnect, ${repairs} needed manual repair`,
    },
    {
      id: 6,
      met: false,
      statement: 'remaining friction is transport/gesture, not missing WAG semantic capability',
      measured: 'a human judgement from the evidence; not asserted by this tool',
    },
  ];

  return {
    tasks: records.length,
    distinctTasks: distinct.size,
    succeeded,
    withoutDcFallback: withoutDc,
    totalHumanRun: records.reduce((sum, r) => sum + r.humanRun, 0),
    totalHumanApprove: records.reduce((sum, r) => sum + r.humanApprove, 0),
    reconnects,
    unexpectedRepairs: repairs,
    securityAnomalies: anomalies,
    medianElapsedMs: median,
    criteria,
    passes: criteria.every((c) => c.met),
  };
}
