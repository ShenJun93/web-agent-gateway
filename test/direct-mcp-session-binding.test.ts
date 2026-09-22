import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { adapterCorrelationDigest, BROWSER_OPERATOR_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  evaluateGoalLease,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseRequest,
} from '../src/goal-lease.js';
import { loadPrivateGatewayConfig, type PrivateGatewayConfig } from '../src/private-config.js';
import {
  PRIVATE_STDIO_ADAPTER_ID,
  startRepositoryEngineeringRuntime,
} from '../src/repository-engineering-runtime.js';

/**
 * Autonomous authority on the direct MCP surface depends on one thing the surface did not have:
 * a session identity that survives a restart.
 *
 * A Goal Lease admits only the sessions its own durable row lists. `serve-stdio` minted
 * `sid_${randomUUID()}` per process and never emitted it, so no lease could ever name the session
 * it would actually see — autonomous admission was not merely unused on this surface, it was
 * unreachable. Under a tunnel this is worse, not better, because the process lifetime belongs to
 * the tunnel client and every reconnect is a new process.
 *
 * The fix reuses the mechanism browser adapters already have (ADR-0017): a correlation resolves
 * to a durable adapter session, and the same correlation resolves to the same session. These
 * tests exist to prove the fix is stable *and* that it cannot be used to acquire a session — and
 * therefore a lease — that belongs to someone else.
 */

const CORRELATION = 'session_11111111-2222-3333-4444-555555555555';
const OTHER_CORRELATION = 'session_99999999-8888-7777-6666-555555555555';
const OWNER = 'local.private.stdio';

async function scratch(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wag-session-binding-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Opened and closed around one callback rather than through `t.after`.
 *
 * `after` hooks run in registration order, and `scratch` registers the directory removal first —
 * so a store closed in a later hook is still open when Windows tries to unlink its file, and the
 * test fails on EBUSY having already proved what it set out to prove.
 */
function withStore<T>(dir: string, body: (store: SqliteDurableStore) => T): T {
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  try {
    return body(store);
  } finally {
    store.close();
  }
}

function configFor(dir: string, over: { sessionCorrelation?: string; goalLeaseId?: string } = {}): PrivateGatewayConfig {
  return {
    allowedRoots: [dir],
    devspace: { baseUrl: 'http://127.0.0.1:1', resourceUrl: 'http://127.0.0.1:1/mcp' },
    verifyProfiles: { unit: { argv: ['node', '--version'] } },
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath: join(dir, 'state.sqlite'),
        ownerId: OWNER,
        ...over,
      },
    },
  };
}

/** Start the runtime, read the sessions it left behind, close it. No executor is attached. */
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

  assert.equal(first.length, 1, 'one correlation must mint exactly one durable session');
  assert.deepEqual(second, first, 'a restart must resolve the same session, not mint a new one');
  assert.match(first[0]!, /^session_/);
});

test('without a correlation the session is still fresh per process, as ADR-0020 describes', async (t) => {
  const dir = await scratch(t);
  const config = configFor(dir);

  await sessionsAfterStart(config);
  const sessions = await sessionsAfterStart(config);

  // The default path mints no durable adapter session at all — it is an in-process id. This pins
  // that the shipped default is untouched by the opt-in.
  assert.deepEqual(sessions, [], 'the default must not start recording durable sessions');
});

test('a different correlation is a different session, so two configs never merge', async (t) => {
  const dir = await scratch(t);

  await sessionsAfterStart(configFor(dir, { sessionCorrelation: CORRELATION }));
  const sessions = await sessionsAfterStart(configFor(dir, { sessionCorrelation: OTHER_CORRELATION }));

  assert.equal(sessions.length, 2, 'each correlation must resolve to its own session');
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
    assert.notEqual(mine.sessionId, theirs.sessionId, 'ownerId is inside the digest for this reason');
  });
});

test('knowing a browser adapter correlation cannot reach the stdio session it names', async (t) => {
  const dir = await scratch(t);
  withStore(dir, (store) => {
    // The identical correlation string, same owner, different adapter. This is the acquisition
    // attempt the domain separation exists to defeat: a browser session must never resolve to the
    // stdio session a lease was issued for, nor the reverse.
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
      'adapterId is inside the digest, so the same string is a different key per adapter',
    );
  });
});

test('a lease issued for one stable session refuses every other one', async (t) => {
  const dir = await scratch(t);
  const { admitted, other } = withStore(dir, (store) => ({
    admitted: store.getOrCreateAdapterSession({
      ownerId: OWNER,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(OWNER, PRIVATE_STDIO_ADAPTER_ID, CORRELATION),
      createdAt: 1,
    }).sessionId,
    other: store.getOrCreateAdapterSession({
      ownerId: OWNER,
      adapterId: PRIVATE_STDIO_ADAPTER_ID,
      correlationSha256: adapterCorrelationDigest(OWNER, PRIVATE_STDIO_ADAPTER_ID, OTHER_CORRELATION),
      createdAt: 1,
    }).sessionId,
  }));

  const bindings: GoalLeaseBindings = {
    workspaceRoots: [dir],
    allowedTools: ['mutation.preview'],
    pathPatterns: ['ticket-id.js'],
    maxFiles: 3,
    maxBytes: 10_000,
    maxDiffBytes: 4_000,
    admittedSessions: [admitted],
    admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID],
    commitSemantics: 'none',
  };
  const lease: GoalLeaseRecord = {
    leaseId: 'lease_direct', createdAt: 0, notBefore: 0, expiresAt: 10_000, bindings,
  };
  const request: LeaseRequest = {
    tool: 'mutation.preview',
    sessionId: admitted,
    adapterId: PRIVATE_STDIO_ADAPTER_ID,
    workspaceRoot: dir,
    path: 'ticket-id.js',
    diffBytes: 100,
  };
  const decide = (over: Partial<LeaseRequest>) => evaluateGoalLease({
    lease, now: 1_000, request: { ...request, ...over },
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false,
  });

  // The stable session the lease names is admitted — the property that makes autonomy reachable.
  assert.deepEqual(decide({}), { admitted: true });

  // A second stdio session on the same machine, same owner, same adapter, is still refused. This
  // is what "a restart cannot acquire another session's authority" means concretely: if the
  // correlation changes, the session changes, and the lease stops applying.
  const wrongSession = decide({ sessionId: other });
  assert.equal(wrongSession.admitted, false);
  assert.equal((wrongSession as { code: string }).code, 'SESSION_NOT_ADMITTED');

  // And the adapter is checked independently of the session.
  const wrongAdapter = decide({ adapterId: BROWSER_OPERATOR_ADAPTER_ID });
  assert.equal(wrongAdapter.admitted, false);
  assert.equal((wrongAdapter as { code: string }).code, 'ADAPTER_NOT_ADMITTED');
});

test('naming a lease without a stable session fails at startup rather than denying in silence', async (t) => {
  const dir = await scratch(t);
  await assert.rejects(
    () => startRepositoryEngineeringRuntime(configFor(dir, { goalLeaseId: 'lease_direct' })),
    /sessionCorrelation/,
    'a lease that could never admit must not start and report autonomous admission as enabled',
  );
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

  // Whoever can choose the string joins the session, and this surface can propose changes — the
  // reason `OPERATOR_CORRELATION_PATTERN` exists. A weak correlation must not be configurable.
  await write('my-laptop');
  await assert.rejects(() => loadPrivateGatewayConfig(configPath));

  await write(CORRELATION);
  const config = await loadPrivateGatewayConfig(configPath);
  assert.equal(config.repositoryEngineering?.mutation?.sessionCorrelation, CORRELATION);
});
