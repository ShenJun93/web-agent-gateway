/**
 * Prove the **built** delegated-dispatch host speaks the protocol (ADR-0029).
 *
 * The test suites drive `runNativeDelegationHost` directly over `PassThrough` streams. That is the
 * right level for the protocol, and a review pointed out what it therefore cannot establish: that
 * the thing shipped to a browser — a SEA executable, invoked by Chrome with an extension origin,
 * talking length-prefixed frames over real stdio — works at all. For a while nothing built that
 * executable, and nothing noticed, because every proof stopped one layer below it.
 *
 * So this runs the real binary. It starts a real v5 admission server over loopback, writes a real
 * discovery file, spawns `wag-native-host-v5.exe` exactly as Chrome would, and drives a full
 * delegated Run through its stdin and stdout.
 *
 * It is a script rather than a `.test.ts` because it needs an artifact `npm test` must not require:
 *
 *   npm run build:delegation-native-host
 *   npx tsx scripts/verify-delegation-native-host.ts
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  BrowserAdmissionRegistry,
  BROWSER_DELEGATION_ADAPTER_ID,
} from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  UiDelegationControlPlane,
  createControllerPlaneKey,
} from '../src/goal-ui-delegation-control.js';
import {
  UiDelegationDispatchPlane,
  createDelegationDispatchPort,
} from '../src/goal-ui-delegation-dispatch.js';
import { DelegatedDispatchRouter } from '../src/delegated-dispatch-router.js';
import { DelegatedRunCoordinator } from '../src/delegated-run-executor.js';
import { startDelegationDispatchHttpServer } from '../src/delegation-dispatch-http.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../src/browser-adapter/native-framing.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const EXECUTABLE = resolve(repoRoot, 'artifacts', 'delegation-adapter', 'wag-native-host-v5.exe');
const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
const PAGE_ORIGIN = 'https://chatgpt.com';
const WORKSPACE = 'ws_verify_native_host';
const BOOTSTRAP = 'v'.repeat(48);

function out(line: string): void { process.stdout.write(`${line}\n`); }

async function main(): Promise<number> {
  if (!existsSync(EXECUTABLE)) {
    out(`missing ${EXECUTABLE}`);
    out('run: npm run build:delegation-native-host');
    return 2;
  }

  const directory = await mkdtemp(join(tmpdir(), 'wag-verify-v5-host-'));
  const store = new SqliteDurableStore(join(directory, 'state.sqlite'));
  const admission = new BrowserAdmissionRegistry(BROWSER_DELEGATION_ADAPTER_ID, store);

  // The bootstrap a human performs: connect once to learn the session, then bind a delegation to it.
  const correlationId = `session_${randomUUID()}`;
  const sessionId = admission.admit(correlationId).callerContext.sessionId;
  const { delegationId } = new UiDelegationControlPlane({
    store, key: createControllerPlaneKey('local.operator.cli'),
  }).issue({
    goalId: 'goal_verify_native_host',
    ttlMs: 30 * 60_000,
    bindings: {
      goalId: 'goal_verify_native_host',
      controllerId: 'local.operator.cli',
      allowedOrigins: [PAGE_ORIGIN],
      allowedTools: ['repo.search'],
      workspaceId: WORKSPACE,
      sessionId,
      adapterId: BROWSER_DELEGATION_ADAPTER_ID,
      maxActions: 3,
    },
  });

  const executed: string[] = [];
  const port = createDelegationDispatchPort(store);
  const server = await startDelegationDispatchHttpServer({
    context: {
      bootstrapToken: BOOTSTRAP,
      admission,
      coordinatorFor: (caller) => new DelegatedRunCoordinator({
        router: new DelegatedDispatchRouter({
          plane: new UiDelegationDispatchPlane({
            port, killSwitch: () => false, configuredDelegationId: delegationId,
          }),
          connection: {
            ownerId: caller.ownerId, sessionId: caller.sessionId, adapterId: caller.adapterId,
          },
        }),
        port,
        sessionId: caller.sessionId,
        executor: {
          async callTool(input) {
            executed.push(input.tool);
            return { ok: true, structuredContent: { matches: ['verified'] } };
          },
        },
      }),
    },
  });

  const discoveryPath = join(directory, 'browser-adapter-v5.json');
  await writeFile(discoveryPath, JSON.stringify({
    admissionUrl: server.admissionUrl,
    bootstrapToken: BOOTSTRAP,
    protocolVersion: 5,
    adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  }), { encoding: 'utf8', mode: 0o600 });

  // Spawned the way Chrome spawns a native host: the extension origin as an argument, and the
  // conversation carried entirely on stdin and stdout.
  const child = spawn(EXECUTABLE, [EXTENSION_ORIGIN, '--discovery', discoveryPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

  const decoder = new NativeMessageDecoder();
  const waiting = new Map<string, (value: Record<string, unknown>) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const record = message as Record<string, unknown>;
      const resolveOne = waiting.get(String(record.requestId));
      if (resolveOne) { waiting.delete(String(record.requestId)); resolveOne(record); }
    }
  });

  const send = (envelope: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolveSend, reject) => {
      const requestId = String(envelope.requestId);
      const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`timeout ${requestId}`)); }, 20_000);
      waiting.set(requestId, (value) => { clearTimeout(timer); resolveSend(value); });
      child.stdin.write(encodeNativeMessage(envelope));
    });

  let failures = 0;
  const check = (label: string, ok: boolean, detail = ''): void => {
    out(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  try {
    const hello = await send({ version: 5, type: 'hello', requestId: `req_${randomUUID()}` });
    check('hello', hello.type === 'result' && (hello.result as { version?: number }).version === 5);

    const bound = await send({
      version: 5, type: 'session.bind', requestId: `req_${randomUUID()}`,
      sessionId: correlationId, provider: 'chatgpt', origin: PAGE_ORIGIN,
    });
    const boundResult = bound.result as { sessionId?: string; delegationId?: string } | undefined;
    check('bind returns the authoritative session id', boundResult?.sessionId === sessionId,
      `${boundResult?.sessionId ?? '(none)'}`);
    check('bind returns it as a different string from the correlation',
      boundResult?.sessionId !== correlationId);
    check('bind offers the configured delegation', boundResult?.delegationId === delegationId);

    const staged = await send({
      version: 5, type: 'run.stage', requestId: `req_${randomUUID()}`,
      sessionId, delegationId, tool: 'repo.search', workspaceId: WORKSPACE,
      origin: PAGE_ORIGIN, arguments: { workspace_id: WORKSPACE, query: 'needle' },
    });
    const proposalId = (staged.result as { proposalId?: string } | undefined)?.proposalId;
    check('stage', staged.type === 'result' && typeof proposalId === 'string');

    const dispatched = await send({
      version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
      sessionId, delegationId, proposalId,
    });
    const outcome = dispatched.result as { authority?: string; resultId?: string } | undefined;
    check('dispatch is admitted as DELEGATED_RUN', outcome?.authority === 'DELEGATED_RUN',
      JSON.stringify(dispatched).slice(0, 200));
    check('the tool ran exactly once', executed.length === 1, `ran ${executed.length}`);

    const replay = await send({
      version: 5, type: 'run.dispatch', requestId: `req_${randomUUID()}`,
      sessionId, delegationId, proposalId,
    });
    check('a replay is refused', replay.type === 'error');
    check('and nothing ran twice', executed.length === 1);

    check('the durable row is RESULTED', store.getStagedProposalRow(proposalId!)?.state === 'RESULTED');
    check('the audit row says DELEGATED_RUN',
      store.getRunAuthority(proposalId!)?.authority === 'DELEGATED_RUN');
    check('exactly one slot was spent', store.countDelegationClaims(delegationId) === 1);
  } finally {
    child.stdin.end();
    await new Promise<void>((done) => { child.once('exit', () => done()); setTimeout(done, 3_000); });
    if (child.exitCode === null) child.kill();
    await server.close();
    admission.close();
    store.close();
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }

  const errorText = Buffer.concat(stderr).toString('utf8').trim();
  if (errorText) out(`host stderr: ${errorText}`);
  out('');
  out(failures === 0
    ? 'the built v5 native host speaks the protocol over real stdio.'
    : `${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => { process.exitCode = code; },
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
