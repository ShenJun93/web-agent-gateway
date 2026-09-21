/**
 * A delegated Run through the **production runtime**, with a real tool and zero manual Run clicks.
 *
 * Everything below `startBrowserOperatorRuntime` is the shipped assembly: the real config loader,
 * the real store, the real v5 admission server, the real native host over streams, the real MCP
 * tool surface. Nothing is stubbed, and in particular the tool that runs is the same
 * `createBrowserOperatorAdmittedMcpServer` a clicked Run reaches.
 *
 * ## What this is actually proving
 *
 * Three things, and the third is the one worth having:
 *
 *   1. with no `goalUiDelegationId`, **none of it exists** — no v5 server, no discovery file, no
 *      sweeper. ADR-0026 holds in full and Run is human, which is the default and must stay it.
 *   2. naming an id that matches no row authorises nothing. A configured placeholder gets a
 *      refusal, not an exemption.
 *   3. the documented bootstrap actually works end to end: connect, discover the session, issue a
 *      delegation bound to it out of band, name it, restart, reconnect — and the *same* session
 *      comes back, because a session is keyed by the correlation the extension holds.
 *
 * That last one is the part a design document cannot assert. The session identity has to survive a
 * WAG restart or the delegation stops matching the moment it is configured, and the only way to
 * know is to restart a real runtime and look.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { startBrowserOperatorRuntime, type BrowserOperatorRuntime } from '../src/browser-operator-runtime.js';
import { BROWSER_DELEGATION_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';
import { HttpLocalDelegationAdapterLink, parseDelegationAdapterDiscovery } from '../src/browser-adapter/local-link-v5.js';
import { runNativeDelegationHost } from '../src/browser-adapter/native-host-v5.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
const PAGE_ORIGIN = 'https://chatgpt.com';
const GOAL = 'goal_production_runtime';

/** The extension's correlation. Stable across restarts, exactly as `chrome.storage.session` is. */
const CORRELATION = `session_${randomUUID()}`;

const execFileAsync = promisify(execFile);
const git = async (cwd: string, args: string[]) => (await execFileAsync('git', args, { cwd })).stdout.trim();

interface Bench {
  temp: string;
  root: string;
  configPath: string;
  statePath: string;
  discoveryPath: string;
  delegationDiscoveryPath: string;
  writeConfig(delegationId?: string): Promise<void>;
  start(): Promise<BrowserOperatorRuntime>;
  stop(): Promise<void>;
}

async function bench(t: test.TestContext): Promise<Bench> {
  const devspace = await startPinnedDevspace();
  const temp = await mkdtemp(join(tmpdir(), 'wag-delegated-runtime-'));
  const root = devspace.workspaceRoot;
  await writeFile(join(root, 'haystack.txt'), 'alpha\nthe needle is here\nomega\n');
  // `repo.search` searches *tracked* files, so the workspace has to be a real repository with a
  // real commit. Skipping this makes the search error rather than return nothing, which is how the
  // first run of this test failed.
  await git(root, ['init', '--initial-branch=work', '.']);
  await git(root, ['config', 'user.email', 'wag@example.invalid']);
  await git(root, ['config', 'user.name', 'WAG Test']);
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-m', 'base']);

  const configPath = join(temp, 'private.json');
  const statePath = join(temp, 'state.sqlite');
  const discoveryPath = join(temp, 'browser-adapter-v4.json');
  const delegationDiscoveryPath = join(temp, 'browser-adapter-v5.json');

  const writeConfig = async (delegationId?: string) => {
    await writeFile(configPath, JSON.stringify({
      allowedRoots: [root],
      devspace: { baseUrl: devspace.baseUrl, resourceUrl: `${devspace.baseUrl}/mcp` },
      verifyProfiles: {},
      repositoryEngineering: {
        mutation: {
          statePath: join(temp, 'engineering.sqlite'),
          ...(delegationId === undefined ? {} : { goalUiDelegationId: delegationId }),
        },
        gitCommit: {},
      },
    }), 'utf8');
  };

  let running: BrowserOperatorRuntime | undefined;
  const start = async () => {
    running = await startBrowserOperatorRuntime({
      configPath,
      discoveryPath,
      delegationDiscoveryPath,
      statePath,
      env: { ...process.env, DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    });
    return running;
  };
  const stop = async () => {
    const current = running;
    running = undefined;
    await current?.close();
  };

  // One ordered cleanup: the runtime holds the sqlite handle, and Windows will not unlink the
  // directory until it is closed.
  t.after(async () => {
    await stop().catch(() => undefined);
    await devspace.stop();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  });

  await writeConfig();
  return { temp, root, configPath, statePath, discoveryPath, delegationDiscoveryPath, writeConfig, start, stop };
}

/** A v5 native host over real streams, talking to whatever discovery is on disk right now. */
async function connect(b: Bench, t: test.TestContext) {
  const discovery = parseDelegationAdapterDiscovery(
    JSON.parse(await readFile(b.delegationDiscoveryPath, 'utf8')) as unknown,
  );
  const toHost = new PassThrough();
  const fromHost = new PassThrough();
  const decoder = new NativeMessageDecoder();
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  fromHost.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const record = message as Record<string, unknown>;
      const resolve = waiting.get(String(record.requestId));
      if (resolve) { waiting.delete(String(record.requestId)); resolve(record); }
    }
  });
  const hostRun = runNativeDelegationHost({
    input: toHost,
    output: fromHost,
    expectedOrigin: EXTENSION_ORIGIN,
    linkFactory: (id) => HttpLocalDelegationAdapterLink.admit(discovery, id),
  }).catch(() => undefined);

  const send = (envelope: unknown): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const requestId = String((envelope as { requestId?: unknown }).requestId);
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`timeout ${requestId}`)); }, 15_000);
    waiting.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    toHost.write(encodeNativeMessage(envelope));
  });

  t.after(async () => { toHost.end(); await hostRun; });

  const bound = await send({
    version: 5, type: 'session.bind', requestId: `req_${randomUUID()}`,
    sessionId: CORRELATION, provider: 'chatgpt', origin: PAGE_ORIGIN,
  });
  assert.equal(bound.type, 'result', JSON.stringify(bound));
  const result = bound.result as { sessionId: string; delegationId?: string };
  return { send, sessionId: result.sessionId, offeredDelegationId: result.delegationId };
}

