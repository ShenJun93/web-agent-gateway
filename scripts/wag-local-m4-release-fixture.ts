import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  createReleaseManifest,
  readReleaseState,
  transactionalRollback,
  transactionalUpdate,
  uninstallOwnedArtifacts,
  type ReleaseState,
} from '../src/product-release.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function writePayload(root: string, version: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'packaging'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), `console.log("fixture-${version}")\n`, 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web-agent-gateway', version }) + '\n', 'utf8');
  writeFileSync(join(root, 'scripts', 'wag-local-start.ps1'), `# fixture ${version}\n`, 'utf8');
  writeFileSync(join(root, 'packaging', 'runtime-package-lock.json'), '{}\n', 'utf8');
}

function seedRelease(installRoot: string, releaseId: string): string {
  const root = join(installRoot, 'runtime', releaseId);
  writePayload(root, '1.0.0');
  mkdirSync(join(installRoot, 'state'), { recursive: true });
  const state: ReleaseState = {
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: releaseId,
    previousReleaseId: null,
    channel: 'stable',
    migrationVersion: 1,
    updatedAtUtc: '2026-09-30T00:00:00.000Z',
  };
  writeFileSync(join(installRoot, 'state', 'release-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return root;
}

function atomicPointer(pointer: string, target: string | null): void {
  mkdirSync(dirname(pointer), { recursive: true });
  const temp = pointer + '.tmp';
  writeFileSync(temp, (target ?? 'NONE') + '\n', 'utf8');
  renameSync(temp, pointer);
}

function parseOutput(): string {
  const index = process.argv.indexOf('--output');
  if (index < 0) return join(repoRoot, 'docs', 'benchmarks', '2026-09-30-wag-local-product-m4-fixture.json');
  const value = process.argv[index + 1];
  if (!value) throw new Error('Missing value after --output');
  return resolve(value);
}

const fixtureRoot = mkdtempSync(join(tmpdir(), 'wag-m4-release-'));
const output = parseOutput();

try {
  const installRoot = join(fixtureRoot, 'install');
  const pointer = join(fixtureRoot, 'active-runtime.txt');
  const userWorkspace = join(fixtureRoot, 'user-workspace');
  mkdirSync(userWorkspace, { recursive: true });
  writeFileSync(join(userWorkspace, 'keep.txt'), 'keep\n', 'utf8');

  const release1 = seedRelease(installRoot, 'release-1');
  atomicPointer(pointer, release1);

  const candidate2 = join(fixtureRoot, 'candidate-2');
  writePayload(candidate2, '1.1.0');
  const manifest2 = createReleaseManifest(candidate2, {
    releaseId: 'release-2',
    version: '1.1.0',
    channel: 'beta',
    sourceProvenance: 'git:1111111111111111111111111111111111111111',
    compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
    migrationVersion: 1,
    rollbackTarget: 'previous-active',
  });

  const switchSequence: string[] = [];
  let activeTarget = release1;
  const success = await transactionalUpdate({
    installRoot,
    packageRoot: candidate2,
    manifest: manifest2,
    nodeMajor: 24,
    acceptCandidate: async (root) => {
      return existsSync(join(root, 'dist', 'cli.js'));
    },
    switchRuntime: async (root) => {
      activeTarget = root ?? '';
      atomicPointer(pointer, root);
      switchSequence.push(root ?? 'NONE');
    },
    postSwitchHealth: async () => {
      return readFileSync(pointer, 'utf8').trim() === activeTarget
        && existsSync(join(activeTarget, 'dist', 'cli.js'));
    },
  });

  const afterSuccess = readReleaseState(installRoot);

  const candidate3 = join(fixtureRoot, 'candidate-3');
  writePayload(candidate3, '1.2.0');
  const manifest3 = createReleaseManifest(candidate3, {
    releaseId: 'release-3',
    version: '1.2.0',
    channel: 'beta',
    sourceProvenance: 'git:2222222222222222222222222222222222222222',
    compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
    migrationVersion: 1,
    rollbackTarget: 'previous-active',
  });

  const failed = await transactionalUpdate({
    installRoot,
    packageRoot: candidate3,
    manifest: manifest3,
    nodeMajor: 24,
    acceptCandidate: async () => true,
    switchRuntime: async (root) => {
      activeTarget = root ?? '';
      atomicPointer(pointer, root);
      switchSequence.push(root ?? 'NONE');
    },
    postSwitchHealth: async () => false,
  });

  const afterAutoRollback = readReleaseState(installRoot);

  activeTarget = join(installRoot, 'runtime', afterAutoRollback!.activeReleaseId);
  const explicitRollback = await transactionalRollback({
    installRoot,
    switchRuntime: async (root) => {
      activeTarget = root ?? '';
      atomicPointer(pointer, root);
      switchSequence.push(root ?? 'NONE');
    },
    postSwitchHealth: async () => {
      return readFileSync(pointer, 'utf8').trim() === activeTarget
        && existsSync(join(activeTarget, 'dist', 'cli.js'));
    },
  });

  const afterExplicitRollback = readReleaseState(installRoot);

  mkdirSync(join(installRoot, 'logs'), { recursive: true });
  mkdirSync(join(installRoot, 'secrets'), { recursive: true });
  mkdirSync(join(installRoot, 'receipts'), { recursive: true });
  mkdirSync(join(installRoot, 'DevSpace-Pin-fixture'), { recursive: true });
  mkdirSync(join(installRoot, 'DevSpace-State'), { recursive: true });
  mkdirSync(join(installRoot, 'unknown-tool'), { recursive: true });
  writeFileSync(join(installRoot, 'unknown-tool', 'keep.txt'), 'keep\n', 'utf8');

  const uninstall = uninstallOwnedArtifacts(installRoot, {
    purgeState: true,
    removeManagedDevspace: true,
    externalWorkspacePaths: [userWorkspace],
  });

  const checks = {
    updateSucceeded: success.state === 'SUCCEEDED',
    previousReleasePreserved: afterSuccess?.activeReleaseId === 'release-2'
      && afterSuccess.previousReleaseId === 'release-1'
      && existsSync(join(installRoot, 'runtime', 'release-1')) === false,
    automaticRollbackSucceeded: failed.state === 'FAILED_ROLLED_BACK'
      && failed.rolledBack
      && afterAutoRollback?.activeReleaseId === 'release-2',
    explicitRollbackSucceeded: explicitRollback.state === 'SUCCEEDED'
      && afterExplicitRollback?.activeReleaseId === 'release-1',
    atomicPointerUsed: switchSequence.length >= 4,
    manifestCarriesReleaseMetadata: manifest2.channel === 'beta'
      && manifest2.sourceProvenance.startsWith('git:')
      && manifest2.payloadSha256.length === 64
      && manifest2.compatibility.nodeMinMajor === 22
      && manifest2.compatibility.nodeMaxMajor === 26
      && manifest2.migrationVersion === 1
      && manifest2.rollbackTarget === 'previous-active',
    uninstallPreservedUnknown: uninstall.preservedEntries.includes('unknown-tool')
      && existsSync(join(installRoot, 'unknown-tool', 'keep.txt')),
    uninstallPreservedUserWorkspace: uninstall.preservedExternalWorkspaces.includes(userWorkspace)
      && existsSync(join(userWorkspace, 'keep.txt')),
    uninstallRemovedRuntime: uninstall.removedEntries.includes('runtime'),
    uninstallRemovedManagedDevspace: uninstall.removedEntries.includes('DevSpace-Pin-fixture')
      && uninstall.removedEntries.includes('DevSpace-State'),
  };

  // previousReleasePreserved is evaluated after uninstall above only for state values, not filesystem.
  checks.previousReleasePreserved = afterSuccess?.activeReleaseId === 'release-2'
    && afterSuccess.previousReleaseId === 'release-1';

  const pass = Object.values(checks).every(Boolean);
  const receipt = {
    schema: 'WAG_LOCAL_M4_RELEASE_FIXTURE_V1',
    generatedAtUtc: new Date().toISOString(),
    pass,
    release: {
      success,
      failed,
      explicitRollback,
      manifest: manifest2,
      switchSequence,
    },
    uninstall,
    checks,
  };

  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
  process.stdout.write(`M4_FIXTURE_RECEIPT=${output}\n`);
  process.stdout.write(`M4_FIXTURE_PASS=${pass}\n`);
  if (!pass) process.exitCode = 2;
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}
