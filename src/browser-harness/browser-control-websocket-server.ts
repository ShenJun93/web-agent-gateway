import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';

import { BROWSER_ADAPTER_EXTENSION_ID } from '../browser-adapter/native-host-distribution.js';
import {
  EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
  parseExistingBrowserControlResponse,
  parseExistingBrowserTarget,
  type ExistingBrowserControlRequest,
  type ExistingBrowserTarget,
} from '../browser-adapter/existing-browser-control-protocol.js';
import type { ExistingBrowserControlClient } from './existing-browser-control-client.js';

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}`;
const STATE_VERSION = 1 as const;
const DEFAULT_PORT = 17841;
const MAX_PENDING_REQUESTS = 128;
const MAX_TARGETS = 512;
const MAX_CONTROL_MESSAGE_BYTES = 256 * 1024;
const MAX_AX_TREE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64_CHARS = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);
const MAX_WEBSOCKET_MESSAGE_BYTES = MAX_SCREENSHOT_BASE64_CHARS + 64 * 1024;

export interface BrowserControlPairingState {
  version: typeof STATE_VERSION;
  endpoint: string;
  pairingToken: string;
}

export interface BrowserExtensionReleaseState {
  schema: 'WAG_BROWSER_EXTENSION_RELEASE_STATE_V1';
  connected: boolean;
  observedSourceHead: string | null;
  expectedSourceHead: string | null;
  match: boolean | null;
  reloadRequested: boolean;
  reloadAccepted: boolean;
  lastError: string | null;
  updatedAtUtc: string;
}

export interface BrowserControlWebSocketServer {
  readonly endpoint: string;
  readonly pairingToken: string;
  readonly client: ExistingBrowserControlClient;
  readonly connected: () => boolean;
  readonly releaseState: () => BrowserExtensionReleaseState;
  close(): Promise<void>;
}

export async function readBrowserControlPairingState(
  statePath: string,
): Promise<BrowserControlPairingState> {
  const value = JSON.parse(await readFile(statePath, 'utf8')) as unknown;
  return parsePairingState(value);
}

export async function loadOrCreateBrowserControlPairingState(
  statePath: string,
  port = DEFAULT_PORT,
): Promise<BrowserControlPairingState> {
  try {
    return await readBrowserControlPairingState(statePath);
  } catch {
    const state: BrowserControlPairingState = {
      version: STATE_VERSION,
      endpoint: `ws://127.0.0.1:${port}/browser-control`,
      pairingToken: randomBytes(32).toString('base64url'),
    };
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify(state, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    return state;
  }
}

