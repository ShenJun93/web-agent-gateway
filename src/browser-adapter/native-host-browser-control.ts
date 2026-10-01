import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import {
  EXISTING_BROWSER_CONTROL_MAX_BYTES,
  EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
  parseExistingBrowserControlRequest,
  parseExistingBrowserControlResponse,
  type ExistingBrowserControlRequest,
} from './existing-browser-control-protocol.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from './native-host-distribution.js';

const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;
const MAX_PENDING = 256;

export interface BrowserControlHostDiscovery {
  protocolVersion: typeof EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION;
  endpoint: string;
  bearerToken: string;
}

export interface NativeBrowserControlHost {
  endpoint: string;
  discoveryPath: string;
  close(): Promise<void>;
}

export interface NativeBrowserControlHostInvocation {
  expectedOrigin: string;
  discoveryPath: string;
}

export function parseNativeBrowserControlHostInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): NativeBrowserControlHostInvocation {
  const origins = argv.filter((arg) => arg === EXTENSION_ORIGIN);
  if (origins.length !== 1) throw new Error('Browser control host requires exact extension origin');
  const override = argv.indexOf('--discovery');
  let discoveryPath: string;
  if (override >= 0) {
    const value = argv[override + 1];
    if (!value || !isAbsolute(value)) throw new Error('Browser control discovery override must be absolute');
    discoveryPath = value;
  } else {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for browser control discovery');
    discoveryPath = join(env.LOCALAPPDATA, 'WebAgentGateway', 'browser-control-v1.json');
  }
  return { expectedOrigin: origins[0]!, discoveryPath };
}

export async function loadBrowserControlHostDiscovery(path: string): Promise<BrowserControlHostDiscovery> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Browser control host discovery unavailable'); }
  return parseBrowserControlHostDiscovery(value);
}

export function parseBrowserControlHostDiscovery(value: unknown): BrowserControlHostDiscovery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid browser control host discovery');
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(',') !== 'bearerToken,endpoint,protocolVersion'
      || row.protocolVersion !== EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION
      || typeof row.endpoint !== 'string'
      || typeof row.bearerToken !== 'string'
      || Buffer.byteLength(row.bearerToken, 'utf8') < 32) {
    throw new Error('Invalid browser control host discovery');
  }
  let endpoint: URL;
  try { endpoint = new URL(row.endpoint); }
  catch { throw new Error('Invalid browser control host endpoint'); }
  if (endpoint.protocol !== 'tcp:' || endpoint.hostname !== '127.0.0.1'
      || !endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
      || endpoint.username || endpoint.password) {
    throw new Error('Invalid browser control host endpoint');
  }
  return {
    protocolVersion: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
    endpoint: endpoint.toString(),
    bearerToken: row.bearerToken,
  };
}

export async function runNativeBrowserControlHost(options: {
  input: Readable;
  output: Writable;
  expectedOrigin: string;
  discoveryPath: string;
  bearerToken?: string;
}): Promise<NativeBrowserControlHost> {
  if (options.expectedOrigin !== EXTENSION_ORIGIN) {
    throw new Error('Invalid browser control native host caller origin');
  }
  if (!isAbsolute(options.discoveryPath)) throw new Error('Browser control discovery path must be absolute');

  const bearerToken = options.bearerToken ?? randomBytes(32).toString('base64url');
  if (Buffer.byteLength(bearerToken, 'utf8') < 32) throw new Error('Browser control bearer token is too short');

  const pending = new Map<string, Socket>();
  const server = createServer((socket) => {
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let accepted = false;

    socket.on('data', (chunk) => {
      if (accepted) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
      if (buffer.length > EXISTING_BROWSER_CONTROL_MAX_BYTES + 4096) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      accepted = true;
      const line = buffer.subarray(0, newline).toString('utf8');
      void acceptLine(socket, line);
    });
  });

  async function acceptLine(socket: Socket, line: string): Promise<void> {
    let value: unknown;
    try { value = JSON.parse(line); }
    catch { socket.end(JSON.stringify(localError(null, 'MALFORMED_REQUEST', 'Invalid control request')) + '\n'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      socket.end(JSON.stringify(localError(null, 'MALFORMED_REQUEST', 'Invalid control request')) + '\n');
      return;
    }
    const row = value as Record<string, unknown>;
    if (row.bearerToken !== bearerToken) {
      socket.end(JSON.stringify(localError(null, 'UNAUTHORIZED', 'Browser control authentication failed')) + '\n');
      return;
    }
    let request: ExistingBrowserControlRequest;
    try { request = parseExistingBrowserControlRequest(row.request); }
    catch {
      socket.end(JSON.stringify(localError(null, 'MALFORMED_REQUEST', 'Invalid control request')) + '\n');
      return;
    }
    if (pending.size >= MAX_PENDING) {
      socket.end(JSON.stringify(localError(request.requestId, 'HOST_BUSY', 'Browser control host is busy')) + '\n');
      return;
    }
    if (pending.has(request.requestId)) {
      socket.end(JSON.stringify(localError(request.requestId, 'DUPLICATE_REQUEST', 'Duplicate browser control request')) + '\n');
      return;
    }
    pending.set(request.requestId, socket);
    socket.once('close', () => {
      if (pending.get(request.requestId) === socket) pending.delete(request.requestId);
    });
    try {
      options.output.write(encodeNativeMessage(request));
    } catch {
      pending.delete(request.requestId);
      socket.end(JSON.stringify(localError(request.requestId, 'NATIVE_WRITE_FAILED', 'Browser extension bridge failed')) + '\n');
    }
  }

  const decoder = new NativeMessageDecoder();
  const nativePump = (async () => {
    for await (const raw of options.input) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      for (const value of decoder.push(chunk)) {
        let response;
        try { response = parseExistingBrowserControlResponse(value); }
        catch { continue; }
        const socket = pending.get(response.requestId);
        if (!socket) continue;
        pending.delete(response.requestId);
        socket.end(JSON.stringify(response) + '\n');
      }
    }
  })();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Browser control host did not bind TCP');
  }
  const endpoint = `tcp://127.0.0.1:${address.port}/`;
  await mkdir(dirname(options.discoveryPath), { recursive: true });
  await writeFile(options.discoveryPath, JSON.stringify({
    protocolVersion: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
    endpoint,
    bearerToken,
  }), { encoding: 'utf8', mode: 0o600 });

  let closed = false;
  return {
    endpoint,
    discoveryPath: options.discoveryPath,
    async close() {
      if (closed) return;
      closed = true;
      for (const [requestId, socket] of pending) {
        pending.delete(requestId);
        socket.end(JSON.stringify(localError(requestId, 'HOST_CLOSED', 'Browser control host closed')) + '\n');
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(options.discoveryPath, { force: true }).catch(() => undefined);
      options.input.destroy();
      await nativePump.catch(() => undefined);
    },
  };
}

function localError(requestId: string | null, code: string, message: string) {
  return {
    version: EXISTING_BROWSER_CONTROL_PROTOCOL_VERSION,
    type: 'control.error',
    requestId,
    error: { code, message },
  };
}
