import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256,
  NATIVE_HOST_ACCEPTED_REPOSITORY,
  NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
  NATIVE_HOST_ACCEPTED_SOURCE_SHA,
  NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
  NATIVE_HOST_INSTALLATION_SCHEMA_VERSION,
  buildNativeHostInstallPaths,
  classifyNativeHostRegistration,
  createNativeHostRegistrationDescriptor,
  decideNativeHostOwnedCleanup,
  parseNativeHostInstallReceipt,
} from '../src/browser-adapter/native-host-installation.js';
import {
  BROWSER_ADAPTER_EXTENSION_ID,
  NATIVE_HOST_APPLICATION_NAME,
} from '../src/browser-adapter/native-host-distribution.js';
import { createNativeHostManifest } from '../src/browser-adapter/native-host-manifest.js';

const execFileAsync = promisify(execFile);
const verifierPath = fileURLToPath(new URL('../scripts/verify-native-host-installation.ps1', import.meta.url));
const expectedRegistryPath = 'Registry::HKEY_CURRENT_USER\\SOFTWARE\\Chromium\\NativeMessagingHosts\\com.openai.web_agent_gateway';

function registrationArtifact(manifestPath: string): Buffer {
  const escaped = manifestPath.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const body = 'Windows Registry Editor Version 5.00\r\n\r\n'
    + `[HKEY_CURRENT_USER\\SOFTWARE\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_APPLICATION_NAME}]\r\n`
    + `@=\"${escaped}\"\r\n`;
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, 'utf16le')]);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function validReceipt() {
  const paths = buildNativeHostInstallPaths(
    'C:\\Users\\Alice\\AppData\\Local',
    NATIVE_HOST_ACCEPTED_SOURCE_SHA,
  );
  return parseNativeHostInstallReceipt({
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
    manifestSha256: 'b'.repeat(64),
    registration: createNativeHostRegistrationDescriptor(paths.manifest),
    preparedAt: '2026-09-14T12:34:56.000Z',
  });
}

const syntheticExecutableBytes = Buffer.from('WAG native host verifier synthetic fixture v1\n', 'utf8');
const syntheticExecutableSha256 = sha256(syntheticExecutableBytes);

async function createFixtureVerifier(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wag-native-install-verifier-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = await readFile(verifierPath, 'utf8');
  const needle = `$expectedExecutableSha256 = '${NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256}'`;
  assert.equal(source.split(needle).length - 1, 1, 'committed verifier must contain one accepted executable hash pin');
  const fixturePath = join(root, 'verify-native-host-installation.ps1');
  await writeFile(fixturePath, source.replace(needle, `$expectedExecutableSha256 = '${syntheticExecutableSha256}'`), 'utf8');
  return fixturePath;
}

interface PreparedFixture {
  localAppData: string;
  paths: ReturnType<typeof buildNativeHostInstallPaths>;
  manifest: Record<string, unknown>;
  receipt: Record<string, unknown>;
  verifierPath: string;
  executableSha256: string;
}

