import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createNodeCdpTransport } from '../src/browser-harness/node-cdp-transport.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const EXTENSION_ID = 'nnhhhppkpogkedpjnijeagcbfjaoogec';

async function startFixture(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createHttpServer((request, response) => {
    if (request.url?.startsWith('/target')) {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>WAG Browser v2 target</title><h1 id="ready">ready</h1>');
      return;
    }
    response.writeHead(404).end('not found');
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind TCP');
  return {
    port: address.port,
    close: () => new Promise<void>((resolvePromise, reject) => {
      server.close((error) => error ? reject(error) : resolvePromise());
    }),
  };
}

async function waitForDebugPort(
  profileRoot: string,
  processState: () => { exitCode: number | null; stderr: string },
): Promise<number> {
  const path = join(profileRoot, 'DevToolsActivePort');
  const deadline = Date.now() + 15_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const [line] = (await readFile(path, 'utf8')).split(/\r?\n/);
      const port = Number(line);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  const state = processState();
  throw new Error('DevToolsActivePort was not created; exit=' + String(state.exitCode)
    + '; stderr=' + state.stderr.slice(-2000)
    + '; last=' + (last instanceof Error ? last.message : 'unknown'));
}

async function waitForResult(debugPort: number): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  const resultUrl = `chrome-extension://${EXTENSION_ID}/result.html`;
  let last: unknown;
  let observedTargets: Array<{ type?: string; url?: string }> = [];
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (!response.ok) throw new Error('CDP target list unavailable');
      const targets = await response.json() as Array<{ type?: string; url?: string; webSocketDebuggerUrl?: string }>;
      observedTargets = targets.map(({ type, url }) => ({ type, url }));
      const target = targets.find((row) =>
        row.type === 'service_worker'
        && row.url === `chrome-extension://${EXTENSION_ID}/worker.js`
        && row.webSocketDebuggerUrl);
      if (target?.webSocketDebuggerUrl) {
        const transport = await createNodeCdpTransport({
          endpointUrl: target.webSocketDebuggerUrl,
          commandTimeoutMs: 2_000,
        });
        try {
          const command = await transport.send({
            id: 1,
            method: 'Runtime.evaluate',
            params: {
              expression: "chrome.storage.local.get('wagBrowserV2Spike').then((v) => JSON.stringify(v.wagBrowserV2Spike ?? null))",
              awaitPromise: true,
              returnByValue: true,
            },
          });
          const text = 'result' in command ? (command.result as any)?.result?.value : undefined;
          if (typeof text === 'string' && text !== 'null') {
            const parsed = JSON.parse(text) as Record<string, unknown>;
            if (parsed.status === 'PASS' || parsed.status === 'FAIL') return parsed;
          }
        } finally {
          await transport.close();
        }
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150));
  }
  throw new Error('Real Edge attach spike timed out: '
    + (last instanceof Error ? last.message : 'no result')
    + '; targets=' + JSON.stringify(observedTargets).slice(0, 4000));
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Real Edge attach spike requires Windows');

  const fixture = await startFixture();
  const tempRoot = await mkdtemp(join(tmpdir(), 'wag-browser-v2-spike-'));
  const extensionRoot = join(tempRoot, 'extension');
  const profileRoot = join(tempRoot, 'profile');
  let debugPort = 0;
  const targetUrl = `http://127.0.0.1:${fixture.port}/target?oauth_secret=must_not_escape#fragment`;
  const resultUrl = `chrome-extension://${EXTENSION_ID}/result.html`;
  let child: ReturnType<typeof spawn> | undefined;
  let childExitCode: number | null = null;
  let childStderr = '';

  try {
    await mkdir(extensionRoot, { recursive: true });
    await copyFile(
      resolve('browser/extension/existing-browser-control-v1.js'),
      join(extensionRoot, 'existing-browser-control-v1.js'),
    );
    const sourceManifest = JSON.parse(
      await readFile(resolve('browser/extension/manifest.json'), 'utf8'),
    ) as { key?: string };
    if (!sourceManifest.key) throw new Error('Extension key is missing');

    await writeFile(join(extensionRoot, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      name: 'WAG Browser v2 Attach Spike',
      version: '0.0.1',
      key: sourceManifest.key,
      permissions: ['debugger', 'storage', 'tabs'],
      background: { service_worker: 'worker.js', type: 'module' },
    }, null, 2));

    await writeFile(join(extensionRoot, 'worker.js'), `
import { createExistingBrowserControlV1 } from './existing-browser-control-v1.js';
const control = createExistingBrowserControlV1(chrome);
const targetUrl = ${JSON.stringify(targetUrl)};

async function waitForTarget() {
  await chrome.tabs.create({ url: targetUrl, active: false });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const targets = await control.listTargets();
    const target = targets.find((row) => row.url === new URL(targetUrl).origin + '/target');
    if (target?.tabId !== null && target?.tabId !== undefined) return target;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('TARGET_NOT_FOUND');
}

async function run() {
  const target = await waitForTarget();
  const activeBefore = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  const attached = await control.attach(target.tabId);
  const probe = await control.probe(target.tabId);
  const activeDuring = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  const release = await control.release(target.tabId);
  const targetAfter = await chrome.tabs.get(target.tabId);
  const activeAfter = (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id ?? null;
  const result = {
    status: activeBefore === activeDuring && activeDuring === activeAfter && targetAfter.id === target.tabId
      && attached.state === 'ATTACHED' && probe.attached === true && release.released === true
      ? 'PASS' : 'FAIL',
    discovered: true,
    targetWasActive: target.active,
    activeStable: activeBefore === activeDuring && activeDuring === activeAfter,
    attached: attached.state === 'ATTACHED',
    probeOrigin: probe.origin,
    probeUrl: probe.url,
    querySecretLeaked: JSON.stringify({ target, probe }).includes('oauth_secret'),
    released: release.released,
    targetStillOpen: targetAfter.id === target.tabId,
  };
  await chrome.storage.local.set({ wagBrowserV2Spike: result });
}

run().catch(async (error) => {
  await chrome.storage.local.set({
    wagBrowserV2Spike: {
      status: 'FAIL',
      errorClass: error?.code ?? error?.name ?? 'Error',
    },
  });
});
`);

    await writeFile(join(extensionRoot, 'result.html'),
      '<!doctype html><meta charset="utf-8"><body>WAITING<script type="module" src="result.js"></script>');
    await writeFile(join(extensionRoot, 'result.js'), `
async function poll() {
  const value = (await chrome.storage.local.get('wagBrowserV2Spike')).wagBrowserV2Spike;
  if (value) {
    document.body.textContent = JSON.stringify(value);
    return;
  }
  setTimeout(poll, 100);
}
void poll();
`);

    child = spawn(EDGE, [
      `--user-data-dir=${profileRoot}`,
      '--remote-debugging-port=0',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=msEdgeFirstRunExperience',
      '--window-position=-32000,-32000',
      '--window-size=800,600',
      resultUrl,
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr?.on('data', (chunk) => {
      childStderr = (childStderr + String(chunk)).slice(-8000);
    });
    child.once('exit', (code) => { childExitCode = code; });

    debugPort = await waitForDebugPort(profileRoot, () => ({
      exitCode: childExitCode,
      stderr: childStderr,
    }));
    const result = await waitForResult(debugPort);
    process.stdout.write(JSON.stringify({
      ...result,
      usedTemporaryProfile: true,
      usedRealEdge: true,
      browserClosedByRelease: false,
    }) + '\n');
    if (result.status !== 'PASS') process.exitCode = 1;
  } finally {
    child?.kill();
    await fixture.close().catch(() => undefined);
    await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write('wag-browser-v2-real-edge-spike: ' + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
