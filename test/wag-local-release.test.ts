import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  createReleaseManifest,
  hashReleasePayload,
  readReleaseState,
  transactionalRollback,
  transactionalUpdate,
  uninstallOwnedArtifacts,
  validateReleaseManifest,
  type ReleaseManifest,
  type ReleaseState,
} from '../src/product-release.js';

function tempRoot(t: test.TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'wag-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writePayload(root: string, label: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'dist', 'cli.js'), `console.log("${label}")\n`, 'utf8');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'web-agent-gateway', version: label }) + '\n', 'utf8');
  writeFileSync(join(root, 'scripts', 'wag-local-start.ps1'), `# ${label}\n`, 'utf8');
}

function seedRelease(
  installRoot: string,
  releaseId: string,
  channel: 'stable' | 'beta' | 'development' = 'stable',
): string {
  const root = join(installRoot, 'runtime', releaseId);
  writePayload(root, releaseId);
  const state: ReleaseState = {
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: releaseId,
    previousReleaseId: null,
    channel,
    migrationVersion: 1,
    updatedAtUtc: '2026-09-30T00:00:00.000Z',
  };
  mkdirSync(join(installRoot, 'state'), { recursive: true });
  writeFileSync(join(installRoot, 'state', 'release-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  return root;
}

function manifest(packageRoot: string, releaseId: string, rollbackTarget: string | null): ReleaseManifest {
  return createReleaseManifest(packageRoot, {
    releaseId,
    version: '1.2.3',
    channel: 'stable',
    sourceProvenance: 'git:0123456789abcdef0123456789abcdef01234567',
    compatibility: { nodeMinMajor: 22, nodeMaxMajor: 26 },
    migrationVersion: 1,
    rollbackTarget,
  });
}

test('runtime wrapper replacement uses a unique atomic temp file', () => {
  const source = readFileSync(resolve('src/product-release-runtime.ts'), 'utf8');
  assert.match(source, /mktemp \"\$2\.tmp\.XXXXXX\"/);
  assert.match(source, /mv -f \"\$tmp\" \"\$2\"/);
  assert.doesNotMatch(source, /tmp=\"\$2\.tmp\.\$\"/);
});

test('release payload hash is deterministic and excludes RELEASE.json', (t) => {
  const root = tempRoot(t);
  writePayload(root, '1.2.3');
  const before = hashReleasePayload(root);
  writeFileSync(join(root, 'RELEASE.json'), '{"ignored":true}\n', 'utf8');
  const after = hashReleasePayload(root);
  assert.equal(after, before);
});

test('manifest validation enforces compatibility, migration, and exact rollback target', (t) => {
  const root = tempRoot(t);
  writePayload(root, '1.2.3');
  const good = manifest(root, 'release-2', 'release-1');
  assert.doesNotThrow(() => validateReleaseManifest(good, 'release-1', 24));

  assert.throws(
    () => validateReleaseManifest({ ...good, rollbackTarget: null }, 'release-1', 24),
    /WAG_RELEASE_ROLLBACK_TARGET_MISMATCH/,
  );
  assert.throws(
    () => validateReleaseManifest({ ...good, migrationVersion: 99 }, 'release-1', 24),
    /WAG_RELEASE_MIGRATION_UNSUPPORTED/,
  );
  assert.throws(
    () => validateReleaseManifest(good, 'release-1', 21),
    /WAG_RELEASE_NODE_INCOMPATIBLE/,
  );
});

test('transactional update stages, accepts, switches, verifies health, and preserves rollback target', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  seedRelease(installRoot, 'release-1');

  const candidate = join(root, 'candidate');
  writePayload(candidate, '1.2.3');
  writeFileSync(join(candidate, 'unshipped-secret.txt'), 'must-not-stage\n', 'utf8');
  const release = manifest(candidate, 'release-2', 'release-1');

  const switched: Array<string | null> = [];
  const receipt = await transactionalUpdate({
    installRoot,
    packageRoot: candidate,
    manifest: release,
    nodeMajor: 24,
    now: () => new Date('2026-09-30T01:00:00.000Z'),
    acceptCandidate: async (staged) => {
      assert.equal(readFileSync(join(staged, 'dist', 'cli.js'), 'utf8').includes('1.2.3'), true);
      assert.equal(existsSync(join(staged, 'unshipped-secret.txt')), false);
      return true;
    },
    switchRuntime: async (path) => { switched.push(path); },
    postSwitchHealth: async () => true,
  });

  assert.equal(receipt.state, 'SUCCEEDED');
  assert.equal(receipt.healthPassed, true);
  assert.equal(receipt.rolledBack, false);
  assert.equal(switched.length, 1);
  assert.match(switched[0]!, /release-2$/);

  const state = readReleaseState(installRoot)!;
  assert.equal(state.activeReleaseId, 'release-2');
  assert.equal(state.previousReleaseId, 'release-1');
  assert.equal(existsSync(join(installRoot, 'runtime', 'release-1')), true);
  assert.equal(existsSync(join(installRoot, 'runtime', 'release-2')), true);
});

test('failed post-switch health automatically restores previous runtime and state', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  seedRelease(installRoot, 'release-1');

  const candidate = join(root, 'candidate');
  writePayload(candidate, '1.2.3');
  const release = manifest(candidate, 'release-2', 'release-1');
  const switched: Array<string | null> = [];

  const receipt = await transactionalUpdate({
    installRoot,
    packageRoot: candidate,
    manifest: release,
    nodeMajor: 24,
    acceptCandidate: async () => true,
    switchRuntime: async (path) => { switched.push(path); },
    postSwitchHealth: async () => false,
  });

  assert.equal(receipt.state, 'FAILED_ROLLED_BACK');
  assert.equal(receipt.failureCode, 'WAG_RELEASE_POST_SWITCH_HEALTH_FAILED');
  assert.equal(receipt.rolledBack, true);
  assert.equal(switched.length, 2);
  assert.match(switched[0]!, /release-2$/);
  assert.match(switched[1]!, /release-1$/);
  assert.equal(readReleaseState(installRoot)!.activeReleaseId, 'release-1');
});

test('partial switch failure attempts exact rollback to the previous runtime', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  seedRelease(installRoot, 'release-1');

  const candidate = join(root, 'candidate');
  writePayload(candidate, '1.2.3');
  const switched: Array<string | null> = [];
  let calls = 0;

  const receipt = await transactionalUpdate({
    installRoot,
    packageRoot: candidate,
    manifest: manifest(candidate, 'release-2', 'release-1'),
    nodeMajor: 24,
    acceptCandidate: async () => true,
    switchRuntime: async (path) => {
      switched.push(path);
      calls += 1;
      if (calls === 1) throw new Error('WAG_FIXTURE_PARTIAL_SWITCH');
    },
    postSwitchHealth: async () => true,
  });

  assert.equal(receipt.state, 'FAILED_ROLLED_BACK');
  assert.equal(receipt.rolledBack, true);
  assert.equal(switched.length, 2);
  assert.match(switched[0]!, /release-2$/);
  assert.match(switched[1]!, /release-1$/);
  assert.equal(readReleaseState(installRoot)!.activeReleaseId, 'release-1');
});

test('candidate rejection never switches the active runtime', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  seedRelease(installRoot, 'release-1');

  const candidate = join(root, 'candidate');
  writePayload(candidate, '1.2.3');
  const switched: Array<string | null> = [];

  const receipt = await transactionalUpdate({
    installRoot,
    packageRoot: candidate,
    manifest: manifest(candidate, 'release-2', 'release-1'),
    nodeMajor: 24,
    acceptCandidate: async () => false,
    switchRuntime: async (path) => { switched.push(path); },
    postSwitchHealth: async () => true,
  });

  assert.equal(receipt.state, 'FAILED');
  assert.equal(receipt.failureCode, 'WAG_RELEASE_CANDIDATE_REJECTED');
  assert.deepEqual(switched, []);
  assert.equal(readReleaseState(installRoot)!.activeReleaseId, 'release-1');
});

test('explicit rollback swaps active/previous only after healthy switch', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  seedRelease(installRoot, 'release-1');

  const candidate = join(root, 'candidate');
  writePayload(candidate, '1.2.3');
  await transactionalUpdate({
    installRoot,
    packageRoot: candidate,
    manifest: manifest(candidate, 'release-2', 'release-1'),
    nodeMajor: 24,
    acceptCandidate: async () => true,
    switchRuntime: async () => undefined,
    postSwitchHealth: async () => true,
  });

  const switched: Array<string | null> = [];
  const receipt = await transactionalRollback({
    installRoot,
    switchRuntime: async (path) => { switched.push(path); },
    postSwitchHealth: async () => true,
  });

  assert.equal(receipt.state, 'SUCCEEDED');
  assert.equal(receipt.fromReleaseId, 'release-2');
  assert.equal(receipt.toReleaseId, 'release-1');
  assert.match(switched[0]!, /release-1$/);
  const state = readReleaseState(installRoot)!;
  assert.equal(state.activeReleaseId, 'release-1');
  assert.equal(state.previousReleaseId, 'release-2');
});