async function createPreparedFixture(
  t: TestContext,
  localAppDataOverride?: string,
): Promise<PreparedFixture> {
  const fixtureVerifierPath = await createFixtureVerifier(t);
  const localAppData = localAppDataOverride ?? await mkdtemp(join(tmpdir(), 'wag-native-install-localapp-'));
  if (!localAppDataOverride) t.after(() => rm(localAppData, { recursive: true, force: true }));
  const paths = buildNativeHostInstallPaths(localAppData, NATIVE_HOST_ACCEPTED_SOURCE_SHA);
  await mkdir(paths.root, { recursive: true });
  await writeFile(paths.executable, syntheticExecutableBytes);
  const manifest = createNativeHostManifest({
    executablePath: paths.executable,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
  }) as unknown as Record<string, unknown>;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(paths.manifest, manifestBytes);
  const receipt: Record<string, unknown> = {
    schemaVersion: NATIVE_HOST_INSTALLATION_SCHEMA_VERSION,
    repository: NATIVE_HOST_ACCEPTED_REPOSITORY,
    sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
    workflowRunId: NATIVE_HOST_ACCEPTED_WORKFLOW_RUN_ID,
    runAttempt: NATIVE_HOST_ACCEPTED_RUN_ATTEMPT,
    executableSha256: syntheticExecutableSha256,
    nativeApplicationName: NATIVE_HOST_APPLICATION_NAME,
    extensionId: BROWSER_ADAPTER_EXTENSION_ID,
    executablePath: paths.executable,
    manifestPath: paths.manifest,
    manifestSha256: sha256(manifestBytes),
    registration: createNativeHostRegistrationDescriptor(paths.manifest),
    preparedAt: '2026-09-14T12:34:56.000Z',
  };
  await writeFile(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await writeFile(paths.registrationArtifact, registrationArtifact(paths.manifest));
  return { localAppData, paths, manifest, receipt, verifierPath: fixtureVerifierPath, executableSha256: syntheticExecutableSha256 };
}

async function writeReceipt(fixture: PreparedFixture, receipt: Record<string, unknown>): Promise<void> {
  fixture.receipt = receipt;
  await writeFile(fixture.paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
}

async function writeManifest(
  fixture: PreparedFixture,
  manifest: Record<string, unknown>,
  updateReceiptHash = true,
): Promise<void> {
  fixture.manifest = manifest;
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(fixture.paths.manifest, bytes);
  if (updateReceiptHash) {
    await writeReceipt(fixture, { ...fixture.receipt, manifestSha256: sha256(bytes) });
  }
}

type RegistrationMode = 'ABSENT' | 'MATCH' | 'DRIFT';

async function runVerifier(
  fixture: PreparedFixture,
  mode: RegistrationMode,
  localAppData = fixture.localAppData,
) {
  const wrapper = [
    'function Get-ItemPropertyValue {',
    '  param([string] $LiteralPath, [string] $Name, $ErrorAction)',
    "  if ($LiteralPath -cne $env:WAG_EXPECTED_REGISTRY_PATH) { throw 'unexpected registry path' }",
    "  if ($Name -cne '(default)') { throw 'unexpected registry value name' }",
    "  if ($env:WAG_TEST_REGISTRATION_MODE -ceq 'ABSENT') { throw [System.Management.Automation.ItemNotFoundException]::new('absent') }",
    "  if ($env:WAG_TEST_REGISTRATION_MODE -ceq 'MATCH') { return $env:WAG_TEST_REGISTRATION_VALUE }",
    "  if ($env:WAG_TEST_REGISTRATION_MODE -ceq 'DRIFT') { return 'C:\\Other\\native-host.json' }",
    "  throw 'unknown registration test mode'",
    '}',
    '& $env:WAG_VERIFIER -ReceiptPath $env:WAG_RECEIPT',
  ].join('\n');
  return execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', wrapper], {
    cwd: process.cwd(),
    timeout: 15_000,
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      WAG_EXPECTED_REGISTRY_PATH: expectedRegistryPath,
      WAG_TEST_REGISTRATION_MODE: mode,
      WAG_TEST_REGISTRATION_VALUE: fixture.paths.manifest,
      WAG_VERIFIER: fixture.verifierPath,
      WAG_RECEIPT: fixture.paths.receipt,
    },
  });
}

async function expectVerifierFailure(
  fixture: PreparedFixture,
  mode: RegistrationMode = 'ABSENT',
  localAppData = fixture.localAppData,
): Promise<void> {
  await assert.rejects(
    () => runVerifier(fixture, mode, localAppData),
    (error: unknown) => {
      const failure = error as { stderr?: string };
      assert.equal(failure.stderr?.trim(), 'wag-native-host-installation-verify: failed');
      return true;
    },
  );
}

