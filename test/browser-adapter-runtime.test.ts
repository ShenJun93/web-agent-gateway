import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { promisify } from 'node:util';
import { McpLocalVerifyAdapterLink, type VerifyAdapterDiscovery } from '../src/browser-adapter/local-link-v3.js';
import { startBrowserAdapterRuntime } from '../scripts/browser-adapter-runtime.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';
import { BROWSER_VERIFY_ADAPTER_ID } from '../src/adapter-admission.js';
import { BROWSER_VERIFY_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v3.js';

const execFileAsync = promisify(execFile);
const correlationA = 'session_runtime_A';
const correlationB = 'session_runtime_B';
const browserVerifyFixtureRoot = new URL('../docs/benchmarks/fixtures/browser-verify-v1/', import.meta.url);
const browserVerifyFixtureManifestSha256 = '7097c3c10e7cd98917c90fd6d2c0325646555b252791b4bdabf3be2989df8e86';

async function materializeBrowserVerifyFixture(temp: string) {
  const manifest = await readFile(new URL('fixture-manifest.sha256', browserVerifyFixtureRoot));
  assert.equal(createHash('sha256').update(manifest).digest('hex'), browserVerifyFixtureManifestSha256);
  for (const line of manifest.toString('utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert.ok(match, `Invalid browser verify fixture manifest line: ${line}`);
    const content = await readFile(new URL(match[2]!, browserVerifyFixtureRoot));
    assert.equal(createHash('sha256').update(content).digest('hex'), match[1]);
  }
  const workspaceRoot = join(temp, 'repo');
  const outsideCanary = join(temp, 'outside-canary.txt');
  await cp(new URL('template/', browserVerifyFixtureRoot), workspaceRoot, { recursive: true });
  await cp(new URL('outside-canary.txt', browserVerifyFixtureRoot), outsideCanary);
  return { workspaceRoot, outsideCanary };
}

async function writeConfig(path: string, root: string, baseUrl: string, resourceUrl: string) {
  await writeFile(path, JSON.stringify({
    allowedRoots: [root],
    devspace: { baseUrl, resourceUrl },
    verifyProfiles: {},
  }), 'utf8');
}

async function rawAdmit(discovery: VerifyAdapterDiscovery, correlationId: string) {
  const response = await fetch(discovery.admissionUrl, {
    method: 'POST',
    headers: { authorization: `Bearer ${discovery.bootstrapToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ correlation_id: correlationId }),
  });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ mcp_url: string; bearer_token: string }>;
}

async function unauthorizedPing(mcpUrl: string, bearer: string) {
  return fetch(mcpUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
  });
}

function verifyJobCount(statePath: string): number {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT COUNT(*) AS count FROM verify_jobs').get() as { count: number };
    return Number(row.count);
  } finally {
    db.close();
  }
}

// Internal verify-job authority values. `verify.result` is browser-visible, so none of
// these may ever appear in what it returns.
function verifyJobAuthority(statePath: string): Record<string, string> {
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db.prepare(`SELECT job_id, owner_id, session_id, adapter_id, workspace_id, plan_sha256
      FROM verify_jobs`).get() as Record<string, string> | undefined;
    assert.ok(row, 'expected exactly one internal verify job');
    return {
      jobId: row.job_id!,
      ownerId: row.owner_id!,
      sessionId: row.session_id!,
      adapterId: row.adapter_id!,
      workspaceId: row.workspace_id!,
      planSha256: row.plan_sha256!,
    };
  } finally {
    db.close();
  }
}

test('browser runtime rejects relative durable state path before startup', async () => {
  await assert.rejects(() => startBrowserAdapterRuntime({
    configPath: 'C:\\absolute-config.json',
    discoveryPath: 'C:\\absolute-discovery.json',
    statePath: 'relative-state.sqlite',
    env: {},
  }), /state path must be absolute/i);
});

test('browser runtime isolates sessions and recovers owned workspace across WAG restart', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), 'alpha\nbeta\n', 'utf8');
  const temp = await mkdtemp(join(tmpdir(), 'wag-browser-runtime-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'private.json');
  const discoveryPath = join(temp, 'local-state', 'browser-adapter.json');
  const statePath = join(temp, 'local-state', 'control-plane.sqlite');
  await writeConfig(configPath, fixture.workspaceRoot, fixture.baseUrl, fixture.resourceUrl);

  const runtimeA = await startBrowserAdapterRuntime({
    configPath, discoveryPath, statePath,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });  t.after(() => runtimeA.close());

  const discoveryA = JSON.parse(await readFile(discoveryPath, 'utf8')) as VerifyAdapterDiscovery;
  assert.deepEqual(Object.keys(discoveryA).sort(), ['adapterId', 'admissionUrl', 'bootstrapToken', 'protocolVersion']);
  assert.equal(discoveryA.protocolVersion, BROWSER_VERIFY_PROTOCOL_VERSION);
  assert.equal(discoveryA.adapterId, BROWSER_VERIFY_ADAPTER_ID);
  assert.match(discoveryA.admissionUrl, /^http:\/\/127\.0\.0\.1:\d+\/adapter\/admit$/);
  assert.ok(Buffer.byteLength(discoveryA.bootstrapToken, 'utf8') >= 32);
  const renderedDiscovery = JSON.stringify(discoveryA);
  assert.equal(renderedDiscovery.includes(statePath), false);
  assert.equal(renderedDiscovery.includes(fixture.workspaceRoot), false);
  assert.doesNotMatch(renderedDiscovery, /owner_|\/mcp"/);

  const linkA = await McpLocalVerifyAdapterLink.admit(discoveryA, correlationA);
  t.after(() => linkA.close());
  const linkB = await McpLocalVerifyAdapterLink.admit(discoveryA, correlationB);
  t.after(() => linkB.close());
  const openedA = await linkA.call({
    version: BROWSER_VERIFY_PROTOCOL_VERSION, type: 'tool.call', requestId: 'req_runtime_open_A', sessionId: correlationA,
    tool: 'workspace.open', arguments: { path: fixture.workspaceRoot },
  });
  assert.equal(openedA.type, 'result');
  const workspaceA = openedA.type === 'result' ? (openedA.result as { workspaceId?: string }).workspaceId : undefined;
  assert.match(workspaceA ?? '', /^ws_/);

  const openedB = await linkB.call({
    version: BROWSER_VERIFY_PROTOCOL_VERSION, type: 'tool.call', requestId: 'req_runtime_open_B', sessionId: correlationB,
    tool: 'workspace.open', arguments: { path: fixture.workspaceRoot },
  });
  assert.equal(openedB.type, 'result');
  const workspaceB = openedB.type === 'result' ? (openedB.result as { workspaceId?: string }).workspaceId : undefined;
  assert.match(workspaceB ?? '', /^ws_/);
  assert.notEqual(workspaceB, workspaceA);

  const crossRead = await linkB.call({
    version: BROWSER_VERIFY_PROTOCOL_VERSION, type: 'tool.call', requestId: 'req_runtime_cross', sessionId: correlationB,
    tool: 'file.read', arguments: { workspace_id: workspaceA!, path: 'note.txt' },
  });
  assert.equal(crossRead.type, 'error');

  await linkA.close();
  await linkB.close();
  const stale = await rawAdmit(discoveryA, correlationA);
  await runtimeA.close();

  const runtimeB = await startBrowserAdapterRuntime({
    configPath, discoveryPath, statePath,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });
  t.after(() => runtimeB.close());
  const discoveryB = JSON.parse(await readFile(discoveryPath, 'utf8')) as VerifyAdapterDiscovery;
  assert.notEqual(discoveryB.bootstrapToken, discoveryA.bootstrapToken);
  const runtimeBProbe = await rawAdmit(discoveryB, 'session_runtime_probe');
  assert.equal((await unauthorizedPing(runtimeBProbe.mcp_url, stale.bearer_token)).status, 401);

  const recovered = await McpLocalVerifyAdapterLink.admit(discoveryB, correlationA);
  t.after(() => recovered.close());
  const read = await recovered.call({
    version: BROWSER_VERIFY_PROTOCOL_VERSION, type: 'tool.call', requestId: 'req_runtime_recover', sessionId: correlationA,
    tool: 'file.read', arguments: { workspace_id: workspaceA!, path: 'note.txt' },
  });
  assert.equal(read.type, 'result');
  assert.equal(read.type === 'result' ? (read.result as { content?: string }).content : undefined, 'alpha\nbeta');
  await recovered.close();

  await runtimeB.close();
  await assert.rejects(() => readFile(discoveryPath, 'utf8'), /ENOENT/);
  const devspaceStillAlive = await fetch(`${fixture.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(devspaceStillAlive.ok, true);
});

test('browser verify runtime requires local approval and keeps request authority session-bound', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'wag-browser-verify-runtime-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { workspaceRoot, outsideCanary } = await materializeBrowserVerifyFixture(temp);
  const outsideCanaryBaseline = await readFile(outsideCanary, 'utf8');
  await execFileAsync('git', ['init', workspaceRoot]);
  await execFileAsync('git', ['-C', workspaceRoot, 'add', '-A']);
  await execFileAsync('git', ['-C', workspaceRoot, '-c', 'user.name=WAG Test',
    '-c', 'user.email=wag@example.invalid', 'commit', '-m', 'fixture']);

  const previousSecret = process.env.WAG_TEST_SECRET;
  process.env.WAG_TEST_SECRET = 'browser-verify-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.WAG_TEST_SECRET;
    else process.env.WAG_TEST_SECRET = previousSecret;
  });

  const devspace = await startPinnedDevspace({ workspaceRoot });
  t.after(() => devspace.stop());
  const configPath = join(temp, 'private.json');
  const discoveryPath = join(temp, 'state', 'browser-adapter.json');
  const statePath = join(temp, 'state', 'control-plane.sqlite');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [workspaceRoot],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: devspace.resourceUrl },
    verifyProfiles: {
      unit: { argv: ['node', '--test'], timeoutMs: 10_000, maxOutputTokens: 1_000 },
    },
    browserVerifyProfiles: ['unit'],
  }), 'utf8');

  const runtime = await startBrowserAdapterRuntime({
    configPath, discoveryPath, statePath,
    env: { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
  });
  t.after(() => runtime.close());
  const discovery = JSON.parse(await readFile(discoveryPath, 'utf8')) as VerifyAdapterDiscovery;
  const discoveryText = JSON.stringify(discovery);
  assert.equal(discoveryText.includes(runtime.operatorOrigin), false);
  assert.equal(discoveryText.includes(runtime.operatorBootstrapUrl), false);
  assert.doesNotMatch(discoveryText, /operator|approval|csrf/i);

  const link = await McpLocalVerifyAdapterLink.admit(discovery, 'session_verify_runtime_A');
  t.after(() => link.close());
  const opened = await link.call({
    version: 3, type: 'tool.call', requestId: 'req_verify_open_01',
    sessionId: 'session_verify_runtime_A', tool: 'workspace.open',
    arguments: { path: workspaceRoot },
  });
  assert.equal(opened.type, 'result');
  const workspaceId = opened.type === 'result'
    ? (opened.result as { workspaceId?: string }).workspaceId : undefined;
  assert.match(workspaceId ?? '', /^ws_/);

  const preview = await link.call({
    version: 3, type: 'tool.call', requestId: 'req_verify_preview_01',
    sessionId: 'session_verify_runtime_A', tool: 'verify.preview',
    arguments: { workspace_id: workspaceId!, profile: 'unit' },
  });
  assert.equal(preview.type, 'result');
  const requestId = preview.type === 'result'
    ? (preview.result as { request_id?: string }).request_id : undefined;
  assert.match(requestId ?? '', /^verifyreq_/);
  assert.equal(verifyJobCount(statePath), 0, 'preview must not create an internal verify job');

  const pending = await link.call({
    version: 3, type: 'tool.call', requestId: 'req_verify_pending_01',
    sessionId: 'session_verify_runtime_A', tool: 'verify.result',
    arguments: { request_id: requestId! },
  });
  assert.equal(pending.type, 'result');
  assert.equal(pending.type === 'result'
    ? (pending.result as { state?: string }).state : undefined, 'PENDING_APPROVAL');

  const foreign = await McpLocalVerifyAdapterLink.admit(discovery, 'session_verify_runtime_B');
  t.after(() => foreign.close());
  const cross = await foreign.call({
    version: 3, type: 'tool.call', requestId: 'req_verify_cross_01',
    sessionId: 'session_verify_runtime_B', tool: 'verify.result',
    arguments: { request_id: requestId! },
  });
  assert.equal(cross.type, 'error');

  const boot = await fetch(runtime.operatorBootstrapUrl, { redirect: 'manual' });
  assert.equal(boot.status, 303);
  const cookie = boot.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  const page = await fetch(runtime.operatorOrigin, { headers: { cookie } });

  const html = await page.text();
  assert.match(html, /Verify unit/);
  assert.doesNotMatch(html, /browser-verify-secret|DEVSPACE_OAUTH_OWNER_TOKEN/);
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const approval = await fetch(
    `${runtime.operatorOrigin}/verifications/${encodeURIComponent(requestId!)}/approve`,
    {
      method: 'POST',
      headers: {
        cookie,
        origin: runtime.operatorOrigin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
      redirect: 'manual',
    },
  );
  assert.equal(approval.status, 303);
  assert.equal(verifyJobCount(statePath), 1, 'approval must create exactly one internal verify job');

  let completed: Awaited<ReturnType<typeof link.call>> | undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    completed = await link.call({
      version: 3, type: 'tool.call', requestId: `req_verify_result_${String(attempt).padStart(2, '0')}`,
      sessionId: 'session_verify_runtime_A', tool: 'verify.result',
      arguments: { request_id: requestId! },
    });
    const state = completed.type === 'result'
      ? (completed.result as { state?: string }).state : undefined;
    if (state === 'SUCCEEDED' || state === 'FAILED' || state === 'OUTCOME_UNKNOWN') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.ok(completed);
  assert.equal(completed.type, 'result');
  const result = completed.type === 'result'
    ? completed.result as {
      state?: string; exit_code?: number; output?: string; output_truncated?: boolean;
    } : {};
  assert.equal(result.state, 'SUCCEEDED');
  assert.equal(result.exit_code, 1);
  assert.equal(result.output_truncated, false);
  assert.match(result.output ?? '', /tests 2/);
  assert.match(result.output ?? '', /pass 1/);
  assert.match(result.output ?? '', /fail 1/);
  // `output` is verbatim untrusted subprocess text, so a keyword scan over it says nothing
  // about gateway authority: a repository's own test output legitimately contains words like
  // "operator" or "Bootstrap". Scan the envelope for authority-shaped names...
  const envelope = JSON.stringify(completed, (key, value) => (key === 'output' ? undefined : value));
  assert.doesNotMatch(envelope, /job_|ownerId|sessionId|adapterId|operator|bootstrap|csrf|browser-verify-secret|DEVSPACE_OAUTH_OWNER_TOKEN/i);

  // ...and scan the whole payload, captured output included, for the live authority values.
  const serialized = JSON.stringify(completed);
  const withheld: Record<string, string> = {
    ...verifyJobAuthority(statePath),
    operatorOrigin: runtime.operatorOrigin,
    operatorBootstrapUrl: runtime.operatorBootstrapUrl,
    operatorCookie: cookie,
    operatorCsrf: csrf,
    devspaceOwnerToken: DEVSPACE_TEST_OWNER_TOKEN,
    runtimeSecret: 'browser-verify-secret',
  };
  for (const [label, value] of Object.entries(withheld)) {
    assert.ok(value, `withheld value ${label} must be non-empty for the leak scan to mean anything`);
    assert.equal(serialized.includes(value), false, `browser verify result leaked ${label}`);
  }

  const snapshot = await link.call({
    version: 3, type: 'tool.call', requestId: 'req_verify_snapshot_01',
    sessionId: 'session_verify_runtime_A', tool: 'repo.snapshot',
    arguments: { workspace_id: workspaceId! },
  });
  assert.equal(snapshot.type, 'result');
  assert.equal(snapshot.type === 'result'
    ? (snapshot.result as { dirty?: boolean }).dirty : undefined, false);
  assert.equal(await readFile(outsideCanary, 'utf8'), outsideCanaryBaseline);

  await foreign.close();
  await link.close();
  await runtime.close();
});
