import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  createLocalMachineContext,
} from '../src/local-machine-runtime.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

const SESSION = 'session_machine_test';
const ADAPTER = 'private.stdio.v1';
const OWNER = 'owner_machine_test';

async function fixture(t: test.TestContext, withLease: boolean) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-machine-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'authority.sqlite');
  await writeFile(join(root, 'note.txt'), 'alpha\nsecret=visible-non-sensitive\n', 'utf8');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const callerContext = createGatewayCallerContext({
    ownerId: OWNER,
    sessionId: SESSION,
    adapterId: ADAPTER,
  });
  if (withLease) {
    const now = Date.now();
    store.insertGoalLease({
      leaseId: 'lease_machine_test',
      createdAt: now,
      notBefore: now - 1_000,
      expiresAt: now + 60_000,
      bindings: JSON.stringify({
        workspaceRoots: [root],
        allowedTools: [
          'machine.open',
          'machine.list',
          'machine.read',
          'machine.command.run',
          'machine.process.start',
          'mutation.preview'
        ],
        pathPatterns: ['**'],
        maxFiles: 8,
        maxBytes: 128 * 1024,
        maxDiffBytes: 64 * 1024,
        admittedSessions: [SESSION],
        admittedAdapters: [ADAPTER],
        commitSemantics: 'none',
      }),
    });
  }
  const context = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => false,
    gatewayRoot: resolve(root, '..', 'not-the-running-gateway'),
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { root, context };
}

test('local-machine open is fail-closed without a matching Goal Lease', async (t) => {
  const { root, context } = await fixture(t, false);
  await assert.rejects(() => context.open(root), /NO_LEASE/);
});

test('local-machine lease authorizes bounded read/list/argv execution and detached start', async (t) => {
  const { root, context } = await fixture(t, true);
  const opened = await context.open(root) as { workspace_id: string; lease_id: string };
  assert.match(opened.workspace_id, /^ws_/);
  assert.equal(opened.lease_id, 'lease_machine_test');

  const listed = await context.list(opened.workspace_id) as { entries: Array<{ name: string }> };
  assert.ok(listed.entries.some((entry) => entry.name === 'note.txt'));

  const read = await context.read(opened.workspace_id, 'note.txt') as {
    content: string;
    raw_sha256: string;
    redacted: boolean;
  };
  assert.match(read.content, /alpha/);
  assert.match(read.raw_sha256, /^[a-f0-9]{64}$/);
  assert.equal(read.redacted, false);

  const command = await context.commandRun(
    opened.workspace_id,
    [process.execPath, '-e', 'process.stdout.write("machine-ok")'],
  ) as { exitCode: number; output: string; timedOut: boolean };
  assert.equal(command.exitCode, 0);
  assert.equal(command.output, 'machine-ok');
  assert.equal(command.timedOut, false);

  const marker = join(root, 'background.txt');
  const started = await context.processStart(
    opened.workspace_id,
    [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], "started\\n")',
      marker,
    ],
  ) as { pid: number; started: boolean };
  assert.equal(started.started, true);
  assert.ok(started.pid > 0);

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(marker);
      break;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
  }
  assert.equal(await readFile(marker, 'utf8'), 'started\n');
});

test('local-machine workspace ownership prevents a second session from inheriting the handle', async (t) => {
  const { root, context } = await fixture(t, true);
  const opened = await context.open(root) as { workspace_id: string };

  const dir = await mkdtemp(join(tmpdir(), 'wag-local-machine-other-'));
  const store = new SqliteDurableStore(join(dir, 'authority.sqlite'));
  const identities = new WorkspaceIdentityRegistry(join(dir, 'authority.sqlite'));
  const other = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: OWNER,
      sessionId: 'session_machine_other',
      adapterId: ADAPTER,
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
    gatewayRoot: resolve(root, '..', 'not-the-running-gateway'),
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(() => other.read(opened.workspace_id, 'note.txt'), /workspace/);
});
