import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFile = promisify(execFileCb);
const root = process.cwd();

test('record CLI failure is bounded and never echoes local paths', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-candidate-error-output-'));
  try {
    const repoDir = join(temp, 'repo');
    await mkdir(repoDir, { recursive: true });
    await copyFile(join(root, 'package-lock.json'), join(repoDir, 'package-lock.json'));
    await execFile('git', ['init'], { cwd: repoDir });
    await execFile('git', ['config', 'user.email', 'candidate-test@example.invalid'], { cwd: repoDir });
    await execFile('git', ['config', 'user.name', 'Candidate Test'], { cwd: repoDir });
    await execFile('git', ['add', 'package-lock.json'], { cwd: repoDir });
    await execFile('git', ['commit', '-m', 'fixture'], { cwd: repoDir });
    const head = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: repoDir })).stdout.trim();
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const recorder = join(root, 'scripts', 'record-native-host-unsigned-candidate.ts');
    const missingBuild = join(temp, 'secret-local-build-path');
    const output = join(temp, 'receipt.json');
    const child = spawn(process.execPath, [tsxCli, recorder, '--build-dir', missingBuild, '--source-sha', head, '--repository', 'owner/repo', '--output', output], {
      cwd: repoDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (c) => stdout.push(Buffer.from(c)));
    child.stderr.on('data', (c) => stderr.push(Buffer.from(c)));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(code, 1);
    assert.equal(Buffer.concat(stdout).toString('utf8'), '');
    assert.equal(Buffer.concat(stderr).toString('utf8'), 'wag-native-host-candidate-record: failed\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
