import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { GatewayAuthority } from '../src/caller-context.js';
import type { BrowserOpenRequest, BrowserPort, BrowserSessionHandle } from '../src/browser-harness/browser-port.js';
import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import { createSemanticBrowser, type SemanticBrowser } from '../src/browser-harness/semantic-browser.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_browser_bounds',
  sessionId: 'session_browser_bounds',
  adapterId: 'private.stdio.v1',
};

function handle(index: number, profileId = 'profile'): BrowserSessionHandle {
  return {
    browserSessionId: `browser_00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    profileId,
    owner: OWNER,
    backend: 'cdp',
    executionMode: 'WAG_HEADLESS',
    ownershipMode: 'WAG_OWNED',
    controlState: 'RUNNING',
    createdAt: 1,
    lastSeenAt: 1,
    state: 'ACTIVE',
  };
}

test('semantic AX parsing caps source nodes before building refs and marks truncation', async () => {
  const session = handle(901);
  const source = Array.from({ length: 2_100 }, (_, index) => ({
    ignored: false,
    role: { value: 'button' },
    name: { value: 'node-' + index },
    backendDOMNodeId: index + 1,
  }));
  const port: BrowserPort = {
    async open() { return session; },
    async describe() { return session; },
    async snapshot() {
      return {
        browserSessionId: session.browserSessionId,
        targetId: 'target_bounds',
        url: 'https://example.test/',
        title: 'Bounds',
        observedAt: 1,
        state: 'ACTIVE',
      };
    },
    async exec(_owner, _id, request) {
      if (request.method === 'Accessibility.getFullAXTree') return { nodes: source };
      throw new Error('unexpected browser command');
    },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...session, state: 'CLOSED' }; },
  };
  const semantic = createSemanticBrowser({
    port,
    randomUUID: () => '00000000-0000-4000-8000-000000000902',
  });
  const snapshot = await semantic.snapshot(OWNER, session.browserSessionId);
  assert.equal(snapshot.nodes.length, 2_000);
  assert.equal(snapshot.truncated, true);
  assert.equal(snapshot.nodes.at(-1)?.name, 'node-1999');
});

test('browser MCP snapshot caps returned semantic nodes to 500 and propagates truncation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-snapshot-bound-'));
  const session = handle(903);
  const port: BrowserPort = {
    async open() { return session; },
    async describe() { return session; },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close() { return { ...session, state: 'CLOSED' }; },
  };
  const nodes = Array.from({ length: 600 }, (_, index) => ({
    ref: `node_00000000-0000-4000-8000-000000000904_${index}`,
    role: 'button',
    name: 'node-' + index,
    disabled: false,
    editable: false,
    focusable: true,
  }));
  const semantic: SemanticBrowser = {
    async snapshot() {
      return {
        snapshotId: '00000000-0000-4000-8000-000000000904',
        browserSessionId: session.browserSessionId,
        url: 'https://example.test/?secret=must-not-enter-diagnostics',
        title: 'Sensitive page title',
        nodes,
        truncated: true,
      };
    },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'edge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    diagnosticsStatePath: join(root, 'browser-diagnostics.json'),
    killSwitch: () => false,
    port,
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const snapshot = await runtime.snapshot(session.browserSessionId);
  assert.equal(snapshot.nodes.length, 500);
  assert.equal(snapshot.truncated, true);
  const diagnosticText = JSON.stringify(runtime.diagnostics?.recent() ?? {});
  assert.equal(diagnosticText.includes('Sensitive page title'), false);
  assert.equal(diagnosticText.includes('must-not-enter-diagnostics'), false);
  assert.equal(diagnosticText.includes('node-499'), false);
});

test('browser runtime refuses a 33rd active session before opening backend resources', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-session-bound-'));
  let opens = 0;
  const sessions = new Map<string, BrowserSessionHandle>();
  const port: BrowserPort = {
    async open(request: BrowserOpenRequest) {
      opens += 1;
      const value = handle(opens, request.profileId);
      sessions.set(value.browserSessionId, value);
      return value;
    },
    async describe(_owner, browserSessionId) {
      const value = sessions.get(browserSessionId);
      if (!value) throw new Error('Browser session not found');
      return value;
    },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { throw new Error('unused'); },
    async close(_owner, browserSessionId) {
      const value = sessions.get(browserSessionId);
      if (!value) throw new Error('Browser session not found');
      sessions.delete(browserSessionId);
      return { ...value, state: 'CLOSED' };
    },
  };
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'edge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port,
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  for (let index = 0; index < 32; index += 1) {
    await runtime.open('profile-' + index, 'WAG_HEADLESS');
  }
  await assert.rejects(
    () => runtime.open('profile-32', 'WAG_HEADLESS'),
    /active session limit reached/,
  );
  assert.equal(opens, 32, 'backend open must not run after the session cap is reached');
});

test('browser screenshot rejects oversized base64 before returning it to the caller', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-screenshot-bound-'));
  const session = handle(950);
  const overLimit = 'A'.repeat(4 * Math.ceil((8 * 1024 * 1024) / 3) + 1);
  const port: BrowserPort = {
    async open() { return session; },
    async describe() { return session; },
    async snapshot() { throw new Error('unused'); },
    async exec() { throw new Error('unused'); },
    async screenshot() { return { mimeType: 'image/png', dataBase64: overLimit }; },
    async close() { return { ...session, state: 'CLOSED' }; },
  };
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { throw new Error('unused'); },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'edge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port,
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    () => runtime.screenshot(session.browserSessionId),
    /screenshot exceeds size limit/,
  );
});
