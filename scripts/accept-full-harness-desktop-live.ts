import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import type { PrivateGatewayConfig } from '../src/private-config.js';
import { startRepositoryEngineeringRuntime } from '../src/repository-engineering-runtime.js';

type Stage =
  | 'INIT'
  | 'FIXTURE_WRITTEN'
  | 'RUNTIME_READY'
  | 'PROCESS_STARTED'
  | 'DESKTOP_OPEN'
  | 'SNAPSHOT_OBSERVED'
  | 'SET_VALUE_SUCCEEDED'
  | 'SET_VALUE_RETRY_CONFIRMED'
  | 'INPUT_READBACK_CONFIRMED'
  | 'INVOKE_SUCCEEDED'
  | 'INVOKE_RETRY_CONFIRMED'
  | 'STATUS_READBACK_OBSERVED'
  | 'STATUS_READBACK_CONFIRMED'
  | 'SCREENSHOT_CONFIRMED'
  | 'DESKTOP_CLOSED'
  | 'PROCESS_TERMINATED'
  | 'SUCCEEDED'
  | 'FAILED';

interface Receipt {
  state: 'SUCCEEDED';
  source: 'wag-desktop-native-live-v5';
  runId: string;
  statePath: string;
  journalDir: string;
  workspaceId: string;
  processId: string;
  pid: number;
  windowMode: 'normal';
  desktopSessionId: string;
  nativeWindowId: string;
  title: string;
  snapshotNodeCount: number;
  setValueEffectId: string;
  setValueRetryEffectId: string;
  invokeEffectId: string;
  invokeRetryEffectId: string;
  observedInput: string;
  observedStatus: string;
  screenshotBytes: number;
  screenshotSha256: string;
  desktopCloseState: string;
  processAliveAfterDesktopClose: boolean;
  processTerminated: boolean;
  completedAtUtc: string;
}

const EXPECTED_INPUT = 'beta';
const EXPECTED_STATUS = 'applied:beta';

const fixturePowerShellSource = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title = 'WAG Desktop Acceptance'
$window.Width = 480
$window.Height = 280
$window.WindowStartupLocation = 'CenterScreen'

$grid = New-Object System.Windows.Controls.Grid
$window.Content = $grid

$inputBox = New-Object System.Windows.Controls.TextBox
$inputBox.Name = 'InputBox'
$inputBox.Text = 'alpha'
$inputBox.Width = 250
$inputBox.Height = 28
$inputBox.HorizontalAlignment = 'Left'
$inputBox.VerticalAlignment = 'Top'
$inputBox.Margin = '20,20,0,0'
[System.Windows.Automation.AutomationProperties]::SetName($inputBox,'Input')
$grid.Children.Add($inputBox) | Out-Null

$apply = New-Object System.Windows.Controls.Button
$apply.Name = 'ApplyButton'
$apply.Content = 'Apply'
$apply.Width = 100
$apply.Height = 30
$apply.HorizontalAlignment = 'Left'
$apply.VerticalAlignment = 'Top'
$apply.Margin = '295,18,0,0'
[System.Windows.Automation.AutomationProperties]::SetName($apply,'Apply')
$grid.Children.Add($apply) | Out-Null

$enabled = New-Object System.Windows.Controls.CheckBox
$enabled.Name = 'EnabledCheck'
$enabled.Content = 'Enabled'
$enabled.HorizontalAlignment = 'Left'
$enabled.VerticalAlignment = 'Top'
$enabled.Margin = '20,70,0,0'
[System.Windows.Automation.AutomationProperties]::SetName($enabled,'Enabled')
$grid.Children.Add($enabled) | Out-Null

$status = New-Object System.Windows.Controls.TextBox
$status.Name = 'StatusBox'
$status.Text = 'idle'
$status.IsReadOnly = $true
$status.Width = 375
$status.Height = 28
$status.HorizontalAlignment = 'Left'
$status.VerticalAlignment = 'Top'
$status.Margin = '20,115,0,0'
[System.Windows.Automation.AutomationProperties]::SetName($status,'Status')
$grid.Children.Add($status) | Out-Null

$apply.Add_Click({
  $status.Text = 'applied:' + $inputBox.Text
})

