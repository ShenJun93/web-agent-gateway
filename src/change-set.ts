import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { GatewayCallerContext } from './caller-context.js';
import { sameAuthorityTuple } from './authority-tuple.js';
import type { FileMutationBackend } from './file-mutation-backend.js';
import type { SqliteDurableStore, WorkspaceRecord } from './durable-store.js';
import { assertCreateTarget, assertReadTarget, validateReadPath } from './path-policy.js';
import { buildSafeGitEnv, SAFE_GIT_BASE_ARGS } from './safe-git.js';
import {
  ChangeSetStore,
  type ChangeSetRecord,
  type ChangeSetState,
} from './change-set-store.js';

const execFileAsync = promisify(execFile);
const SHA256_RE = /^[a-f0-9]{64}$/;
const GIT_OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_OPERATIONS = 32;
const MAX_CONTENT_BYTES = 32 * 1024;
const MAX_TOTAL_CONTENT_BYTES = 256 * 1024;

export type ChangeSetOperationInput =
  | { type: 'replace'; path: string; baseSha256: string; content: string }
  | { type: 'create'; path: string; content: string }
  | { type: 'delete'; path: string; baseSha256: string }
  | { type: 'move'; from: string; to: string; baseSha256: string };

type PreparedOperation =
  | {
      type: 'replace';
      path: string;
      baseSha256: string;
      resultSha256: string;
      before: string;
      content: string;
    }
  | {
      type: 'create';
      path: string;
      resultSha256: string;
      content: string;
    }
  | {
      type: 'delete';
      path: string;
      baseSha256: string;
      before: string;
    }
  | {
      type: 'move';
      from: string;
      to: string;
      baseSha256: string;
      resultSha256: string;
      before: string;
    };

export interface ChangeSetPreviewView {
  changeId: string;
  state: 'PREPARED';
  workspaceId: string;
  baseHead: string;
  planSha256: string;
  operations: ChangeSetOperationView[];
  createdAt: number;
}

export interface ChangeSetResultView {
  changeId: string;
  state: ChangeSetState;
  workspaceId: string;
  baseHead: string;
  planSha256: string;
  operations: ChangeSetOperationView[];
  createdAt: number;
  applyStartedAt?: number;
  completedAt?: number;
  errorClass?: string;
}

export type ChangeSetOperationView =
  | { type: 'replace'; path: string; baseSha256: string; resultSha256: string }
  | { type: 'create'; path: string; resultSha256: string }
  | { type: 'delete'; path: string; baseSha256: string }
  | { type: 'move'; from: string; to: string; baseSha256: string; resultSha256: string };

type PlanClassification = 'BEFORE' | 'AFTER' | 'MIXED';

export class DurableChangeSetCoordinator {
  private readonly backends: Map<string, FileMutationBackend>;
  private readonly now: () => number;

  constructor(private readonly options: {
    store: ChangeSetStore;
    workspaceStore: SqliteDurableStore;
    backends: readonly FileMutationBackend[];
    now?: () => number;
    killSwitch?: () => boolean;
    effectBoundary?: {
      revalidateWorkspace(workspaceId: string, canonicalRoot: string): Promise<void>;
    };
  }) {
    this.backends = new Map(options.backends.map((backend) => [backend.kind, backend]));
    if (this.backends.size !== options.backends.length) {
      throw new Error('Duplicate change-set backend kind');
    }
    this.now = options.now ?? Date.now;
  }

  async preview(
    caller: GatewayCallerContext,
    workspaceId: string,
    operations: readonly ChangeSetOperationInput[],
  ): Promise<ChangeSetPreviewView> {
    this.assertExecutionAllowed();
    const workspace = this.ownedWorkspace(caller, workspaceId);
    await this.options.effectBoundary?.revalidateWorkspace(workspaceId, workspace.canonicalRoot);
    const backend = this.backend(workspace.backendKind);
    const baseHead = await readExactHead(workspace.canonicalRoot);
    const prepared = await this.prepareOperations(workspace, backend, operations);
    const operationsJson = JSON.stringify(prepared);
    const planSha256 = planDigest(workspaceId, baseHead, prepared);
    const record = this.options.store.create({
      ...caller,
      workspaceId,
      canonicalRoot: workspace.canonicalRoot,
      backendKind: workspace.backendKind,
      baseHead,
      planSha256,
      operationsJson,
      createdAt: this.now(),
    });
    return {
      changeId: record.changeId,
      state: 'PREPARED',
      workspaceId,
      baseHead,
      planSha256,
      operations: prepared.map(operationView),
      createdAt: record.createdAt,
    };
  }