const exists = async (path: string): Promise<boolean> =>
  access(path).then(() => true, () => false);

// -------------------------------------------------------------------------------------------

test('with no delegation configured, the whole v5 surface is absent', async (t) => {
  const b = await bench(t);
  const runtime = await b.start();

  assert.equal(runtime.goalUiDelegationId, undefined);
  assert.equal(runtime.delegationDiscoveryPath, undefined);
  assert.equal(
    await exists(b.delegationDiscoveryPath), false,
    'no discovery file, so no native host can find a v5 route at all',
  );
  // And the v4 surface is untouched, which is the property that makes this safe to ship.
  assert.equal(await exists(b.discoveryPath), true);
});

test('the documented bootstrap works: connect, issue out of band, name it, restart, run', async (t) => {
  const b = await bench(t);

  // ---- step 1: name a placeholder and start. The surface is up and authorises nothing. ----
  await b.writeConfig('uidel_000000000000000000000000');
  let runtime = await b.start();
  assert.equal(runtime.goalUiDelegationId, 'uidel_000000000000000000000000');
  assert.equal(await exists(b.delegationDiscoveryPath), true);

  // ---- step 2: connect. WAG mints the session the delegation will bind. ----
  const first = await connect(b, t);
  assert.notEqual(first.sessionId, CORRELATION, 'the session id is not the correlation');
  assert.equal(
    first.offeredDelegationId, 'uidel_000000000000000000000000',
    'the configured id is offered as an opaque reference, even though it names no row',
  );

  // A proposal staged under the placeholder is refused: naming is not granting.
  const stagedUnderPlaceholder = await first.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: first.sessionId, delegationId: 'uidel_000000000000000000000000',
    tool: 'repo.search', workspaceId: 'ws_nothing', origin: PAGE_ORIGIN,
    arguments: { workspace_id: 'ws_nothing', query: 'needle' },
  });
  assert.equal(stagedUnderPlaceholder.type, 'error', JSON.stringify(stagedUnderPlaceholder));

  // ---- step 3: open a workspace on the human path. This is the gesture the design defers to. ----
  const stagedOpen = await first.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: first.sessionId,
    tool: 'workspace.open', workspaceId: 'ws_not_yet_open', origin: PAGE_ORIGIN,
    arguments: { path: b.root },
  });
  assert.equal(stagedOpen.type, 'result', JSON.stringify(stagedOpen));
  const openProposalId = (stagedOpen.result as { proposalId: string }).proposalId;

  const opened = await first.send({
    version: 5, type: 'run.human', requestId: `req_${randomUUID()}`,
    sessionId: first.sessionId, proposalId: openProposalId,
  });
  assert.equal(opened.type, 'result', JSON.stringify(opened));
  const openResult = opened.result as { authority: string; result: { workspaceId: string } };
  assert.equal(openResult.authority, 'HUMAN_RUN');
  const workspaceId = openResult.result.workspaceId;
  assert.match(workspaceId, /^ws_/);

  // ---- step 4: issue the delegation out of band, bound to that session and workspace. ----
  const sessionId = first.sessionId;
  await b.stop();

  const store = new SqliteDurableStore(b.statePath);
  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  });
  const { delegationId } = control.issue({
    goalId: GOAL,
    ttlMs: 60 * 60_000,
    bindings: {
      goalId: GOAL,
      controllerId: 'local.operator.cli',
      allowedOrigins: [PAGE_ORIGIN],
      allowedTools: ['repo.search'],
      workspaceId,
      sessionId,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      maxActions: 2,
    },
  });
  store.close();

  // ---- step 5: name it and restart. ----
  await b.writeConfig(delegationId);
  runtime = await b.start();
  assert.equal(runtime.goalUiDelegationId, delegationId);

  // ---- step 6: reconnect with the same correlation. The session must come back identical. ----
  const second = await connect(b, t);
  assert.equal(
    second.sessionId, sessionId,
    'a restart must return the same session, or a delegation stops matching the moment it is configured',
  );
  assert.equal(second.offeredDelegationId, delegationId);

  // ---- step 7: a delegated Run, with nobody clicking anything. ----
  const staged = await second.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId, delegationId, tool: 'repo.search', workspaceId, origin: PAGE_ORIGIN,
    arguments: { workspace_id: workspaceId, query: 'needle' },
  });
  assert.equal(staged.type, 'result', JSON.stringify(staged));
  const proposalId = (staged.result as { proposalId: string }).proposalId;

  const dispatched = await second.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId, delegationId, proposalId,
  });
  assert.equal(dispatched.type, 'result', JSON.stringify(dispatched));
  const outcome = dispatched.result as {
    authority: string; goalId: string; resultId: string; result: { matches: unknown[] };
  };
  assert.equal(outcome.authority, 'DELEGATED_RUN');
  assert.equal(outcome.goalId, GOAL);
  assert.match(outcome.resultId, /^res_[0-9a-f]{32}$/);

  // The real tool really ran, against the real workspace.
  assert.ok(Array.isArray(outcome.result.matches), 'repo.search returned matches');
  assert.ok(outcome.result.matches.length > 0, 'and it found the needle in the real file');

  // ---- and the durable record says exactly what happened. ----
  await b.stop();
  const audit = new SqliteDurableStore(b.statePath);
  t.after(() => { try { audit.close(); } catch { /* already closed */ } });

  const row = audit.getStagedProposalRow(proposalId);
  assert.equal(row?.state, 'RESULTED');
  assert.equal(row?.sessionId, sessionId);
  assert.equal(row?.workspaceId, workspaceId);

  const authority = audit.getRunAuthority(proposalId);
  assert.equal(authority?.authority, 'DELEGATED_RUN');
  assert.equal(authority?.delegationId, delegationId);
  assert.equal(authority?.resultId, outcome.resultId);
  assert.equal(audit.countDelegationClaims(delegationId), 1, 'exactly one action of the two');

  // The workspace.open that a person authorised is recorded as HUMAN_RUN, separately and
  // distinguishably — which is the whole point of having two authorities in one table.
  const humanAuthority = audit.getRunAuthority(openProposalId);
  assert.equal(humanAuthority?.authority, 'HUMAN_RUN');
  assert.equal(humanAuthority?.delegationId, undefined);
});