$window.ShowDialog() | Out-Null
`;

function requiredReceiptArg(): string {
  const index = process.argv.indexOf('--receipt');
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || !isAbsolute(value)) throw new Error('--receipt must be an absolute path');
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizedFixtureValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Desktop live acceptance requires Windows');

  const receiptPath = requiredReceiptArg();
  const outputDir = dirname(receiptPath);
  const statePath = receiptPath + '.state.sqlite';
  const journalDir = receiptPath + '.journal';
  if (existsSync(receiptPath) || existsSync(statePath) || existsSync(journalDir)) {
    throw new Error('Desktop live acceptance output already exists; use a new receipt path');
  }
  await mkdir(outputDir, { recursive: true });
  await mkdir(journalDir, { recursive: false });

  const runId = `desktop_live_${randomUUID()}`;
  let journalSequence = 0;
  let currentStage: Stage = 'INIT';
  const journal = async (stage: Stage, detail: Record<string, unknown> = {}): Promise<void> => {
    currentStage = stage;
    const name = `${String(journalSequence++).padStart(2, '0')}-${stage.toLowerCase().replaceAll('_', '-')}.json`;
    await writeFile(join(journalDir, name), `${JSON.stringify({
      version: 1,
      source: 'wag-desktop-native-live-journal-v1',
      runId,
      stage,
      observedAtUtc: new Date().toISOString(),
      ...detail,
    }, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  };

  await journal('INIT', { statePath });

  const root = await mkdtemp(join(tmpdir(), 'wag-desktop-native-live-'));
  const fixtureScriptPath = join(root, 'desktop-fixture.ps1');
  await writeFile(fixtureScriptPath, fixturePowerShellSource, 'utf8');
  await journal('FIXTURE_WRITTEN', { fixtureScriptPath });

  const config: PrivateGatewayConfig = {
    allowedRoots: [root],
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
        sessionCorrelation: runId,
      },
      desktop: { enabled: true },
    },
  };

  const runtime = await startRepositoryEngineeringRuntime(config);
  let workspaceId: string | undefined;
  let processId: string | undefined;
  let desktopSessionId: string | undefined;
  let processTerminated = false;
  let pid: number | undefined;
  let setValueEffectId: string | undefined;
  let invokeEffectId: string | undefined;

  try {
    if (!runtime.machineContext || !runtime.desktopContext) {
      throw new Error('Desktop live acceptance runtime contexts are unavailable');
    }
    await journal('RUNTIME_READY');

    const machine = runtime.machineContext;
    const desktop = runtime.desktopContext;
    const opened = await machine.open(root) as { workspace_id?: unknown };
    if (typeof opened.workspace_id !== 'string') throw new Error('machine.open returned no workspace');
    workspaceId = opened.workspace_id;

    const started = await machine.processStart(
      workspaceId,
      [
        'powershell.exe',
        '-NoLogo',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fixtureScriptPath,
      ],
      { windowMode: 'normal' },
    ) as {
      process_id?: unknown;
      pid?: unknown;
      window_mode?: unknown;
    };
    if (typeof started.process_id !== 'string'
        || !Number.isInteger(started.pid)
        || started.window_mode !== 'normal') {
      throw new Error('Desktop fixture did not start with owned normal-window identity');
    }
    processId = started.process_id;
    pid = started.pid as number;
    await journal('PROCESS_STARTED', { workspaceId, processId, pid });

    const deadline = Date.now() + 20_000;
    let session: Awaited<ReturnType<typeof desktop.open>> | undefined;
    let lastOpenError: unknown;
    while (Date.now() <= deadline && !session) {
      try {
        session = await desktop.open(workspaceId, processId);
      } catch (error) {
        lastOpenError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!session) {
      throw lastOpenError instanceof Error
        ? lastOpenError
        : new Error('Desktop fixture window did not become observable');
    }
    desktopSessionId = session.desktopSessionId;
    await journal('DESKTOP_OPEN', {
      desktopSessionId,
      nativeWindowId: session.nativeWindowId,
      title: session.title,
    });

    let snapshot = await desktop.snapshot(desktopSessionId);
    const input = snapshot.nodes.find((node) => node.name === 'Input' && node.patterns.includes('Value'));
    const apply = snapshot.nodes.find((node) => node.name === 'Apply' && node.patterns.includes('Invoke'));
    const status = snapshot.nodes.find((node) => node.name === 'Status' && node.patterns.includes('Value'));
    if (!input || !apply || !status) {
      throw new Error('Desktop fixture semantic controls are incomplete');
    }
    await journal('SNAPSHOT_OBSERVED', {
      snapshotNodeCount: snapshot.nodes.length,
      inputRef: input.ref,
      applyRef: apply.ref,
      statusRef: status.ref,
    });

    const setValueAction = {
      type: 'setValue' as const,
      ref: input.ref,
      value: EXPECTED_INPUT,
    };
    const setValue = await desktop.exec(desktopSessionId, 'desktop.live.set-value.once', setValueAction);
    if (setValue.state !== 'SUCCEEDED') throw new Error('Desktop setValue was not confirmed');
    setValueEffectId = setValue.effectId;
    await journal('SET_VALUE_SUCCEEDED', {
      effectId: setValue.effectId,
      attemptId: setValue.attemptId,
    });

    const setValueRetry = await desktop.exec(
      desktopSessionId,
      'desktop.live.set-value.once',
      setValueAction,
    );
    if (setValueRetry.effectId !== setValue.effectId
        || setValueRetry.resultDigest !== setValue.resultDigest
        || setValueRetry.state !== 'SUCCEEDED') {
      throw new Error('Desktop setValue exact-once retry did not return durable success');
    }
    await journal('SET_VALUE_RETRY_CONFIRMED', {
      effectId: setValueRetry.effectId,
      resultDigest: setValueRetry.resultDigest,
    });

    let inputReadback: (typeof snapshot.nodes)[number] | undefined;
    let observedInput: string | undefined;
    const inputReadbackDeadline = Date.now() + 5_000;
    do {
      snapshot = await desktop.snapshot(desktopSessionId);
      inputReadback = snapshot.nodes.find((node) => node.name === 'Input' && node.patterns.includes('Value'));
      observedInput = normalizedFixtureValue(inputReadback?.value);
      if (inputReadback && observedInput === EXPECTED_INPUT) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() <= inputReadbackDeadline);
    if (!inputReadback || observedInput !== EXPECTED_INPUT) {
      throw new Error(`Desktop input readback mismatch: ${String(inputReadback?.value)}`);
    }
    await journal('INPUT_READBACK_CONFIRMED', {
      observedInput,
      rawInput: inputReadback.value,
    });

    const freshApply = snapshot.nodes.find((node) => node.name === 'Apply' && node.patterns.includes('Invoke'));
    if (!freshApply) throw new Error('Desktop Apply control disappeared after setValue');
    const invokeAction = { type: 'invoke' as const, ref: freshApply.ref };
    const invoked = await desktop.exec(desktopSessionId, 'desktop.live.invoke.once', invokeAction);
    if (invoked.state !== 'SUCCEEDED') throw new Error('Desktop invoke was not confirmed');
    invokeEffectId = invoked.effectId;
    await journal('INVOKE_SUCCEEDED', {
      effectId: invoked.effectId,
      attemptId: invoked.attemptId,
    });

    const invokeRetry = await desktop.exec(
      desktopSessionId,
      'desktop.live.invoke.once',
      invokeAction,
    );
    if (invokeRetry.effectId !== invoked.effectId
        || invokeRetry.resultDigest !== invoked.resultDigest
        || invokeRetry.state !== 'SUCCEEDED') {
      throw new Error('Desktop invoke exact-once retry did not return durable success');
    }
    await journal('INVOKE_RETRY_CONFIRMED', {
      effectId: invokeRetry.effectId,
      resultDigest: invokeRetry.resultDigest,
    });

    let statusReadback: (typeof snapshot.nodes)[number] | undefined;
    let observedStatus: string | undefined;
    const statusReadbackDeadline = Date.now() + 5_000;
    do {
      snapshot = await desktop.snapshot(desktopSessionId);
      statusReadback = snapshot.nodes.find((node) => node.name === 'Status' && node.patterns.includes('Value'));
      observedStatus = normalizedFixtureValue(statusReadback?.value);
      if (statusReadback && observedStatus === EXPECTED_STATUS) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() <= statusReadbackDeadline);
    await journal('STATUS_READBACK_OBSERVED', {
      observedStatus,
      rawStatus: statusReadback?.value,
      valueNodes: snapshot.nodes
        .filter((node) => node.patterns.includes('Value'))
        .map((node) => ({ name: node.name, value: node.value })),
    });
    if (!statusReadback || observedStatus !== EXPECTED_STATUS) {
      throw new Error(`Desktop status readback mismatch: ${String(statusReadback?.value)}`);
    }
    await journal('STATUS_READBACK_CONFIRMED', {
      observedStatus,
      rawStatus: statusReadback.value,
    });

    const image = await desktop.screenshot(desktopSessionId);
    const imageBytes = Buffer.from(image.dataBase64, 'base64');
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (imageBytes.length < 128 || !imageBytes.subarray(0, 8).equals(pngSignature)) {
      throw new Error('Desktop screenshot is not a valid bounded PNG');
    }
    const screenshotSha256 = sha256(imageBytes);
    await journal('SCREENSHOT_CONFIRMED', {
      screenshotBytes: imageBytes.length,
      screenshotSha256,
    });

    const closed = await desktop.close(desktopSessionId);
    desktopSessionId = undefined;
    if (closed.state !== 'CLOSED') throw new Error('Desktop session did not close');
    await journal('DESKTOP_CLOSED', { desktopCloseState: closed.state });

    const stillRunning = await machine.processInspect(workspaceId, processId) as {
      found?: unknown;
      owned?: unknown;
      state?: unknown;
    };
    const processAliveAfterDesktopClose = stillRunning.found === true
      && stillRunning.owned === true
      && stillRunning.state === 'RUNNING';
    if (!processAliveAfterDesktopClose) {
      throw new Error('desktop.close incorrectly ended the owned application process');
    }

    const terminated = await machine.processTerminate(workspaceId, processId) as {
      terminated?: unknown;
      state?: unknown;
    };
    processTerminated = terminated.terminated === true || terminated.state === 'TERMINATED';
    if (!processTerminated) throw new Error('Owned desktop fixture process was not terminated');
    await journal('PROCESS_TERMINATED', { processId, pid });

    const receipt: Receipt = {
      state: 'SUCCEEDED',
      source: 'wag-desktop-native-live-v5',
      runId,
      statePath,
      journalDir,
      workspaceId,
      processId,
      pid,
      windowMode: 'normal',
      desktopSessionId: session.desktopSessionId,
      nativeWindowId: session.nativeWindowId,
      title: session.title,
      snapshotNodeCount: snapshot.nodes.length,
      setValueEffectId: setValue.effectId,
      setValueRetryEffectId: setValueRetry.effectId,
      invokeEffectId: invoked.effectId,
      invokeRetryEffectId: invokeRetry.effectId,
      observedInput,
      observedStatus,
      screenshotBytes: imageBytes.length,
      screenshotSha256,
      desktopCloseState: closed.state,
      processAliveAfterDesktopClose,
      processTerminated,
      completedAtUtc: new Date().toISOString(),
    };

    await journal('SUCCEEDED', {
      setValueEffectId: setValue.effectId,
      invokeEffectId: invoked.effectId,
      observedInput,
      observedStatus,
      processTerminated,
    });
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch (error) {
    await journal('FAILED', {
      failedAtStage: currentStage,
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(processId === undefined ? {} : { processId }),
      ...(pid === undefined ? {} : { pid }),
      ...(desktopSessionId === undefined ? {} : { desktopSessionId }),
      ...(setValueEffectId === undefined ? {} : { setValueEffectId }),
      ...(invokeEffectId === undefined ? {} : { invokeEffectId }),
    }).catch(() => undefined);
    if (!existsSync(receiptPath)) {
      await writeFile(receiptPath, `${JSON.stringify({
        state: 'FAILED',
        source: 'wag-desktop-native-live-v5',
        runId,
        statePath,
        journalDir,
        failedAtStage: currentStage,
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(processId === undefined ? {} : { processId }),
        ...(pid === undefined ? {} : { pid }),
        ...(desktopSessionId === undefined ? {} : { desktopSessionId }),
        ...(setValueEffectId === undefined ? {} : { setValueEffectId }),
        ...(invokeEffectId === undefined ? {} : { invokeEffectId }),
        completedAtUtc: new Date().toISOString(),
      }, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (runtime.desktopContext && desktopSessionId) {
      await runtime.desktopContext.close(desktopSessionId).catch(() => undefined);
    }
    if (runtime.machineContext && workspaceId && processId && !processTerminated) {
      await runtime.machineContext.processTerminate(workspaceId, processId).catch(() => undefined);
    }
    await runtime.close().catch(() => undefined);
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }).catch(() => undefined);
  }
}

await main();