  async apply(
    caller: GatewayCallerContext,
    changeId: string,
    planSha256: string,
  ): Promise<ChangeSetResultView> {
    if (!/^change_[0-9a-f-]{36}$/.test(changeId)) {
      throw new Error('Gateway rejected invalid change_id');
    }
    if (!SHA256_RE.test(planSha256)) {
      throw new Error('Gateway rejected invalid change plan SHA-256');
    }
    this.assertExecutionAllowed();

    let record = this.ownedRecord(caller, changeId);
    if (record.planSha256 !== planSha256) {
      throw new Error('Gateway denied change apply: plan digest mismatch');
    }
    this.assertRecordIntegrity(record);

    if (record.state === 'VERIFIED') return this.toResult(record);
    if (record.state === 'PARTIAL_EFFECT_DETECTED') {
      throw new Error('Gateway denied change apply: partial effect detected');
    }
    if (record.state === 'APPLYING' || record.state === 'APPLIED') {
      await this.reconcileRecord(record);
      record = this.ownedRecord(caller, changeId);
      if (record.state === 'VERIFIED') return this.toResult(record);
      if (record.state === 'PARTIAL_EFFECT_DETECTED') {
        throw new Error('Gateway denied change apply: partial effect detected');
      }
    }
    if (record.state !== 'PREPARED') {
      throw new Error('Gateway denied change apply: record is not prepared');
    }

    try {
      await this.assertBeforeState(record);
    } catch (error) {
      this.options.store.setPreparedError(changeId, classifyPreconditionError(error));
      throw error;
    }

    if (!this.options.store.claimPrepared(changeId, this.now())) {
      const current = this.ownedRecord(caller, changeId);
      if (current.state === 'VERIFIED') return this.toResult(current);
      throw new Error('Gateway denied change apply: concurrent execution');
    }

    record = this.ownedRecord(caller, changeId);
    try {
      this.assertExecutionAllowed();
      await this.options.effectBoundary?.revalidateWorkspace(record.workspaceId, record.canonicalRoot);
      await this.assertBeforeState(record);
      const backend = this.backend(record.backendKind);
      const operations = this.operations(record);
      for (const operation of operations) {
        this.assertExecutionAllowed();
        await this.applyOperation(record.canonicalRoot, backend, operation);
      }
      if (!this.options.store.markApplied(changeId)) {
        throw new Error('Gateway change-set state transition failed');
      }
      record = this.ownedRecord(caller, changeId);
      const classification = await this.classify(record);
      if (classification !== 'AFTER') {
        this.options.store.markPartial(changeId, this.now(), 'POST_APPLY_VERIFY_MISMATCH');
        throw new Error('Gateway detected partial change-set effect');
      }
      if (!this.options.store.markVerified(changeId, this.now())) {
        throw new Error('Gateway change-set verification transition failed');
      }
      return this.toResult(this.ownedRecord(caller, changeId));
    } catch (error) {
      await this.reconcileAfterEffectError(changeId, error);
      const current = this.ownedRecord(caller, changeId);
      if (current.state === 'VERIFIED') return this.toResult(current);
      throw error;
    }
  }

  result(caller: GatewayCallerContext, changeId: string): ChangeSetResultView {
    if (!/^change_[0-9a-f-]{36}$/.test(changeId)) {
      throw new Error('Gateway rejected invalid change_id');
    }
    return this.toResult(this.ownedRecord(caller, changeId));
  }

  async reconcile(): Promise<void> {
    for (const record of this.options.store.listRecoverable()) {
      await this.reconcileRecord(record);
    }
  }

  private async reconcileAfterEffectError(changeId: string, error: unknown): Promise<void> {
    const record = this.options.store.get(changeId);
    if (!record || (record.state !== 'APPLYING' && record.state !== 'APPLIED')) return;
    try {
      const classification = await this.classify(record);
      if (classification === 'AFTER') {
        this.options.store.markVerified(changeId, this.now());
        return;
      }
      if (classification === 'BEFORE' && record.state === 'APPLYING') {
        this.options.store.resetPrepared(changeId, effectErrorClass(error));
        return;
      }
      this.options.store.markPartial(changeId, this.now(), effectErrorClass(error));
    } catch {
      this.options.store.markPartial(changeId, this.now(), 'RECOVERY_OBSERVATION_FAILED');
    }
  }