test('classifies only the exact receipt-owned registration value as MATCH', () => {
  const receipt = validReceipt();
  assert.equal(classifyNativeHostRegistration(null, receipt), 'ABSENT');
  assert.equal(classifyNativeHostRegistration(undefined, receipt), 'ABSENT');
  assert.equal(classifyNativeHostRegistration(receipt.manifestPath, receipt), 'MATCH');
  assert.equal(classifyNativeHostRegistration(receipt.manifestPath.toUpperCase(), receipt), 'DRIFT');
  assert.equal(classifyNativeHostRegistration(`${receipt.manifestPath} `, receipt), 'DRIFT');
  assert.equal(classifyNativeHostRegistration('C:\\Other\\com.openai.web_agent_gateway.json', receipt), 'DRIFT');
});

test('cleanup decisions fail closed on registration or owned-file drift', () => {
  const receipt = validReceipt();
  assert.equal(decideNativeHostOwnedCleanup(null, receipt, true), 'FILES_ONLY');
  assert.equal(decideNativeHostOwnedCleanup(receipt.manifestPath, receipt, true), 'REGISTRATION_THEN_FILES');
  assert.equal(
    decideNativeHostOwnedCleanup('C:\\Other\\com.openai.web_agent_gateway.json', receipt, true),
    'BLOCK_DRIFT',
  );
  assert.equal(decideNativeHostOwnedCleanup(null, receipt, false), 'BLOCK_DRIFT');
  assert.equal(decideNativeHostOwnedCleanup(receipt.manifestPath, receipt, false), 'BLOCK_DRIFT');
});

test('committed verifier stays pinned to the historical accepted distribution identity', async () => {
  const source = await readFile(verifierPath, 'utf8');
  const sourcePin = `$expectedSourceSha = '${NATIVE_HOST_ACCEPTED_SOURCE_SHA}'`;
  const executablePin = `$expectedExecutableSha256 = '${NATIVE_HOST_ACCEPTED_EXECUTABLE_SHA256}'`;
  assert.equal(source.split(sourcePin).length - 1, 1);
  assert.equal(source.split(executablePin).length - 1, 1);
});

test('PowerShell verifier AST stays inside the positive read-only capability allowlist', {
  skip: process.platform !== 'win32' ? 'Windows-only PowerShell AST audit' : false,
}, async () => {
  const astProbe = [
    '$tokens = $null; $errors = $null',
    '$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:WAG_VERIFIER, [ref]$tokens, [ref]$errors)',
    "$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $name = $_.GetCommandName(); if ($null -eq $name) { '<dynamic>' } else { $name } })",
    "$members = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { [string]$_.Member.Value })",
    '[ordered]@{ parseErrors = @($errors).Count; commands = $commands; members = $members } | ConvertTo-Json -Compress -Depth 4',
  ].join('; ');
  const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', astProbe], {
    env: { ...process.env, WAG_VERIFIER: verifierPath },
  });
  const parsed = JSON.parse(result.stdout) as { parseErrors: number; commands: string[]; members: string[] };
  assert.equal(parsed.parseErrors, 0);
  const allowedCommands = new Set([
    'Assert-CanonicalTimestamp', 'Assert-ExactInt', 'Assert-ExactProperties', 'Assert-ExactString',
    'Assert-JsonObject', 'Assert-OwnedDirectory', 'ConvertFrom-Json', 'ConvertTo-Json', 'Get-FileHash',
    'Get-Item', 'Get-ItemPropertyValue', 'Get-LowercaseSha256', 'Resolve-OwnedFile', 'Resolve-Path',
    'Set-StrictMode', 'Sort-Object',
  ]);
  for (const command of parsed.commands) {
    assert.ok(allowedCommands.has(command), `unexpected PowerShell command capability: ${command}`);
  }
  assert.deepEqual([...new Set(parsed.commands)].sort(), [...allowedCommands].sort());
  const allowedMembers = new Set([
    'Combine', 'Equals', 'GetFullPath', 'ReadAllText', 'ToLowerInvariant', 'TryParseExact', 'WriteLine',
  ]);
  for (const member of parsed.members) {
    assert.ok(allowedMembers.has(member), `unexpected PowerShell member-call capability: ${member}`);
  }
  assert.deepEqual([...new Set(parsed.members)].sort(), [...allowedMembers].sort());
});

