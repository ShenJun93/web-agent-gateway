import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
  NATIVE_HOST_ACCEPTED_REPOSITORY,
  NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
  NATIVE_HOST_ACCEPTED_SOURCE_SHA,
  NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
  NATIVE_HOST_INSTALLATION_SCHEMA_VERSION,
  buildNativeHostInstallPaths,
  createNativeHostRegistrationDescriptor,
  parseNativeHostInstallReceipt,
} from '../src/browser-adapter/native-host-installation.js';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
} from '../src/browser-adapter/native-host-distribution.js';

const localAppData = 'C:\\Users\\Alice\\AppData\\Local';
const manifestSha256 = 'b'.repeat(64);

function validReceipt() {
  const paths = buildNativeHostInstallPaths(localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
  return {
    schemaVersion: NATIVE_HOST_INSTALLATION_SCHEMA_VERSION,
    repository: NATIVE_HOST_ACCEPTED_REPOSITORY,
    sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    workflowRunId: NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
    runAttempt: NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
    executableSha256: NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    executablePath: paths.executable,
    manifestPath: paths.manifest,
    manifestSha256,
    registration: createNativeHostRegistrationDescriptor(paths.manifest),
    preparedAt: '2026-09-14T12:34:56.000Z',
  };
}

test('native host installation paths use the deterministic source-SHA layout and exact filenames', () => {
  assert.deepEqual(buildNativeHostInstallPaths(localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA), {
    root: `${localAppData}\\WebAgentGateway\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}`,
    executable: `${localAppData}\\WebAgentGateway\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}\\wag-native-host.exe`,
    manifest: `${localAppData}\\WebAgentGateway\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}\\com.openai.web_agent_gateway.json`,
    receipt: `${localAppData}\\WebAgentGateway\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}\\install-receipt.json`,
    registrationArtifact: `${localAppData}\\WebAgentGateway\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}\\register-native-host.reg`,
  });
});

test('native host installation paths reject relative local app data and non-canonical source identity', () => {
  assert.throws(
    () => buildNativeHostInstallPaths('relative\\AppData\\Local', NATIVE_HOST_ACCEPTED_SOURCE_SHA),
    /Windows absolute/i,
  );
  assert.throws(
    () => buildNativeHostInstallPaths(localAppData, 'a'.repeat(40)),
    /source SHA/i,
  );
});

test('native host installation receipt accepts exactly the recorded provenance, identities, paths, and hashes', () => {
  const receipt = validReceipt();
  assert.deepEqual(parseNativeHostInstallReceipt(receipt), receipt);
  assert.equal(NATIVE_HOST_INSTALLATION_SCHEMA_VERSION, 1);
  assert.equal(NATIVE_HOST_ACCEPTED_REPOSITORY, 'ShenJun93/web-agent-gateway');
  assert.equal(NATIVE_HOST_ACCEPTED_SOURCE_SHA, '9c7fb2881d3641354104f6a20257284d5629ef1c');
  assert.equal(NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256, '4f0869078357cf8b8ae00e4d27adbef0b905921bdd5202aca38ca10c1b055ebb');
  assert.equal(NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID, '35027172925');
  assert.equal(NATIVE_HOST_ACCEPTED_RUN_ATTEMPT, 1);
  assert.equal(receipt.nativeApplicationName, 'com.openai.web_agent_gateway');
  assert.equal(receipt.extensionId, 'nnhhhppkpogkedpjnijeagcbfjaoogec');
  assert.equal(receipt.manifestSha256, manifestSha256);
});

test('native host registration descriptor fixes one exact per-user 64-bit Chromium target', () => {
  const manifestPath = validReceipt().manifestPath;
  assert.deepEqual(createNativeHostRegistrationDescriptor(manifestPath), {
    hive: 'HKCU',
    view: '64-bit',
    subkey: 'SOFTWARE\\Chromium\\NativeMessagingHosts\\com.openai.web_agent_gateway',
    defaultValue: manifestPath,
  });
  assert.throws(() => createNativeHostRegistrationDescriptor('relative\\manifest.json'), /Windows absolute/i);
});

test('native host installation receipt rejects extra keys, relative paths, and wrong accepted identities', () => {
  const receipt = validReceipt();
  const wrongRoot = `C:\\Other\\native-host\\${NATIVE_HOST_ACCEPTED_SOURCE_SHA}`;
  const wrongRootManifest = `${wrongRoot}\\com.openai.web_agent_gateway.json`;
  const cases: unknown[] = [
    { ...receipt, extra: true },
    { ...receipt, repository: 'other/repository' },
    { ...receipt, sourceSha: 'a'.repeat(40) },
    { ...receipt, workflowRunId: '34757274245' },
    { ...receipt, runAttempt: 2 },
    { ...receipt, executableSha256: 'c'.repeat(64) },
    { ...receipt, nativeApplicationName: 'com.example.other' },
    { ...receipt, extensionId: 'a'.repeat(32) },
    { ...receipt, executablePath: 'relative\\wag-native-host.exe' },
    { ...receipt, manifestPath: 'relative\\com.openai.web_agent_gateway.json' },
    {
      ...receipt,
      executablePath: `${wrongRoot}\\wag-native-host.exe`,
      manifestPath: wrongRootManifest,
      registration: createNativeHostRegistrationDescriptor(wrongRootManifest),
    },
    { ...receipt, manifestSha256: 'b'.repeat(63) },
    { ...receipt, preparedAt: 'September 14, 2026' },
  ];

  for (const value of cases) assert.throws(() => parseNativeHostInstallReceipt(value));
});

test('native host installation receipt rejects widened or inconsistent registration descriptors', () => {
  const receipt = validReceipt();
  const cases: unknown[] = [
    { ...receipt, registration: { ...receipt.registration, hive: 'HKLM' } },
    { ...receipt, registration: { ...receipt.registration, view: '32-bit' } },
    {
      ...receipt,
      registration: {
        ...receipt.registration,
        subkey: 'SOFTWARE\\Google\\Chrome\\NativeMessagingHosts\\com.openai.web_agent_gateway',
      },
    },
    { ...receipt, registration: { ...receipt.registration, defaultValue: 'C:\\other\\manifest.json' } },
    { ...receipt, registration: { ...receipt.registration, extra: true } },
  ];

  for (const value of cases) assert.throws(() => parseNativeHostInstallReceipt(value));
});
