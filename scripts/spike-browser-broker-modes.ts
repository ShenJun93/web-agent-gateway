import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createPrivateBrowserMcpContext } from '../src/browser-harness/browser-mcp-runtime.js';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function mainProcessWorkingSetKb(pid: number | undefined): number | null {
  if (!pid) return null;
  try {
    const output = execFileSync('tasklist.exe', [
      '/FI', `PID eq ${pid}`,
      '/FO', 'CSV',
      '/NH',
    ], { encoding: 'utf8', windowsHide: true });
    const match = /"([^"]*)","([^"]*)","([^"]*)","([^"]*)","([^"]*)"/.exec(output.trim());
    if (!match?.[5]) return null;
    const digits = match[5].replace(/[^0-9]/g, '');
    const value = Number(digits);
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

async function exercise(
  context: ReturnType<typeof createPrivateBrowserMcpContext>,
  profileId: string,
  mode: 'WAG_HEADLESS' | 'WAG_VISIBLE',
) {
  const started = performance.now();
  const opened = await context.open(profileId, mode);
  const startupMs = Math.round((performance.now() - started) * 10) / 10;
  const snapshotStarted = performance.now();
  const snapshot = await context.snapshot(opened.browserSessionId);
  const snapshotMs = Math.round((performance.now() - snapshotStarted) * 10) / 10;
  const workingSetKb = mainProcessWorkingSetKb(opened.pid);

  let takeover: Record<string, unknown> | null = null;
  if (mode === 'WAG_VISIBLE') {
    const pauseEffect = await context.exec(
      opened.browserSessionId,
      profileId + '.pause.1',
      { type: 'pause_for_user' },
    );
    const paused = await context.describe(opened.browserSessionId);
    const userEffect = await context.exec(
      opened.browserSessionId,
      profileId + '.take-control.1',
      { type: 'take_user_control' },
    );
    const user = await context.describe(opened.browserSessionId);
    const resumeEffect = await context.exec(
      opened.browserSessionId,
      profileId + '.resume.1',
      { type: 'resume_automation' },
    );
    const resumed = await context.describe(opened.browserSessionId);
    takeover = {
      paused: paused.controlState,
      user: user.controlState,
      resumed: resumed.controlState,
      effectStates: [pauseEffect.state, userEffect.state, resumeEffect.state],
    };
  }

  const closed = await context.close(opened.browserSessionId);
  return {
    mode,
    browserSessionIdStable: opened.browserSessionId === snapshot.browserSessionId
      && opened.browserSessionId === closed.browserSessionId,
    executionMode: opened.executionMode,
    ownershipMode: opened.ownershipMode,
    controlState: opened.controlState,
    startupMs,
    snapshotMs,
    mainProcessWorkingSetKb: workingSetKb,
    snapshotUrl: snapshot.url,
    snapshotNodes: snapshot.nodes.length,
    takeover,
    closedState: closed.state,
  };
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('BrowserBroker real smoke requires Windows');
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-broker-smoke-'));
  const context = createPrivateBrowserMcpContext({
    owner: {
      ownerId: 'browser_broker_smoke',
      sessionId: 'browser_broker_smoke',
      adapterId: 'private.stdio.v1',
    },
    edgeExecutablePath: EDGE,
    profileRoot: join(root, 'profiles'),
    effectStatePath: join(root, 'effects.sqlite'),
    killSwitch: () => false,
  });

  try {
    const headless = await exercise(context, 'headless', 'WAG_HEADLESS');
    const visible = await exercise(context, 'visible', 'WAG_VISIBLE');
    const pass = headless.executionMode === 'WAG_HEADLESS'
      && visible.executionMode === 'WAG_VISIBLE'
      && headless.browserSessionIdStable
      && visible.browserSessionIdStable
      && visible.takeover?.paused === 'PAUSED_FOR_USER'
      && visible.takeover?.user === 'USER_CONTROL'
      && visible.takeover?.resumed === 'RUNNING'
      && JSON.stringify(visible.takeover?.effectStates) === JSON.stringify(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED'])
      && headless.closedState === 'CLOSED'
      && visible.closedState === 'CLOSED';

    process.stdout.write(JSON.stringify({
      status: pass ? 'PASS' : 'FAIL',
      headless,
      visible,
      memoryMeasurement: 'main Edge process working set only; not total browser process tree',
    }) + '\n');
    if (!pass) process.exitCode = 1;
  } finally {
    await context.closeAll().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write('wag-browser-broker-real-smoke: '
    + (error instanceof Error ? error.message : 'failed') + '\n');
  process.exitCode = 1;
});
