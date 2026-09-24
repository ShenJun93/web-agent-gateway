import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  adapterCorrelationDigest,
  BROWSER_OPERATOR_ADAPTER_ID,
} from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { loadPrivateGatewayConfig, type PrivateGatewayConfig } from '../src/private-config.js';
import {
  PRIVATE_STDIO_ADAPTER_ID,
  startRepositoryEngineeringRuntime,
} from '../src/repository-engineering-runtime.js';

/**
 * Direct-MCP session correlation is identity/audit continuity only.
 *
 * It must survive reconnects, remain domain-separated by owner and adapter, and keep caller-owned
 * workspace handles isolated. It is not an authority grant: private stdio authority comes from
 * the trusted AUTONOMOUS_LOCAL profile plus the emergency kill switch.
 */
const CORRELATION = 'session_11111111-2222-3333-4444-555555555555';
const OTHER_CORRELATION = 'session_99999999-8888-7777-6666-555555555555';
const OWNER = 'local.private.stdio';

async function scratch(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wag-session-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function withStore<T>(dir: string, body: (store: SqliteDurableStore) => T): T {
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  try {
    return body(store);
  } finally {
    store.close();
  }
}

function configFor(
  dir: string,
  over: { sessionCorrelation?: string } = {},
  statePath = join(dir, 'state.sqlite'),
): PrivateGatewayConfig {
  return {
    allowedRoots: [dir],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath,
        ownerId: OWNER,
        ...over,
      },
    },
  };
}

async function sessionsAfterStart(config: PrivateGatewayConfig): Promise<readonly string[]> {
  const runtime = await startRepositoryEngineeringRuntime(config);
  await runtime.close();
  const store = new SqliteDurableStore(config.repositoryEngineering!.mutation!.statePath);
  try {
    return store.listAdapterSessions(PRIVATE_STDIO_ADAPTER_ID).map((row) => row.sessionId);
  } finally {
    store.close();
  }
}

test('the same correlation is the same session across restarts', async (t) => {
  const dir = await scratch(t);
  const config = configFor(dir, { sessionCorrelation: CORRELATION });

  const first = await sessionsAfterStart(config);
  const second = await sessionsAfterStart(config);

  assert.equal(first.length, 1);
  assert.deepEqual(second, first);
  assert.match(first[0]!, /^session_/);
});

test('without a correlation the session remains process-local', async (t) => {
  const dir = await scratch(t);
  const config = configFor(dir);

  await sessionsAfterStart(config);
  const sessions = await sessionsAfterStart(config);

  assert.deepEqual(sessions, []);
});

test('different correlations remain different stable sessions', async (t) => {
  const dir = await scratch(t);

  await sessionsAfterStart(configFor(dir, { sessionCorrelation: CORRELATION }));
  const sessions = await sessionsAfterStart(configFor(dir, { sessionCorrelation: OTHER_CORRELATION }));

  assert.equal(sessions.length, 2);
  assert.notEqual(sessions[0], sessions[1]);
});

test('the same correlation under a different owner is a different session', async (t) => {
  const dir = await scratch(t);
  withStore(dir, (store) => {
    const mine = store.getOrCreateAdapterSession({
      ownerId: OWNER,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(OWNER, PRIVATE_STDIO_ADAPTER_ID, CORRELATION),
      createdAt: 1,
    });
    const theirs = store.getOrCreateAdapterSession({
      ownerId: 'someone.else',
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest('someone.else', PRIVATE_STDIO_ADAPTER_ID, CORRELATION),
      createdAt: 1,
    });
    assert.notEqual(mine.sessionId, theirs.sessionId);
  });
});

test('the same correlation on a browser adapter cannot acquire the private-stdio session', async (t) => {
  const dir = await scratch(t);
  withStore(dir, (store) => {
    const stdio = store.getOrCreateAdapterSession({
      ownerId: OWNER,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(OWNER, PRIVATE_STDIO_ADAPTER_ID, CORRELATION),
      createdAt: 1,
    });
    const browser = store.getOrCreateAdapterSession({
      ownerId: OWNER,
      adapterId: BROWSER_OPERATOR_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(OWNER, BROWSER_OPERATOR_ADAPTER_ID, CORRELATION),
      createdAt: 1,
    });

    assert.notEqual(stdio.sessionId, browser.sessionId);
    assert.notEqual(
      adapterCorrelationDigest(OWNER, PRIVATE_STDIO_ADAPTER_ID, CORRELATION),
      adapterCorrelationDigest(OWNER, BROWSER_OPERATOR_ADAPTER_ID, CORRELATION),
    );
  });
});

