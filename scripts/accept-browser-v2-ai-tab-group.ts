import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import { createNodeCdpTransport } from '../src/browser-harness/node-cdp-transport.js';
import {
  loadOrCreateBrowserControlPairingState,
  startBrowserControlWebSocketServer,
} from '../src/browser-harness/browser-control-websocket-server.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec';

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
        'set-cookie': 'wag_auth=accepted; Path=/; SameSite=Lax',
      });
      response.end();
      return;
    }
    if (request.url === '/target') {
      const authenticated = request.headers.cookie?.includes('wag_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? `<!doctype html><title>WAG AI Tab Group Acceptance</title>
           <label>Name <input id="name" aria-label="Name"></label>
           <button id="submit">Submit</button>
           <p id="status">authenticated ready</p>
           <script>
             document.querySelector('#submit').addEventListener('click', () => {
               document.querySelector('#status').textContent =
                 'submitted:' + document.querySelector('#name').value;
             });
           </script>`
        : '<!doctype html><title>Unauthorized</title><p>unauthorized</p>');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>WAG User Tab</title><p>user stays here</p>');
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


async function waitForDebugPort(profileRoot: string): Promise<number> {
  const path = join(profileRoot, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [line] = (await readFile(path, 'utf8')).split(/\r?\n/);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('Edge debug port was not created');
}

async function inspectExtension(debugPort: number): Promise<string> {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    const targets = await response.json() as Array<{
      type?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const worker = targets.find((row) =>
      row.type === 'service_worker'
      && row.url?.startsWith(`chrome-extension://${EXTENSION_ID}/`)
      && row.webSocketDebuggerUrl);
    if (!worker?.webSocketDebuggerUrl) {
      return 'service-worker-not-found:' + JSON.stringify(targets.map(({ type, url }) => ({ type, url })));
    }
    const transport = await createNodeCdpTransport({
      endpointUrl: worker.webSocketDebuggerUrl,
      commandTimeoutMs: 3000,
    });
    try {
      const result = await transport.send({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `Promise.resolve(globalThis.__wagControl?.listTargets())
            .then((targets) => JSON.stringify({
              connected: globalThis.__wagTransport?.isConnected?.() ?? null,
              lastMethod: globalThis.__wagLastMethod ?? null,
              lastDone: globalThis.__wagLastDone ?? null,
              lastError: globalThis.__wagLastError ?? null,
              targets,
            }))
            .catch((error) => JSON.stringify({
              connected: globalThis.__wagTransport?.isConnected?.() ?? null,
              error: String(error),
              stack: String(error?.stack ?? ''),
            }))`,
          awaitPromise: true,
          returnByValue: true,
        },
      });
      return JSON.stringify(result);
    } finally {
      await transport.close();
    }
  } catch (error) {
    return 'diagnostic-failed:' + (error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('AI tab group acceptance requires Windows');

  const root = await mkdtemp(join(tmpdir(), 'wag-ai-tab-group-'));
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
      name: 'WAG AI Tab Group Acceptance',
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
const originalExec = control.exec.bind(control);
control.exec = async (...args) => {
  globalThis.__wagLastMethod = args[1];
  globalThis.__wagLastDone = false;
  globalThis.__wagLastError = null;
  try {
    const value = await originalExec(...args);
    globalThis.__wagLastDone = true;
    return value;
  } catch (error) {
    globalThis.__wagLastError = String(error);
    throw error;
  }
};
const transport = createBrowserControlWebSocketV1({
  storage: chrome.storage.local,
  control,
});
globalThis.__wagControl = control;
globalThis.__wagTransport = transport;
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
      '--remote-debugging-port=0',
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
    const debugPort = await waitForDebugPort(profileRoot);

    await waitUntil(async () => controlServer.connected() ? true : undefined, 'extension WebSocket connection');

    const origin = `http://127.0.0.1:${web.port}`;
    let target;
    try {
      target = await waitUntil(async () => {
        const targets = await controlServer.client.listTargets();
        return targets.find((row) =>
          row.origin === origin
          && row.url === origin + '/target'
          && row.title === 'WAG AI Tab Group Acceptance');
      }, 'authenticated inactive target');
    } catch (error) {
      throw new Error((error instanceof Error ? error.message : String(error))
        + '; extension=' + await inspectExtension(debugPort));
    }

    process.stderr.write('acceptance-phase: target-discovered\n');
    const before = await controlServer.client.listTargets();
    process.stderr.write('acceptance-phase: pre-group-list-ok\n');
    const activeBefore = before.find((row) => row.active)?.targetId ?? null;
    if (target.active) throw new Error('AI target unexpectedly stole active tab before attach');

    context = createPrivateBrowserMcpContext({
      owner: {
        ownerId: 'ai_tab_group_acceptance',
        sessionId: 'ai_tab_group_acceptance',
        adapterId: 'private.stdio.v1',
      },
      edgeExecutablePath: EDGE,
      profileRoot: join(root, 'managed-profiles-unused'),
      effectStatePath: join(root, 'effects.sqlite'),
      control: controlServer.client,
      killSwitch: () => false,
    });

    let opened;
    try {
      opened = await context.open(
        'acceptance',
        'AI_TAB_GROUP',
        target.targetId,
        'WAG • Acceptance',
      );
      process.stderr.write('acceptance-phase: group-and-attach-ok\n');
    } catch (error) {
      throw new Error('group-or-attach: ' + (error instanceof Error ? error.message : String(error))
        + '; extension=' + await inspectExtension(debugPort));
    }
    if (opened.executionMode !== 'AI_TAB_GROUP'
        || opened.ownershipMode !== 'ATTACHED_EXISTING'
        || opened.groupTitle !== 'WAG • Acceptance') {
      throw new Error('AI tab group session metadata mismatch');
    }

    let first;
    try {
      first = await context.snapshot(opened.browserSessionId);
      process.stderr.write('acceptance-phase: first-snapshot-ok\n');
    } catch (error) {
      throw new Error('snapshot: ' + (error instanceof Error ? error.message : String(error))
        + '; extension=' + await inspectExtension(debugPort));
    }
    const input = first.nodes.find((node) => node.name === 'Name' && node.editable);
    const button = first.nodes.find((node) => node.name === 'Submit');
    if (!input || !button) throw new Error('semantic nodes not discovered');

    let fill;
    try {
      fill = await context.exec(opened.browserSessionId, 'ai-tab.fill.1', {
        type: 'fill',
        ref: input.ref,
        text: 'WAG',
      });
      process.stderr.write('acceptance-phase: fill-ok\n');
    } catch (error) {
      throw new Error('fill: ' + (error instanceof Error ? error.message : String(error))
        + '; extension=' + await inspectExtension(debugPort));
    }
    let click;
    try {
      click = await context.exec(opened.browserSessionId, 'ai-tab.click.1', {
        type: 'click',
        ref: button.ref,
      });
      process.stderr.write('acceptance-phase: click-ok\n');
    } catch (error) {
      throw new Error('click: ' + (error instanceof Error ? error.message : String(error))
        + '; extension=' + await inspectExtension(debugPort));
    }
    if (fill.state !== 'SUCCEEDED' || click.state !== 'SUCCEEDED') {
      throw new Error('semantic effects did not succeed');
    }

    const finalSnapshot = await context.snapshot(opened.browserSessionId);
    const submitted = finalSnapshot.nodes.some((node) => node.name === 'submitted:WAG');
    if (!submitted) throw new Error('semantic result not observed; nodes='
      + JSON.stringify(finalSnapshot.nodes.slice(0, 30).map((node) => ({
        role: node.role, name: node.name, value: node.value,
      }))));

    const afterAutomation = await controlServer.client.listTargets();
    const activeAfterAutomation = afterAutomation.find((row) => row.active)?.targetId ?? null;
    if (activeAfterAutomation !== activeBefore) {
      throw new Error('AI automation changed the user active tab');
    }

    const closed = await context.close(opened.browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('AI tab group did not release cleanly');
    const afterRelease = await controlServer.client.listTargets();
    const targetAfter = afterRelease.find((row) => row.targetId === target.targetId);
    const activeAfterRelease = afterRelease.find((row) => row.active)?.targetId ?? null;
    if (!targetAfter || targetAfter.attached) throw new Error('AI target was not preserved after release');
    if (activeAfterRelease !== activeBefore) throw new Error('release changed the user active tab');
    if (child.exitCode !== null) throw new Error('Edge exited during release: ' + stderr);

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      transport: 'LOOPBACK_WEBSOCKET',
      nativeBrowserControlExecutable: false,
      executionMode: opened.executionMode,
      ownershipMode: opened.ownershipMode,
      groupId: opened.groupId,
      groupTitle: opened.groupTitle,
      authenticatedSessionPreserved: true,
      targetStartedInactive: true,
      activeTabStable: true,
      semanticSnapshot: true,
      semanticFill: fill.state,
      semanticClick: click.state,
      finalStateVerified: submitted,
      targetStillOpenAfterRelease: true,
      browserStillOpenAfterRelease: true,
      windowsUiAutomationUsed: false,
      osPointerInjectionUsed: false,
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
  process.stderr.write('wag-ai-tab-group-acceptance: '
    + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
