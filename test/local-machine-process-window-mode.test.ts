import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { createLocalMachineContext } from '../src/local-machine-runtime.js';
import { WorkspaceIdentityRegistry } from '../src/workspace-identity.js';

test('machine process start preserves hidden default and accepts explicit normal GUI window mode', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-window-mode-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_window_mode',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const opened = await context.open(root) as { workspace_id: string };

  const hidden = await context.processStart(opened.workspace_id, [
    process.execPath, '-e', 'setTimeout(()=>{},5000)',
  ]) as { process_id: string; window_mode: string };
  assert.equal(hidden.window_mode, 'hidden');
  await context.processTerminate(opened.workspace_id, hidden.process_id);

  const normal = await context.processStart(opened.workspace_id, [
    process.execPath, '-e', 'setTimeout(()=>{},5000)',
  ], { windowMode: 'normal' }) as { process_id: string; window_mode: string };
  assert.equal(normal.window_mode, 'normal');
  await context.processTerminate(opened.workspace_id, normal.process_id);
});

test('machine process spawn failure is contained and the runtime remains usable', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-spawn-failure-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_spawn_failure',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const opened = await context.open(root) as { workspace_id: string };

  await assert.rejects(
    () => context.processStart(opened.workspace_id, ['wag-definitely-missing-executable-20260926.exe']),
    /process did not start/,
  );

  const healthy = await context.processStart(opened.workspace_id, [
    process.execPath, '-e', 'setTimeout(()=>{},5000)',
  ]) as { process_id: string };
  await context.processTerminate(opened.workspace_id, healthy.process_id);
});


test('normal Windows GUI process stays alive for DesktopPort ownership', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-normal-gui-'));
  const root = await realpath(dir);
  const statePath = join(dir, 'state.sqlite');
  const scriptPath = join(dir, 'fixture.ps1');
  await writeFile(scriptPath, [
    "$ErrorActionPreference='Stop'",
    'Add-Type -AssemblyName System.Windows.Forms',
    '$form = New-Object System.Windows.Forms.Form',
    "$form.Text = 'WAG Process Window Regression'",
    '$form.ShowInTaskbar = $false',
    '$form.Opacity = 0',
    '[System.Windows.Forms.Application]::Run($form)',
  ].join('\n'), 'utf8');

  const store = new SqliteDurableStore(statePath);
  const identities = new WorkspaceIdentityRegistry(statePath);
  const context = createLocalMachineContext({
    store,
    callerContext: createGatewayCallerContext({
      ownerId: 'local.private.stdio',
      sessionId: 'session_normal_gui',
      adapterId: 'private.stdio.v1',
    }),
    workspaceIdentities: identities,
    killSwitch: () => false,
  });
  t.after(async () => {
    identities.close();
    store.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const opened = await context.open(root) as { workspace_id: string };
  const started = await context.processStart(opened.workspace_id, [
    'powershell.exe', '-NoLogo', '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
  ], { windowMode: 'normal' }) as { process_id: string; window_mode: string };
  assert.equal(started.window_mode, 'normal');

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const inspected = await context.processInspect(opened.workspace_id, started.process_id) as {
    found?: boolean;
    owned?: boolean;
    state?: string;
  };
  assert.equal(inspected.found, true);
  assert.equal(inspected.owned, true);
  assert.equal(inspected.state, 'RUNNING');
  await context.processTerminate(opened.workspace_id, started.process_id);
});
