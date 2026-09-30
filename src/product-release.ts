import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export type ReleaseChannel = 'stable' | 'beta' | 'development';

export interface ReleaseManifest {
  schema: 'WAG_LOCAL_RELEASE_V1';
  releaseId: string;
  version: string;
  channel: ReleaseChannel;
  sourceProvenance: string;
  payloadSha256: string;
  compatibility: {
    nodeMinMajor: number;
    nodeMaxMajor: number;
  };
  migrationVersion: number;
  rollbackTarget: string | 'previous-active' | null;
}

export interface ReleaseState {
  schema: 'WAG_LOCAL_RELEASE_STATE_V1';
  activeReleaseId: string;
  previousReleaseId: string | null;
  channel: ReleaseChannel;
  migrationVersion: number;
  updatedAtUtc: string;
}

export interface UpdateReceipt {
  schema: 'WAG_LOCAL_UPDATE_V1';
  generatedAtUtc: string;
  releaseId: string;
  previousReleaseId: string | null;
  channel: ReleaseChannel;
  staged: boolean;
  candidateAccepted: boolean;
  switched: boolean;
  healthPassed: boolean;
  rolledBack: boolean;
  state: 'SUCCEEDED' | 'FAILED_ROLLED_BACK' | 'FAILED';
  failureCode: string | null;
}

export interface RollbackReceipt {
  schema: 'WAG_LOCAL_ROLLBACK_V1';
  generatedAtUtc: string;
  fromReleaseId: string;
  toReleaseId: string | null;
  switched: boolean;
  healthPassed: boolean;
  restoredOriginal: boolean;
  state: 'SUCCEEDED' | 'FAILED_RESTORED' | 'FAILED';
  failureCode: string | null;
}

export interface TransactionalUpdateOptions {
  installRoot: string;
  packageRoot: string;
  manifest: ReleaseManifest;
  acceptCandidate: (stagedReleaseRoot: string) => Promise<boolean>;
  switchRuntime: (releaseRoot: string | null) => Promise<void>;
  postSwitchHealth: () => Promise<boolean>;
  now?: () => Date;
  nodeMajor?: number;
}

export interface TransactionalRollbackOptions {
  installRoot: string;
  switchRuntime: (releaseRoot: string | null) => Promise<void>;
  postSwitchHealth: () => Promise<boolean>;
  now?: () => Date;
}

const RELEASE_MANIFEST_NAME = 'RELEASE.json';
const STATE_FILE_NAME = 'release-state.json';
export const SUPPORTED_MIGRATION_VERSION = 1;

function isSafeReleaseId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

function assertInside(root: string, candidate: string): void {
  const base = resolve(root);
  const target = resolve(candidate);
  const rel = relative(base, target);
  if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith('..' + '/'))) return;
  throw new Error('WAG_RELEASE_PATH_ESCAPE');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.tmp-' + randomUUID();
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temp, path);
}

function currentNodeMajor(): number {
  const major = Number(process.versions.node.split('.')[0]);
  if (!Number.isSafeInteger(major)) throw new Error('WAG_NODE_VERSION_INVALID');
  return major;
}