test('Windows verifier rejects a valid prepared installation under a 32-bit PowerShell process', {
  skip: process.platform !== 'win32' ? 'Windows-only 32-bit verifier gate' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  const control = await runVerifier(fixture, 'ABSENT');
  assert.equal(JSON.parse(control.stdout).registration, 'ABSENT');

  const powershell32 = join(
    process.env.WINDIR ?? 'C:\\Windows',
    'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
  );
  await assert.rejects(
    () => execFileAsync(powershell32, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', fixture.verifierPath,
      '-ReceiptPath', fixture.paths.receipt,
    ], { env: { ...process.env, LOCALAPPDATA: fixture.localAppData } }),
    (error: unknown) => {
      const failure = error as { stderr?: string };
      assert.equal(failure.stderr?.trim(), 'wag-native-host-installation-verify: failed');
      return true;
    },
  );
});

test('Windows verifier reports hermetic ABSENT, MATCH, and DRIFT classifications', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  for (const mode of ['ABSENT', 'MATCH', 'DRIFT'] as const) {
    const result = await runVerifier(fixture, mode);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.trim().split(/\r?\n/).length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      sourceSha: NATIVE_HOST_ACCEPTED_SOURCE_SHA,
      executableSha256: fixture.executableSha256,
      manifestSha256: fixture.receipt.manifestSha256,
      registration: mode,
    });
    assert.doesNotMatch(result.stdout, new RegExp(fixture.localAppData.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('Windows verifier rejects non-canonical receipt scalar types and timestamps', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  const original = { ...fixture.receipt };
  const invalidCases: Array<[string, Record<string, unknown>]> = [
    ['string schema version', { ...original, schemaVersion: '1' }],
    ['string run attempt', { ...original, runAttempt: '1' }],
    ['impossible timestamp', { ...original, preparedAt: '2026-99-99T99:99:99.999Z' }],
  ];
  for (const [label, receipt] of invalidCases) {
    await writeReceipt(fixture, receipt);
    await expectVerifierFailure(fixture).catch((error) => {
      throw new Error(`${label}: ${String(error)}`);
    });
  }
});

test('Windows verifier requires allowed_origins to remain an actual one-element JSON array', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  const origins = fixture.manifest.allowed_origins as unknown[];
  await writeManifest(fixture, { ...fixture.manifest, allowed_origins: origins[0] });
  await expectVerifierFailure(fixture);
});

test('Windows verifier binds the receipt to the process LOCALAPPDATA installation root', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  const differentLocalAppData = await mkdtemp(join(tmpdir(), 'wag-native-install-other-localapp-'));
  t.after(() => rm(differentLocalAppData, { recursive: true, force: true }));
  await expectVerifierFailure(fixture, 'ABSENT', differentLocalAppData);
});

test('Windows verifier rejects an installation rooted through a junction', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const localAppData = await mkdtemp(join(tmpdir(), 'wag-native-install-junction-localapp-'));
  const outsideApplicationRoot = await mkdtemp(join(tmpdir(), 'wag-native-install-junction-target-'));
  t.after(() => rm(localAppData, { recursive: true, force: true }));
  t.after(() => rm(outsideApplicationRoot, { recursive: true, force: true }));
  await symlink(outsideApplicationRoot, join(localAppData, 'WebAgentGateway'), 'junction');
  const fixture = await createPreparedFixture(t, localAppData);
  await expectVerifierFailure(fixture);
});

test('Windows verifier fails closed on receipt-owned manifest hash drift', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  await writeFile(fixture.paths.manifest, `${JSON.stringify(fixture.manifest)}\n`, 'utf8');
  await expectVerifierFailure(fixture, 'MATCH');
});

test('Windows verifier fails closed on receipt-owned executable hash drift', {
  skip: process.platform !== 'win32' ? 'Windows-only verifier execution' : false,
  timeout: 180_000,
}, async (t) => {
  const fixture = await createPreparedFixture(t);
  await writeFile(fixture.paths.executable, 'tampered', 'utf8');
  await expectVerifierFailure(fixture, 'MATCH');
});