  private async reconcileRecord(record: ChangeSetRecord): Promise<void> {
    this.assertRecordIntegrity(record);
    let classification: PlanClassification;
    try {
      classification = await this.classify(record);
    } catch {
      this.options.store.markPartial(record.changeId, this.now(), 'RECOVERY_OBSERVATION_FAILED');
      return;
    }
    if (classification === 'AFTER') {
      this.options.store.markVerified(record.changeId, this.now());
      return;
    }
    if (classification === 'BEFORE' && record.state === 'APPLYING') {
      this.options.store.resetPrepared(record.changeId, 'RECOVERED_BEFORE_EFFECT');
      return;
    }
    this.options.store.markPartial(record.changeId, this.now(), 'RECOVERY_MIXED_STATE');
  }

  private async assertBeforeState(record: ChangeSetRecord): Promise<void> {
    this.assertExecutionAllowed();
    await this.options.effectBoundary?.revalidateWorkspace(record.workspaceId, record.canonicalRoot);
    const head = await readExactHead(record.canonicalRoot);
    if (head !== record.baseHead) {
      throw new Error('Gateway denied change apply: HEAD drift');
    }
    const backend = this.backend(record.backendKind);
    for (const operation of this.operations(record)) {
      if (!(await matchesBefore(record.canonicalRoot, backend, operation))) {
        throw new Error('Gateway denied change apply: path precondition drift');
      }
    }
  }

  private async classify(record: ChangeSetRecord): Promise<PlanClassification> {
    await this.options.effectBoundary?.revalidateWorkspace(record.workspaceId, record.canonicalRoot);
    const backend = this.backend(record.backendKind);
    const operations = this.operations(record);
    let before = true;
    let after = true;
    for (const operation of operations) {
      before = before && await matchesBefore(record.canonicalRoot, backend, operation);
      after = after && await matchesAfter(record.canonicalRoot, backend, operation);
    }
    if (before && !after) return 'BEFORE';
    if (after && !before) return 'AFTER';
    if (before && after) {
      // Empty plans are forbidden, so an operation set cannot be meaningfully both states.
      return 'MIXED';
    }
    return 'MIXED';
  }

  private async applyOperation(
    root: string,
    backend: FileMutationBackend,
    operation: PreparedOperation,
  ): Promise<void> {
    if (operation.type === 'replace') {
      await backend.updateExisting(root, operation.path, operation.before, operation.content);
      return;
    }
    if (operation.type === 'create') {
      await backend.createNew(root, operation.path, operation.content);
      return;
    }
    if (operation.type === 'delete') {
      await deleteExact(backend, root, operation.path, operation.before);
      return;
    }
    // Move is intentionally decomposed into two exact effects. Perfect filesystem transactions are
    // not claimed; if the process fails between them, durable reconciliation reports PARTIAL.
    await backend.createNew(root, operation.to, operation.before);
    await deleteExact(backend, root, operation.from, operation.before);
  }

  private async prepareOperations(
    workspace: WorkspaceRecord,
    backend: FileMutationBackend,
    operations: readonly ChangeSetOperationInput[],
  ): Promise<PreparedOperation[]> {
    if (operations.length < 1 || operations.length > MAX_OPERATIONS) {
      throw new Error('Gateway rejected change operation count');
    }
    const touched = new Set<string>();
    let totalContentBytes = 0;
    const prepared: PreparedOperation[] = [];

    for (const operation of operations) {
      if (operation.type === 'replace') {
        const path = checkedUniquePath(touched, operation.path);
        validateSha(operation.baseSha256);
        validateContent(operation.content, true);
        totalContentBytes += Buffer.byteLength(operation.content, 'utf8');
        await assertReadTarget(workspace.canonicalRoot, path);
        const before = await backend.readExact(workspace.canonicalRoot, path);
        if (sha256(before) !== operation.baseSha256) {
          throw new Error('Gateway rejected change replace base SHA-256 mismatch');
        }
        if (before === operation.content) {
          throw new Error('Gateway rejected no-op change replace');
        }
        prepared.push({
          type: 'replace',
          path,
          baseSha256: operation.baseSha256,
          resultSha256: sha256(operation.content),
          before,
          content: operation.content,
        });
        continue;
      }

      if (operation.type === 'create') {
        const path = checkedUniquePath(touched, operation.path);
        validateContent(operation.content);
        totalContentBytes += Buffer.byteLength(operation.content, 'utf8');
        await assertCreateTarget(workspace.canonicalRoot, path);
        if (await backend.readExactIfPresent(workspace.canonicalRoot, path) !== undefined) {
          throw new Error('Gateway rejected occupied change create target');
        }
        prepared.push({
          type: 'create',
          path,
          resultSha256: sha256(operation.content),
          content: operation.content,
        });
        continue;
      }

      if (operation.type === 'delete') {
        const path = checkedUniquePath(touched, operation.path);
        validateSha(operation.baseSha256);
        await assertReadTarget(workspace.canonicalRoot, path);
        const before = await backend.readExact(workspace.canonicalRoot, path);
        if (sha256(before) !== operation.baseSha256) {
          throw new Error('Gateway rejected change delete base SHA-256 mismatch');
        }
        prepared.push({ type: 'delete', path, baseSha256: operation.baseSha256, before });
        continue;
      }

      const from = checkedUniquePath(touched, operation.from);
      const to = checkedUniquePath(touched, operation.to);
      validateSha(operation.baseSha256);
      await assertReadTarget(workspace.canonicalRoot, from);
      await assertCreateTarget(workspace.canonicalRoot, to);
      const before = await backend.readExact(workspace.canonicalRoot, from);
      if (sha256(before) !== operation.baseSha256) {
        throw new Error('Gateway rejected change move base SHA-256 mismatch');
      }
      if (await backend.readExactIfPresent(workspace.canonicalRoot, to) !== undefined) {
        throw new Error('Gateway rejected occupied change move destination');
      }
      prepared.push({
        type: 'move',
        from,
        to,
        baseSha256: operation.baseSha256,
        resultSha256: operation.baseSha256,
        before,
      });
    }

    if (totalContentBytes > MAX_TOTAL_CONTENT_BYTES) {
      throw new Error('Gateway rejected change-set content exceeds 256 KiB');
    }
    return prepared;
  }