export async function startBrowserControlWebSocketServer(options: {
  statePath: string;
  port?: number;
  pairingState?: BrowserControlPairingState;
  extensionOrigin?: string;
  requestTimeoutMs?: number;
  expectedExtensionSourceHead?: string;
  extensionReleaseStatePath?: string;
}): Promise<BrowserControlWebSocketServer> {
  const state = options.pairingState
    ?? await loadOrCreateBrowserControlPairingState(options.statePath, options.port ?? DEFAULT_PORT);
  const endpoint = new URL(state.endpoint);
  const port = Number(endpoint.port);
  const extensionOrigin = options.extensionOrigin ?? EXTENSION_ORIGIN;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const expectedExtensionSourceHead = validSourceHead(options.expectedExtensionSourceHead)
    ? options.expectedExtensionSourceHead!
    : undefined;
  const extensionReleaseStatePath = options.extensionReleaseStatePath
    ?? options.statePath + '.extension-release.json';
  let extensionReleaseState: BrowserExtensionReleaseState = {
    schema: 'WAG_BROWSER_EXTENSION_RELEASE_STATE_V1',
    connected: false,
    observedSourceHead: null,
    expectedSourceHead: expectedExtensionSourceHead ?? null,
    match: expectedExtensionSourceHead === undefined ? null : false,
    reloadRequested: false,
    reloadAccepted: false,
    lastError: null,
    updatedAtUtc: new Date().toISOString(),
  };
  await persistExtensionReleaseState(extensionReleaseStatePath, extensionReleaseState);
  let extensionReleaseWrite: Promise<void> = Promise.resolve();
  const queueExtensionReleaseState = (): Promise<void> => {
    const snapshot = { ...extensionReleaseState };
    extensionReleaseWrite = extensionReleaseWrite
      .catch(() => undefined)
      .then(() => persistExtensionReleaseState(extensionReleaseStatePath, snapshot))
      .catch(() => undefined);
    return extensionReleaseWrite;
  };

  let peer: WebSocket | undefined;
  let authenticated = false;
  let closing = false;
  const pending = new Map<string, {
    method: ExistingBrowserControlRequest['method'];
    maxResponseBytes: number;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  }>();

  const server = new WebSocketServer({
    host: '127.0.0.1',
    port,
    path: '/browser-control',
    maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
    verifyClient: ({ origin }: { origin: string }) => origin === extensionOrigin,
  });

  server.on('connection', (socket) => {
    let admitted = false;
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'text only');
        return;
      }
      const text = data.toString();
      const wireBytes = Buffer.byteLength(text, 'utf8');
      let message: unknown;
      try { message = JSON.parse(text); }
      catch {
        socket.close(1007, 'invalid json');
        return;
      }

      if (!admitted) {
        if (!isHello(message, state.pairingToken)) {
          socket.close(1008, 'pairing failed');
          return;
        }
        if (peer && peer !== socket) peer.close(4001, 'superseded');
        peer = socket;
        admitted = true;
        authenticated = true;
        const observedSourceHead = extensionHelloSourceHead(message);
        extensionReleaseState = {
          ...extensionReleaseState,
          connected: true,
          observedSourceHead: observedSourceHead ?? null,
          match: expectedExtensionSourceHead === undefined
            ? null
            : observedSourceHead === expectedExtensionSourceHead,
          reloadRequested: false,
          reloadAccepted: false,
          lastError: null,
          updatedAtUtc: new Date().toISOString(),
        };
        void queueExtensionReleaseState();
        socket.send(JSON.stringify({
          version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
          type: 'control.ready',
        }));
        if (expectedExtensionSourceHead !== undefined
            && observedSourceHead !== expectedExtensionSourceHead) {
          extensionReleaseState = {
            ...extensionReleaseState,
            reloadRequested: true,
            updatedAtUtc: new Date().toISOString(),
          };
          void queueExtensionReleaseState();
          void request('extension.reload').then((value) => {
            const row = value && typeof value === 'object' && !Array.isArray(value)
              ? value as Record<string, unknown> : {};
            extensionReleaseState = {
              ...extensionReleaseState,
              reloadAccepted: row.accepted === true,
              lastError: row.accepted === true ? null : 'EXTENSION_RELOAD_NOT_ACCEPTED',
              updatedAtUtc: new Date().toISOString(),
            };
            return queueExtensionReleaseState();
          }).catch((error) => {
            extensionReleaseState = {
              ...extensionReleaseState,
              reloadAccepted: false,
              lastError: String(error instanceof Error ? error.message : error).slice(0, 512),
              updatedAtUtc: new Date().toISOString(),
            };
            return queueExtensionReleaseState();
          });
        }
        return;
      }

      if (isPing(message)) {
        socket.send(JSON.stringify({
          version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
          type: 'control.pong',
        }));
        return;
      }

      let response;
      try { response = parseExistingBrowserControlResponse(message); }
      catch { return; }
      const entry = pending.get(response.requestId);
      if (!entry) return;
      const maxBytes = entry.maxResponseBytes;
      if (wireBytes > maxBytes) {
        pending.delete(response.requestId);
        clearTimeout(entry.timer);
        entry.reject(new Error('Browser control response exceeds size limit'));
        socket.close(1009, 'response too large');
        return;
      }
      pending.delete(response.requestId);
      clearTimeout(entry.timer);
      if (response.type === 'control.error') {
        entry.reject(new Error(response.error.code + ': ' + response.error.message));
      } else {
        entry.resolve(response.result);
      }
    });

    socket.on('close', () => {
      if (peer === socket) {
        peer = undefined;
        authenticated = false;
        extensionReleaseState = {
          ...extensionReleaseState,
          connected: false,
          updatedAtUtc: new Date().toISOString(),
        };
        if (!closing) void queueExtensionReleaseState();
        rejectAll(new Error('Browser control extension disconnected'));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    if (server.address()) { resolve(); return; }
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  function rejectAll(error: Error) {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  function request(
    method: ExistingBrowserControlRequest['method'],
    targetId?: string,
    currentTargetId?: string,
    groupTitle?: string,
    cdpMethod?: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    if (!peer || !authenticated || peer.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Browser control extension is offline'));
    }
    if (pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(new Error('Browser control pending request limit reached'));
    }
    const requestId = `bctl_${randomUUID()}`;
    const maxResponseBytes = method === 'target.screenshot'
      ? MAX_WEBSOCKET_MESSAGE_BYTES
      : method === 'target.exec' && cdpMethod === 'Accessibility.getFullAXTree'
        ? MAX_AX_TREE_RESPONSE_BYTES
        : MAX_CONTROL_MESSAGE_BYTES;
    const message: ExistingBrowserControlRequest = {
      version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
      type: 'control.request',
      requestId,
      method,
      ...(targetId === undefined ? {} : { targetId }),
      ...(currentTargetId === undefined ? {} : { currentTargetId }),
      ...(groupTitle === undefined ? {} : { groupTitle }),
      ...(cdpMethod === undefined ? {} : { cdpMethod }),
      ...(params === undefined ? {} : { params }),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('Browser control request timed out'));
      }, requestTimeoutMs);
      timer.unref?.();
      pending.set(requestId, { method, maxResponseBytes, resolve, reject, timer });
      peer!.send(JSON.stringify(message), (error) => {
        if (!error) return;
        const entry = pending.get(requestId);
        if (!entry) return;
        pending.delete(requestId);
        clearTimeout(entry.timer);
        entry.reject(error);
      });
    });
  }

  const client: ExistingBrowserControlClient = {
    async extensionStatus() {
      return parseExtensionReleaseResult(await request('extension.status'));
    },
    async reloadExtension() {
      const value = await request('extension.reload');
      const status = parseExtensionReleaseResult(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || (value as Record<string, unknown>).accepted !== true) {
        throw new Error('Browser extension reload response is invalid');
      }
      return { accepted: true, ...status };
    },
    async listTargets() {
      const value = await request('targets.list');
      if (!Array.isArray(value)) throw new Error('Browser control target list is invalid');
      if (value.length > MAX_TARGETS) throw new Error('Browser control target list exceeds limit');
      return Object.freeze(value.map(parseExistingBrowserTarget));
    },
    async createTarget() {
      return parseExistingBrowserTarget(await request('target.create'));
    },
    async watchContinuity(targetId) {
      const value = await request('target.watch', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser continuity watch response is invalid');
      }
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || !Number.isInteger(row.baselineSequence) || Number(row.baselineSequence) < 0) {
        throw new Error('Browser continuity watch response is invalid');
      }
      return { targetId, baselineSequence: Number(row.baselineSequence) };
    },
    async resolveContinuity(rootTargetId, currentTargetId) {
      const value = await request('target.continuity', rootTargetId, currentTargetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser continuity response is invalid');
      }
      const row = value as Record<string, unknown>;
      const reasons = ['CURRENT_GONE', 'ROOT_UPDATED', 'SUCCESSOR', 'NO_CHANGE'] as const;
      if (!Number.isInteger(row.sequence) || Number(row.sequence) < 0
          || typeof row.reason !== 'string' || !reasons.includes(row.reason as typeof reasons[number])) {
        throw new Error('Browser continuity response is invalid');
      }
      return {
        sequence: Number(row.sequence),
        reason: row.reason as typeof reasons[number],
        target: row.target === null ? null : parseExistingBrowserTarget(row.target),
      };
    },
    async groupTarget(targetId, title) {
      const value = await request('target.group', targetId, undefined, title);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser control group response is invalid');
      }
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || typeof row.groupId !== 'string'
          || typeof row.groupTitle !== 'string' || typeof row.activeStable !== 'boolean') {
        throw new Error('Browser control group response is invalid');
      }
      return {
        targetId,
        groupId: row.groupId,
        groupTitle: row.groupTitle,
        activeStable: row.activeStable,
      };
    },
    async attach(targetId) {
      return parseExistingBrowserTarget(await request('target.attach', targetId));
    },
    async describe(targetId) {
      return parseExistingBrowserTarget(await request('target.describe', targetId));
    },
    exec: (targetId, method, params) => request('target.exec', targetId, undefined, undefined, method, params),
    async screenshot(targetId) {
      const value = await request('target.screenshot', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser screenshot invalid');
      const row = value as Record<string, unknown>;
      if (row.mimeType !== 'image/png' || typeof row.dataBase64 !== 'string') throw new Error('Browser screenshot invalid');
      if (row.dataBase64.length > MAX_SCREENSHOT_BASE64_CHARS
          || Buffer.byteLength(row.dataBase64, 'base64') > MAX_SCREENSHOT_BYTES) {
        throw new Error('Browser screenshot exceeds size limit');
      }
      return { mimeType: 'image/png', dataBase64: row.dataBase64 };
    },
    async release(targetId) {
      const value = await request('target.release', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser release invalid');
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || typeof row.released !== 'boolean') throw new Error('Browser release invalid');
      return { targetId, released: row.released };
    },
    async closeTarget(targetId) {
      const value = await request('target.close', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Browser close invalid');
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || typeof row.closed !== 'boolean') throw new Error('Browser close invalid');
      return { targetId, closed: row.closed };
    },
  };

  return {
    endpoint: state.endpoint,
    pairingToken: state.pairingToken,
    client,
    connected: () => authenticated,
    releaseState: () => ({ ...extensionReleaseState }),
    async close() {
      closing = true;
      rejectAll(new Error('Browser control server closed'));
      if (peer) peer.close(1001, 'server closing');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await extensionReleaseWrite.catch(() => undefined);
    },
  };
}

