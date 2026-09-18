import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseNativeHostSignatureInspection } from '../src/browser-adapter/native-host-candidate.js';

const root = process.cwd();
const inspectorPath = join(root, 'scripts', 'inspect-native-host-signature.ps1');
const failureSentinel = 'wag-native-host-signature-inspect: failed';

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(command: string, args: string[], cwd = root): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function invokeInspector(executablePath: string, expectedState: string): Promise<RunResult> {
  return run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-File', inspectorPath,
    '-ExecutablePath', executablePath,
    '-ExpectedState', expectedState,
  ]);
}

async function buildUnsignedNativeHost(outputDir: string): Promise<string> {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const result = await run(process.execPath, [
    tsxCli,
    'scripts/build-native-host.ts',
    '--output', outputDir,
  ]);
  assert.equal(result.code, 0, result.stderr);
  return join(outputDir, 'wag-native-host.exe');
}

type AstProbe = {
  commands: string[];
  members: Array<{ member: string; expression: string; arguments: string[] }>;
  parseErrors: number;
};
async function inspectAst(): Promise<AstProbe> {
  const quoted = inspectorPath.replaceAll("'", "''");
  const command = [
    '$tokens=$null;$errors=$null;',
    `$ast=[System.Management.Automation.Language.Parser]::ParseFile('${quoted}',[ref]$tokens,[ref]$errors);`,
    '$commands=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.CommandAst]},$true) | ForEach-Object {$_.GetCommandName()});',
    '$members=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst]},$true) | ForEach-Object {',
    '  $m=$_;',
    '  [pscustomobject]@{member=$m.Member.Value;expression=$m.Expression.Extent.Text;arguments=@($m.Arguments | ForEach-Object {$_.Extent.Text})}',
    '});',
    '[pscustomobject]@{commands=$commands;members=$members;parseErrors=$errors.Count} | ConvertTo-Json -Compress -Depth 6',
  ].join(' ');
  const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout) as AstProbe;
}

function parseSuccess(result: RunResult) {
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, 'success must emit one compact JSON object');
  return parseNativeHostSignatureInspection(JSON.parse(lines[0]!));
}

function assertBoundedFailure(result: RunResult): void {
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, failureSentinel);
}
test('native host signature inspector PowerShell AST is read-only and narrowly allowlisted', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode inspector');
  await readFile(inspectorPath, 'utf8');
  const ast = await inspectAst();
  assert.equal(ast.parseErrors, 0);

  const commands = [...new Set(ast.commands)].sort();
  assert.deepEqual(commands, [
    'ConvertTo-Json',
    'Get-AppLockerFileInformation',
    'Get-AuthenticodeSignature',
    'Get-Item',
    'Resolve-Path',
    'Set-StrictMode',
  ]);

  const allowedMembers = new Set(['Equals', 'GetFullPath', 'ToLowerInvariant', 'Write']);
  assert.ok(ast.members.length > 0);
  for (const member of ast.members) {
    assert.equal(allowedMembers.has(member.member), true, `unexpected member invocation: ${member.member}`);
    if (member.member === 'Write') {
      assert.equal(member.expression, '[System.Console]::Error');
      assert.deepEqual(member.arguments, [`'${failureSentinel}'`]);
    }
  }
  assert.deepEqual([...new Set(ast.members.map((member) => member.member))].sort(), [
    'Equals', 'GetFullPath', 'ToLowerInvariant', 'Write',
  ]);
});
test('inspector accepts a real unsigned WAG SEA only as Unsigned', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode inspector');
  const temp = await mkdtemp(join(root, '.wag-native-host-signature-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const executable = await buildUnsignedNativeHost(join(temp, 'unsigned-wag'));

  const unsigned = parseSuccess(await invokeInspector(executable, 'Unsigned'));
  assert.equal(unsigned.status, 'NotSigned');
  assert.deepEqual(Object.keys(unsigned).sort(), ['authenticodeSha256', 'status']);
  assert.match(unsigned.authenticodeSha256, /^[0-9a-f]{64}$/);

  assertBoundedFailure(await invokeInspector(executable, 'Valid'));
});

test('inspector accepts trusted signed Notepad only as Valid', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode inspector');
  const executable = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const valid = parseSuccess(await invokeInspector(executable, 'Valid'));
  assert.equal(valid.status, 'Valid');
  assert.equal(valid.publicKeyAlgorithmOid, '1.2.840.113549.1.1.1');
  assert.equal(valid.codeSigningEkuOid, '1.3.6.1.5.5.7.3.3');
  assert.match(valid.signerThumbprint, /^[0-9a-f]{40}$/);
  assert.match(valid.authenticodeSha256, /^[0-9a-f]{64}$/);
  if (valid.timestamp) assert.match(valid.timestamp.signerThumbprint, /^[0-9a-f]{40}$/);

  assertBoundedFailure(await invokeInspector(executable, 'Unsigned'));
});
test('inspector fails closed with one fixed sentinel for invalid inputs', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows Authenticode inspector');
  const notepad = join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const missing = join(tmpdir(), 'wag-native-host-signature-missing.exe');

  assertBoundedFailure(await invokeInspector('relative.exe', 'Valid'));
  assertBoundedFailure(await invokeInspector(missing, 'Valid'));
  assertBoundedFailure(await invokeInspector(notepad, 'Other'));
  assertBoundedFailure(await invokeInspector(join(process.env.WINDIR ?? 'C:\\Windows', 'System32'), 'Valid'));
});
