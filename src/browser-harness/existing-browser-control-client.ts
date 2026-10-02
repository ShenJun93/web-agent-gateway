import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { join } from 'node:path';
import {
  EXISTING_BROWSER_CONTROL_MAX_BYTES,
  EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
  parseExistingBrowserControlResponse,
  parseExistingBrowserTarget,
  type ExistingBrowserControlRequest,
  type ExistingBrowserDownloadEventMethod,
  type ExistingBrowserTarget,
} from '../browser-adapter/existing-browser-control-protocol.js';
import {
  loadBrowserControlHostDiscovery,
  type BrowserControlHostDiscovery,
} from '../browser-adapter/native-host-browser-control.js';

export class ExistingBrowserControlClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ExistingBrowserControlClientError';
  }
}

export function defaultExistingBrowserControlDiscoveryPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, 'WebAgentGateway', 'browser-control-v1.json')
    : undefined;
}

export interface ExistingBrowserControlClient {
  extensionStatus?(): Promise<{ schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1'; sourceHead: string }>;
  reloadExtension?(): Promise<{ accepted: boolean; schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1'; sourceHead: string }>;
  listTargets(): Promise<readonly ExistingBrowserTarget[]>;
  createTarget(): Promise<ExistingBrowserTarget>;
  watchContinuity(targetId: string): Promise<{ targetId: string; baselineSequence: number }>;
  resolveContinuity(rootTargetId: string, currentTargetId: string): Promise<{
    sequence: number;
    reason: 'CURRENT_GONE' | 'ROOT_UPDATED' | 'SUCCESSOR' | 'NO_CHANGE';
    target: ExistingBrowserTarget | null;
  }>;
  groupTarget(targetId: string, title: string): Promise<{ targetId: string; groupId: string; groupTitle: string; activeStable: boolean }>;
  attach(targetId: string): Promise<ExistingBrowserTarget>;
  describe(targetId: string): Promise<ExistingBrowserTarget>;
  exec(targetId: string, method: string, params?: Readonly<Record<string, unknown>>): Promise<unknown>;
  onEvent?(
    targetId: string,
    method: ExistingBrowserDownloadEventMethod,
    listener: (params: Readonly<Record<string, unknown>>) => void,
  ): () => void;
  screenshot(targetId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  release(targetId: string): Promise<{ targetId: string; released: boolean }>;
  closeTarget(targetId: string): Promise<{ targetId: string; closed: boolean }>;
}

function parseExtensionStatus(value: unknown): { schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1'; sourceHead: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Browser extension release status is invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== 'WAG_BROWSER_EXTENSION_RELEASE_V1'
      || typeof row.sourceHead !== 'string'
      || (!/^[a-f0-9]{40}$/.test(row.sourceHead) && row.sourceHead !== 'development')) {
    throw new Error('Browser extension release status is invalid');
  }
  return { schema: 'WAG_BROWSER_EXTENSION_RELEASE_V1', sourceHead: row.sourceHead };
}

export function createExistingBrowserControlClient(options: {
  discoveryPath: string;
  timeoutMs?: number;
}): ExistingBrowserControlClient {
  const timeoutMs = options.timeoutMs ?? 5000;

  async function call(
    method: ExistingBrowserControlRequest['method'],
    targetId?: string,
    currentTargetId?: string,
    groupTitle?: string,
    cdpMethod?: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    const request: ExistingBrowserControlRequest = {
      version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
      type: 'control.request',
      requestId: `bctl_${randomUUID()}`,
      method,
      ...(targetId === undefined ? {} : { targetId }),
      ...(currentTargetId === undefined ? {} : { currentTargetId }),
      ...(groupTitle === undefined ? {} : { groupTitle }),
      ...(cdpMethod === undefined ? {} : { cdpMethod }),
      ...(params === undefined ? {} : { params }),
    };
    const discovery = await loadBrowserControlHostDiscovery(options.discoveryPath);
    return send(discovery, request, timeoutMs);
  }

  return {
    async extensionStatus() {
      return parseExtensionStatus(await call('extension.status'));
    },
    async reloadExtension() {
      const value = await call('extension.reload');
      const status = parseExtensionStatus(value);
      if (!value || typeof value !== 'object' || Array.isArray(value)
          || (value as Record<string, unknown>).accepted !== true) {
        throw new Error('Browser extension reload response is invalid');
      }
      return { accepted: true, ...status };
    },
    async listTargets() {
      const value = await call('targets.list');
      if (!Array.isArray(value)) throw new Error('Browser control target list is invalid');
      return Object.freeze(value.map(parseExistingBrowserTarget));
    },
    async createTarget() {
      return parseExistingBrowserTarget(await call('target.create'));
    },
    async watchContinuity(targetId) {
      const value = await call('target.watch', targetId);
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
      const value = await call('target.continuity', rootTargetId, currentTargetId);
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
      const value = await call('target.group', targetId, undefined, title);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser control group response is invalid');
      }
      const row = value as Record<string, unknown>;
      if (typeof row.groupId !== 'string' || typeof row.groupTitle !== 'string'
          || typeof row.activeStable !== 'boolean') {
        throw new Error('Browser control group response is invalid');
      }
      return { targetId, groupId: row.groupId, groupTitle: row.groupTitle, activeStable: row.activeStable };
    },
    async attach(targetId) {
      return parseExistingBrowserTarget(await call('target.attach', targetId));
    },
    async describe(targetId) {
      return parseExistingBrowserTarget(await call('target.describe', targetId));
    },
    exec: (targetId, method, params) => call('target.exec', targetId, undefined, undefined, method, params),
    async screenshot(targetId) {
      const value = await call('target.screenshot', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser control screenshot is invalid');
      }
      const row = value as Record<string, unknown>;
      if (row.mimeType !== 'image/png' || typeof row.dataBase64 !== 'string') {
        throw new Error('Browser control screenshot is invalid');
      }
      return { mimeType: 'image/png', dataBase64: row.dataBase64 };
    },
    async release(targetId) {
      const value = await call('target.release', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser control release response is invalid');
      }
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || typeof row.released !== 'boolean') {
        throw new Error('Browser control release response is invalid');
      }
      return { targetId, released: row.released };
    },
    async closeTarget(targetId) {
      const value = await call('target.close', targetId);
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Browser control close response is invalid');
      }
      const row = value as Record<string, unknown>;
      if (row.targetId !== targetId || typeof row.closed !== 'boolean') {
        throw new Error('Browser control close response is invalid');
      }
      return { targetId, closed: row.closed };
    },
  };
}

