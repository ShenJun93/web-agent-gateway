import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import {
  loadOrCreateBrowserControlPairingState,
  startBrowserControlWebSocketServer,
} from '../src/browser-harness/browser-control-websocket-server.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

async function allocatePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('port allocation failed');
  const port = address.port;
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return port;
}

async function fixture(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(302, {
        location: '/target',
        'set-cookie': 'wag_recovery_auth=accepted; Path=/; SameSite=Lax',
      });
      response.end();
      return;
    }
    if (request.url === '/target') {
      const authenticated = request.headers.cookie?.includes('wag_recovery_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? `<!doctype html><title>WAG Runtime Recovery Acceptance</title>
           <button id="once">Submit Once</button>
           <p id="count">count:0</p>
           <script>
             let count = 0;
             document.querySelector('#once').addEventListener('click', () => {
               count += 1;
               document.querySelector('#count').textContent = 'count:' + count;
             });
           </script>`
        : '<!doctype html><title>Unauthorized</title><p>unauthorized</p>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>WAG User Tab</title><p>user-stays-here</p>');
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  return {
    port: address.port,
    close: () => new Promise<void>((resolvePromise, reject) =>
      server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

async function waitUntil<T>(
  operation: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 25_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await operation();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error(label + ' timed out: ' + (last instanceof Error ? last.message : 'not ready'));
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('runtime recovery acceptance requires Windows');

  const root = await mkdtemp(join(tmpdir(), 'wag-runtime-recovery-'));
  const extensionRoot = join(root, 'extension');
  const profileRoot = join(root, 'edge-profile');
  const web = await fixture();
  const controlPort = await allocatePort();
  const pairingPath = join(root, 'browser-control-pairing.json');
  const pairing = await loadOrCreateBrowserControlPairingState(pairingPath, controlPort);
  let controlServer = await startBrowserControlWebSocketServer({
    statePath: pairingPath,
    pairingState: pairing,
  });
  let first: ReturnType<typeof createPrivateBrowserMcpContext> | undefined;
  let second: ReturnType<typeof createPrivateBrowserMcpContext> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = '';

  const owner = {
    ownerId: 'runtime_recovery_acceptance',
    sessionId: 'runtime_recovery_acceptance',
    adapterId: 'private.stdio.v1',
  } as const;
  const effectStatePath = join(root, 'effects.sqlite');
  const claimStatePath = join(root, 'claims.sqlite');
  const sessionStatePath = join(root, 'sessions.sqlite');

  const createContext = () => createPrivateBrowserMcpContext({
    owner,
    edgeExecutablePath: EDGE,
    profileRoot: join(root, 'managed-profiles-unused'),
    effectStatePath,
    targetClaimStatePath: claimStatePath,
    attachedSessionStatePath: sessionStatePath,
    control: controlServer.client,
    killSwitch: () => false,
  });

  try {
    await mkdir(extensionRoot, { recursive: true });
    for (const file of [
      'existing-browser-control-v1.js',
      'native-browser-control-v1.js',
      'browser-control-websocket-v1.js',
    ]) {
      await copyFile(resolve('browser/extension', file), join(extensionRoot, file));
    }
    const sourceManifest = JSON.parse(
      await readFile(resolve('browser/extension/manifest.json'), 'utf8'),
    ) as { key?: string };
    if (!sourceManifest.key) throw new Error('extension key missing');

    const loginUrl = `http://127.0.0.1:${web.port}/login`;
    await writeFile(join(extensionRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'WAG Runtime Recovery Acceptance',
      version: '0.0.1',
      minimum_chrome_version: '118',
      key: sourceManifest.key,
      permissions: ['debugger', 'storage', 'tabs', 'tabGroups'],
      background: { service_worker: 'worker.js', type: 'module' },
      content_security_policy: {
        extension_pages: `script-src 'self'; object-src 'self'; connect-src ws://127.0.0.1:${controlPort}`,
      },
    }, null, 2), 'utf8');

    await writeFile(join(extensionRoot, 'worker.js'), `
import { createExistingBrowserControlV1 } from './existing-browser-control-v1.js';
import { createBrowserControlWebSocketV1 } from './browser-control-websocket-v1.js';
const control = createExistingBrowserControlV1(chrome);
const transport = createBrowserControlWebSocketV1({
  storage: chrome.storage.local,
  control,
});
void (async () => {
  await transport.configure({
    endpoint: ${JSON.stringify(pairing.endpoint)},
    pairingToken: ${JSON.stringify(pairing.pairingToken)},
  });
  await chrome.tabs.create({ url: ${JSON.stringify(loginUrl)}, active: false });
})().catch(() => undefined);
`, 'utf8');

    child = spawn(EDGE, [
      `--user-data-dir=${profileRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--window-position=-32000,-32000',
      '--window-size=1000,700',
      `http://127.0.0.1:${web.port}/holder`,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });

    await waitUntil(async () => controlServer.connected() ? true : undefined, 'initial extension WebSocket');

    const origin = `http://127.0.0.1:${web.port}`;
    const target = await waitUntil(async () => {
      const targets = await controlServer.client.listTargets();
      return targets.find((row) =>
        row.origin === origin
        && row.url === origin + '/target'
        && row.title === 'WAG Runtime Recovery Acceptance');
    }, 'authenticated target');

    const before = await controlServer.client.listTargets();
    const activeBefore = before.find((row) => row.active)?.targetId ?? null;
    if (target.active) throw new Error('recovery target unexpectedly active');

    first = createContext();
    const opened = await first.open(
      'runtime-recovery',
      'AI_TAB_GROUP',
      target.targetId,
      'WAG • Recovery',
    );
    if (opened.claimEpoch !== 1) throw new Error('initial claim epoch mismatch');

    const snapshot = await first.snapshot(opened.browserSessionId);
    const button = snapshot.nodes.find((node) => node.name === 'Submit Once');
    if (!button) throw new Error('Submit Once button not found');
    const action = { type: 'click' as const, ref: button.ref };
    const effect = await first.exec(opened.browserSessionId, 'runtime-recovery.click.once', action);
    if (effect.state !== 'SUCCEEDED') throw new Error('initial click effect did not succeed');

    const afterFirst = await first.snapshot(opened.browserSessionId);
    if (!afterFirst.nodes.some((node) => node.name === 'count:1')) {
      throw new Error('initial consequential click was not observed exactly once');
    }

    await first.suspendForRestart();
    first = undefined;
    await controlServer.close();

    controlServer = await startBrowserControlWebSocketServer({
      statePath: pairingPath,
      pairingState: pairing,
    });
    await waitUntil(async () => controlServer.connected() ? true : undefined, 'extension reconnect after control-plane restart');

    second = createContext();
    const recovered = await second.open(
      'runtime-recovery',
      'AI_TAB_GROUP',
      target.targetId,
      'WAG • Recovery',
    );
    if (recovered.browserSessionId !== opened.browserSessionId) {
      throw new Error('logical browser session id changed across restart');
    }
    if (recovered.claimEpoch !== 2) throw new Error('recovered claim epoch did not advance');
    if (recovered.targetGeneration !== opened.targetGeneration) {
      throw new Error('target generation changed during same-target recovery');
    }

    let replayBlocked = false;
    try {
      await second.exec(opened.browserSessionId, 'runtime-recovery.click.once', action);
    } catch (error) {
      replayBlocked = /conflicts with a different effect plan/i.test(
        error instanceof Error ? error.message : String(error),
      );
      if (!replayBlocked) throw error;
    }
    if (!replayBlocked) throw new Error('completed consequential effect was replayable after restart');

    const afterRecovery = await second.snapshot(opened.browserSessionId);
    if (!afterRecovery.nodes.some((node) => node.name === 'count:1')) {
      throw new Error('page state changed after blocked replay');
    }
    if (afterRecovery.nodes.some((node) => node.name === 'count:2')) {
      throw new Error('consequential click was duplicated after restart');
    }

    const priorEffect = await second.effect(effect.effectId);
    if (priorEffect.state !== 'SUCCEEDED' || priorEffect.effectId !== effect.effectId) {
      throw new Error('durable exact-once effect receipt was not preserved');
    }

    const after = await controlServer.client.listTargets();
    const activeAfter = after.find((row) => row.active)?.targetId ?? null;
    if (activeAfter !== activeBefore) throw new Error('runtime recovery changed the user active tab');
    if (child.exitCode !== null) throw new Error('Edge exited during runtime recovery: ' + stderr);

    const closed = await second.close(opened.browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('recovered session did not close cleanly');

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      transport: 'LOOPBACK_WEBSOCKET',
      executionMode: recovered.executionMode,
      browserSessionStable: true,
      initialClaimEpoch: opened.claimEpoch,
      recoveredClaimEpoch: recovered.claimEpoch,
      targetGenerationStable: recovered.targetGeneration === opened.targetGeneration,
      extensionReconnected: true,
      durableEffectReceiptPreserved: true,
      completedEffectReplayBlocked: true,
      consequentialClickCount: 1,
      activeTabStable: true,
      targetStayedOpen: true,
      browserStayedOpen: true,
      windowsUiAutomationUsed: false,
      osPointerInjectionUsed: false,
      nativeBrowserControlExecutable: false,
      userRealProfileUsed: false,
    }) + '\n');
  } finally {
    await first?.closeAll().catch(() => undefined);
    await second?.closeAll().catch(() => undefined);
    child?.kill();
    await controlServer.close().catch(() => undefined);
    await web.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write('wag-runtime-recovery-acceptance: '
    + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
