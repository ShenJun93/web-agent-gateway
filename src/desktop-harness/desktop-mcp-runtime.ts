import { createHash } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import type { LocalMachineContext } from '../local-machine-runtime.js';
import { HarnessEffectCoordinator } from '../harness-effect-coordinator.js';
import {
  HarnessEffectLedger,
  type HarnessEffectRecord,
} from '../harness-effect-ledger.js';
import type { CanonicalValue } from '../proposal-fingerprint.js';
import {
  createDesktopPort,
  type DesktopPort,
  type DesktopSessionHandle,
  type DesktopSnapshot,
  type DesktopTargetIdentity,
  type DesktopTargetResolver,
} from './desktop-port.js';
import {
  createPowerShellWindowsUiaBridgeClient,
  createWindowsUiaDesktopBackend,
  resolveWindowsDesktopWindow,
  type WindowsUiaBridgeClient,
} from './windows-uia-backend.js';

export type DesktopMcpAction =
  | { readonly type: 'invoke'; readonly ref: string }
  | { readonly type: 'setValue'; readonly ref: string; readonly value: string }
  | { readonly type: 'toggle'; readonly ref: string }
  | { readonly type: 'select'; readonly ref: string };

export interface DesktopMcpSession {
  readonly desktopSessionId: string;
  readonly processId: string;
  readonly pid: number;
  readonly executablePath: string;
  readonly nativeWindowId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: string;
}

export interface DesktopMcpSnapshot {
  readonly snapshotId: string;
  readonly desktopSessionId: string;
  readonly pid: number;
  readonly executablePath: string;
  readonly nativeWindowId: string;
  readonly title: string;
  readonly nodes: DesktopSnapshot['nodes'];
  readonly observedAt: number;
}

export interface DesktopMcpEffect {
  readonly effectId: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly planFingerprint: string;
  readonly state: HarnessEffectRecord['state'];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attemptId?: string;
  readonly resultDigest?: string;
  readonly errorClass?: string;
}

export interface DesktopMcpContext {
  open(workspaceId: string, processId: string): Promise<DesktopMcpSession>;
  describe(desktopSessionId: string): Promise<DesktopMcpSession>;
  snapshot(desktopSessionId: string): Promise<DesktopMcpSnapshot>;
  exec(
    desktopSessionId: string,
    idempotencyKey: string,
    action: DesktopMcpAction,
  ): Promise<DesktopMcpEffect>;
  effect(effectId: string): Promise<DesktopMcpEffect>;
  screenshot(desktopSessionId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(desktopSessionId: string): Promise<DesktopMcpSession>;
  closeAll(): Promise<void>;
}

interface SessionBinding {
  readonly workspaceId: string;
  readonly processId: string;
}

const WORKSPACE_ID = /^ws_[0-9a-f-]{36}$/;
const PROCESS_ID = /^proc_[0-9a-f-]{36}$/;
const TARGET_ID = /^desktop_target:(ws_[0-9a-f-]{36}):(proc_[0-9a-f-]{36})$/;
const SESSION_ID = /^desktop_[0-9a-f-]{36}$/;

function parseOwnedProcess(value: unknown, workspaceId: string, processId: string): {
  pid: number;
  executablePath: string;
  creationDate: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Desktop process inspection is invalid');
  const row = value as {
    found?: unknown;
    owned?: unknown;
    process_id?: unknown;
    pid?: unknown;
    executable_path?: unknown;
    creation_date?: unknown;
    state?: unknown;
  };
  if (row.found !== true
      || row.owned !== true
      || row.process_id !== processId
      || !Number.isInteger(row.pid)
      || (row.pid as number) <= 0
      || typeof row.executable_path !== 'string'
      || row.executable_path.length < 1
      || row.executable_path.includes('\0')
      || Buffer.byteLength(row.executable_path, 'utf8') > 4096
      || typeof row.creation_date !== 'string'
      || row.creation_date.length < 1
      || /[\u0000-\u001F]/.test(row.creation_date)
      || Buffer.byteLength(row.creation_date, 'utf8') > 256
      || row.state !== 'RUNNING') {
    throw new Error(`Desktop requires a running WAG-owned process in workspace ${workspaceId}`);
  }
  return {
    pid: row.pid as number,
    executablePath: row.executable_path,
    creationDate: row.creation_date,
  };
}

function targetId(workspaceId: string, processId: string): string {
  if (!WORKSPACE_ID.test(workspaceId)) throw new Error('Desktop workspace id is invalid');
  if (!PROCESS_ID.test(processId)) throw new Error('Desktop process id must be WAG-owned');
  return `desktop_target:${workspaceId}:${processId}`;
}

function parseTargetId(value: string): { workspaceId: string; processId: string } {
  const match = TARGET_ID.exec(value);
  if (!match) throw new Error('Desktop target identity is invalid');
  return { workspaceId: match[1]!, processId: match[2]! };
}

function sessionView(handle: DesktopSessionHandle, binding: SessionBinding): DesktopMcpSession {
  return Object.freeze({
    desktopSessionId: handle.desktopSessionId,
    processId: binding.processId,
    pid: handle.target.pid,
    executablePath: handle.target.executablePath,
    nativeWindowId: handle.target.nativeWindowId,
    title: handle.target.title,
    createdAt: handle.createdAt,
    lastSeenAt: handle.lastSeenAt,
    state: handle.state,
  });
}

function snapshotView(snapshot: DesktopSnapshot): DesktopMcpSnapshot {
  return Object.freeze({
    snapshotId: snapshot.snapshotId,
    desktopSessionId: snapshot.desktopSessionId,
    pid: snapshot.target.pid,
    executablePath: snapshot.target.executablePath,
    nativeWindowId: snapshot.target.nativeWindowId,
    title: snapshot.target.title,
    nodes: snapshot.nodes,
    observedAt: snapshot.observedAt,
  });
}

function effectView(value: HarnessEffectRecord): DesktopMcpEffect {
  return Object.freeze({
    effectId: value.effectId,
    kind: value.kind,
    resourceId: value.resourceId,
    planFingerprint: value.planFingerprint,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
    ...(value.resultDigest === undefined ? {} : { resultDigest: value.resultDigest }),
    ...(value.errorClass === undefined ? {} : { errorClass: value.errorClass }),
  });
}

function successDigest(action: DesktopMcpAction): string {
  return `sha256_${createHash('sha256').update(JSON.stringify(action), 'utf8').digest('hex')}`;
}

function createOwnedProcessResolver(options: {
  machineContext: LocalMachineContext;
  owner: GatewayAuthority;
  bridge: WindowsUiaBridgeClient;
}): DesktopTargetResolver {
  return {
    async resolve(owner, id): Promise<DesktopTargetIdentity> {
      if (owner.ownerId !== options.owner.ownerId
          || owner.sessionId !== options.owner.sessionId
          || owner.adapterId !== options.owner.adapterId) {
        throw new Error('Desktop resolver authority mismatch');
      }
      const { workspaceId, processId } = parseTargetId(id);
      const inspected = parseOwnedProcess(
        await options.machineContext.processInspect(workspaceId, processId),
        workspaceId,
        processId,
      );
      const window = await resolveWindowsDesktopWindow(options.bridge, inspected.pid);
      return Object.freeze({
        targetId: id,
        pid: inspected.pid,
        processInstanceId: `created:${inspected.creationDate}`,
        executablePath: inspected.executablePath,
        nativeWindowId: `hwnd:${window.hwndHex}`,
        title: window.title,
      });
    },
  };
}

export function createPrivateDesktopMcpContext(options: {
  owner: GatewayAuthority;
  machineContext: LocalMachineContext;
  effectStatePath: string;
  killSwitch: () => boolean;
  bridge?: WindowsUiaBridgeClient;
  port?: DesktopPort;
}): DesktopMcpContext {
  if (process.platform !== 'win32' && options.port === undefined) {
    throw new Error('DesktopPort native backend requires Windows');
  }

  const bridge = options.bridge ?? createPowerShellWindowsUiaBridgeClient();
  const port = options.port ?? createDesktopPort({
    resolver: createOwnedProcessResolver({
      machineContext: options.machineContext,
      owner: options.owner,
      bridge,
    }),
    backend: createWindowsUiaDesktopBackend({ bridge }),
    effectAllowed: () => !options.killSwitch(),
  });
  const effects = new HarnessEffectLedger(options.effectStatePath);
  effects.reconcileExecuting();
  const coordinator = new HarnessEffectCoordinator(effects);
  const sessions = new Map<string, SessionBinding>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error('Desktop MCP runtime is closed');
  }

