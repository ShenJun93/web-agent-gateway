import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createDesktopPort,
  type DesktopBackend,
  type DesktopBackendSession,
  type DesktopTargetIdentity,
  type DesktopTargetResolver,
} from '../src/desktop-harness/desktop-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_desktop',
  sessionId: 'session_desktop',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_desktop',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};

function target(overrides: Partial<DesktopTargetIdentity> = {}): DesktopTargetIdentity {
  return {
    targetId: 'target_editor',
    pid: 5100,
    processInstanceId: 'created:5100:100',
    executablePath: 'C:\\Program Files\\Editor\\editor.exe',
    nativeWindowId: 'hwnd:000000000001A2B3',
    title: 'Editor',
    ...overrides,
  };
}

function fixture() {
  let current = target();
  let effectsAllowed = true;
  const calls: Array<{ kind: string; id?: string; value?: string }> = [];
  const resolver: DesktopTargetResolver = {
    async resolve(owner, targetId) {
      if (owner.sessionId !== OWNER.sessionId) throw new Error('target not owned');
      if (targetId !== current.targetId) throw new Error('target not found');
      return current;
    },
  };
  let closed = false;
  const backendSession: DesktopBackendSession = {
    async snapshot() {
      return [
        {
          backendElementId: 'uia:button:save',
          role: 'button',
          name: 'Save',
          enabled: true,
          patterns: ['Invoke'],
        },
        {
          backendElementId: 'uia:text:name',
          role: 'edit',
          name: 'Name',
          value: 'alpha',
          enabled: true,
          patterns: ['Value'],
        },
        {
          backendElementId: 'uia:check:enabled',
          role: 'checkBox',
          name: 'Enabled',
          enabled: true,
          patterns: ['Toggle'],
        },
        {
          backendElementId: 'uia:item:one',
          role: 'listItem',
          name: 'One',
          enabled: true,
          patterns: ['SelectionItem'],
        },
        {
          backendElementId: 'uia:button:disabled',
          role: 'button',
          name: 'Disabled',
          enabled: false,
          patterns: ['Invoke'],
        },
      ];
    },
    async invoke(id) { calls.push({ kind: 'invoke', id }); },
    async setValue(id, value) { calls.push({ kind: 'setValue', id, value }); },
    async toggle(id) { calls.push({ kind: 'toggle', id }); },
    async select(id) { calls.push({ kind: 'select', id }); },
    async screenshot() { return { mimeType: 'image/png', dataBase64: 'UE5H' }; },
    async close() { closed = true; calls.push({ kind: 'close' }); },
  };
  const backend: DesktopBackend = {
    async open(opened) {
      assert.equal(opened.targetId, current.targetId);
      calls.push({ kind: 'open' });
      return backendSession;
    },
  };
  let n = 1;
  const port = createDesktopPort({
    resolver,
    backend,
    effectAllowed: () => effectsAllowed,
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });
  return {
    port,
    calls,
    closed: () => closed,
    setTarget(next: DesktopTargetIdentity) { current = next; },
    setEffectsAllowed(value: boolean) { effectsAllowed = value; },
  };
}

test('DesktopPort owns an exact target/session and blocks foreign authority or duplicate active ownership', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');
  assert.equal(opened.desktopSessionId, 'desktop_00000000-0000-4000-8000-000000000001');
  assert.equal(opened.state, 'ACTIVE');
  assert.equal(opened.target.pid, 5100);

  await assert.rejects(() => f.port.open(OWNER, 'target_editor'), /already has an active session/);
  await assert.rejects(() => f.port.describe(OTHER, opened.desktopSessionId), /another authority/);
  await assert.rejects(() => f.port.close(OTHER, opened.desktopSessionId), /another authority/);
  assert.equal(f.closed(), false);
});

test('DesktopPort uses semantic control patterns and invalidates refs before each effect', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');

  let snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const save = snap.nodes.find((node) => node.name === 'Save')!;
  await f.port.invoke(OWNER, opened.desktopSessionId, save.ref);
  assert.deepEqual(f.calls.at(-1), { kind: 'invoke', id: 'uia:button:save' });
  await assert.rejects(
    () => f.port.invoke(OWNER, opened.desktopSessionId, save.ref),
    /stale or unknown/,
  );

  snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const name = snap.nodes.find((node) => node.name === 'Name')!;
  await f.port.setValue(OWNER, opened.desktopSessionId, name.ref, 'beta');
  assert.deepEqual(f.calls.at(-1), { kind: 'setValue', id: 'uia:text:name', value: 'beta' });

  snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const enabled = snap.nodes.find((node) => node.name === 'Enabled')!;
  await f.port.toggle(OWNER, opened.desktopSessionId, enabled.ref);
  assert.deepEqual(f.calls.at(-1), { kind: 'toggle', id: 'uia:check:enabled' });

  snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const one = snap.nodes.find((node) => node.name === 'One')!;
  await f.port.select(OWNER, opened.desktopSessionId, one.ref);
  assert.deepEqual(f.calls.at(-1), { kind: 'select', id: 'uia:item:one' });
});

test('DesktopPort denies unsupported or disabled control patterns before backend effect', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');
  const snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const name = snap.nodes.find((node) => node.name === 'Name')!;
  const disabled = snap.nodes.find((node) => node.name === 'Disabled')!;
  const before = f.calls.length;

  await assert.rejects(
    () => f.port.invoke(OWNER, opened.desktopSessionId, name.ref),
    /does not support Invoke/,
  );
  await assert.rejects(
    () => f.port.invoke(OWNER, opened.desktopSessionId, disabled.ref),
    /element is disabled/,
  );
  assert.equal(f.calls.length, before);
});

test('DesktopPort revalidates process/window identity before effects and refuses HWND/PID reuse', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');
  const snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const save = snap.nodes.find((node) => node.name === 'Save')!;
  const before = f.calls.length;

  f.setTarget(target({ processInstanceId: 'created:5100:later', title: 'Replacement' }));
  await assert.rejects(
    () => f.port.invoke(OWNER, opened.desktopSessionId, save.ref),
    /target identity changed/,
  );
  assert.equal(f.calls.length, before);
});

test('DesktopPort effect gate denies mutation while read-only snapshot/screenshot remain available', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');
  const snap = await f.port.snapshot(OWNER, opened.desktopSessionId);
  const save = snap.nodes.find((node) => node.name === 'Save')!;
  f.setEffectsAllowed(false);

  await assert.rejects(
    () => f.port.invoke(OWNER, opened.desktopSessionId, save.ref),
    /effect denied/,
  );
  assert.equal((await f.port.snapshot(OWNER, opened.desktopSessionId)).nodes.length, 5);
  assert.deepEqual(
    await f.port.screenshot(OWNER, opened.desktopSessionId),
    { mimeType: 'image/png', dataBase64: 'UE5H' },
  );
});

test('DesktopPort close releases only the owned target and permits later reopen', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, 'target_editor');
  const closed = await f.port.close(OWNER, opened.desktopSessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(f.closed(), true);
  const reopened = await f.port.open(OWNER, 'target_editor');
  assert.equal(reopened.state, 'ACTIVE');
});