  private ownedWorkspace(caller: GatewayCallerContext, workspaceId: string): WorkspaceRecord {
    const workspace = this.options.workspaceStore.getWorkspace(workspaceId);
    if (!workspace || !sameAuthorityTuple(workspace, caller)) {
      throw new Error('Gateway denied change-set workspace');
    }
    return workspace;
  }

  private ownedRecord(caller: GatewayCallerContext, changeId: string): ChangeSetRecord {
    const record = this.options.store.get(changeId);
    if (!record || !sameAuthorityTuple(record, caller)) {
      throw new Error('Gateway denied change-set record');
    }
    const workspace = this.ownedWorkspace(caller, record.workspaceId);
    if (
      workspace.canonicalRoot !== record.canonicalRoot
      || workspace.backendKind !== record.backendKind
    ) {
      throw new Error('Gateway denied change-set workspace drift');
    }
    this.assertRecordIntegrity(record);
    return record;
  }

  private assertRecordIntegrity(record: ChangeSetRecord): void {
    const operations = this.operations(record);
    if (planDigest(record.workspaceId, record.baseHead, operations) !== record.planSha256) {
      throw new Error('Gateway denied corrupt change-set plan');
    }
  }

  private operations(record: ChangeSetRecord): PreparedOperation[] {
    let parsed: unknown;
    try { parsed = JSON.parse(record.operationsJson); }
    catch { throw new Error('Gateway denied corrupt change-set operations'); }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_OPERATIONS) {
      throw new Error('Gateway denied corrupt change-set operations');
    }
    return parsed as PreparedOperation[];
  }

  private toResult(record: ChangeSetRecord): ChangeSetResultView {
    return {
      changeId: record.changeId,
      state: record.state,
      workspaceId: record.workspaceId,
      baseHead: record.baseHead,
      planSha256: record.planSha256,
      operations: this.operations(record).map(operationView),
      createdAt: record.createdAt,
      ...(record.applyStartedAt === undefined ? {} : { applyStartedAt: record.applyStartedAt }),
      ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
      ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
    };
  }

  private backend(kind: string): FileMutationBackend {
    const backend = this.backends.get(kind);
    if (!backend) throw new Error('Gateway denied unsupported change-set backend');
    return backend;
  }

  private assertExecutionAllowed(): void {
    if (this.options.killSwitch?.()) {
      throw new Error('Gateway denied change-set effect: kill switch engaged');
    }
  }
}

async function matchesBefore(
  root: string,
  backend: FileMutationBackend,
  operation: PreparedOperation,
): Promise<boolean> {
  if (operation.type === 'create') {
    try { await assertCreateTarget(root, operation.path); }
    catch { return false; }
    return await backend.readExactIfPresent(root, operation.path) === undefined;
  }
  if (operation.type === 'move') {
    const source = await readPresentHash(backend, root, operation.from);
    if (source !== operation.baseSha256) return false;
    try { await assertCreateTarget(root, operation.to); }
    catch { return false; }
    return await backend.readExactIfPresent(root, operation.to) === undefined;
  }
  const current = await readPresentHash(backend, root, operation.path);
  return current === operation.baseSha256;
}

