import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import {
  NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
  NATIVE_HOST_ACCEPTED_REPOSITORY,
  NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
  NATIVE_HOST_ACCEPTED_SOURCE_SHA,
  NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
  buildNativeHostInstallPaths,
  parseNativeHostInstallReceipt,
  prepareNativeHostInstallation,
  type NativeHostInstallationDependencies,
} from '../src/browser-adapter/native-host-installation.js';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
  NATIVE_HOST_FILENAME,
  type NativeHostBuildReceipt,
} from '../src/browser-adapter/native-host-distribution.js';
import { createNativeHostManifest } from '../src/browser-adapter/native-host-manifest.js';
import { runNativeHostInstallationCli } from '../scripts/prepare-native-host-installation.js';

const executableBytes = Buffer.from('synthetic accepted native host\0fixture');

function buildReceipt(overrides: Record<string, unknown> = {}): NativeHostBuildReceipt {
  return {
    schemaVersion: 1,
    repository: NATIVE_HOST_ACCEPTED_REPOSITORY,
    sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    sourceRef: `refs/heads/${NATIVE_HOST_ACCEPTED_SOURCE_SHA}`,
    workflowRunId: NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
    runAttempt: NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
    runner: { os: 'Windows', arch: 'X64' },
    nodeVersion: '24.20.0',
    packageLockSha256: 'a'.repeat(64),
    artifact: { filename: NATIVE_HOST_FILENAME, sha256: NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 },
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    verificationGates: [
      'typecheck',
      'build',
      'browser-adapter-protocol',
      'native-messaging-framing',
      'native-host-protocol',
      'native-host-manifest',
      'browser-extension-identity',
      'native-host-artifact',
    ],
    ...overrides,
  } as unknown as NativeHostBuildReceipt;
}