test('a delegated Run is refused once the delegation is revoked, with no restart', async (t) => {
  const b = await bench(t);
  await b.writeConfig('uidel_000000000000000000000000');
  await b.start();
  const first = await connect(b, t);

  const stagedOpen = await first.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId: first.sessionId, tool: 'workspace.open', workspaceId: 'ws_pending',
    origin: PAGE_ORIGIN, arguments: { path: b.root },
  });
  const openProposalId = (stagedOpen.result as { proposalId: string }).proposalId;
  const opened = await first.send({
    version: 5, type: 'run.human', requestId: `req_${randomUUID()}`,
    sessionId: first.sessionId, proposalId: openProposalId,
  });
  const workspaceId = (opened.result as { result: { workspaceId: string } }).result.workspaceId;
  const sessionId = first.sessionId;
  await b.stop();

  const store = new SqliteDurableStore(b.statePath);
  const control = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  });
  const { delegationId } = control.issue({
    goalId: GOAL,
    ttlMs: 60 * 60_000,
    bindings: {
      goalId: GOAL, controllerId: 'local.operator.cli', allowedOrigins: [PAGE_ORIGIN],
      allowedTools: ['repo.search'], workspaceId, sessionId,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID, maxActions: 5,
    },
  });
  store.close();

  await b.writeConfig(delegationId);
  await b.start();
  const second = await connect(b, t);

  const stage = () => second.send({
    version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
    sessionId, delegationId, tool: 'repo.search', workspaceId, origin: PAGE_ORIGIN,
    arguments: { workspace_id: workspaceId, query: 'needle' },
  });
  const before = await stage();
  assert.equal(before.type, 'result', 'it works before revocation');

  // Revoked from a second connection to the same store, while the runtime is live — which is what
  // a person running `delegation-control --revoke` actually does.
  const revoker = new SqliteDurableStore(b.statePath);
  new UiDelegationControlPlane({
    store: revoker, key: createControllerPlaneKey('local.operator.cli'),
  }).revoke(delegationId);
  revoker.close();

  const after = await second.send({
    version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
    sessionId, delegationId,
    proposalId: (before.result as { proposalId: string }).proposalId,
  });
  assert.equal(after.type, 'error', JSON.stringify(after));
  assert.equal(
    (after.error as { code: string }).code, 'DELEGATION_REVOKED',
    'the delegation is re-read from the row on every admission, so revocation lands immediately',
  );
});