async function send(
  discovery: BrowserControlHostDiscovery,
  request: ExistingBrowserControlRequest,
  timeoutMs: number,
): Promise<unknown> {
  const endpoint = new URL(discovery.endpoint);
  const port = Number(endpoint.port);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new ExistingBrowserControlClientError(
      'CONTROL_HOST_TIMEOUT', 'Browser control host timed out',
    )), timeoutMs);
    timer.unref?.();

    socket.once('connect', () => {
      socket.write(JSON.stringify({ bearerToken: discovery.bearerToken, request }) + '\n');
    });
    socket.on('data', (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      if (buffer.length > EXISTING_BROWSER_CONTROL_MAX_BYTES + 4096) {
        finish(new ExistingBrowserControlClientError('CONTROL_RESPONSE_TOO_LARGE', 'Browser control response too large'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      let value: unknown;
      try { value = JSON.parse(buffer.subarray(0, newline).toString('utf8')); }
      catch {
        finish(new ExistingBrowserControlClientError('CONTROL_RESPONSE_INVALID', 'Browser control response invalid'));
        return;
      }
      let response;
      try { response = parseExistingBrowserControlResponse(value); }
      catch {
        const row = value && typeof value === 'object' && !Array.isArray(value)
          ? value as Record<string, unknown> : undefined;
        const error = row?.error && typeof row.error === 'object' && !Array.isArray(row.error)
          ? row.error as Record<string, unknown> : undefined;
        finish(new ExistingBrowserControlClientError(
          typeof error?.code === 'string' ? error.code : 'CONTROL_RESPONSE_INVALID',
          typeof error?.message === 'string' ? error.message : 'Browser control response invalid',
        ));
        return;
      }
      if (response.requestId !== request.requestId) {
        finish(new ExistingBrowserControlClientError('CONTROL_RESPONSE_MISMATCH', 'Browser control response mismatch'));
        return;
      }
      if (response.type === 'control.error') {
        finish(new ExistingBrowserControlClientError(response.error.code, response.error.message));
      } else {
        finish(undefined, response.result);
      }
    });
    socket.once('error', () => finish(new ExistingBrowserControlClientError(
      'CONTROL_HOST_UNAVAILABLE', 'Browser control host is unavailable',
    )));
    socket.once('close', () => {
      if (!settled) finish(new ExistingBrowserControlClientError(
        'CONTROL_HOST_CLOSED', 'Browser control host closed before responding',
      ));
    });
  });
}