async function fixture(t: test.TestContext) {
  const localAppData = await mkdtemp(join(tmpdir(), 'wag-native-install-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  const distributionDirectory = join(localAppData, 'distribution');
  await mkdir(distributionDirectory);
  await writeFile(join(distributionDirectory, NATIVE_HOST_FILENAME), executableBytes);
  return { localAppData, distributionDirectory };
}

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function dependencies(receipt = buildReceipt()): NativeHostInstallationDependencies {
  return {
    verifyDistribution: async () => receipt,
    sha256File: async (path) => {
      const bytes = await readFile(path);
      return bytes.equals(executableBytes) ? NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 : sha256(bytes);
    },
  };
}

function preparationInput(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    distributionDirectory: f.distributionDirectory,
    localAppData: f.localAppData,
    repository: NATIVE_HOST_ACCEPTED_REPOSITORY,
  };
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(() => access(path));
}

test('prepares the exact source-SHA installation from a verified synthetic distribution', async (t) => {
  const f = await fixture(t);
  const receipt = await prepareNativeHostInstallation(preparationInput(f), dependencies());
  const paths = buildNativeHostInstallPaths(f.localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);

  assert.deepEqual((await readdir(paths.root)).sort(), [
    'com.openai.web_agent_gateway.json',
    'install-receipt.json',
    'register-native-host.reg',
    NATIVE_HOST_FILENAME,
  ].sort());
  assert.deepEqual(await readFile(paths.executable), executableBytes);

  const expectedManifest = createNativeHostManifest({
    executablePath: paths.executable,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
  });
  assert.deepEqual(JSON.parse(await readFile(paths.manifest, 'utf8')), expectedManifest);
  assert.deepEqual(parseNativeHostInstallReceipt(JSON.parse(await readFile(paths.receipt, 'utf8'))), receipt);
  assert.deepEqual(receipt, {
    schemaVersion: 1,
    repository: NATIVE_HOST_ACCEPTED_REPOSITORY,
    sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    workflowRunId: NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
    runAttempt: NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
    executableSha256: NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    executablePath: paths.executable,
    manifestPath: paths.manifest,
    manifestSha256: sha256(await readFile(paths.manifest)),
    registration: {
      hive: 'HKCU',
      view: '64-bit',
      subkey: 'SOFTWARE\\Chromium\\NativeMessagingHosts\\com.openai.web_agent_gateway',
      defaultValue: paths.manifest,
    },
    preparedAt: receipt.preparedAt,
  });
  assert.match(receipt.preparedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const registrationBytes = await readFile(paths.registrationArtifact);
  assert.deepEqual(registrationBytes.subarray(0, 2), Buffer.from([0xff, 0xfe]));
  const registration = registrationBytes.subarray(2).toString('utf16le');
  assert.equal(registration,
    'Windows Registry Editor Version 5.00\r\n\r\n'
    + '[HKEY_CURRENT_USER\\SOFTWARE\\Chromium\\NativeMessagingHosts\\com.openai.web_agent_gateway]\r\n'
    + `@="${paths.manifest.replaceAll('\\', '\\\\')}"\r\n`,
  );
  assert.doesNotMatch(registration, /HKEY_LOCAL_MACHINE|Google\\Chrome|Microsoft\\Edge|reg(?:\.exe)?\s+add|powershell/i);

  const nativeHostParent = join(f.localAppData, 'WebAgentGateway', 'native-host');
  assert.deepEqual(await readdir(nativeHostParent), [NATIVE_HOST_ACCEPTED_SOURCE_SHA]);
});

test('rejects every non-canonical accepted artifact identity before writing installation state', async (t) => {
  const cases: Array<[string, NativeHostBuildReceipt]> = [
    ['repository', buildReceipt({ repository: 'other/repository' })],
    ['source SHA', buildReceipt({ sourceSha: 'b'.repeat(40) })],
    ['workflow run', buildReceipt({ workflowRunId: '34757274245' })],
    ['run attempt', buildReceipt({ runAttempt: 2 })],
    ['artifact filename', buildReceipt({ artifact: { filename: 'other.exe', sha256: NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 } })],
    ['executable hash', buildReceipt({ artifact: { filename: NATIVE_HOST_FILENAME, sha256: 'b'.repeat(64) } })],
    ['application', buildReceipt({ nativeApplicationName: 'com.example.other' })],
    ['extension', buildReceipt({ extensionId: 'a'.repeat(32) })],
  ];

  for (const [label, receipt] of cases) {
    const f = await fixture(t);
    const paths = buildNativeHostInstallPaths(f.localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
    await assert.rejects(
      () => prepareNativeHostInstallation(preparationInput(f), dependencies(receipt)),
      new RegExp(label, 'i'),
    );
    await assertMissing(paths.root);
  }

  const f = await fixture(t);
  await assert.rejects(
    () => prepareNativeHostInstallation({ ...preparationInput(f), repository: 'other/repository' }, dependencies()),
    /repository/i,
  );
});

test('re-hashes copied bytes and validates the complete temp installation before atomic rename', async (t) => {
  const f = await fixture(t);
  const paths = buildNativeHostInstallPaths(f.localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
  let executableHashCalls = 0;
  const deps = dependencies();
  deps.sha256File = async (path) => {
    if (basename(path) === NATIVE_HOST_FILENAME) {
      executableHashCalls += 1;
      return executableHashCalls === 1 ? NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256 : 'f'.repeat(64);
    }
    return sha256(await readFile(path));
  };

  await assert.rejects(() => prepareNativeHostInstallation(preparationInput(f), deps), /executable hash/i);
  assert.equal(executableHashCalls, 2);
  await assertMissing(paths.root);
  assert.deepEqual(await readdir(join(f.localAppData, 'WebAgentGateway', 'native-host')), []);
});

test('is idempotent only for byte-identical validated owned state', async (t) => {
  const f = await fixture(t);
  let verificationCalls = 0;
  const deps = dependencies();
  const verifyDistribution = deps.verifyDistribution;
  deps.verifyDistribution = async (input) => {
    verificationCalls += 1;
    return verifyDistribution(input);
  };
  const first = await prepareNativeHostInstallation(preparationInput(f), deps);
  const paths = buildNativeHostInstallPaths(f.localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
  const before = await Promise.all([
    readFile(paths.executable), readFile(paths.manifest), readFile(paths.receipt), readFile(paths.registrationArtifact),
  ]);

  const second = await prepareNativeHostInstallation(preparationInput(f), deps);
  const after = await Promise.all([
    readFile(paths.executable), readFile(paths.manifest), readFile(paths.receipt), readFile(paths.registrationArtifact),
  ]);
  assert.deepEqual(second, first);
  assert.deepEqual(after, before);
  assert.equal(verificationCalls, 2);
});

test('fails closed without overwriting drifted owned files or an unexpected executable', async (t) => {
  const cases: Array<[string, (paths: ReturnType<typeof buildNativeHostInstallPaths>) => Promise<string>]> = [
    ['executable', async (paths) => (await writeFile(paths.executable, 'tampered'), paths.executable)],
    ['manifest', async (paths) => (await writeFile(paths.manifest, '{}\n'), paths.manifest)],
    ['receipt', async (paths) => (await writeFile(paths.receipt, '{}\n'), paths.receipt)],
    ['registration', async (paths) => (await writeFile(paths.registrationArtifact, 'tampered'), paths.registrationArtifact)],
    ['unexpected executable', async (paths) => {
      const extra = join(paths.root, 'unexpected.exe');
      await writeFile(extra, 'unexpected');
      return extra;
    }],
  ];

  for (const [label, tamper] of cases) {
    const f = await fixture(t);
    const deps = dependencies();
    await prepareNativeHostInstallation(preparationInput(f), deps);
    const paths = buildNativeHostInstallPaths(f.localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
    const driftedPath = await tamper(paths);
    const driftedBytes = await readFile(driftedPath);
    await assert.rejects(() => prepareNativeHostInstallation(preparationInput(f), deps), /drift|payload|receipt|hash/i, label);
    assert.deepEqual(await readFile(driftedPath), driftedBytes, `${label} was overwritten`);
    assert.deepEqual((await readdir(join(f.localAppData, 'WebAgentGateway', 'native-host'))), [
      NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    ]);
  }
});

test('CLI accepts exactly the three required options and returns bounded prepared identity only', async (t) => {
  const f = await fixture(t);
  const output = await runNativeHostInstallationCli([
    '--distribution', f.distributionDirectory,
    '--local-app-data', f.localAppData,
    '--repository', NATIVE_HOST_ACCEPTED_REPOSITORY,
  ], dependencies());
  assert.deepEqual(JSON.parse(output), {
    status: 'prepared',
    sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    sha256: NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
  });
  assert.doesNotMatch(output, new RegExp(f.localAppData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(output, /registry|registration|applied|HKCU/i);

  for (const args of [
    [],
    ['--distribution', f.distributionDirectory, '--local-app-data', f.localAppData],
    ['--distribution', f.distributionDirectory, '--local-app-data', f.localAppData, '--repository', NATIVE_HOST_ACCEPTED_REPOSITORY, '--extra', 'value'],
    ['--distribution', f.distributionDirectory, '--distribution', f.distributionDirectory, '--local-app-data', f.localAppData, '--repository', NATIVE_HOST_ACCEPTED_REPOSITORY],
  ]) {
    await assert.rejects(() => runNativeHostInstallationCli(args, dependencies()), /arguments|missing|duplicate|unknown/i);
  }
});
