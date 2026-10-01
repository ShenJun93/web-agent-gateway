import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import type { DevspaceExecutor, ExecResult } from '../src/executor/devspace.js';
import { createGateway } from '../src/server.js';
import { resolveVerifyProfile } from '../src/verify-profile.js';

function decodePayload(command: string): {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  executionRoot?: string;
  treeKillAfterMs: number;
} {
  const encoded = command.slice(command.indexOf('" ') + 2).split(' ')[1];
  assert.ok(encoded, 'runner payload must exist');
  return JSON.parse(gunzipSync(Buffer.from(encoded, 'base64url')).toString('utf8'));
}

function encodedRunnerAndPayload(command: string): { runner: string; payload: string } {
  const parts = command.slice(command.indexOf('" ') + 2).split(' ');
  assert.equal(parts.length, 2);
  return { runner: parts[0]!, payload: parts[1]! };
}

function stubExecutor(calls: Array<{ workspaceId: string; command: string }>): DevspaceExecutor {
  return {
    openWorkspace: async (root: string) => `devspace_${createHash('sha256').update(root).digest('hex').slice(0, 12)}`,
    execCommand: async (workspaceId: string, command: string) => {
      calls.push({ workspaceId, command });
      return { output: 'ok\n', exitCode: 0, running: false } satisfies ExecResult;
    },
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
}

test('command.run binds runner executionRoot to the exact canonical workspace, including relative cwd', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'wag-command-root-'));
  const root = await realpath(base);
  await mkdir(join(root, 'src'));
  t.after(() => rm(base, { recursive: true, force: true }));

  const calls: Array<{ workspaceId: string; command: string }> = [];
  const gateway = createGateway({
    executor: stubExecutor(calls),
    allowedRoots: [root],
  });
  const { workspaceId } = await gateway.openWorkspace(root);

  await gateway.commandRun(workspaceId, ['node', '--version']);
  await gateway.commandRun(workspaceId, ['node', '--version'], { cwd: 'src' });

  assert.equal(calls.length, 2);
  const first = decodePayload(calls[0]!.command);
  assert.equal(first.cwd, '.');
  assert.equal(first.executionRoot, root);

  const nested = decodePayload(calls[1]!.command);
  assert.equal(nested.cwd, 'src');
  assert.equal(nested.executionRoot, root);

  assert.equal(calls[0]!.command.includes(root), false, 'canonical root must travel as encoded data, never shell syntax');
});

test('verify profiles without an executionRoot preserve the legacy plan hash and payload shape', () => {
  const resolved = resolveVerifyProfile({ argv: ['node', 'verify.mjs'] });
  const legacyCanonical = JSON.stringify({
    argv: ['node', 'verify.mjs'],
    cwd: '.',
    timeoutMs: 10_000,
    maxOutputTokens: 4_000,
    env: [],
    resumeQueuedAfterRestart: false,
  });
  assert.equal(
    resolved.planSha256,
    createHash('sha256').update(legacyCanonical, 'utf8').digest('hex'),
  );
  assert.equal(resolved.executionRoot, undefined);
  assert.equal('executionRoot' in decodePayload(resolved.command), false);
});

test('argv runner resolves dot cwd against trusted executionRoot rather than its own process cwd', async (t) => {
  const outer = await mkdtemp(join(tmpdir(), 'wag-runner-anchor-'));
  const target = join(outer, 'target');
  const launcherCwd = join(outer, 'launcher');
  await mkdir(target);
  await mkdir(launcherCwd);
  const canonicalTarget = await realpath(target);
  t.after(() => rm(outer, { recursive: true, force: true }));

  await writeFile(join(target, 'probe.js'), [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync('cwd.txt', process.cwd(), 'utf8');",
  ].join('\n'));

  const resolved = resolveVerifyProfile(
    { argv: ['node', 'probe.js'], timeoutMs: 2_000 },
    '.',
    canonicalTarget,
  );
  const encoded = encodedRunnerAndPayload(resolved.command);
  const runnerPath = join(outer, 'runner.js');
  await writeFile(
    runnerPath,
    gunzipSync(Buffer.from(encoded.runner, 'base64url')).toString('utf8'),
    'utf8',
  );

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [runnerPath, encoded.payload], {
      cwd: launcherCwd,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => resolvePromise(code ?? -1));
  });

  assert.equal(exitCode, 0);
  const observedCwd = (await readFile(join(target, 'cwd.txt'), 'utf8')).trim();
  assert.equal(await realpath(observedCwd), canonicalTarget);
});
