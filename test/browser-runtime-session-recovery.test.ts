import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import type { ExistingBrowserControlClient } from '../src/browser-harness/existing-browser-control-client.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_runtime_recovery',
  sessionId: 'session_runtime_recovery',
  adapterId: 'private.stdio.v1',
};

function controlFixture(): ExistingBrowserControlClient & { attached(): boolean } {
  let isAttached = false;
  const target = () => ({
    targetId: 'tab_7',
    windowId: 'window_3',
    title: 'Authenticated',
    url: 'https://example.test/app',
    origin: 'https://example.test',
    active: false,
    attachable: true,
    ownership: 'USER_EXISTING' as const,
    attached: isAttached,
  });
  return {
    attached: () => isAttached,
    async createTarget() { return { ...target(), targetId: 'tab_8' }; },
    async watchContinuity(targetId) {
      return { targetId, baselineSequence: 0 };
    },
    async resolveContinuity() {
      return { sequence: 0, reason: 'NO_CHANGE', target: null };
    },
    async listTargets() {
      return [target()];
    },
    async groupTarget(targetId, groupTitle) {
      return { targetId, groupId: 'group_9', groupTitle, activeStable: true };
    },
    async attach() {
      isAttached = true;
      return target();
    },
    async describe() {
      return target();
    },
    async exec(_targetId, method) {
      if (method === 'Accessibility.getFullAXTree') return { nodes: [] };
      return {};
    },
    async screenshot() {
      return { mimeType: 'image/png', dataBase64: 'cG5n' };
    },
    async release(targetId) {
      const released = isAttached;
      isAttached = false;
      return { targetId, released };
    },
    async closeTarget(targetId) {
      isAttached = false;
      return { targetId, closed: true };
    },
  };
}

function runtime(root: string, control: ExistingBrowserControlClient) {
  return createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    targetClaimStatePath: join(root, 'claims.sqlite'),
    attachedSessionStatePath: join(root, 'sessions.sqlite'),
    killSwitch: () => false,
    control,
  });
}

test('graceful runtime restart recovers the same logical browser session at a fresh claim epoch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-recovery-'));
  const control = controlFixture();
  let first = runtime(root, control);
  let blocked: ReturnType<typeof runtime> | undefined;
  let second: ReturnType<typeof runtime> | undefined;
  t.after(async () => {
    await first.closeAll().catch(() => undefined);
    await blocked?.closeAll().catch(() => undefined);
    await second?.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const opened = await first.open('recovery', 'AI_TAB_GROUP', 'tab_7', 'WAG • Recovery');
  assert.equal(opened.claimEpoch, 1);
  assert.equal(control.attached(), true);

  const aliased = await first.open('fresh-chat-profile', 'AI_TAB_GROUP', 'tab_7', 'WAG • Recovery');
  assert.equal(
    aliased.browserSessionId,
    opened.browserSessionId,
    'a fresh logical profile on the same owned exact target must reuse the existing session instead of creating a conflicting claim',
  );
  assert.equal(aliased.claimEpoch, opened.claimEpoch);

  const effect = await first.exec(opened.browserSessionId, 'restart.navigate.once', {
    type: 'navigate',
    url: 'https://example.test/next',
  });
  assert.equal(effect.state, 'SUCCEEDED');

  blocked = runtime(root, control);
  await assert.rejects(
    () => blocked!.open('recovery', 'AI_TAB_GROUP', 'tab_7', 'WAG • Recovery'),
    /recovery lease is still active|owned by another active session/i,
  );
  assert.equal(control.attached(), true, 'blocked successor must not detach or steal the live target');
  await blocked.closeAll();
  blocked = undefined;

  await first.suspendForRestart();
  assert.equal(control.attached(), false);

  second = runtime(root, control);
  const recovered = await second.describe(opened.browserSessionId);
  assert.equal(
    recovered.browserSessionId,
    opened.browserSessionId,
    'direct describe must restore a durable attached session even though the new broker has no route',
  );
  const reopened = await second.open('recovery', 'AI_TAB_GROUP', 'tab_7', 'WAG • Recovery');
  assert.equal(reopened.browserSessionId, opened.browserSessionId);
  assert.equal(reopened.claimEpoch, recovered.claimEpoch);
  const recoveryEvents = second.diagnostics?.recent({ limit: 20 }).events.filter((event) =>
    event.action_type === 'recover' && event.browser_session_id === opened.browserSessionId) ?? [];
  assert.equal(recoveryEvents.some((event) => event.recovered && !event.success), true);
  assert.equal(recoveryEvents.some((event) => event.recovered && event.success), true);
  assert.equal(recovered.claimEpoch, 2);
  assert.equal(recovered.targetGeneration, opened.targetGeneration);
  assert.equal(recovered.rootTargetId, 'tab_7');
  assert.equal(recovered.targetId, 'tab_7');
  assert.equal(recovered.groupTitle, 'WAG • Recovery');
  assert.equal(control.attached(), true);

  const described = await second.describe(opened.browserSessionId);
  assert.equal(described.browserSessionId, opened.browserSessionId);
  assert.equal(described.claimEpoch, 2);

  await assert.rejects(
    () => second!.exec(opened.browserSessionId, 'restart.navigate.once', {
      type: 'navigate',
      url: 'https://example.test/next',
    }),
    /conflicts with a different effect plan/i,
  );

  const oldEffect = await second.effect(effect.effectId);
  assert.equal(oldEffect.state, 'SUCCEEDED');
  assert.equal(oldEffect.effectId, effect.effectId);
});

