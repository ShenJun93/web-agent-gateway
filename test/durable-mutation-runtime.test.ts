import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import { startDurableMutationMcpFixture } from './durable-mutation-mcp-fixture.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const caller = { ownerId: 'owner_runtime', sessionId: 'session_runtime', adapterId: 'browser_bridge_runtime' };
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function cookiePair(value: string | null): string {
  assert.ok(value);
  return value.split(';', 1)[0]!;
}
test('durable mutation runtime reconciles before serving and owns only its local resources', async (t) => {
  const fixture = await startPinnedDevspace();
  t.after(() => fixture.stop());
  const temp = await mkdtemp(join(tmpdir(), 'wag-durable-runtime-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = join(temp, 'private.json');
  const statePath = join(temp, 'state.sqlite');
  const note = 'alpha\nbeta\ngamma\n';
  await writeFile(join(fixture.workspaceRoot, 'note.txt'), note);
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [fixture.workspaceRoot],
    devspace: { baseUrl: fixture.baseUrl, resourceUrl: fixture.resourceUrl },
    verifyProfiles: {},
  }));

  const before = new SqliteDurableStore(statePath);
  const expiredWorkspace = before.openWorkspaceRecord({ ...caller, canonicalRoot: fixture.workspaceRoot, backendKind: 'devspace-file', createdAt: 1 });
  const expired = before.createMutation({
    ...caller, workspaceId: expiredWorkspace.workspaceId, backendKind: 'devspace-file', path: 'note.txt',
    baseSha256: sha256(note), before: 'beta', after: 'BETA', resultSha256: sha256(note.replace('beta', 'BETA')),
    fingerprint: 'f'.repeat(64), additions: 1, removals: 1, createdAt: 1, reviewDeadline: 2,
  });
  before.close();

  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN };
  const runtime = await startDurableMutationMcpFixture({ configPath, statePath, caller, env });
  t.after(() => runtime.close());
  assert.match(runtime.operatorOrigin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(runtime.operatorBootstrapUrl, /\/bootstrap\?token=/);
  const boot = await fetch(runtime.operatorBootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const operatorPage = await fetch(runtime.operatorOrigin, { headers: { cookie } });
  const operatorHtml = await operatorPage.text();
  assert.doesNotMatch(operatorHtml, new RegExp(expired.mutationId));

  const client = runtime.client;
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), [
    'health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run',
    'mutation.preview', 'file.create', 'mutation.result',
  ]);

  const opened = await client.callTool({ name: 'workspace.open', arguments: { path: fixture.workspaceRoot } });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);
  const preview = await client.callTool({ name: 'mutation.preview', arguments: {
    workspace_id: workspaceId, path: 'note.txt', base_sha256: sha256(note), before: 'beta', after: 'BETA',
  } });
  const mutationId = (preview.structuredContent as { mutationId?: string } | undefined)?.mutationId;
  assert.match(mutationId ?? '', /^mut_/);
  assert.doesNotMatch(JSON.stringify(preview), /bootstrap|operatorOrigin|owner_runtime|session_runtime/i);

  const result = await client.callTool({ name: 'mutation.result', arguments: { mutation_id: mutationId } });
  assert.equal((result.structuredContent as { state?: string } | undefined)?.state, 'PENDING_APPROVAL');

  await client.close();
  await runtime.close();
  const devspaceStillAlive = await fetch(`${fixture.baseUrl}/.well-known/oauth-authorization-server`);
  assert.equal(devspaceStillAlive.ok, true);
});