test('goalLeaseId is no longer accepted by the private config schema', async (t) => {
  const dir = await scratch(t);
  const configPath = join(dir, 'wag.config.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [dir],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(dir, 'state.sqlite'),
        ownerId: OWNER,
        sessionCorrelation: CORRELATION,
        goalLeaseId: 'lease_retired',
      },
    },
  }));

  await assert.rejects(() => loadPrivateGatewayConfig(configPath));
});

test('a guessable correlation is refused by configuration', async (t) => {
  const dir = await scratch(t);
  const configPath = join(dir, 'wag.config.json');
  const write = (sessionCorrelation: string) => writeFile(configPath, JSON.stringify({
    allowedRoots: [dir],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      mutation: { statePath: join(dir, 'state.sqlite'), ownerId: OWNER, sessionCorrelation },
    },
  }));

  await write('my-laptop');
  await assert.rejects(() => loadPrivateGatewayConfig(configPath));

  await write(CORRELATION);
  const config = await loadPrivateGatewayConfig(configPath);
  assert.equal(config.repositoryEngineering?.mutation?.sessionCorrelation, CORRELATION);
});

test('two direct connector lanes keep distinct stable sessions and workspace ownership in one store', async (t) => {
  const dir = await scratch(t);
  const rootA = join(dir, 'lane-a');
  const rootB = join(dir, 'lane-b');
  const statePath = join(dir, 'shared-state.sqlite');
  await mkdir(rootA, { recursive: true });
  await mkdir(rootB, { recursive: true });

  const laneConfig = (root: string, correlation: string): PrivateGatewayConfig => ({
    allowedRoots: [root],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      gitCommit: {},
      mutation: {
        statePath,
        ownerId: OWNER,
        sessionCorrelation: correlation,
      },
    },
  });

  const firstA = await startRepositoryEngineeringRuntime(laneConfig(rootA, CORRELATION));
  const firstB = await startRepositoryEngineeringRuntime(laneConfig(rootB, OTHER_CORRELATION));
  let sessionA = '';
  let sessionB = '';
  let workspaceA = '';
  let workspaceB = '';
  try {
    sessionA = firstA.profile.stableSessionId ?? '';
    sessionB = firstB.profile.stableSessionId ?? '';
    assert.match(sessionA, /^session_/);
    assert.match(sessionB, /^session_/);
    assert.notEqual(sessionA, sessionB);

    workspaceA = firstA.openWorkspaceId?.(rootA) ?? '';
    workspaceB = firstB.openWorkspaceId?.(rootB) ?? '';
    assert.match(workspaceA, /^ws_/);
    assert.match(workspaceB, /^ws_/);

    const store = new SqliteDurableStore(statePath);
    try {
      assert.equal(store.getWorkspace(workspaceA)?.sessionId, sessionA);
      assert.equal(store.getWorkspace(workspaceB)?.sessionId, sessionB);
      assert.equal(store.getWorkspace(workspaceA)?.canonicalRoot, rootA);
      assert.equal(store.getWorkspace(workspaceB)?.canonicalRoot, rootB);
    } finally {
      store.close();
    }
  } finally {
    await firstA.close();
    await firstB.close();
  }

  const secondA = await startRepositoryEngineeringRuntime(laneConfig(rootA, CORRELATION));
  const secondB = await startRepositoryEngineeringRuntime(laneConfig(rootB, OTHER_CORRELATION));
  try {
    assert.equal(secondA.profile.stableSessionId, sessionA);
    assert.equal(secondB.profile.stableSessionId, sessionB);

    const reopenedA = secondA.openWorkspaceId?.(rootA);
    const reopenedB = secondB.openWorkspaceId?.(rootB);
    assert.ok(reopenedA);
    assert.ok(reopenedB);

    const store = new SqliteDurableStore(statePath);
    try {
      assert.equal(store.getWorkspace(reopenedA)?.sessionId, sessionA);
      assert.equal(store.getWorkspace(reopenedB)?.sessionId, sessionB);
    } finally {
      store.close();
    }
  } finally {
    await secondA.close();
    await secondB.close();
  }
});
