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
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;

    if (path === '/login') {
      response.writeHead(302, {
        location: '/app',
        'set-cookie': 'wag_oauth_auth=accepted; Path=/; SameSite=Lax',
      });
      response.end();
      return;
    }

    if (path === '/app') {
      const authenticated = request.headers.cookie?.includes('wag_oauth_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? `<!doctype html><title>WAG OAuth App</title>
           <button id="oauth">Continue OAuth</button>
           <p id="status">app-ready</p>
           <script>
             document.querySelector('#oauth').addEventListener('click', () => {
               const popup = window.open('/oauth', 'wag-oauth', 'width=520,height=640');
               document.querySelector('#status').textContent = popup ? 'oauth-opened' : 'oauth-blocked';
             });
           </script>`
        : '<!doctype html><title>Unauthorized</title><p>unauthorized</p>');
      return;
    }

    if (path === '/oauth') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>WAG OAuth Provider</title>
        <p>provider-ready</p>
        <button id="authorize">Authorize</button>
        <script>
          document.querySelector('#authorize').addEventListener('click', () => {
            if (window.opener) window.opener.location.href = '/done';
            window.location.href = '/callback?code=secret-value';
          });
        </script>`);
      return;
    }

    if (path === '/callback') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><title>WAG OAuth Callback</title>
        <p>callback-complete</p>
        <script>setTimeout(() => window.close(), 500);</script>`);
      return;
    }

    if (path === '/done') {
      const authenticated = request.headers.cookie?.includes('wag_oauth_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? '<!doctype html><title>WAG OAuth Complete</title><p>oauth-complete</p>'
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
  timeoutMs = 20_000,
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
  if (process.platform !== 'win32') throw new Error('OAuth continuity acceptance requires Windows');

  const root = await mkdtemp(join(tmpdir(), 'wag-oauth-continuity-'));
  const extensionRoot = join(root, 'extension');
  const profileRoot = join(root, 'edge-profile');
  const web = await fixture();
  const controlPort = await allocatePort();
  const pairingPath = join(root, 'browser-control-pairing.json');
  const pairing = await loadOrCreateBrowserControlPairingState(pairingPath, controlPort);
  const controlServer = await startBrowserControlWebSocketServer({
    statePath: pairingPath,
    pairingState: pairing,
  });
  let context: ReturnType<typeof createPrivateBrowserMcpContext> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let stderr = '';

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
      name: 'WAG OAuth Continuity Acceptance',
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

    await waitUntil(async () => controlServer.connected() ? true : undefined, 'extension WebSocket connection');

    const origin = `http://127.0.0.1:${web.port}`;
    const rootTarget = await waitUntil(async () => {
      const targets = await controlServer.client.listTargets();
      return targets.find((row) =>
        row.origin === origin
        && row.url === origin + '/app'
        && row.title === 'WAG OAuth App');
    }, 'authenticated app target');

    const initialTargets = await controlServer.client.listTargets();
    const userTab = initialTargets.find((row) => row.title === 'WAG User Tab');
    if (!userTab?.active) throw new Error('user holder tab is not active before OAuth flow');
    if (rootTarget.active) throw new Error('OAuth app unexpectedly active before automation');

    context = createPrivateBrowserMcpContext({
      owner: {
        ownerId: 'oauth_continuity_acceptance',
        sessionId: 'oauth_continuity_acceptance',
        adapterId: 'private.stdio.v1',
      },
      edgeExecutablePath: EDGE,
      profileRoot: join(root, 'managed-profiles-unused'),
      effectStatePath: join(root, 'effects.sqlite'),
      control: controlServer.client,
      killSwitch: () => false,
    });

    const opened = await context.open(
      'oauth-continuity',
      'AI_TAB_GROUP',
      rootTarget.targetId,
      'WAG • OAuth',
    );
    const browserSessionId = opened.browserSessionId;
    if (opened.targetGeneration !== 0 || opened.rootTargetId !== rootTarget.targetId) {
      throw new Error('initial OAuth logical target metadata mismatch');
    }

    const app = await context.snapshot(browserSessionId);
    const continueButton = app.nodes.find((node) => node.name === 'Continue OAuth');
    if (!continueButton) throw new Error('OAuth launch button not discovered');

    const launch = await context.exec(browserSessionId, 'oauth.launch.1', {
      type: 'click',
      ref: continueButton.ref,
    });
    if (launch.state !== 'SUCCEEDED') throw new Error('OAuth launch effect did not succeed');

    const provider = await waitUntil(async () => {
      const snapshot = await context!.snapshot(browserSessionId);
      return snapshot.title === 'WAG OAuth Provider' ? snapshot : undefined;
    }, 'OAuth successor target');

    const onProvider = await context.describe(browserSessionId);
    if (onProvider.browserSessionId !== browserSessionId
        || onProvider.rootTargetId !== rootTarget.targetId
        || onProvider.targetId === rootTarget.targetId
        || onProvider.targetGeneration !== 1) {
      throw new Error('OAuth successor did not preserve logical browser session');
    }

    const authorize = provider.nodes.find((node) => node.name === 'Authorize');
    if (!authorize) throw new Error('OAuth authorize button not discovered');
    const authorizeEffect = await context.exec(browserSessionId, 'oauth.authorize.1', {
      type: 'click',
      ref: authorize.ref,
    });
    if (authorizeEffect.state !== 'SUCCEEDED') throw new Error('OAuth authorize effect did not succeed');

    const completed = await waitUntil(async () => {
      const snapshot = await context!.snapshot(browserSessionId);
      return snapshot.title === 'WAG OAuth Complete' ? snapshot : undefined;
    }, 'OAuth callback return', 25_000);

    const finalHandle = await context.describe(browserSessionId);
    if (finalHandle.browserSessionId !== browserSessionId
        || finalHandle.targetId !== rootTarget.targetId
        || finalHandle.rootTargetId !== rootTarget.targetId
        || (finalHandle.targetGeneration ?? 0) < 2) {
      throw new Error('OAuth callback did not return the logical session to its root target');
    }
    if (!completed.nodes.some((node) => node.name === 'oauth-complete')) {
      throw new Error('OAuth callback completion state was not observed');
    }

    const beforeClose = await controlServer.client.listTargets();
    const userTabAfter = beforeClose.find((row) => row.targetId === userTab.targetId);
    if (!userTabAfter?.active) {
      throw new Error('WAG changed the original user tab active state during OAuth workflow');
    }

    const closed = await context.close(browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('OAuth logical session did not close cleanly');
    if (child.exitCode !== null) throw new Error('Edge exited during OAuth acceptance: ' + stderr);

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      transport: 'LOOPBACK_WEBSOCKET',
      executionMode: opened.executionMode,
      browserSessionStable: true,
      rootTargetId: rootTarget.targetId,
      successorObserved: true,
      successorGeneration: onProvider.targetGeneration,
      returnedToRoot: true,
      finalTargetGeneration: finalHandle.targetGeneration,
      authenticatedSessionPreserved: true,
      callbackStateVerified: true,
      originalUserTabStayedActive: true,
      windowsUiAutomationUsed: false,
      osPointerInjectionUsed: false,
      arbitraryJavascriptExposed: false,
      nativeBrowserControlExecutable: false,
      userRealProfileUsed: false,
    }) + '\n');
  } finally {
    await context?.closeAll().catch(() => undefined);
    child?.kill();
    await controlServer.close().catch(() => undefined);
    await web.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write('wag-oauth-continuity-acceptance: '
    + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
