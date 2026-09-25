import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { BrowserPort } from '../src/browser-harness/browser-port.js';
import {
  createPrivateBrowserMcpContext,
} from '../src/browser-harness/browser-mcp-runtime.js';
import type { SemanticBrowser } from '../src/browser-harness/semantic-browser.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_browser_mcp',
  sessionId: 'session_browser_mcp',
  adapterId: 'private.stdio.v1',
};
const SESSION = 'browser_00000000-0000-4000-8000-000000000111';

function unusedPort(): BrowserPort {
  const unavailable = async (): Promise<never> => { throw new Error('unused BrowserPort method'); };
  return {
    open: unavailable,
    describe: unavailable,
    snapshot: unavailable,
    exec: unavailable,
    screenshot: unavailable,
    close: unavailable,
  };
}

test('browser MCP exact-once coordinator never replays a succeeded semantic effect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-mcp-effect-'));
  let clicks = 0;
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() { clicks += 1; },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port: unusedPort(),
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const action = { type: 'click' as const, ref: 'node_00000000-0000-4000-8000-000000000222_0' };
  const first = await runtime.exec(SESSION, 'browser.click.once', action);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(clicks, 1);

  const second = await runtime.exec(SESSION, 'browser.click.once', action);
  assert.equal(second.effectId, first.effectId);
  assert.equal(second.state, 'SUCCEEDED');
  assert.equal(clicks, 1, 'a successful idempotent retry must not dispatch a second click');

  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.once', {
      type: 'press',
      key: 'Enter',
    }),
    /conflicts with a different effect plan/i,
  );
  assert.equal(clicks, 1);
});

test('browser MCP outcome-unknown blocks blind replay after an uncertain semantic effect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-mcp-unknown-'));
  let attempts = 0;
  const semantic: SemanticBrowser = {
    async snapshot() { throw new Error('unused'); },
    async navigate() { throw new Error('unused'); },
    async click() {
      attempts += 1;
      throw new Error('connection disappeared after dispatch boundary');
    },
    async fill() { throw new Error('unused'); },
    async setFiles() { throw new Error('unused'); },
    async press() { throw new Error('unused'); },
  };
  const runtime = createPrivateBrowserMcpContext({
    owner: OWNER,
    edgeExecutablePath: join(root, 'msedge.exe'),
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
    port: unusedPort(),
    semantic,
  });
  t.after(async () => {
    await runtime.closeAll();
    await rm(root, { recursive: true, force: true });
  });

  const action = { type: 'click' as const, ref: 'node_00000000-0000-4000-8000-000000000333_0' };
  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.unknown', action),
    /connection disappeared/i,
  );
  assert.equal(attempts, 1);

  await assert.rejects(
    () => runtime.exec(SESSION, 'browser.click.unknown', action),
    /not claimable from OUTCOME_UNKNOWN/i,
  );
  assert.equal(attempts, 1, 'OUTCOME_UNKNOWN must never dispatch the effect again');
});