test('AI_TAB_GROUP without target recovers the same AI-owned tab across restart and closes only on terminal close', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-owned-recovery-'));
  const base = controlFixture();
  let createCalls = 0;
  const closedTargets: string[] = [];
  const control: ExistingBrowserControlClient & { attached(): boolean } = {
    ...base,
    async createTarget() {
      createCalls += 1;
      return base.createTarget();
    },
    async closeTarget(targetId) {
      closedTargets.push(targetId);
      return base.closeTarget(targetId);
    },
  };
  const first = runtime(root, control);
  let second: ReturnType<typeof runtime> | undefined;
  t.after(async () => {
    await first.closeAll().catch(() => undefined);
    await second?.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const opened = await first.open('owned-visible', 'AI_TAB_GROUP');
  assert.equal(opened.executionMode, 'AI_TAB_GROUP');
  assert.equal(opened.ownershipMode, 'WAG_OWNED');
  assert.equal(opened.rootTargetId, 'tab_8');
  assert.equal(createCalls, 1);

  await first.suspendForRestart();
  assert.equal(closedTargets.length, 0, 'restart suspension must preserve the WAG-owned tab');

  second = runtime(root, control);
  const recovered = await second.open('owned-visible', 'AI_TAB_GROUP');
  assert.equal(recovered.browserSessionId, opened.browserSessionId);
  assert.equal(recovered.ownershipMode, 'WAG_OWNED');
  assert.equal(recovered.rootTargetId, 'tab_8');
  assert.equal(createCalls, 1, 'durable recovery must not create another browser tab');

  await second.close(opened.browserSessionId);
  assert.deepEqual(closedTargets, ['tab_8']);
});

test('runtime closeAll is terminal rather than recoverable', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-terminal-close-'));
  const control = controlFixture();
  const first = runtime(root, control);
  let second: ReturnType<typeof runtime> | undefined;
  t.after(async () => {
    await first.closeAll().catch(() => undefined);
    await second?.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const opened = await first.open('terminal', 'ATTACH_EXISTING', 'tab_7');
  await first.closeAll();
  assert.equal(control.attached(), false);

  second = runtime(root, control);
  await assert.rejects(
    () => second!.describe(opened.browserSessionId),
    /Browser session/,
  );
});


test('attached browser close replay returns durable CLOSED without reattaching or rerunning release', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-close-replay-'));
  let releaseCalls = 0;
  const base = controlFixture();
  const control: ExistingBrowserControlClient = {
    ...base,
    async release(targetId) {
      releaseCalls += 1;
      return base.release(targetId);
    },
  };
  const instance = runtime(root, control);
  t.after(async () => {
    await instance.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const opened = await instance.open('close-replay', 'ATTACH_EXISTING', 'tab_7');
  const first = await instance.close(opened.browserSessionId);
  assert.equal(first.state, 'CLOSED');
  assert.equal(releaseCalls, 1);
  assert.equal(base.attached(), false);

  const replay = await instance.close(opened.browserSessionId);
  assert.equal(replay.state, 'CLOSED');
  assert.equal(replay.browserSessionId, opened.browserSessionId);
  assert.equal(releaseCalls, 1, 'close replay must not dispatch a second detach');
});
