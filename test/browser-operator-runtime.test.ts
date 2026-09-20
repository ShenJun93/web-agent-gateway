import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { McpLocalOperatorAdapterLink, parseOperatorAdapterDiscovery } from '../src/browser-adapter/local-link-v4.js';
import { startBrowserOperatorRuntime } from '../src/browser-operator-runtime.js';
import { BROWSER_OPERATOR_ADAPTER_ID } from '../src/adapter-admission.js';
import { BROWSER_OPERATOR_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v4.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd })).stdout.trim();

let sequence = 0;
function requestId(): string {
  sequence += 1;
  return `req_operator_${String(sequence).padStart(4, '0')}`;
}

/**
 * Drives the local operator review server exactly as a human browser would: redeem the one-time
 * bootstrap, keep the session cookie, read the CSRF token out of the rendered page, and POST
 * with a matching Origin. Nothing here is available to the browser caller.
 */
class OperatorBrowser {
  private cookie = '';

  constructor(private readonly origin: string) {}

  async bootstrap(url: string): Promise<void> {
    const response = await fetch(url, { redirect: 'manual' });
    assert.equal(response.status, 303);
    this.cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
    assert.notEqual(this.cookie, '');
  }

  async review(kind: 'mutations' | 'commits', id: string): Promise<string> {
    const response = await fetch(`${this.origin}/${kind}/${encodeURIComponent(id)}`, {
      headers: { cookie: this.cookie },
    });
    assert.equal(response.status, 200);
    return response.text();
  }

