import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { createLocalMachineContext } from '../src/local-machine-runtime.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

const SESSION = 'session_machine_test';
const ADAPTER = 'private.stdio.v1';
const OWNER = 'owner_machine_test';

async function fixture(t: test.TestContext, killSwitch = false) {
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
  const context = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => killSwitch,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { root, context };
}

test('local-machine opens directly under autonomous-local authority', async (t) => {
  const { root, context } = await fixture(t);
  const opened = await context.open(root) as {
    workspace_id: string;
    authority: { mode: string; kill_switch: string };
  };
  assert.match(opened.workspace_id, /^ws_/);
  assert.deepEqual(opened.authority, { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' });

  const described = await context.describe(opened.workspace_id) as {
    authority: { mode: string; kill_switch: string };
  };
  assert.deepEqual(described.authority, { mode: 'AUTONOMOUS_LOCAL', kill_switch: 'CLEAR' });
});

test('local-machine autonomous profile permits bounded read/list/argv execution and detached start', async (t) => {
  const { root, context } = await fixture(t);
  const opened = await context.open(root) as { workspace_id: string };

  const listed = await context.list(opened.workspace_id) as { entries: Array<{ name: string }> };
  assert.ok(listed.entries.some((entry) => entry.name === 'note.txt'));

  const read = await context.read(opened.workspace_id, 'note.txt') as {
    content: string;
    raw_sha256: string;
    redacted: boolean;
  };
  assert.match(read.content, /alpha/);
  assert.match(read.content, /secret=<REDACTED>/i);
  assert.match(read.raw_sha256, /^[a-f0-9]{64}$/);
  assert.equal(read.redacted, true);

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

test('detached process registry survives context reconstruction without persisting argv secrets', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-local-process-registry-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'authority.sqlite');
  const registryPath = join(dir, 'processes.json');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const callerContext = createGatewayCallerContext({
    ownerId: OWNER,
    sessionId: SESSION,
    adapterId: ADAPTER,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  const first = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => false,
    processRegistryPath: registryPath,
  });
  const opened = await first.open(root) as { workspace_id: string };
  const secretArgument = 'registry-secret-must-not-persist';
  const started = await first.processStart(
    opened.workspace_id,
    [process.execPath, '-e', `const secret=${JSON.stringify(secretArgument)}; setInterval(()=>void secret,1000)`],
  ) as { process_id: string; pid: number; registry_persisted: boolean };
  assert.equal(started.registry_persisted, true);

  const registry = await readFile(registryPath, 'utf8');
  assert.match(registry, new RegExp(started.process_id));
  assert.doesNotMatch(registry, new RegExp(secretArgument));

  const second = createLocalMachineContext({
    store,
    callerContext,
    workspaceIdentities: identities,
    killSwitch: () => false,
    processRegistryPath: registryPath,
  });
  const recovered = await second.processInspect(opened.workspace_id, started.process_id) as {
    found: boolean;
    owned?: boolean;
    process_id?: string;
    pid: number;
  };
  assert.equal(recovered.found, true);
  assert.equal(recovered.owned, true);
  assert.equal(recovered.process_id, started.process_id);
  assert.equal(recovered.pid, started.pid);

  if (process.platform === 'win32') {
    await new Promise<void>((resolvePromise) => {
      const child = spawn(
        'taskkill.exe', ['/PID', String(started.pid), '/T', '/F'], { stdio: 'ignore' },
      );
      child.once('exit', () => resolvePromise());
    });
  } else {
    process.kill(started.pid, 'SIGTERM');
  }
});

test('local-machine kill switch blocks effects but leaves caller-owned inspection available', async (t) => {
  const { root, context } = await fixture(t, true);
  const opened = await context.open(root) as { workspace_id: string };

  assert.match(
    (await context.read(opened.workspace_id, 'note.txt') as { content: string }).content,
    /alpha/,
  );
  await assert.rejects(
    () => context.commandRun(opened.workspace_id, [process.execPath, '--version']),
    /KILL_SWITCH_ENGAGED/,
  );
  await assert.rejects(
    () => context.processStart(opened.workspace_id, [process.execPath, '--version']),
    /KILL_SWITCH_ENGAGED/,
  );
});

test('local-machine workspace ownership prevents a second session from inheriting the handle', async (t) => {
  const { root, context } = await fixture(t);
  const opened = await context.open(root) as { workspace_id: string };

  const dir = await mkdtemp(join(tmpdir(), 'wag-local-machine-other-'));
  const statePath = join(dir, 'authority.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const other = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: OWNER,
      sessionId: 'session_machine_other',
      adapterId: ADAPTER,
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(() => other.read(opened.workspace_id, 'note.txt'), /workspace/);
});