export function validateReleaseManifest(
  manifest: ReleaseManifest,
  currentReleaseId: string | null,
  nodeMajor = currentNodeMajor(),
): void {
  if (manifest.schema !== 'WAG_LOCAL_RELEASE_V1') throw new Error('WAG_RELEASE_SCHEMA_INVALID');
  if (!isSafeReleaseId(manifest.releaseId)) throw new Error('WAG_RELEASE_ID_INVALID');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    throw new Error('WAG_RELEASE_VERSION_INVALID');
  }
  if (!['stable', 'beta', 'development'].includes(manifest.channel)) {
    throw new Error('WAG_RELEASE_CHANNEL_INVALID');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.payloadSha256)) {
    throw new Error('WAG_RELEASE_PAYLOAD_HASH_INVALID');
  }
  if (!manifest.sourceProvenance || manifest.sourceProvenance.length > 512) {
    throw new Error('WAG_RELEASE_PROVENANCE_INVALID');
  }
  if (!Number.isSafeInteger(manifest.compatibility.nodeMinMajor)
      || !Number.isSafeInteger(manifest.compatibility.nodeMaxMajor)
      || manifest.compatibility.nodeMinMajor < 1
      || manifest.compatibility.nodeMaxMajor < manifest.compatibility.nodeMinMajor) {
    throw new Error('WAG_RELEASE_COMPATIBILITY_INVALID');
  }
  if (nodeMajor < manifest.compatibility.nodeMinMajor || nodeMajor > manifest.compatibility.nodeMaxMajor) {
    throw new Error('WAG_RELEASE_NODE_INCOMPATIBLE');
  }
  if (!Number.isSafeInteger(manifest.migrationVersion)
      || manifest.migrationVersion < 0
      || manifest.migrationVersion > SUPPORTED_MIGRATION_VERSION) {
    throw new Error('WAG_RELEASE_MIGRATION_UNSUPPORTED');
  }
  if (manifest.rollbackTarget !== 'previous-active' && manifest.rollbackTarget !== currentReleaseId) {
    throw new Error('WAG_RELEASE_ROLLBACK_TARGET_MISMATCH');
  }
  if (currentReleaseId === null && manifest.rollbackTarget === 'previous-active') {
    throw new Error('WAG_RELEASE_ROLLBACK_TARGET_MISMATCH');
  }
}

function payloadFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).replaceAll('\\', '/');
      if (rel === RELEASE_MANIFEST_NAME || rel === 'dist/RELEASE.json') continue;
      if (entry.isSymbolicLink()) throw new Error('WAG_RELEASE_SYMLINK_UNSUPPORTED');
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile()) throw new Error('WAG_RELEASE_NON_FILE_UNSUPPORTED');
      result.push(path);
    }
  };

  const directories = ['dist'];
  const files = [
    'package.json',
    'scripts/install-wag-local-launchers.ps1',
    'scripts/wag-local-doctor.ps1',
    'scripts/wag-local-product-health.ps1',
    'scripts/wag-local-provision.ps1',
    'scripts/wag-local-setup.ps1',
    'scripts/wag-local-start.ps1',
    'scripts/wag-local-supervisor.ps1',
    'scripts/wag-local-tunnel-launcher.ps1',
    'docs/benchmarks/devspace-pin.json',
    'packaging/runtime-package-lock.json',
    'LICENSE',
    'THIRD_PARTY_NOTICES.md',
  ];

  for (const directory of directories) {
    const path = join(root, directory);
    if (existsSync(path) && statSync(path).isDirectory()) visit(path);
  }
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    if (!statSync(path).isFile()) throw new Error('WAG_RELEASE_NON_FILE_UNSUPPORTED');
    result.push(path);
  }

  return [...new Set(result)].sort((left, right) =>
    relative(root, left).localeCompare(relative(root, right)));
}

