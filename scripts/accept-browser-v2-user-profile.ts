import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';
import {
  loadOrCreateBrowserControlPairingState,
  startBrowserControlWebSocketServer,
} from '../src/browser-harness/browser-control-websocket-server.js';

const ACCEPTANCE_ROOT = 'E:\\WAG-Acceptance\\browser-v2-user-profile-gate';
const PAIRING_PATH = join(ACCEPTANCE_ROOT, 'pairing.json');
const RESULT_PATH = join(ACCEPTANCE_ROOT, 'result.json');
const STATUS_PATH = join(ACCEPTANCE_ROOT, 'status.json');

async function writeStatus(state: string, extra: Record<string, unknown> = {}) {
  await writeFile(STATUS_PATH, JSON.stringify({ state, ...extra }, null, 2) + '\n', 'utf8');
}

async function waitUntil<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(label + ' timed out');
}

async function main() {
  let stage = 'BOOT';
  await mkdir(ACCEPTANCE_ROOT, { recursive: true });
  await rm(RESULT_PATH, { force: true }).catch(() => undefined);

  const pairing = await loadOrCreateBrowserControlPairingState(PAIRING_PATH, 17841);
  const copied = spawnSync('clip.exe', {
    input: JSON.stringify(pairing),
    encoding: 'utf8',
    windowsHide: true,
  });
  if (copied.status !== 0) throw new Error('Could not copy pairing payload to clipboard');

  const server = await startBrowserControlWebSocketServer({
    statePath: PAIRING_PATH,
    pairingState: pairing,
    requestTimeoutMs: 15_000,
  });

  let context: ReturnType<typeof createPrivateBrowserMcpContext> | undefined;
  let openedSessionId: string | undefined;
  try {
    stage = 'WAITING_FOR_PAIRING';
    await writeStatus('WAITING_FOR_PAIRING', {
      pairingPayloadInClipboard: true,
      endpoint: pairing.endpoint,
    });
    process.stdout.write('PAIRING_PAYLOAD_COPIED_TO_CLIPBOARD\n');
    process.stdout.write('WAITING_FOR_EXTENSION_CONNECTION\n');

    await waitUntil(async () => server.connected() ? true : undefined, 10 * 60_000, 'extension pairing');
    stage = 'WAITING_FOR_ACTIVE_WEB_TAB';
    await writeStatus('WAITING_FOR_ACTIVE_WEB_TAB', { connected: true });
    process.stdout.write('EXTENSION_CONNECTED\n');
    process.stdout.write('WAITING_FOR_ACTIVE_WEB_TAB\n');

    const selected = await waitUntil(async () => {
      const targets = await server.client.listTargets();
      const active = targets.find((target) =>
        target.active
        && target.attachable
        && typeof target.url === 'string'
        && (target.url.startsWith('https://') || target.url.startsWith('http://')));
      return active;
    }, 10 * 60_000, 'active web target');

    const beforeTargets = await server.client.listTargets();
    const activeBefore = beforeTargets.find((target) => target.active)?.targetId ?? null;
    if (activeBefore !== selected.targetId) throw new Error('Selected target is no longer active');

    stage = 'CREATE_CONTEXT';
    context = createPrivateBrowserMcpContext({
      owner: {
        ownerId: 'user_profile_acceptance',
        sessionId: 'user_profile_acceptance',
        adapterId: 'private.stdio.v1',
      },
      edgeExecutablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      profileRoot: join(ACCEPTANCE_ROOT, 'managed-profiles-unused'),
      effectStatePath: join(ACCEPTANCE_ROOT, 'effects.sqlite'),
      targetClaimStatePath: join(ACCEPTANCE_ROOT, 'claims.sqlite'),
      attachedSessionStatePath: join(ACCEPTANCE_ROOT, 'sessions.sqlite'),
      diagnosticsStatePath: join(ACCEPTANCE_ROOT, 'diagnostics.json'),
      control: server.client,
      killSwitch: () => false,
    });

    stage = 'OPEN_AUTO';
    await writeStatus('RUNNING_BOUNDED_ACCEPTANCE', { connected: true, stage });

    const opened = await context.open(
      'daily-profile-acceptance',
      'AUTO',
      selected.targetId,
      'WAG • Daily Profile Gate',
    );
    openedSessionId = opened.browserSessionId;

    if (opened.executionMode !== 'AI_TAB_GROUP') {
      throw new Error('AUTO did not resolve to AI_TAB_GROUP');
    }
    if (opened.ownershipMode !== 'ATTACHED_EXISTING') {
      throw new Error('Daily profile target was not attached-existing ownership');
    }

    stage = 'SNAPSHOT';
    const snapshot = await context.snapshot(opened.browserSessionId);
    stage = 'PAUSE';
    const paused = await context.pauseForUser(opened.browserSessionId);
    stage = 'RESUME';
    const resumed = await context.resumeAutomation(opened.browserSessionId);
    stage = 'RELEASE';
    const closed = await context.close(opened.browserSessionId);
    openedSessionId = undefined;

    const afterTargets = await server.client.listTargets();
    const activeAfter = afterTargets.find((target) => target.active)?.targetId ?? null;
    const targetStillOpen = afterTargets.some((target) => target.targetId === selected.targetId);

    const result = {
      status: 'PASS',
      userDailyEdgeProfileUsed: true,
      transport: 'LOOPBACK_WEBSOCKET',
      requestedMode: 'AUTO',
      executionMode: opened.executionMode,
      ownershipMode: opened.ownershipMode,
      pairingConnected: true,
      selectedTargetWasActive: true,
      activeTabStable: activeAfter === activeBefore,
      semanticSnapshotSucceeded: snapshot.browserSessionId === opened.browserSessionId,
      semanticNodeCountObserved: snapshot.nodes.length,
      snapshotTruncated: snapshot.truncated === true,
      pauseState: paused.controlState,
      resumeState: resumed.controlState,
      releaseState: closed.state,
      targetStillOpenAfterRelease: targetStillOpen,
      browserStillRunningAfterRelease: true,
      noNavigate: true,
      noFill: true,
      noClick: true,
      noSubmit: true,
      noCookieRead: true,
      noTokenRead: true,
      noWindowsUiAutomation: true,
      noOsPointerInjection: true,
    };

    if (!result.activeTabStable
        || !result.semanticSnapshotSucceeded
        || result.pauseState !== 'PAUSED_FOR_USER'
        || result.resumeState !== 'RUNNING'
        || result.releaseState !== 'CLOSED'
        || !result.targetStillOpenAfterRelease) {
      throw new Error('Bounded daily-profile acceptance invariant failed');
    }

    await writeFile(RESULT_PATH, JSON.stringify(result, null, 2) + '\n', 'utf8');
    await writeStatus('PASS', {
      connected: true,
      userDailyEdgeProfileUsed: true,
      activeTabStable: true,
      targetStillOpenAfterRelease: true,
    });
    process.stdout.write('USER_DAILY_EDGE_PROFILE_ACCEPTANCE=PASS\n');
  } catch (error) {
    if (context && openedSessionId) {
      await context.close(openedSessionId).catch(() => undefined);
    }
    await writeStatus('FAILED', {
      stage,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
    }).catch(() => undefined);
    throw error;
  } finally {
    await context?.closeAll().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(
    'wag-browser-v2-user-profile-gate: '
      + (error instanceof Error ? error.message : 'failed')
      + '\n',
  );
  process.exitCode = 1;
});
