import type { CdpCommand, CdpResponse, CdpTransport } from './cdp-protocol.js';

interface WebSocketEventLike {
  readonly data?: unknown;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: WebSocketEventLike) => void, options?: { once?: boolean }): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type FetchLike = (input: string, init?: { signal?: AbortSignal }) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}>;

const OPEN = 1;
const CLOSED = 3;

function loopback(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1'
    || normalized === '::1' || normalized === '[::1]';
}

function assertAllowedEndpoint(url: URL, allowRemote: boolean): void {
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('CDP endpoint scheme is not supported');
  }
  if (!allowRemote && !loopback(url.hostname)) {
    throw new Error('Remote CDP endpoint is denied');
  }
}

export async function resolveCdpWebSocketEndpoint(options: {
  endpointUrl: string;
  allowRemote?: boolean;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<string> {
  const allowRemote = options.allowRemote ?? false;
  const endpoint = new URL(options.endpointUrl);
  assertAllowedEndpoint(endpoint, allowRemote);
  if (endpoint.protocol === 'ws:' || endpoint.protocol === 'wss:') return endpoint.toString();

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) throw new Error('fetch is unavailable for CDP endpoint discovery');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  try {
    const versionUrl = new URL('/json/version', endpoint);
    const response = await fetchImpl(versionUrl.toString(), { signal: controller.signal });
    if (!response.ok) throw new Error(`CDP discovery failed with HTTP ${response.status}`);
    const body = await response.json() as { webSocketDebuggerUrl?: unknown };
    if (typeof body.webSocketDebuggerUrl !== 'string' || body.webSocketDebuggerUrl.length === 0) {
      throw new Error('CDP discovery response has no webSocketDebuggerUrl');
    }
    const websocket = new URL(body.webSocketDebuggerUrl);
    assertAllowedEndpoint(websocket, allowRemote);
    if (websocket.protocol !== 'ws:' && websocket.protocol !== 'wss:') {
      throw new Error('CDP discovery returned a non-WebSocket endpoint');
    }
    return websocket.toString();
  } finally {
    clearTimeout(timer);
  }
}

function socketFactory(url: string): WebSocketLike {
  const ctor = (globalThis as unknown as { WebSocket?: new (input: string) => WebSocketLike }).WebSocket;
  if (!ctor) throw new Error('WebSocket is unavailable in this Node runtime');
  return new ctor(url);
}

export async function createNodeCdpTransport(options: {
  endpointUrl: string;
  allowRemote?: boolean;
  fetchImpl?: FetchLike;
  createWebSocket?: (url: string) => WebSocketLike;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
}): Promise<CdpTransport> {
  const websocketUrl = await resolveCdpWebSocketEndpoint(options);
  const socket = (options.createWebSocket ?? socketFactory)(websocketUrl);
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const commandTimeoutMs = options.commandTimeoutMs ?? 10_000;
  const pending = new Map<number, {
    resolve(value: CdpResponse): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let terminalError: Error | undefined;

  await new Promise<void>((resolvePromise, reject) => {
    if (socket.readyState === OPEN) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timed out')), connectTimeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(timer);
      resolvePromise();
    }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket connection failed'));
    }, { once: true });
  });

  function failAll(error: Error): void {
    terminalError = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let value: unknown;
    try {
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const response = value as Partial<CdpResponse> & { id?: unknown };
    if (typeof response.id !== 'number') return;
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id);
    clearTimeout(item.timer);
    item.resolve(value as CdpResponse);
  });
  socket.addEventListener('close', () => failAll(new Error('CDP WebSocket closed')));
  socket.addEventListener('error', () => failAll(new Error('CDP WebSocket failed')));

  return {
    async send(command: CdpCommand) {
      if (terminalError) throw terminalError;
      if (socket.readyState !== OPEN) throw new Error('CDP WebSocket is not open');
      if (pending.has(command.id)) throw new Error(`CDP command id ${command.id} is already pending`);
      return new Promise<CdpResponse>((resolvePromise, reject) => {
        const timer = setTimeout(() => {
          pending.delete(command.id);
          reject(new Error(`CDP command ${command.method} timed out`));
        }, commandTimeoutMs);
        pending.set(command.id, { resolve: resolvePromise, reject, timer });
        try {
          socket.send(JSON.stringify(command));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(command.id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },

    async close() {
      if (socket.readyState === CLOSED) return;
      socket.close(1000, 'WAG BrowserPort close');
    },
  };
}
