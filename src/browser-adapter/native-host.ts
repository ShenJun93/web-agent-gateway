import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import {
  parseBrowserAdapterRequest,
  parseBrowserAdapterResponse,
  type BrowserAdapterRequest,
  type BrowserAdapterResponse,
} from './protocol.js';
import { McpLocalAdapterLink, type AdapterDiscovery, type LocalAdapterLink } from './local-link.js';

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;

export interface NativeHostInvocation {
  expectedOrigin: string;
  discoveryPath: string;
}

export function parseNativeHostInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): NativeHostInvocation {
  const origins = argv.filter((arg) => EXTENSION_ORIGIN.test(arg));
  if (origins.length !== 1) throw new Error('Native host requires exactly one extension origin');

  const overrideIndex = argv.indexOf('--discovery');
  let discoveryPath: string;
  if (overrideIndex >= 0) {
    const value = argv[overrideIndex + 1];
    if (!value || !isAbsolute(value)) throw new Error('Discovery override must be absolute');
    discoveryPath = value;
  } else {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for native host discovery');
    discoveryPath = join(env.LOCALAPPDATA, 'WebAgentGateway', 'browser-adapter.json');
  }
  return { expectedOrigin: origins[0]!, discoveryPath };
}
export async function loadAdapterDiscovery(path: string): Promise<AdapterDiscovery> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('Browser adapter discovery unavailable');
  }
  if (!value || typeof value !== 'object') throw new Error('Browser adapter discovery unavailable');
  const record = value as Record<string, unknown>;
  if (typeof record.mcpUrl !== 'string' || typeof record.bearerToken !== 'string') {
    throw new Error('Browser adapter discovery unavailable');
  }
  return { mcpUrl: record.mcpUrl, bearerToken: record.bearerToken };
}

export async function connectNativeHostLink(discoveryPath: string): Promise<LocalAdapterLink> {
  return McpLocalAdapterLink.connect(await loadAdapterDiscovery(discoveryPath));
}

export async function runNativeHost(options: {
  input: Readable;
  output: Writable;
  link: LocalAdapterLink;
  expectedOrigin: string;
}): Promise<void> {
  const { input, output, link, expectedOrigin } = options;
  const decoder = new NativeMessageDecoder();
  const seen = new Set<string>();
  let boundSession: string | undefined;

  try {
    if (!EXTENSION_ORIGIN.test(expectedOrigin)) throw new Error('Invalid native host caller origin');
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const messages = decoder.push(chunk);
      for (const value of messages) {
        const request = parseBrowserAdapterRequest(value);
        const response = await handleRequest(request);
        output.write(encodeNativeMessage(parseBrowserAdapterResponse(response)));
      }
    }
  } finally {
    await link.close().catch(() => undefined);
  }
  async function handleRequest(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse> {
    if (seen.has(request.requestId)) return hostError(request.requestId, 'DUPLICATE_REQUEST', 'Duplicate request id');
    seen.add(request.requestId);

    if (request.type === 'hello') {
      return hostResult(request.requestId, { protocolVersion: 1 });
    }
    if (request.type === 'session.bind') {
      if (boundSession !== undefined) return hostError(request.requestId, 'SESSION_ALREADY_BOUND', 'A session is already bound');
      boundSession = request.sessionId;
      return hostResult(request.requestId, { sessionId: request.sessionId, provider: request.provider });
    }
    if (boundSession !== request.sessionId) {
      return hostError(request.requestId, 'SESSION_NOT_BOUND', 'Request session is not bound');
    }
    if (request.type === 'session.unbind') {
      boundSession = undefined;
      return hostResult(request.requestId, { unbound: true });
    }
    if (request.type === 'tools.list') {
      return hostResult(request.requestId, { tools: await link.listTools() });
    }
    if (request.type === 'ping') {
      return hostResult(request.requestId, { alive: true });
    }
    return link.call(request);
  }
}

function hostResult(requestId: string, result: unknown): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({ version: 1, type: 'result', requestId, result });
}

function hostError(requestId: string, code: string, message: string): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({
    version: 1,
    type: 'error',
    requestId,
    error: { code, message },
  });
}
