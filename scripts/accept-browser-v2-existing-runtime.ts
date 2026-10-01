import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import {
  createExistingBrowserControlClient,
  defaultExistingBrowserControlDiscoveryPath,
} from '../src/browser-harness/existing-browser-control-client.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec';

async function fixture() {
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
        ? `<!doctype html><title>WAG Authenticated Attach</title>
           <label>Name <input id="name" aria-label="Name"></label>
           <button id="submit">Submit</button><p id="status">authenticated ready</p>
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
    response.end('<!doctype html><title>WAG Control Holder</title><p>holder</p>');
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await stat(path)).isFile()) return;
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('browser control discovery file was not created');
}

async function waitForTarget(
  control: ReturnType<typeof createExistingBrowserControlClient>,
  expectedOrigin: string,
) {
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const targets = await control.listTargets();
      const target = targets.find((row) =>
        row.origin === expectedOrigin && row.title === 'WAG Authenticated Attach');
      if (target) return { target, targets };
    } catch (error) { last = error; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('authenticated target not discovered: '
    + (last instanceof Error ? last.message : 'no target'));
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('real existing-tab acceptance requires Windows');
  const discoveryPath = defaultExistingBrowserControlDiscoveryPath();
  if (!discoveryPath) throw new Error('browser control discovery path unavailable');
  try {
    await stat(discoveryPath);
    throw new Error('browser control discovery already exists; refusing to disturb another host');
  } catch (error) {
    if (error instanceof Error && error.message.includes('refusing')) throw error;
  }

  const web = await fixture();
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-v2-runtime-attach-'));
  const extensionRoot = join(root, 'extension');
  const profileRoot = join(root, 'edge-profile');
  let child: ReturnType<typeof spawn> | undefined;
  let context: ReturnType<typeof createPrivateBrowserMcpContext> | undefined;

  try {
    await mkdir(extensionRoot, { recursive: true });
    await copyFile(resolve('browser/extension/existing-browser-control-v1.js'),
      join(extensionRoot, 'existing-browser-control-v1.js'));
    await copyFile(resolve('browser/extension/native-browser-control-v1.js'),
      join(extensionRoot, 'native-browser-control-v1.js'));
    const sourceManifest = JSON.parse(await readFile(resolve('browser/extension/manifest.json'), 'utf8')) as { key?: string };
    if (!sourceManifest.key) throw new Error('extension key missing');
    await writeFile(join(extensionRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'WAG Browser v2 Runtime Attach Acceptance',
      version: '0.0.1',
      key: sourceManifest.key,
      permissions: ['debugger', 'nativeMessaging', 'storage', 'tabs'],
      background: { service_worker: 'worker.js', type: 'module' },
    }, null, 2), 'utf8');

    const loginUrl = `http://127.0.0.1:${web.port}/login`;
    await writeFile(join(extensionRoot, 'worker.js'), `
import { createExistingBrowserControlV1 } from './existing-browser-control-v1.js';
import { createNativeBrowserControlV1 } from './native-browser-control-v1.js';
const control = createExistingBrowserControlV1(chrome);
const native = createNativeBrowserControlV1({
  connectNative: () => chrome.runtime.connectNative('com.openai.web_agent_gateway_browser_control'),
  control,
});
native.ensureConnected();
chrome.tabs.create({ url: ${JSON.stringify(loginUrl)}, active: false });
`, 'utf8');

    child = spawn(EDGE, [
      `--user-data-dir=${profileRoot}`,
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--window-position=-32000,-32000',
      '--window-size=800,600',
      `http://127.0.0.1:${web.port}/holder`,
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });

    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-8000); });
    await waitForFile(discoveryPath);
    const control = createExistingBrowserControlClient({ discoveryPath, timeoutMs: 5000 });
    const expectedOrigin = `http://127.0.0.1:${web.port}`;
    const initial = await waitForTarget(control, expectedOrigin);
    const activeBefore = initial.targets.find((row) => row.active)?.targetId ?? null;
    if (initial.target.active) throw new Error('acceptance target unexpectedly became active');
    if (initial.target.url !== expectedOrigin + '/target') {
      throw new Error('authenticated redirect target was not preserved');
    }

    context = createPrivateBrowserMcpContext({
      owner: { ownerId: 'runtime_attach', sessionId: 'runtime_attach', adapterId: 'private.stdio.v1' },
      edgeExecutablePath: EDGE,
      profileRoot: join(root, 'wag-profiles'),
      effectStatePath: join(root, 'effects.sqlite'),
      controlDiscoveryPath: discoveryPath,
      killSwitch: () => false,
    });

    const listed = await context.targets();
    const target = listed.find((row) => row.targetId === initial.target.targetId);
    if (!target) throw new Error('BrowserMcpContext did not expose target');

    const opened = await context.open('authenticated-existing', 'ATTACH_EXISTING', target.targetId);
    if (opened.executionMode !== 'ATTACH_EXISTING' || opened.ownershipMode !== 'ATTACHED_EXISTING') {
      throw new Error('ATTACH_EXISTING session metadata mismatch');
    }
    const first = await context.snapshot(opened.browserSessionId);
    const input = first.nodes.find((node) => node.name === 'Name' && node.editable);
    const button = first.nodes.find((node) => node.name === 'Submit');
    if (!input || !button) throw new Error('semantic fixture nodes not discovered');

    const fill = await context.exec(opened.browserSessionId, 'runtime-attach.fill.1', {
      type: 'fill', ref: input.ref, text: 'WAG',
    });
    const click = await context.exec(opened.browserSessionId, 'runtime-attach.click.1', {
      type: 'click', ref: button.ref,
    });
    if (fill.state !== 'SUCCEEDED' || click.state !== 'SUCCEEDED') {
      throw new Error('semantic attached effects did not succeed');
    }
    const finalSnapshot = await context.snapshot(opened.browserSessionId);
    const submitted = finalSnapshot.nodes.some((node) => node.name.includes('submitted:WAG'));
    if (!submitted) throw new Error('attached semantic form result was not observed');

    const closed = await context.close(opened.browserSessionId);
    if (closed.state !== 'CLOSED') throw new Error('attached session did not release cleanly');
    const after = await control.listTargets();
    const targetAfter = after.find((row) => row.targetId === target.targetId);
    const activeAfter = after.find((row) => row.active)?.targetId ?? null;
    if (!targetAfter || targetAfter.attached) throw new Error('release did not preserve detached target');
    if (activeBefore !== activeAfter) throw new Error('attach workflow changed foreground tab');
    if (child.exitCode !== null) throw new Error('browser exited during attached release');

    process.stdout.write(JSON.stringify({
      status: 'PASS',
      extensionId: EXTENSION_ID,
      authenticatedTargetDiscovered: true,
      targetId: target.targetId,
      targetWasInactive: !target.active,
      activeTabStable: activeBefore === activeAfter,
      executionMode: opened.executionMode,
      ownershipMode: opened.ownershipMode,
      semanticSnapshot: true,
      semanticFill: fill.state,
      semanticClick: click.state,
      finalStateVerified: submitted,
      released: true,
      targetStillOpen: true,
      browserStillOpen: child.exitCode === null,
      rawCdpPublic: false,
      windowsUiAutomationUsed: false,
      userRealProfileUsed: false,
    }) + '\n');
  } finally {
    await context?.closeAll().catch(() => undefined);
    child?.kill();
    await web.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write('wag-browser-v2-runtime-attach: '
    + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
