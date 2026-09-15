import { randomUUID } from 'node:crypto';
import type { GatewayCallerContext } from './caller-context.js';
import type {
  SqliteDurableStore, VerifyJobErrorClass, VerifyJobRecord, VerifyJobState, WorkspaceRecord,
} from './durable-store.js';
import type { VerifyExecutionPort } from './verify-execution-port.js';
import { resolveVerifyProfile, type ResolvedVerifyProfile, type VerifyProfile } from './verify-profile.js';

const DISPATCH_TTL_MS = 300_000;
const MAX_PERSISTED_OUTPUT_BYTES = 64 * 1024;

export interface VerifyJobView {
  jobId: string;
  workspaceId: string;
  profileName: string;
  state: VerifyJobState;
  createdAt: number;
  dispatchDeadline: number;
  completedAt?: number;
  exitCode?: number;
  output?: string;
  outputTruncated?: boolean;
  errorClass?: VerifyJobErrorClass;
}

interface DispatchReady {
  record: VerifyJobRecord;
  workspace: WorkspaceRecord;
  profile: ResolvedVerifyProfile;
  port: VerifyExecutionPort;
}
export class DurableVerifyJobCoordinator {
  private readonly now: () => number;
  private readonly ports: Map<string, VerifyExecutionPort>;

  constructor(private readonly options: {
    store: SqliteDurableStore;
    profiles: () => Readonly<Record<string, VerifyProfile>>;
    ports: readonly VerifyExecutionPort[];
    now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
    this.ports = new Map(options.ports.map((port) => [port.kind, port]));
    if (this.ports.size !== options.ports.length) throw new Error('Duplicate verify execution port kind');
  }

  enqueue(caller: GatewayCallerContext, workspaceId: string, profileName: string): VerifyJobView {
    const workspace = this.options.store.getWorkspace(workspaceId);
    if (!workspace || !sameAuthority(caller, workspace)) throw new Error('Gateway denied verify workspace');
    const profile = this.options.profiles()[profileName];
    if (!profile) throw new Error('Gateway denied verify profile');
    const resolved = resolveVerifyProfile(profile);
    const createdAt = this.now();
    const record = this.options.store.createVerifyJob({
      ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
      workspaceId, backendKind: workspace.backendKind, profileName,
      planSha256: resolved.planSha256,
      createdAt, dispatchDeadline: createdAt + DISPATCH_TTL_MS,
    });
    return toView(record);
  }

  result(caller: GatewayCallerContext, jobId: string): VerifyJobView {
    const record = this.options.store.getVerifyJob(jobId);
    if (!record || !sameAuthority(caller, record)) throw new Error('Gateway denied verify job');
    return toView(record);
  }

  async dispatch(jobId: string): Promise<void> {
    await this.executeQueued(jobId, false);
  }

  async reconcile(): Promise<void> {
    for (const record of this.options.store.listRecoverableVerifyJobs()) {
      if (record.state === 'EXECUTING') {
        this.options.store.finishVerifyJob(
          record.jobId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'RESTART_EXECUTION_UNVERIFIABLE',
        );
        continue;
      }
      await this.executeQueued(record.jobId, true);
    }
  }

  private async executeQueued(jobId: string, recovered: boolean): Promise<void> {
    const ready = this.prepareDispatch(jobId, recovered);
    if (!ready) return;
    const attemptId = `attempt_${randomUUID()}`;
    const claimed = this.options.store.claimVerifyJob(jobId, this.now(), attemptId);
    if (!claimed) return;

    try {
      const evidence = await ready.port.execute(ready.workspace.canonicalRoot, ready.profile);
      if (evidence.status === 'completed') {
        const bounded = boundUtf8Output(evidence.output, MAX_PERSISTED_OUTPUT_BYTES);
        this.options.store.finishVerifyJob(jobId, 'SUCCEEDED', this.now(), {
          exitCode: evidence.exitCode,
          output: bounded.output,
          outputTruncated: bounded.truncated,
        });
        return;
      }
      this.options.store.finishVerifyJob(
        jobId, 'OUTCOME_UNKNOWN', this.now(), undefined, evidence.errorClass,
      );
    } catch {
      this.options.store.finishVerifyJob(
        jobId, 'OUTCOME_UNKNOWN', this.now(), undefined, 'EXECUTION_PORT_ERROR_UNCONFIRMED',
      );
    }
  }

  private prepareDispatch(jobId: string, recovered: boolean): DispatchReady | undefined {
    const record = this.options.store.getVerifyJob(jobId);
    if (!record || record.state !== 'QUEUED') return undefined;
    const now = this.now();
    if (record.dispatchDeadline <= now) return this.fail(record, 'DISPATCH_DEADLINE_EXPIRED');
    const workspace = this.options.store.getWorkspace(record.workspaceId);
    if (!workspace) return this.fail(record, 'WORKSPACE_MISSING');
    if (!sameAuthority(record, workspace)) return this.fail(record, 'WORKSPACE_OWNERSHIP_MISMATCH');
    const port = this.ports.get(record.backendKind);
    if (workspace.backendKind !== record.backendKind || !port) return this.fail(record, 'UNSUPPORTED_BACKEND');
    const sourceProfile = this.options.profiles()[record.profileName];
    if (!sourceProfile) return this.fail(record, 'PROFILE_MISSING');
    let profile: ResolvedVerifyProfile;
    try {
      profile = resolveVerifyProfile(sourceProfile);
    } catch {
      return this.fail(record, 'PROFILE_PLAN_DRIFT');
    }
    if (profile.planSha256 !== record.planSha256) return this.fail(record, 'PROFILE_PLAN_DRIFT');
    if (recovered && !profile.resumeQueuedAfterRestart) return this.fail(record, 'RESTART_RESUME_DISABLED');
    return { record, workspace, profile, port };
  }

  private fail(record: VerifyJobRecord, errorClass: VerifyJobErrorClass): undefined {
    this.options.store.failQueuedVerifyJob(record.jobId, this.now(), errorClass);
    return undefined;
  }
}
function sameAuthority(
  expected: Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>,
  actual: Pick<GatewayCallerContext, 'ownerId' | 'sessionId' | 'adapterId'>,
): boolean {
  return expected.ownerId === actual.ownerId
    && expected.sessionId === actual.sessionId
    && expected.adapterId === actual.adapterId;
}

function boundUtf8Output(value: string, maxBytes: number): { output: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { output: value, truncated: false };
  let bytes = 0;
  let output = '';
  for (const codePoint of value) {
    const size = Buffer.byteLength(codePoint, 'utf8');
    if (bytes + size > maxBytes) break;
    output += codePoint;
    bytes += size;
  }
  return { output, truncated: true };
}
function toView(record: VerifyJobRecord): VerifyJobView {
  return {
    jobId: record.jobId,
    workspaceId: record.workspaceId,
    profileName: record.profileName,
    state: record.state,
    createdAt: record.createdAt,
    dispatchDeadline: record.dispatchDeadline,
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.outputTruncated === undefined ? {} : { outputTruncated: record.outputTruncated }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
  };
}