  function binding(desktopSessionId: string): SessionBinding {
    if (!SESSION_ID.test(desktopSessionId)) throw new Error('Desktop session id is invalid');
    const value = sessions.get(desktopSessionId);
    if (!value) throw new Error('Desktop session is not owned by this runtime');
    return value;
  }

  function assertEffectAllowed(): void {
    assertOpen();
    if (options.killSwitch()) throw new Error('Desktop MCP effect denied by autonomous stop');
  }

  return {
    async open(workspaceId, processId) {
      assertEffectAllowed();
      const id = targetId(workspaceId, processId);
      const opened = await port.open(options.owner, id);
      const owned = Object.freeze({ workspaceId, processId });
      sessions.set(opened.desktopSessionId, owned);
      return sessionView(opened, owned);
    },

    async describe(desktopSessionId) {
      assertOpen();
      const owned = binding(desktopSessionId);
      return sessionView(await port.describe(options.owner, desktopSessionId), owned);
    },

    async snapshot(desktopSessionId) {
      assertOpen();
      binding(desktopSessionId);
      return snapshotView(await port.snapshot(options.owner, desktopSessionId));
    },

    async exec(desktopSessionId, idempotencyKey, action) {
      assertEffectAllowed();
      binding(desktopSessionId);
      return effectView(await coordinator.execute(
        options.owner,
        idempotencyKey,
        {
          kind: `desktop.${action.type}`,
          resourceId: desktopSessionId,
          arguments: action as unknown as CanonicalValue,
        },
        async () => {
          assertEffectAllowed();
          switch (action.type) {
            case 'invoke':
              await port.invoke(options.owner, desktopSessionId, action.ref);
              break;
            case 'setValue':
              await port.setValue(options.owner, desktopSessionId, action.ref, action.value);
              break;
            case 'toggle':
              await port.toggle(options.owner, desktopSessionId, action.ref);
              break;
            case 'select':
              await port.select(options.owner, desktopSessionId, action.ref);
              break;
          }
          return { status: 'CONFIRMED_SUCCESS', resultDigest: successDigest(action) };
        },
      ));
    },

    async effect(effectId) {
      assertOpen();
      return effectView(effects.get(options.owner, effectId));
    },

    async screenshot(desktopSessionId) {
      assertOpen();
      binding(desktopSessionId);
      return await port.screenshot(options.owner, desktopSessionId);
    },

    async close(desktopSessionId) {
      assertOpen();
      const owned = binding(desktopSessionId);
      const closedSession = await port.close(options.owner, desktopSessionId);
      sessions.delete(desktopSessionId);
      return sessionView(closedSession, owned);
    },

    async closeAll() {
      if (closed) return;
      closed = true;
      for (const desktopSessionId of [...sessions.keys()]) {
        await port.close(options.owner, desktopSessionId).catch(() => undefined);
      }
      sessions.clear();
      effects.close();
    },
  };
}