function validSourceHead(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function extensionHelloSourceHead(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const release = (value as Record<string, unknown>).extensionRelease;
  if (!release || typeof release !== 'object' || Array.isArray(release)) return undefined;
  const row = release as Record<string, unknown>;
  if (row.schema !== 'WAG_BROWSER_EXTENSION_RELEASE_V1') return undefined;
  return validSourceHead(row.sourceHead) || row.sourceHead === 'development'
    ? row.sourceHead as string
    : undefined;
}

function parseExtensionReleaseResult(value: unknown): { schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1'; sourceHead: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser extension release response is invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== 'WAG_BROWSER_EXTENSION_RELEASE_V1'
      || !(validSourceHead(row.sourceHead) || row.sourceHead === 'development')) {
    throw new Error('Browser extension release response is invalid');
  }
  return { schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1', sourceHead: row.sourceHead as string };
}

async function persistExtensionReleaseState(path: string, state: BrowserExtensionReleaseState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  await rename(temp, path);
}

function parsePairingState(value: unknown): BrowserControlPairingState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser control pairing state');
  const row = value as Record<string, unknown>;
  if (row.version !== STATE_VERSION
      || typeof row.endpoint !== 'string'
      || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/browser-control$/.test(row.endpoint)
      || typeof row.pairingToken !== 'string'
      || !/^[A-Za-z0-9_-]{32,256}$/.test(row.pairingToken)) {
    throw new Error('Invalid browser control pairing state');
  }
  return {
    version: STATE_VERSION,
    endpoint: row.endpoint,
    pairingToken: row.pairingToken,
  };
}

function isHello(value: unknown, token: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION
    && row.type === 'control.hello'
    && row.pairingToken === token;
}

function isPing(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION && row.type === 'control.ping';
}
