import type { GatewayCallerContext } from './caller-context.js';
import type { SqliteDurableStore, WorkspaceRecord } from './durable-store.js';
import { DevspaceReadLimitError, type DevspaceExecutor } from './executor/devspace.js';
import { readDevspaceText } from './executor/devspace-read.js';
import type { RepositoryInspectionBackend, RepoSearchOptions, RepoSearchResult, RepoSnapshotOptions, RepoSnapshotResult } from './repository-inspection.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';

interface RuntimeBinding {
  canonicalRoot: string;
  devspaceWorkspaceId: string;
}

export interface AdmittedWorkspaceServiceOptions {
  store: SqliteDurableStore;
  executor: Pick<DevspaceExecutor, 'openWorkspace' | 'readFile'>;
  inspection: RepositoryInspectionBackend;
  allowedRoots: readonly string[];
  now?: () => number;
}

export class AdmittedWorkspaceService {
  private readonly bindings = new Map<string, RuntimeBinding>();
  private readonly now: () => number;

  constructor(private readonly options: AdmittedWorkspaceServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  async open(caller: GatewayCallerContext, path: string): Promise<{ workspaceId: string }> {
    const canonicalRoot = await canonicalWorkspace(path, this.options.allowedRoots);
    const devspaceWorkspaceId = await this.options.executor.openWorkspace(canonicalRoot);
    const record = this.options.store.openWorkspaceRecord({
      ownerId: caller.ownerId,
      sessionId: caller.sessionId,
      adapterId: caller.adapterId,
      canonicalRoot,
      backendKind: 'devspace',
      createdAt: this.now(),
    });
    this.bindings.set(record.workspaceId, { canonicalRoot, devspaceWorkspaceId });
    return { workspaceId: record.workspaceId };
  }

  async read(caller: GatewayCallerContext, workspaceId: string, path: string): Promise<{ content: string }> {
    const { record, binding } = await this.getAuthorizedBinding(caller, workspaceId);
    const safePath = validateReadPath(path);
    await assertReadTarget(record.canonicalRoot, safePath);

    let content: string;
    try {
      content = await readDevspaceText(this.options.executor, binding.devspaceWorkspaceId, safePath, {
        maxBytes: 64 * 1024,
        oversizedMessage: 'Gateway rejected oversized content',
      });
    } catch (error) {
      if (error instanceof DevspaceReadLimitError) throw new Error('Gateway rejected oversized content');
      throw error;
    }

    const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
    if (normalized.includes('\0')) throw new Error('Gateway rejected binary content');
    if (Buffer.byteLength(normalized, 'utf8') > 64 * 1024) {
      throw new Error('Gateway rejected oversized content');
    }
    return { content: normalized };
  }

  private async getAuthorizedBinding(caller: GatewayCallerContext, workspaceId: string): Promise<{ record: WorkspaceRecord; binding: RuntimeBinding }> {
    const record = this.options.store.getWorkspace(workspaceId);
    if (!record || !sameAuthority(record, caller)) throw new Error('Gateway denied workspace');
    const binding = await this.resolveBinding(record);
    return { record, binding };
  }

  async search(
    caller: GatewayCallerContext,
    workspaceId: string,
    query: string,
    options: RepoSearchOptions = {},
  ): Promise<RepoSearchResult> {
    const { record, binding } = await this.getAuthorizedBinding(caller, workspaceId);
    return this.options.inspection.search({
      devspaceWorkspaceId: binding.devspaceWorkspaceId,
      canonicalRoot: record.canonicalRoot,
      query,
      ignoreCase: options.ignoreCase ?? false,
      maxResults: Math.min(Math.max(options.maxResults ?? 20, 1), 50),
      contextLines: Math.min(Math.max(options.contextLines ?? 1, 0), 2),
    });
  }

  async snapshot(
    caller: GatewayCallerContext,
    workspaceId: string,
    options: RepoSnapshotOptions = {},
  ): Promise<RepoSnapshotResult> {
    const { binding } = await this.getAuthorizedBinding(caller, workspaceId);
    const maxFiles = Math.min(Math.max(options.maxFiles ?? 100, 1), 200);
    return this.options.inspection.snapshot(binding.devspaceWorkspaceId, { maxFiles });
  }

  private async resolveBinding(record: WorkspaceRecord): Promise<RuntimeBinding> {
    const cached = this.bindings.get(record.workspaceId);
    if (cached) return cached;
    if (record.backendKind !== 'devspace') throw new Error('Gateway denied workspace');

    const currentCanonical = await canonicalWorkspace(record.canonicalRoot, this.options.allowedRoots);
    if (currentCanonical !== record.canonicalRoot) throw new Error('Gateway denied workspace');
    const devspaceWorkspaceId = await this.options.executor.openWorkspace(record.canonicalRoot);
    const binding = { canonicalRoot: record.canonicalRoot, devspaceWorkspaceId };
    this.bindings.set(record.workspaceId, binding);
    return binding;
  }
}

function sameAuthority(record: WorkspaceRecord, caller: GatewayCallerContext): boolean {
  return record.ownerId === caller.ownerId
    && record.sessionId === caller.sessionId
    && record.adapterId === caller.adapterId;
}
