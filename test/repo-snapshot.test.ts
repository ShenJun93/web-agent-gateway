import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createGateway } from '../src/server.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import type { ExecResult } from '../src/executor/devspace.js';
import { DevspaceRepositoryInspectionBackend } from '../src/repository-inspection.js';
import { startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);

test('repo.snapshot aggregates git state and deterministically prunes file output', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) await writeFile(join(fixture.workspaceRoot, name), `${name}\n`);
  await git(fixture.workspaceRoot, ['init']);
  await git(fixture.workspaceRoot, ['config', 'user.email', 'gateway@example.test']);
  await git(fixture.workspaceRoot, ['config', 'user.name', 'Gateway Test']);
  await git(fixture.workspaceRoot, ['add', '.']);
  await git(fixture.workspaceRoot, ['commit', '-m', 'fixture']);
  await writeFile(join(fixture.workspaceRoot, 'b.txt'), 'modified\n');

  const gateway = createGateway({ executor: new DevspaceExecutor({ baseUrl: fixture.baseUrl, accessToken: fixture.accessToken }), allowedRoots: [fixture.workspaceRoot] });
  const { workspaceId } = await gateway.openWorkspace(fixture.workspaceRoot);
  const snapshot = await gateway.repoSnapshot(workspaceId, { maxFiles: 2 });

  assert.equal(snapshot.files.length, 2);
  assert.deepEqual(snapshot.files, ['a.txt', 'b.txt']);
  assert.equal(snapshot.filesTruncated, true);
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.head, /^[a-f0-9]{40}$/);
  assert.equal(JSON.stringify(snapshot).includes(fixture.workspaceRoot), false);
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd });
}

// ---------------------------------------------------------------------------
// Stub-based regression tests — no live DevSpace required.
// These prove snapshot delegation preserves parse/error/default execution
// semantics after the backend move to DevspaceRepositoryInspectionBackend.
// ---------------------------------------------------------------------------

function makeStubExecutor(result: ExecResult) {
  return {
    execCommand: async (_wsId: string, _cmd: string, _maxTokens?: number, _yieldMs?: number) => result,
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
}

// Minimal valid snapshot output (markers present, short file list).
const VALID_SNAPSHOT_OUTPUT =
  '## main...origin/main\n__WAG_HEAD__\nabc1234abc1234abc1234abc1234abc1234abc1234\n__WAG_DIFF__\n__WAG_FILES__\nfile.ts\n';

test('repo.snapshot - markers missing propagates parse error (not Gateway search failed)', async () => {
  const executor = makeStubExecutor({ output: 'no markers here at all', exitCode: 0, running: false });
  const backend = new DevspaceRepositoryInspectionBackend(executor);
  await assert.rejects(
    () => backend.snapshot('ws'),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected Error');
      assert.equal(err.message, 'repo.snapshot markers missing from executor output');
      return true;
    },
    'markers missing must propagate as snapshot-specific error, not Gateway search failed',
  );
});

test('repo.snapshot - 64 KiB size limit throws snapshot-specific error', async () => {
  // Put 70 KiB of content in diffStat (between __WAG_DIFF__ and __WAG_FILES__).
  // diffStat is NOT subject to maxFiles pruning, so the serialized result always
  // exceeds 64 KiB regardless of how many files are sliced off.
  const hugeDiffStat = 'x'.repeat(72 * 1024); // 72 KiB of diffStat content
  const oversizedOutput = `## main\n__WAG_HEAD__\nabc1234abc1234abc1234abc1234abc1234abc1234\n__WAG_DIFF__\n${hugeDiffStat}\n__WAG_FILES__\nfile.ts\n`;
  const executor = makeStubExecutor({ output: oversizedOutput, exitCode: 0, running: false });
  const backend = new DevspaceRepositoryInspectionBackend(executor);
  await assert.rejects(
    () => backend.snapshot('ws', { maxFiles: 500 }),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected Error');
      assert.equal(err.message, 'repo.snapshot result exceeded 64 KiB size limit');
      return true;
    },
    'oversized diffStat must trigger snapshot-specific size error, not Gateway search failed',
  );
});

test('repo.snapshot - command still running throws snapshot-specific error', async () => {
  const executor = makeStubExecutor({ output: '', exitCode: undefined, running: true, sessionId: undefined });
  const backend = new DevspaceRepositoryInspectionBackend(executor);
  await assert.rejects(
    () => backend.snapshot('ws'),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected Error');
      assert.equal(err.message, 'repo.snapshot command unexpectedly remained running');
      return true;
    },
    'running command must throw snapshot-specific running error',
  );
});

test('repo.snapshot - non-zero exit code throws snapshot-specific error', async () => {
  const executor = makeStubExecutor({ output: '', exitCode: 128, running: false });
  const backend = new DevspaceRepositoryInspectionBackend(executor);
  await assert.rejects(
    () => backend.snapshot('ws'),
    (err: unknown) => {
      assert.ok(err instanceof Error, 'expected Error');
      assert.match(err.message, /repo\.snapshot command failed with exit code 128/);
      return true;
    },
    'non-zero exit must throw snapshot-specific exit-code error',
  );
});

test('repo.snapshot - default execution uses 30 000 ms yieldTimeMs (not hardcoded 5000)', async () => {
  // The stub captures the yieldMs argument passed to execCommand.
  let capturedYieldMs: number | undefined = -1 as unknown as number;
  const captureExecutor = {
    execCommand: async (_wsId: string, _cmd: string, _maxTokens?: number, yieldMs?: number) => {
      capturedYieldMs = yieldMs;
      return { output: VALID_SNAPSHOT_OUTPUT, exitCode: 0, running: false } as ExecResult;
    },
    interruptCommand: async () => {},
  } as unknown as DevspaceExecutor;
  const backend = new DevspaceRepositoryInspectionBackend(captureExecutor);
  await backend.snapshot('ws');
  // When the fourth argument is omitted the DevspaceExecutor default is 30_000.
  // The backend must not pass 5000 (the incorrect hardcoded value from Task 1).
  assert.equal(capturedYieldMs, undefined,
    'snapshot() must omit yieldTimeMs so DevspaceExecutor uses its 30 000 ms default, not 5000');
});
