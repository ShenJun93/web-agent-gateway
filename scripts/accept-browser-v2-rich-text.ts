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

async function editorBundle(): Promise<string> {
  const result = await build({
    stdin: {
      contents: `
        import { Editor } from '@tiptap/core';
        import StarterKit from '@tiptap/starter-kit';
        import { EditorState } from 'prosemirror-state';
        import { EditorView } from 'prosemirror-view';
        import { schema } from 'prosemirror-schema-basic';

        const ce = document.getElementById('contenteditable');
        const ceState = document.getElementById('ce-state');
        ce.addEventListener('input', () => {
          ceState.textContent = 'ce-state:' + ce.textContent;
        });

        const pmStateNode = document.getElementById('pm-state');
        const pmInitial = EditorState.create({
          schema,
          doc: schema.node('doc', null, [
            schema.node('paragraph', null, schema.text('pm-old')),
          ]),
        });
        let pmView;
        pmView = new EditorView(document.getElementById('pm-root'), {
          state: pmInitial,
          dispatchTransaction(transaction) {
            const next = pmView.state.apply(transaction);
            pmView.updateState(next);
            pmStateNode.textContent = 'pm-state:' + next.doc.textContent;
          },
        });
        pmView.dom.setAttribute('aria-label', 'ProseMirror');
        pmView.dom.setAttribute('data-testid', 'prosemirror');
        pmStateNode.textContent = 'pm-state:' + pmView.state.doc.textContent;

        const tipState = document.getElementById('tip-state');
        const tip = new Editor({
          element: document.getElementById('tip-root'),
          extensions: [StarterKit],
          content: '<p>tip-old</p>',
          onUpdate({ editor }) {
            tipState.textContent = 'tip-state:' + editor.getText();
          },
        });
        tip.view.dom.setAttribute('aria-label', 'TipTap');
        tip.view.dom.setAttribute('data-testid', 'tiptap');
        tipState.textContent = 'tip-state:' + tip.getText();

        globalThis.__wagEditors = { pmView, tip };
      `,
      resolveDir: process.cwd(),
      sourcefile: 'wag-rich-text-fixture.js',
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
  if (!file) throw new Error('rich-text fixture bundle was not produced');
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
    if (request.url === '/editor-fixture.js') {
      response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      response.end(bundle);
      return;
    }
    if (request.url === '/target') {
      const authenticated = request.headers.cookie?.includes('wag_auth=accepted') === true;
      response.writeHead(authenticated ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
      response.end(authenticated
        ? `<!doctype html>
           <title>WAG Rich Text Acceptance</title>
           <div id="contenteditable" contenteditable="true" role="textbox" aria-label="Contenteditable">ce-old</div>
           <p id="ce-state">ce-state:ce-old</p>
           <div id="pm-root"></div>
           <p id="pm-state">pm-state:boot</p>
           <div id="tip-root"></div>
           <p id="tip-state">tip-state:boot</p>
           <script src="/editor-fixture.js"></script>`
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

function hasText(nodes: BrowserMcpSnapshot['nodes'], expected: string): boolean {
  return nodes.some((node) => node.name === expected || node.value === expected);
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('rich-text acceptance requires Windows');

  const root = await mkdtemp(join(tmpdir(), 'wag-rich-text-'));
  const extensionRoot = join(root, 'extension');
  const profileRoot = join(root, 'edge-profile');
  const bundle = await editorBundle();
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
      name: 'WAG Rich Text Acceptance',
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
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });

    await waitUntil(async () => controlServer.connected() ? true : undefined, 'extension connection');
    const origin = `http://127.0.0.1:${web.port}`;
    const target = await waitUntil(async () => {
      const targets = await controlServer.client.listTargets();
      return targets.find((row) =>
        row.origin === origin
        && row.url === origin + '/target'
        && row.title === 'WAG Rich Text Acceptance');
    }, 'rich text target');

    const before = await controlServer.client.listTargets();
    const activeBefore = before.find((row) => row.active)?.targetId ?? null;
    if (target.active) throw new Error('rich text target unexpectedly active');

    context = createPrivateBrowserMcpContext({
      owner: {
        ownerId: 'rich_text_acceptance',
        sessionId: 'rich_text_acceptance',
        adapterId: 'private.stdio.v1',
      },
      edgeExecutablePath: EDGE,
      profileRoot: join(root, 'managed-unused'),
      effectStatePath: join(root, 'effects.sqlite'),
      targetClaimStatePath: join(root, 'claims.sqlite'),
      control: controlServer.client,
      killSwitch: () => false,
    });

    const opened = await context.open(
      'rich-text',
      'AI_TAB_GROUP',
      target.targetId,
      'WAG • Rich Text',
    );

    let editorDiagnostic: unknown[] = [];
    try {
      await waitUntil(async () => {
        const snapshot = await context!.snapshot(opened.browserSessionId);
        editorDiagnostic = snapshot.nodes.slice(0, 80).map((node) => ({
          role: node.role,
          name: node.name,
          value: node.value,
          editable: node.editable,
          focusable: node.focusable,
        }));
        const names = new Set(snapshot.nodes.filter((node) => node.editable).map((node) => node.name));
        return names.has('Contenteditable') && names.has('ProseMirror') && names.has('TipTap')
          ? true : undefined;
      }, 'editor render');
    } catch (error) {
      throw new Error((error instanceof Error ? error.message : String(error))
        + '; nodes=' + JSON.stringify(editorDiagnostic));
    }

    async function fillEditor(name: string, text: string, key: string, modelText: string) {
      const snapshot = await context!.snapshot(opened.browserSessionId);
      const node = snapshot.nodes.find((candidate) => candidate.name === name && candidate.editable);
      if (!node) throw new Error('editor not found: ' + name);
      const effect = await context!.exec(opened.browserSessionId, key, {
        type: 'fill',
        ref: node.ref,
        text,
      });
      if (effect.state !== 'SUCCEEDED') throw new Error('fill did not succeed: ' + name);
      await waitUntil(async () => {
        const after = await context!.snapshot(opened.browserSessionId);
        return hasText(after.nodes, modelText) ? true : undefined;
      }, 'model postcondition for ' + name);
    }

    await fillEditor('Contenteditable', 'ce-new', 'rich.ce', 'ce-state:ce-new');
    await fillEditor('ProseMirror', 'pm-new', 'rich.pm', 'pm-state:pm-new');
    await fillEditor('TipTap', 'tip-new', 'rich.tip', 'tip-state:tip-new');

    const finalSnapshot = await context.snapshot(opened.browserSessionId);
    if (!hasText(finalSnapshot.nodes, 'ce-state:ce-new')) throw new Error('contenteditable model mismatch');
    if (!hasText(finalSnapshot.nodes, 'pm-state:pm-new')) throw new Error('ProseMirror model mismatch');
    if (!hasText(finalSnapshot.nodes, 'tip-state:tip-new')) throw new Error('TipTap model mismatch');

    const after = await controlServer.client.listTargets();
    const activeAfter = after.find((row) => row.active)?.targetId ?? null;
    if (activeAfter !== activeBefore) throw new Error('rich text fill changed user active tab');

    const closed = await context.close(opened.browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('rich text session did not close');
    if (child.exitCode !== null) throw new Error('Edge exited during rich text acceptance: ' + stderr);

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      executionMode: opened.executionMode,
      activeTabStable: true,
      contenteditableModel: true,
      prosemirrorModel: true,
      tiptapModel: true,
      replacementNotAppend: true,
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
  process.stderr.write('wag-rich-text-acceptance: '
    + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