async function matchesAfter(
  root: string,
  backend: FileMutationBackend,
  operation: PreparedOperation,
): Promise<boolean> {
  if (operation.type === 'delete') {
    return await backend.readExactIfPresent(root, operation.path) === undefined;
  }
  if (operation.type === 'move') {
    const source = await backend.readExactIfPresent(root, operation.from);
    if (source !== undefined) return false;
    return await readPresentHash(backend, root, operation.to) === operation.resultSha256;
  }
  return await readPresentHash(backend, root, operation.path) === operation.resultSha256;
}

async function deleteExact(
  backend: FileMutationBackend,
  root: string,
  path: string,
  original: string,
): Promise<void> {
  if (!backend.deleteExisting) {
    throw new Error('Gateway denied change-set backend delete capability');
  }
  await backend.deleteExisting(root, path, original);
}

async function readPresentHash(
  backend: FileMutationBackend,
  root: string,
  path: string,
): Promise<string | undefined> {
  const content = await backend.readExactIfPresent(root, path);
  return content === undefined ? undefined : sha256(content);
}

function checkedUniquePath(touched: Set<string>, input: string): string {
  const path = validateReadPath(input);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  if (touched.has(key)) throw new Error('Gateway rejected duplicate change-set path');
  touched.add(key);
  return path;
}

function validateContent(content: string, allowEmpty = false): void {
  if (!allowEmpty && content.length === 0) throw new Error('Gateway rejected empty change-set content');
  if (content.includes('\0')) throw new Error('Gateway rejected NUL in change-set content');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    throw new Error('Gateway rejected change-set content exceeds 32 KiB');
  }
}

function validateSha(value: string): void {
  if (!SHA256_RE.test(value)) throw new Error('Gateway rejected invalid change-set SHA-256');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function planDigest(
  workspaceId: string,
  baseHead: string,
  operations: readonly PreparedOperation[],
): string {
  return sha256(JSON.stringify({
    version: 'wag.change-set.v1',
    workspaceId,
    baseHead,
    operations,
  }));
}

function operationView(operation: PreparedOperation): ChangeSetOperationView {
  if (operation.type === 'replace') {
    return {
      type: 'replace',
      path: operation.path,
      baseSha256: operation.baseSha256,
      resultSha256: operation.resultSha256,
    };
  }
  if (operation.type === 'create') {
    return { type: 'create', path: operation.path, resultSha256: operation.resultSha256 };
  }
  if (operation.type === 'delete') {
    return { type: 'delete', path: operation.path, baseSha256: operation.baseSha256 };
  }
  return {
    type: 'move',
    from: operation.from,
    to: operation.to,
    baseSha256: operation.baseSha256,
    resultSha256: operation.resultSha256,
  };
}

async function readExactHead(root: string): Promise<string> {
  const env = buildSafeGitEnv(process.env);
  const run = async (args: readonly string[]) => {
    const { stdout } = await execFileAsync('git', [...SAFE_GIT_BASE_ARGS, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim();
  };
  const [top, head] = await Promise.all([
    run(['rev-parse', '--show-toplevel']),
    run(['rev-parse', '--verify', 'HEAD']),
  ]);
  const [realRoot, realTop] = await Promise.all([realpath(root), realpath(top)]);
  const sameRoot = process.platform === 'win32'
    ? realRoot.toLowerCase() === realTop.toLowerCase()
    : realRoot === realTop;
  if (!sameRoot) throw new Error('Gateway denied change-set repository root mismatch');
  if (!GIT_OID_RE.test(head)) throw new Error('Gateway denied invalid repository HEAD');
  return head;
}

function classifyPreconditionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HEAD drift/.test(message)) return 'HEAD_DRIFT';
  if (/path precondition drift/.test(message)) return 'PATH_PRECONDITION_DRIFT';
  if (/workspace/.test(message)) return 'WORKSPACE_DRIFT';
  return 'PRECONDITION_FAILED';
}

function effectErrorClass(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/kill switch/i.test(message)) return 'KILL_SWITCH_ENGAGED';
  if (/HEAD drift/.test(message)) return 'HEAD_DRIFT';
  if (/precondition drift/.test(message)) return 'PATH_PRECONDITION_DRIFT';
  return 'EFFECT_ERROR';
}
