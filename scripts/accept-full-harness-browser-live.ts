import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { isAbsolute, join } from 'node:path';

import type { PrivateGatewayConfig } from '../src/private-config.js';
import { startRepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

interface AcceptanceReceipt {
  version: 1;
  session: string;
  source: 'full-harness-live-owned-browser-v1';
  fixtureUrl: string;
  browserSessionId: string;
  profileId: string;
  processId?: string;
  pid?: number;
  openState: string;
  closedState: string;
  navigationEffectId: string;
  clickEffectId: string;
  clickAttemptId?: string;
  retryEffectId: string;
  exactOnceTitle: string;
  screenshotPath: string;
  screenshotSha256: string;
  ownerPath: string;
  ownerRecord: unknown;
  comspecPresent: boolean;
  processGoneAfterClose: boolean;
  completedAtUtc: string;
}

const DEFAULT_SESSION = 'wag-full-harness-live-20260925-a1';
const DEFAULT_EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const DEFAULT_PROFILE_ROOT = 'E:\\AI-BROWSER\\profiles';
const DEFAULT_OUTPUT_ROOT = 'E:\\AI-BROWSER\\output';
const SESSION = /^[A-Za-z0-9._:-]{1,128}$/;

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function startFixture(): Promise<{ server: Server; url: string }> {
  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>WAG BrowserPort Fixture</title></head>
<body>
  <main>
    <h1>WAG BrowserPort Live Acceptance</h1>
    <button id="accept" type="button">Activate acceptance</button>
    <p id="status">count:0</p>
  </main>
  <script>
    let count = 0;
    document.getElementById('accept').addEventListener('click', () => {
      count += 1;
      document.getElementById('status').textContent = 'count:' + count;
      document.title = 'WAG BrowserPort Accepted ' + count;
    });
  </script>
</body>
</html>`;

  const server = createServer((request, response) => {
    if (request.url !== '/') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  });
  server.unref();

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fixture did not bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  return { server, url: `http://127.0.0.1:${port}/` };
}

async function main(): Promise<void> {
  const session = arg('--session', DEFAULT_SESSION);
  const edgeExecutablePath = arg('--edge', DEFAULT_EDGE);
  const profileRoot = arg('--profile-root', DEFAULT_PROFILE_ROOT);
  const outputRoot = arg('--output-root', DEFAULT_OUTPUT_ROOT);

  if (!SESSION.test(session)) throw new Error('Acceptance session name is invalid');
  for (const [label, value] of [
    ['edge executable', edgeExecutablePath],
    ['profile root', profileRoot],
    ['output root', outputRoot],
  ] as const) {
    if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  }
  if (!existsSync(edgeExecutablePath)) throw new Error('Edge executable does not exist');

  const profilePath = join(profileRoot, session);
  const outputPath = join(outputRoot, session);
  if (existsSync(profilePath)) {
    throw new Error(`Acceptance profile already exists; refusing reuse: ${profilePath}`);
  }
  if (existsSync(outputPath)) {
    throw new Error(`Acceptance output already exists; refusing reuse: ${outputPath}`);
  }

  await mkdir(outputRoot, { recursive: true });
  await mkdir(outputPath);
  const statePath = join(outputPath, 'wag-state.sqlite');
  const screenshotPath = join(outputPath, 'screenshot.png');
  const receiptPath = join(outputPath, 'acceptance.json');
  const ownerPath = join(profilePath, 'OWNER.json');

  const fixture = await startFixture();
  let runtime: Awaited<ReturnType<typeof startRepositoryEngineeringRuntime>> | undefined;
  let browserSessionId: string | undefined;
  let closed = false;

  try {
    const config: PrivateGatewayConfig = {
      allowedRoots: [process.cwd()],
      devspace: {
        baseUrl: 'http://127.0.0.1:7677',
        resourceUrl: 'http://127.0.0.1:7677/mcp',
      },
      verifyProfiles: {},
      repositoryEngineering: {
        inspect: true,
        mutation: {
          statePath,
          ownerId: 'local.private.stdio',
          sessionCorrelation: `session_${randomUUID()}`,
        },
        browser: {
          edgeExecutablePath,
          profileRoot,
        },
      },
    };

    runtime = await startRepositoryEngineeringRuntime(config);
    const browser = runtime.browserContext;
    assert.ok(browser, 'BrowserPort context was not assembled');

    const opened = await browser.open(session);
    browserSessionId = opened.browserSessionId;
    assert.equal(opened.profileId, session);
    assert.equal(opened.backend, 'cdp');
    assert.equal(opened.state, 'ACTIVE');
    assert.ok(opened.processId, 'owned Edge process id missing');
    assert.ok(opened.pid && opened.pid > 0, 'owned Edge PID missing');

    const ownerRecord = JSON.parse(await readFile(ownerPath, 'utf8')) as {
      session?: string;
      caller?: string;
      purpose?: string;
      created_at?: string;
      profile_path?: string;
    };
    assert.equal(ownerRecord.session, session);
    assert.equal(ownerRecord.purpose, 'WAG BrowserPort dedicated profile');
    assert.equal(ownerRecord.profile_path, profilePath);
    assert.equal(typeof ownerRecord.caller, 'string');
    assert.equal(typeof ownerRecord.created_at, 'string');

    const navigation = await browser.exec(
      opened.browserSessionId,
      `${session}.navigate.1`,
      { type: 'navigate', url: fixture.url },
    );
    assert.equal(navigation.state, 'SUCCEEDED');

    let fixtureSnapshot: Awaited<ReturnType<typeof browser.snapshot>> | undefined;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const snapshot = await browser.snapshot(opened.browserSessionId);
        if (snapshot.title === 'WAG BrowserPort Fixture') {
          fixtureSnapshot = snapshot;
          break;
        }
      } catch {
        // Navigation can transiently invalidate the accessibility tree while the page commits.
      }
      await delay(100);
    }
    assert.ok(fixtureSnapshot, 'fixture did not become semantically observable');

    const button = fixtureSnapshot.nodes.find(
      (node) => node.role === 'button' && node.name === 'Activate acceptance',
    );
    assert.ok(button, 'semantic snapshot did not expose the acceptance button');

    const clickAction = { type: 'click' as const, ref: button.ref };
    const click = await browser.exec(
      opened.browserSessionId,
      `${session}.click.1`,
      clickAction,
    );
    assert.equal(click.state, 'SUCCEEDED');

    let acceptedSnapshot: Awaited<ReturnType<typeof browser.snapshot>> | undefined;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const snapshot = await browser.snapshot(opened.browserSessionId);
      if (snapshot.title === 'WAG BrowserPort Accepted 1') {
        acceptedSnapshot = snapshot;
        break;
      }
      await delay(50);
    }
    assert.ok(acceptedSnapshot, 'semantic click was not observed in page state');

    const retry = await browser.exec(
      opened.browserSessionId,
      `${session}.click.1`,
      clickAction,
    );
    assert.equal(retry.effectId, click.effectId, 'idempotent retry returned a different effect');
    assert.equal(retry.state, 'SUCCEEDED');

    const afterRetry = await browser.snapshot(opened.browserSessionId);
    assert.equal(
      afterRetry.title,
      'WAG BrowserPort Accepted 1',
      'idempotent retry dispatched the click more than once',
    );

    const screenshot = await browser.screenshot(opened.browserSessionId);
    const screenshotBytes = Buffer.from(screenshot.dataBase64, 'base64');
    assert.ok(screenshotBytes.length > 100, 'screenshot payload is unexpectedly small');
    await writeFile(screenshotPath, screenshotBytes);

    const closedHandle = await browser.close(opened.browserSessionId);
    closed = true;
    assert.equal(closedHandle.state, 'CLOSED');

    let processGoneAfterClose = false;
    try {
      process.kill(opened.pid!, 0);
    } catch {
      processGoneAfterClose = true;
    }
    assert.equal(processGoneAfterClose, true, 'owned Edge PID remained alive after exact close');

    const receipt: AcceptanceReceipt = {
      version: 1,
      session,
      source: 'full-harness-live-owned-browser-v1',
      fixtureUrl: fixture.url,
      browserSessionId: opened.browserSessionId,
      profileId: opened.profileId,
      processId: opened.processId,
      pid: opened.pid,
      openState: opened.state,
      closedState: closedHandle.state,
      navigationEffectId: navigation.effectId,
      clickEffectId: click.effectId,
      ...(click.attemptId === undefined ? {} : { clickAttemptId: click.attemptId }),
      retryEffectId: retry.effectId,
      exactOnceTitle: afterRetry.title,
      screenshotPath,
      screenshotSha256: createHash('sha256').update(screenshotBytes).digest('hex'),
      ownerPath,
      ownerRecord,
      comspecPresent: Boolean(process.env.ComSpec ?? process.env.COMSPEC),
      processGoneAfterClose,
      completedAtUtc: new Date().toISOString(),
    };
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    if (runtime) {
      if (browserSessionId && !closed) {
        await runtime.browserContext?.close(browserSessionId).catch(() => undefined);
      }
      await runtime.close().catch(() => undefined);
    }
    await closeServer(fixture.server).catch(() => undefined);
  }
}

await main();