test('failed rollback health restores the original active runtime', async (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'install');
  const r1 = seedRelease(installRoot, 'release-1');
  const r2 = join(installRoot, 'runtime', 'release-2');
  writePayload(r2, 'release-2');
  const state: ReleaseState = {
    schema: 'WAG_LOCAL_RELEASE_STATE_V1',
    activeReleaseId: 'release-2',
    previousReleaseId: 'release-1',
    channel: 'stable',
    migrationVersion: 1,
    updatedAtUtc: '2026-09-30T00:00:00.000Z',
  };
  writeFileSync(join(installRoot, 'state', 'release-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');

  const switched: Array<string | null> = [];
  const receipt = await transactionalRollback({
    installRoot,
    switchRuntime: async (path) => { switched.push(path); },
    postSwitchHealth: async () => false,
  });

  assert.equal(receipt.state, 'FAILED_RESTORED');
  assert.equal(receipt.restoredOriginal, true);
  assert.equal(switched.length, 2);
  assert.equal(switched[0], r1);
  assert.equal(switched[1], r2);
  assert.equal(readReleaseState(installRoot)!.activeReleaseId, 'release-2');
});

test('uninstall removes only known WAG-owned artifacts and preserves unknown entries and user workspaces', (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'wag-local');
  const userWorkspace = join(root, 'user-workspace');
  writePayload(join(installRoot, 'runtime'), 'owned');
  mkdirSync(join(installRoot, 'logs'), { recursive: true });
  mkdirSync(join(installRoot, 'state'), { recursive: true });
  mkdirSync(join(installRoot, 'secrets'), { recursive: true });
  mkdirSync(join(installRoot, 'unknown-tool'), { recursive: true });
  writeFileSync(join(installRoot, 'unknown-tool', 'keep.txt'), 'keep\n', 'utf8');
  mkdirSync(userWorkspace, { recursive: true });
  writeFileSync(join(userWorkspace, 'keep.txt'), 'keep\n', 'utf8');

  const result = uninstallOwnedArtifacts(installRoot, {
    purgeState: false,
    externalWorkspacePaths: [userWorkspace],
  });
  assert.equal(result.rootRemoved, false);
  assert.ok(result.removedEntries.includes('runtime'));
  assert.ok(result.removedEntries.includes('logs'));
  assert.ok(result.preservedEntries.includes('state'));
  assert.ok(result.preservedEntries.includes('secrets'));
  assert.ok(result.preservedEntries.includes('unknown-tool'));
  assert.deepEqual(result.preservedExternalWorkspaces, [userWorkspace]);
  assert.equal(existsSync(join(userWorkspace, 'keep.txt')), true);
  assert.equal(existsSync(join(installRoot, 'unknown-tool', 'keep.txt')), true);
});

test('purge-state still preserves unknown entries and removes selected managed DevSpace artifacts', (t) => {
  const root = tempRoot(t);
  const installRoot = join(root, 'wag-local');
  mkdirSync(join(installRoot, 'state'), { recursive: true });
  mkdirSync(join(installRoot, 'secrets'), { recursive: true });
  mkdirSync(join(installRoot, 'receipts'), { recursive: true });
  mkdirSync(join(installRoot, 'DevSpace-Pin-abc1234'), { recursive: true });
  mkdirSync(join(installRoot, 'DevSpace-State'), { recursive: true });
  mkdirSync(join(installRoot, 'unknown-tool'), { recursive: true });

  const result = uninstallOwnedArtifacts(installRoot, {
    purgeState: true,
    removeManagedDevspace: true,
  });
  assert.equal(result.rootRemoved, false);
  for (const name of ['state', 'secrets', 'receipts', 'DevSpace-Pin-abc1234', 'DevSpace-State']) {
    assert.ok(result.removedEntries.includes(name));
  }
  assert.deepEqual(result.preservedEntries, ['unknown-tool']);
});