export function hashReleasePayload(root: string): string {
  const absolute = resolve(root);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error('WAG_RELEASE_PACKAGE_MISSING');
  }

  const hash = createHash('sha256');
  for (const path of payloadFiles(absolute)) {
    const rel = relative(absolute, path).replaceAll('\\', '/');
    const bytes = readFileSync(path);
    hash.update(rel, 'utf8');
    hash.update('\0');
    hash.update(String(bytes.length), 'utf8');
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function readReleaseState(installRoot: string): ReleaseState | null {
  const path = join(resolve(installRoot), 'state', STATE_FILE_NAME);
  if (!existsSync(path)) return null;
  const value = readJson(path) as Partial<ReleaseState>;
  if (value.schema !== 'WAG_LOCAL_RELEASE_STATE_V1'
      || typeof value.activeReleaseId !== 'string'
      || !isSafeReleaseId(value.activeReleaseId)
      || (value.previousReleaseId !== null
        && (typeof value.previousReleaseId !== 'string' || !isSafeReleaseId(value.previousReleaseId)))
      || !['stable', 'beta', 'development'].includes(String(value.channel))
      || !Number.isSafeInteger(value.migrationVersion)) {
    throw new Error('WAG_RELEASE_STATE_INVALID');
  }
  return value as ReleaseState;
}

function releaseRoot(installRoot: string, releaseId: string): string {
  const root = join(resolve(installRoot), 'runtime', releaseId);
  assertInside(installRoot, root);
  return root;
}

function statePath(installRoot: string): string {
  const path = join(resolve(installRoot), 'state', STATE_FILE_NAME);
  assertInside(installRoot, path);
  return path;
}

function stageCandidate(
  installRoot: string,
  packageRoot: string,
  manifest: ReleaseManifest,
): string {
  const releases = join(resolve(installRoot), 'runtime');
  mkdirSync(releases, { recursive: true });
  const target = releaseRoot(installRoot, manifest.releaseId);

  if (existsSync(target)) {
    const observed = hashReleasePayload(target);
    if (observed !== manifest.payloadSha256) throw new Error('WAG_RELEASE_EXISTING_PAYLOAD_MISMATCH');
    return target;
  }

  const staging = target + '.staging-' + randomUUID();
  assertInside(installRoot, staging);
  try {
    mkdirSync(staging, { recursive: true });
    for (const source of payloadFiles(resolve(packageRoot))) {
      const rel = relative(resolve(packageRoot), source);
      const destination = join(staging, rel);
      assertInside(staging, destination);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source, destination);
    }
    const observed = hashReleasePayload(staging);
    if (observed !== manifest.payloadSha256) throw new Error('WAG_RELEASE_PAYLOAD_HASH_MISMATCH');
    writeFileSync(join(staging, RELEASE_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return target;
}

function restoreState(installRoot: string, state: ReleaseState | null): void {
  const path = statePath(installRoot);
  if (state === null) {
    rmSync(path, { force: true });
    return;
  }
  writeJsonAtomic(path, state);
}

export async function transactionalUpdate(
  options: TransactionalUpdateOptions,
): Promise<UpdateReceipt> {
  const installRoot = resolve(options.installRoot);
  const packageRoot = resolve(options.packageRoot);
  const before = readReleaseState(installRoot);
  const currentReleaseId = before?.activeReleaseId ?? null;
  const now = options.now ?? (() => new Date());
  validateReleaseManifest(options.manifest, currentReleaseId, options.nodeMajor);

  if (currentReleaseId === options.manifest.releaseId) {
    throw new Error('WAG_RELEASE_ALREADY_ACTIVE');
  }

  let candidateRoot = '';
  let candidateAccepted = false;
  let switched = false;
  let healthPassed = false;
  let rolledBack = false;
  let failureCode: string | null = null;

  try {
    candidateRoot = stageCandidate(installRoot, packageRoot, options.manifest);
    candidateAccepted = await options.acceptCandidate(candidateRoot);
    if (!candidateAccepted) {
      failureCode = 'WAG_RELEASE_CANDIDATE_REJECTED';
      return {
        schema: 'WAG_LOCAL_UPDATE_V1',
        generatedAtUtc: now().toISOString(),
        releaseId: options.manifest.releaseId,
        previousReleaseId: currentReleaseId,
        channel: options.manifest.channel,
        staged: true,
        candidateAccepted: false,
        switched: false,
        healthPassed: false,
        rolledBack: false,
        state: 'FAILED',
        failureCode,
      };
    }

    try {
      await options.switchRuntime(candidateRoot);
      switched = true;
    } catch (error) {
      failureCode = error instanceof Error ? error.message : 'WAG_RELEASE_SWITCH_FAILED';
      const previousRoot = currentReleaseId ? releaseRoot(installRoot, currentReleaseId) : null;
      try {
        await options.switchRuntime(previousRoot);
        restoreState(installRoot, before);
        rolledBack = true;
      } catch {
        failureCode = 'WAG_RELEASE_ROLLBACK_FAILED';
      }
      return {
        schema: 'WAG_LOCAL_UPDATE_V1',
        generatedAtUtc: now().toISOString(),
        releaseId: options.manifest.releaseId,
        previousReleaseId: currentReleaseId,
        channel: options.manifest.channel,
        staged: true,
        candidateAccepted,
        switched: false,
        healthPassed: false,
        rolledBack,
        state: rolledBack ? 'FAILED_ROLLED_BACK' : 'FAILED',
        failureCode,
      };
    }

    const nextState: ReleaseState = {
      schema: 'WAG_LOCAL_RELEASE_STATE_V1',
      activeReleaseId: options.manifest.releaseId,
      previousReleaseId: currentReleaseId,
      channel: options.manifest.channel,
      migrationVersion: options.manifest.migrationVersion,
      updatedAtUtc: now().toISOString(),
    };
    writeJsonAtomic(statePath(installRoot), nextState);

    healthPassed = await options.postSwitchHealth();
    if (!healthPassed) {
      failureCode = 'WAG_RELEASE_POST_SWITCH_HEALTH_FAILED';
      const previousRoot = currentReleaseId ? releaseRoot(installRoot, currentReleaseId) : null;
      try {
        await options.switchRuntime(previousRoot);
        restoreState(installRoot, before);
        rolledBack = true;
      } catch {
        return {
          schema: 'WAG_LOCAL_UPDATE_V1',
          generatedAtUtc: now().toISOString(),
          releaseId: options.manifest.releaseId,
          previousReleaseId: currentReleaseId,
          channel: options.manifest.channel,
          staged: true,
          candidateAccepted,
          switched,
          healthPassed: false,
          rolledBack: false,
          state: 'FAILED',
          failureCode: 'WAG_RELEASE_ROLLBACK_FAILED',
        };
      }
      return {
        schema: 'WAG_LOCAL_UPDATE_V1',
        generatedAtUtc: now().toISOString(),
        releaseId: options.manifest.releaseId,
        previousReleaseId: currentReleaseId,
        channel: options.manifest.channel,
        staged: true,
        candidateAccepted,
        switched,
        healthPassed: false,
        rolledBack,
        state: 'FAILED_ROLLED_BACK',
        failureCode,
      };
    }

    return {
      schema: 'WAG_LOCAL_UPDATE_V1',
      generatedAtUtc: now().toISOString(),
      releaseId: options.manifest.releaseId,
      previousReleaseId: currentReleaseId,
      channel: options.manifest.channel,
      staged: true,
      candidateAccepted,
      switched,
      healthPassed,
      rolledBack,
      state: 'SUCCEEDED',
      failureCode: null,
    };
  } catch (error) {
    if (switched && !rolledBack) {
      const previousRoot = currentReleaseId ? releaseRoot(installRoot, currentReleaseId) : null;
      try {
        await options.switchRuntime(previousRoot);
        restoreState(installRoot, before);
        rolledBack = true;
      } catch {
        failureCode = 'WAG_RELEASE_ROLLBACK_FAILED';
      }
    }
    if (!failureCode) failureCode = error instanceof Error ? error.message : 'WAG_RELEASE_FAILED';
    return {
      schema: 'WAG_LOCAL_UPDATE_V1',
      generatedAtUtc: now().toISOString(),
      releaseId: options.manifest.releaseId,
      previousReleaseId: currentReleaseId,
      channel: options.manifest.channel,
      staged: candidateRoot.length > 0,
      candidateAccepted,
      switched,
      healthPassed,
      rolledBack,
      state: rolledBack ? 'FAILED_ROLLED_BACK' : 'FAILED',
      failureCode,
    };
  }
}

export async function transactionalRollback(
  options: TransactionalRollbackOptions,
): Promise<RollbackReceipt> {
  const installRoot = resolve(options.installRoot);
  const before = readReleaseState(installRoot);
  if (!before) throw new Error('WAG_RELEASE_STATE_MISSING');
  if (!before.previousReleaseId) throw new Error('WAG_RELEASE_ROLLBACK_UNAVAILABLE');

  const now = options.now ?? (() => new Date());
  const activeRoot = releaseRoot(installRoot, before.activeReleaseId);
  const previousRoot = releaseRoot(installRoot, before.previousReleaseId);
  if (!existsSync(previousRoot)) throw new Error('WAG_RELEASE_ROLLBACK_TARGET_MISSING');

  let switched = false;
  try {
    await options.switchRuntime(previousRoot);
    switched = true;
    const healthPassed = await options.postSwitchHealth();
    if (!healthPassed) {
      await options.switchRuntime(activeRoot);
      return {
        schema: 'WAG_LOCAL_ROLLBACK_V1',
        generatedAtUtc: now().toISOString(),
        fromReleaseId: before.activeReleaseId,
        toReleaseId: before.previousReleaseId,
        switched: true,
        healthPassed: false,
        restoredOriginal: true,
        state: 'FAILED_RESTORED',
        failureCode: 'WAG_ROLLBACK_HEALTH_FAILED',
      };
    }

    const next: ReleaseState = {
      ...before,
      activeReleaseId: before.previousReleaseId,
      previousReleaseId: before.activeReleaseId,
      updatedAtUtc: now().toISOString(),
    };
    writeJsonAtomic(statePath(installRoot), next);
    return {
      schema: 'WAG_LOCAL_ROLLBACK_V1',
      generatedAtUtc: now().toISOString(),
      fromReleaseId: before.activeReleaseId,
      toReleaseId: before.previousReleaseId,
      switched: true,
      healthPassed: true,
      restoredOriginal: false,
      state: 'SUCCEEDED',
      failureCode: null,
    };
  } catch (error) {
    if (switched) {
      try {
        await options.switchRuntime(activeRoot);
        return {
          schema: 'WAG_LOCAL_ROLLBACK_V1',
          generatedAtUtc: now().toISOString(),
          fromReleaseId: before.activeReleaseId,
          toReleaseId: before.previousReleaseId,
          switched: true,
          healthPassed: false,
          restoredOriginal: true,
          state: 'FAILED_RESTORED',
          failureCode: error instanceof Error ? error.message : 'WAG_ROLLBACK_FAILED',
        };
      } catch {
        // fall through
      }
    }
    return {
      schema: 'WAG_LOCAL_ROLLBACK_V1',
      generatedAtUtc: now().toISOString(),
      fromReleaseId: before.activeReleaseId,
      toReleaseId: before.previousReleaseId,
      switched,
      healthPassed: false,
      restoredOriginal: false,
      state: 'FAILED',
      failureCode: 'WAG_ROLLBACK_RESTORE_FAILED',
    };
  }
}

export function createReleaseManifest(
  packageRoot: string,
  input: Omit<ReleaseManifest, 'schema' | 'payloadSha256'>,
): ReleaseManifest {
  return {
    schema: 'WAG_LOCAL_RELEASE_V1',
    ...input,
    payloadSha256: hashReleasePayload(packageRoot),
  };
}

export interface UninstallOwnedArtifactsOptions {
  purgeState?: boolean;
  removeManagedDevspace?: boolean;
  externalWorkspacePaths?: string[];
}

export function uninstallOwnedArtifacts(
  installRoot: string,
  options: UninstallOwnedArtifactsOptions = {},
): {
  rootRemoved: boolean;
  removedEntries: string[];
  preservedEntries: string[];
  preservedExternalWorkspaces: string[];
} {
  const root = resolve(installRoot);
  const externalWorkspacePaths = options.externalWorkspacePaths ?? [];
  for (const workspace of externalWorkspacePaths) {
    const target = resolve(workspace);
    const rel = relative(root, target);
    if (rel === '' || (!rel.startsWith('..' + sep) && rel !== '..')) {
      throw new Error('WAG_UNINSTALL_WORKSPACE_INSIDE_INSTALL_ROOT');
    }
  }

  const owned = [
    'runtime',
    'config',
    'logs',
    'browser-profiles',
    'DevSpace',
    'Start-WagLocal.ps1',
    'Start-WagLocalTunnel.ps1',
    'Start-WagLocalSupervisor.ps1',
    'Start-WagLocalB.ps1',
    'WagLocalBServer.mjs',
    'Verify-WagLocalM1PostReboot.ps1',
    'session-correlation.txt',
    'tunnel-client-path.txt',
  ];
  if (options.purgeState) owned.push('state', 'secrets', 'receipts');
  if (options.removeManagedDevspace) owned.push('DevSpace-State');

  if (options.removeManagedDevspace && existsSync(root)) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory() && /^DevSpace-Pin-[A-Za-z0-9._-]+$/.test(entry.name)) owned.push(entry.name);
    }
  }

  const removedEntries: string[] = [];
  for (const name of [...new Set(owned)]) {
    const target = join(root, name);
    assertInside(root, target);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    if (!existsSync(target)) removedEntries.push(name);
  }

  let preservedEntries: string[] = [];
  if (existsSync(root)) {
    preservedEntries = readdirSync(root).sort();
    if (preservedEntries.length === 0) rmSync(root, { recursive: true, force: true });
  }

  return {
    rootRemoved: !existsSync(root),
    removedEntries,
    preservedEntries,
    preservedExternalWorkspaces: externalWorkspacePaths.filter((path) => existsSync(path)),
  };
}
