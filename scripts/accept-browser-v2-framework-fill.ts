import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

import {
  createPrivateBrowserMcpContext,
  type BrowserMcpSnapshot,
} from '../src/browser-harness/browser-mcp-runtime.js';
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

async function reactBundle(): Promise<string> {
  const result = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';

        function App() {
          const [controlled, setControlled] = React.useState('react-old');
          const [validated, setValidated] = React.useState('bad');
          const valid = validated.length >= 5;

          return React.createElement(
            React.Fragment,
            null,
            React.createElement('label', null,
              'React Controlled',
              React.createElement('input', {
                'aria-label': 'React Controlled',
                value: controlled,
                onChange: (event) => setControlled(event.target.value),
              }),
            ),
            React.createElement('p', { id: 'react-state' }, 'react-state:' + controlled),
            React.createElement('form', {
              onSubmit: (event) => event.preventDefault(),
            },
              React.createElement('label', null,
                'Validated',
                React.createElement('input', {
                  'aria-label': 'Validated',
                  value: validated,
                  onChange: (event) => setValidated(event.target.value),
                }),
              ),
              React.createElement(
                'p',
                { id: 'validation-state' },
                'validation:' + (valid ? 'valid:' : 'invalid:') + validated,
              ),
              React.createElement(
                'button',
                { type: 'submit', disabled: !valid },
                'Validated Submit',
              ),
            ),
          );
        }

        createRoot(document.getElementById('react-root')).render(React.createElement(App));
      `,
      resolveDir: process.cwd(),
      sourcefile: 'wag-framework-fill-react-fixture.js',
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: ['chrome118'],
    logLevel: 'silent',
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error('React fixture bundle was not produced');
  return file.text;
}

async function fixture(bundle: string): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/login') {
      response.writeHead(302, {
        location: '/target',
        'set-cookie': 'wag_auth=accepted; Path=/; SameSite=Lax',
      });
      response.end();
      return;
    }
    if (request.url === '/react-fixture.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (request.url === '/target') {
      const authenticated = request.headers.cookie?.includes('wag_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? `<!doctype html>
           <title>WAG Framework Fill Acceptance</title>
           <label>Plain <input aria-label="Plain" value="plain-old"></label>
           <label>Notes <textarea aria-label="Notes">notes-old</textarea></label>
           <div id="react-root"></div>
           <script src="/react-fixture.js"></script>`
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

function nodeValue(
  nodes: readonly { name: string; value?: string; editable: boolean; disabled: boolean }[],
  name: string,
): string | undefined {
  return nodes.find((node) => node.name === name && node.editable)?.value;
}

function hasText(
  nodes: readonly { name: string }[],
  expected: string,
): boolean {
  return nodes.some((node) => node.name === expected);
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('framework fill acceptance requires Windows');

  const root = await mkdtemp(join(tmpdir(), 'wag-framework-fill-'));
  const extensionRoot = join(root, 'extension');
  const profileRoot = join(root, 'edge-profile');
  const bundle = await reactBundle();
  const web = await fixture(bundle);
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
      name: 'WAG Framework Fill Acceptance',
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

    await waitUntil(async () => controlServer.connected() ? true : undefined, 'extension connection');

    const origin = `http://127.0.0.1:${web.port}`;
    const target = await waitUntil(async () => {
      const targets = await controlServer.client.listTargets();
      return targets.find((row) =>
        row.origin === origin
        && row.url === origin + '/target'
        && row.title === 'WAG Framework Fill Acceptance');
    }, 'framework target');

    const before = await controlServer.client.listTargets();
    const activeBefore = before.find((row) => row.active)?.targetId ?? null;
    if (target.active) throw new Error('framework target unexpectedly active');

    context = createPrivateBrowserMcpContext({
      owner: {
        ownerId: 'framework_fill_acceptance',
        sessionId: 'framework_fill_acceptance',
        adapterId: 'private.stdio.v1',
      },
      edgeExecutablePath: EDGE,
      profileRoot: join(root, 'managed-profiles-unused'),
      effectStatePath: join(root, 'effects.sqlite'),
      targetClaimStatePath: join(root, 'claims.sqlite'),
      control: controlServer.client,
      killSwitch: () => false,
    });

    const opened = await context.open(
      'framework-fill',
      'AI_TAB_GROUP',
      target.targetId,
      'WAG • Framework Fill',
    );

    await waitUntil(async () => {
      const snapshot = await context!.snapshot(opened.browserSessionId);
      return snapshot.nodes.some((node) => node.name === 'React Controlled' && node.editable)
        && snapshot.nodes.some((node) => node.name === 'Validated' && node.editable)
        ? true
        : undefined;
    }, 'React fixture render');

    async function fillAndVerify(
      name: string,
      text: string,
      idempotencyKey: string,
      postcondition: (nodes: BrowserMcpSnapshot['nodes']) => boolean,
    ) {
      const snapshot = await context!.snapshot(opened.browserSessionId);
      const node = snapshot.nodes.find((candidate) => candidate.name === name && candidate.editable);
      if (!node) throw new Error('editable node not found: ' + name);
      const effect = await context!.exec(opened.browserSessionId, idempotencyKey, {
        type: 'fill',
        ref: node.ref,
        text,
      });
      if (effect.state !== 'SUCCEEDED') throw new Error('fill effect did not succeed: ' + name);
      let lastNodes: BrowserMcpSnapshot['nodes'] = [];
      try {
        await waitUntil(async () => {
          const after = await context!.snapshot(opened.browserSessionId);
          lastNodes = after.nodes;
          return postcondition(after.nodes) ? true : undefined;
        }, 'postcondition for ' + name);
      } catch (error) {
        const observed = nodeValue(lastNodes, name);
        const visible = lastNodes.map((candidate) => candidate.name).filter(Boolean).slice(0, 30);
        throw new Error((error instanceof Error ? error.message : String(error))
          + '; observedValue=' + JSON.stringify(observed)
          + '; visible=' + JSON.stringify(visible));
      }
    }

    await fillAndVerify(
      'Plain',
      'plain-new',
      'framework-fill.plain',
      (nodes) => nodeValue(nodes, 'Plain') === 'plain-new',
    );

    await fillAndVerify(
      'Notes',
      'notes-new',
      'framework-fill.textarea',
      (nodes) => nodeValue(nodes, 'Notes') === 'notes-new',
    );

    await fillAndVerify(
      'React Controlled',
      'react-new',
      'framework-fill.react-controlled',
      (nodes) => nodeValue(nodes, 'React Controlled') === 'react-new'
        && hasText(nodes, 'react-state:react-new'),
    );

    await fillAndVerify(
      'Validated',
      'valid-text',
      'framework-fill.validated',
      (nodes) => {
        const submit = nodes.find((node) => node.name === 'Validated Submit');
        return nodeValue(nodes, 'Validated') === 'valid-text'
          && hasText(nodes, 'validation:valid:valid-text')
          && submit?.disabled === false;
      },
    );

    const finalSnapshot = await context.snapshot(opened.browserSessionId);
    if (nodeValue(finalSnapshot.nodes, 'Plain') !== 'plain-new') {
      throw new Error('plain input replacement failed');
    }
    if (nodeValue(finalSnapshot.nodes, 'Notes') !== 'notes-new') {
      throw new Error('textarea replacement failed');
    }
    if (nodeValue(finalSnapshot.nodes, 'React Controlled') !== 'react-new') {
      throw new Error('React controlled DOM value failed');
    }
    if (!hasText(finalSnapshot.nodes, 'react-state:react-new')) {
      throw new Error('React controlled state failed');
    }
    if (!hasText(finalSnapshot.nodes, 'validation:valid:valid-text')) {
      throw new Error('React validation state failed');
    }

    const after = await controlServer.client.listTargets();
    const activeAfter = after.find((row) => row.active)?.targetId ?? null;
    if (activeAfter !== activeBefore) throw new Error('framework fill changed user active tab');

    const closed = await context.close(opened.browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('framework fill session did not close');
    if (child.exitCode !== null) throw new Error('Edge exited during acceptance: ' + stderr);

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      executionMode: opened.executionMode,
      activeTabStable: true,
      plainInputReplacement: true,
      textareaReplacement: true,
      reactControlledDomValue: true,
      reactControlledState: true,
      reactValidationState: true,
      reactSubmitEnabled: true,
      appendedInsteadOfReplaced: false,
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
  process.stderr.write('wag-framework-fill-acceptance: '
    + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
