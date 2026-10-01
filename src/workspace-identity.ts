import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const WORKSPACE_IDENTITY_VERSION = 'wag.workspace-identity.v1';

export interface WorkspaceIdentityObservation {
  readonly canonicalRoot: string;
  readonly backendKind: string;
  readonly fsDevice: string;
  readonly fsInode: string;
  readonly gitTopLevel?: string;
  readonly gitDir?: string;
  readonly gitCommonDir?: string;
}

export interface WorkspaceIdentityRecord extends WorkspaceIdentityObservation {
  readonly workspaceId: string;
  readonly fingerprint: string;
  readonly observedAt: number;
}

function validateObservation(value: WorkspaceIdentityObservation): void {
  for (const [name, item] of [
    ['canonicalRoot', value.canonicalRoot],
    ['backendKind', value.backendKind],
    ['fsDevice', value.fsDevice],
    ['fsInode', value.fsInode],
  ] as const) {
    if (typeof item !== 'string' || item.length === 0 || item.includes('\0')) {
      throw new Error(`Invalid workspace identity ${name}`);
    }
  }
  const git = [value.gitTopLevel, value.gitDir, value.gitCommonDir];
  const present = git.filter((item) => item !== undefined).length;
  if (present !== 0 && present !== git.length) {
    throw new Error('Workspace identity Git fields must be all present or all absent');
  }
  for (const item of git) {
    if (item !== undefined && (item.length === 0 || item.includes('\0'))) {
      throw new Error('Invalid workspace identity Git path');
    }
  }
}

/**
 * Stable identity for the directory/repository object behind an opaque workspace handle.
 *
 * HEAD and branch are deliberately absent: they are mutable history state and remain separate
 * Goal Lease CAS bindings. The filesystem device/inode distinguishes a directory recreated at the
 * same path, while gitDir/commonDir distinguish worktrees that share one repository.
 */
export function workspaceIdentityFingerprint(value: WorkspaceIdentityObservation): string {
  validateObservation(value);
  const tuple = [
    WORKSPACE_IDENTITY_VERSION,
    value.canonicalRoot,
    value.backendKind,
    value.fsDevice,
    value.fsInode,
    value.gitTopLevel ?? '',
    value.gitDir ?? '',
    value.gitCommonDir ?? '',
  ];
  return createHash('sha256').update(tuple.join('\0'), 'utf8').digest('hex');
}

/**
 * Separate small registry over the authority database.
 *
 * The generic durable store intentionally has no migration framework and is already over WAG's
 * bounded mutation size. Keeping this security adjunct in its own table/module follows the same
 * composition pattern as the Goal Lease atomic-budget trigger.
 */
export class WorkspaceIdentityRegistry {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(statePath: string) {
    if (!isAbsolute(statePath)) {
      throw new Error('Workspace identity registry requires an absolute state path');
    }
    this.db = new DatabaseSync(statePath);
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_identity_v1 (
        workspace_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        backend_kind TEXT NOT NULL,
        fs_device TEXT NOT NULL,
        fs_inode TEXT NOT NULL,
        git_top_level TEXT,
        git_dir TEXT,
        git_common_dir TEXT,
        observed_at INTEGER NOT NULL
      )
    `);
  }

  record(workspaceId: string, observation: WorkspaceIdentityObservation, observedAt = Date.now()): WorkspaceIdentityRecord {
    if (!/^ws_[A-Za-z0-9-]+$/.test(workspaceId)) throw new Error('Invalid workspace identity workspace id');
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) throw new Error('Invalid workspace identity timestamp');
    validateObservation(observation);
    const fingerprint = workspaceIdentityFingerprint(observation);

    this.db.prepare(`
      INSERT OR IGNORE INTO workspace_identity_v1 (
        workspace_id, fingerprint, canonical_root, backend_kind, fs_device, fs_inode,
        git_top_level, git_dir, git_common_dir, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      fingerprint,
      observation.canonicalRoot,
      observation.backendKind,
      observation.fsDevice,
      observation.fsInode,
      observation.gitTopLevel ?? null,
      observation.gitDir ?? null,
      observation.gitCommonDir ?? null,
      observedAt,
    );

    const record = this.get(workspaceId);
    if (!record) throw new Error('Workspace identity did not persist');
    if (
      record.fingerprint !== fingerprint
      || record.canonicalRoot !== observation.canonicalRoot
      || record.backendKind !== observation.backendKind
      || record.fsDevice !== observation.fsDevice
      || record.fsInode !== observation.fsInode
      || record.gitTopLevel !== observation.gitTopLevel
      || record.gitDir !== observation.gitDir
      || record.gitCommonDir !== observation.gitCommonDir
    ) {
      throw new Error('Workspace identity drift for existing workspace id');
    }
    return record;
  }

  get(workspaceId: string): WorkspaceIdentityRecord | undefined {
    const row = this.db.prepare(
      'SELECT * FROM workspace_identity_v1 WHERE workspace_id = ?',
    ).get(workspaceId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      workspaceId: String(row.workspace_id),
      fingerprint: String(row.fingerprint),
      canonicalRoot: String(row.canonical_root),
      backendKind: String(row.backend_kind),
      fsDevice: String(row.fs_device),
      fsInode: String(row.fs_inode),
      ...(row.git_top_level === null ? {} : { gitTopLevel: String(row.git_top_level) }),
      ...(row.git_dir === null ? {} : { gitDir: String(row.git_dir) }),
      ...(row.git_common_dir === null ? {} : { gitCommonDir: String(row.git_common_dir) }),
      observedAt: Number(row.observed_at),
    };
  }

  fingerprint(workspaceId: string): string | undefined {
    return this.get(workspaceId)?.fingerprint;
  }

  fingerprintFor(workspaceId: string, canonicalRoot: string, backendKind: string): string | undefined {
    const record = this.get(workspaceId);
    if (!record || record.canonicalRoot !== canonicalRoot || record.backendKind !== backendKind) return undefined;
    return record.fingerprint;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