  async approve(kind: 'mutations' | 'commits', id: string, page: string): Promise<number> {
    const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1];
    assert.ok(csrf, 'the review page must carry a CSRF token');
    const response = await fetch(`${this.origin}/${kind}/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie: this.cookie,
        origin: this.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }).toString(),
    });
    return response.status;
  }
}

async function fixture(t: test.TestContext) {
  const devspace = await startPinnedDevspace();
  const temp = await mkdtemp(join(tmpdir(), 'wag-operator-runtime-'));
  const root = devspace.workspaceRoot;

  await writeFile(join(root, 'tracked.txt'), 'original\n');
  await git(root, ['init', '--initial-branch=work', '.']);
  await git(root, ['config', 'user.email', 'wag@example.invalid']);
  await git(root, ['config', 'user.name', 'WAG Test']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);

  const configPath = join(temp, 'private.json');
  // The operator profile is asked for in the config, not implied by the entry point.
  const config = {
    allowedRoots: [root],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: `${devspace.baseUrl}/mcp` },
    verifyProfiles: {},
    repositoryEngineering: {
      mutation: { statePath: join(temp, 'engineering.sqlite') },
      gitCommit: {},
    },
  };
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const discoveryPath = join(temp, 'browser-adapter.json');
  const runtime = await startBrowserOperatorRuntime({
    configPath,
    discoveryPath,
    statePath: join(temp, 'state.sqlite'),
    env: { ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });

  t.after(async () => {
    await runtime.close();
    await devspace.stop();
    await rm(temp, { recursive: true, force: true });
  });

  const discovery = parseOperatorAdapterDiscovery(
    JSON.parse(await readFile(discoveryPath, 'utf8')) as unknown,
  );
  return { runtime, discovery, discoveryPath, root, temp };
}

test('the browser proposes and the local operator is the only thing that can commit', async (t) => {
  const f = await fixture(t);
  const link = await McpLocalOperatorAdapterLink.admit(f.discovery, 'session_11111111-1111-4111-8111-111111111111');
  t.after(() => link.close());

  assert.deepEqual([...await link.listTools()].sort(), [
    'file.create', 'file.read', 'git.commit', 'git.commit.result', 'health',
    'mutation.preview', 'mutation.result', 'repo.search', 'repo.snapshot',
    'verify.preview', 'verify.result', 'workspace.open',
  ]);

  const call = async (tool: string, args: Record<string, unknown>) => link.call({
    version: BROWSER_OPERATOR_PROTOCOL_VERSION,
    type: 'tool.call',
    requestId: requestId(),
    sessionId: 'session_11111111-1111-4111-8111-111111111111',
    tool,
    arguments: args,
  } as never);

  const opened = await call('workspace.open', { path: f.root });
  assert.equal(opened.type, 'result');
  const workspaceId = (opened as { result: { workspaceId: string } }).result.workspaceId;

  // A proposal must change nothing.
  const headBefore = await git(f.root, ['rev-parse', 'HEAD']);
  await writeFile(join(f.root, 'tracked.txt'), 'changed by the browser\n');
  const proposed = await call('git.commit', {
    workspace_id: workspaceId, paths: ['tracked.txt'], message: 'chore: from the browser\n',
  });
  assert.equal(proposed.type, 'result');
  const commitId = (proposed as { result: { commitId: string } }).result.commitId;
  assert.match(commitId, /^cmt_/);
  assert.equal(await git(f.root, ['rev-parse', 'HEAD']), headBefore, 'proposing must not commit');

  // The browser can poll its own record and learns nothing else.
  const polled = await call('git.commit.result', { commit_id: commitId });
  assert.equal(polled.type, 'result');
  assert.equal((polled as { result: { state: string } }).result.state, 'PENDING_APPROVAL');
  assert.equal(JSON.stringify(polled).includes(f.runtime.operatorOrigin), false,
    'the browser must never learn the operator origin');

  // The local operator, over a channel the browser cannot reach, is what makes it happen.
  const operator = new OperatorBrowser(f.runtime.operatorOrigin);
  await operator.bootstrap(f.runtime.operatorBootstrapUrl);
  const page = await operator.review('commits', commitId);
  assert.ok(page.includes('tracked.txt'), 'the operator sees the selected path');
  assert.equal(await operator.approve('commits', commitId, page), 303);

  const headAfter = await git(f.root, ['rev-parse', 'HEAD']);
  assert.notEqual(headAfter, headBefore, 'approval is what commits');
  assert.equal(await git(f.root, ['rev-parse', 'HEAD^']), headBefore, 'exactly one parent');
  assert.equal(await git(f.root, ['show', 'HEAD:tracked.txt']), 'changed by the browser');

  const settled = await call('git.commit.result', { commit_id: commitId });
  assert.equal((settled as { result: { state: string } }).result.state, 'SUCCEEDED');
});

test('a second browser session cannot reach the first session records', async (t) => {
  const f = await fixture(t);
  const first = await McpLocalOperatorAdapterLink.admit(f.discovery, 'session_22222222-2222-4222-8222-222222222222');
  t.after(() => first.close());

  const callOn = (link: McpLocalOperatorAdapterLink, sessionId: string) =>
    async (tool: string, args: Record<string, unknown>) => link.call({
      version: BROWSER_OPERATOR_PROTOCOL_VERSION,
      type: 'tool.call',
      requestId: requestId(),
      sessionId,
      tool,
      arguments: args,
    } as never);

  const callFirst = callOn(first, 'session_22222222-2222-4222-8222-222222222222');
  const opened = await callFirst('workspace.open', { path: f.root });
  const workspaceId = (opened as { result: { workspaceId: string } }).result.workspaceId;
  await writeFile(join(f.root, 'tracked.txt'), 'first session change\n');
  const proposed = await callFirst('git.commit', {
    workspace_id: workspaceId, paths: ['tracked.txt'], message: 'chore: first\n',
  });
  const commitId = (proposed as { result: { commitId: string } }).result.commitId;

  // A different correlation is a different durable session, even from the same browser.
  const second = await McpLocalOperatorAdapterLink.admit(f.discovery, 'session_33333333-3333-4333-8333-333333333333');
  t.after(() => second.close());
  const callSecond = callOn(second, 'session_33333333-3333-4333-8333-333333333333');

  const stolenResult = await callSecond('git.commit.result', { commit_id: commitId });
  assert.equal(stolenResult.type, 'error', 'another session must not read the record');

  const stolenWorkspace = await callSecond('file.read', { workspace_id: workspaceId, path: 'tracked.txt' });
  assert.equal(stolenWorkspace.type, 'error', 'another session must not use the workspace id');

  const stolenProposal = await callSecond('git.commit', {
    workspace_id: workspaceId, paths: ['tracked.txt'], message: 'chore: stolen\n',
  });
  assert.equal(stolenProposal.type, 'error', 'another session must not propose against it');
});

test('discovery carries no operator credential and no approval channel', async (t) => {
  const f = await fixture(t);
  const raw = await readFile(f.discoveryPath, 'utf8');
  const discovery = JSON.parse(raw) as Record<string, unknown>;

  assert.deepEqual(Object.keys(discovery).sort(), ['adapterId', 'admissionUrl', 'bootstrapToken', 'protocolVersion']);
  assert.equal(discovery.adapterId, BROWSER_OPERATOR_ADAPTER_ID);
  assert.equal(discovery.protocolVersion, BROWSER_OPERATOR_PROTOCOL_VERSION);

  const operatorPort = new URL(f.runtime.operatorOrigin).port;
  assert.equal(raw.includes(operatorPort), false, 'the operator port must not be discoverable');
  for (const fragment of ['/bootstrap', 'csrf', 'wag_operator_session', DEVSPACE_TEST_OWNER_TOKEN]) {
    assert.equal(raw.includes(fragment), false, `discovery must not contain ${fragment}`);
  }
});

test('the operator profile is refused unless the config asks for it', async (t) => {
  const devspace = await startPinnedDevspace();
  const temp = await mkdtemp(join(tmpdir(), 'wag-operator-gate-'));
  t.after(async () => { await devspace.stop(); await rm(temp, { recursive: true, force: true }); });

  const base = {
    allowedRoots: [devspace.workspaceRoot],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: `${devspace.baseUrl}/mcp` },
    verifyProfiles: {},
  };
  const discoveryPath = join(temp, 'browser-adapter.json');
  const start = async (repositoryEngineering: unknown) => {
    const configPath = join(temp, `private-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(configPath, JSON.stringify(
      repositoryEngineering === undefined ? base : { ...base, repositoryEngineering },
    ), 'utf8');
    return startBrowserOperatorRuntime({
      configPath,
      discoveryPath,
      statePath: join(temp, 'state.sqlite'),
      env: { ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    });
  };

  await assert.rejects(start(undefined), /requires repositoryEngineering\.mutation/);
  await assert.rejects(start({ inspect: true }), /requires repositoryEngineering\.mutation/);
  // gitCommit needs mutation on this surface too; half the pair is a mistake, not a capability.
  await assert.rejects(
    start({ mutation: { statePath: join(temp, 'engineering.sqlite') } }),
    /requires repositoryEngineering\.gitCommit/,
  );

  // Nothing was published for any refused start.
  await assert.rejects(readFile(discoveryPath, 'utf8'));
});
