import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import {
  parseBrowserAdapterRequest,
  parseBrowserAdapterResponse,
  BROWSER_ADAPTER_PROTOCOL_VERSION,
  type BrowserAdapterRequest,
  type BrowserAdapterResponse,
} from './protocol.js';
import { parseAdapterDiscovery, type AdapterDiscovery, type LocalAdapterLink } from './local-link.js';
import { BROWSER_INSPECT_ADAPTER_ID } from '../adapter-admission.js';

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
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Browser adapter discovery unavailable'); }
  return parseAdapterDiscovery(value);
}

export async function runNativeHost(options: {
  input: Readable;
  output: Writable;
  linkFactory(correlationId: string): Promise<LocalAdapterLink>;
  expectedOrigin: string;
}): Promise<void> {
  const { input, output, linkFactory, expectedOrigin } = options;
  const decoder = new NativeMessageDecoder();
  const seen = new Set<string>();
  let boundSession: string | undefined;
  let link: LocalAdapterLink | undefined;

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
    await link?.close().catch(() => undefined);
  }

  async function handleRequest(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse> {
    if (seen.has(request.requestId)) return hostError(request.requestId, 'DUPLICATE_REQUEST', 'Duplicate request id');
    seen.add(request.requestId);

    if (request.type === 'hello') return hostResult(request.requestId, { protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID });
    if (request.type === 'session.bind') {
      if (boundSession !== undefined) return hostError(request.requestId, 'SESSION_ALREADY_BOUND', 'A session is already bound');
      let admitted: LocalAdapterLink;
      try { admitted = await linkFactory(request.sessionId); }
      catch { return hostError(request.requestId, 'SESSION_ADMISSION_FAILED', 'Local WAG admission failed'); }
      link = admitted;
      boundSession = request.sessionId;
      return hostResult(request.requestId, { sessionId: request.sessionId, provider: request.provider });
    }
    if (boundSession !== request.sessionId || link === undefined) {
      return hostError(request.requestId, 'SESSION_NOT_BOUND', 'Request session is not bound');
    }
    if (request.type === 'session.unbind') {
      const current = link;
      link = undefined;
      boundSession = undefined;
      await current.close().catch(() => undefined);
      return hostResult(request.requestId, { unbound: true });
    }
    if (request.type === 'tools.list') return hostResult(request.requestId, { tools: await link.listTools() });
    if (request.type === 'ping') return hostResult(request.requestId, { alive: true });
    return link.call(request);
  }
}

function hostResult(requestId: string, result: unknown): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({ version: BROWSER_ADAPTER_PROTOCOL_VERSION, type: 'result', requestId, result });
}

function hostError(requestId: string, code: string, message: string): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({
    version: BROWSER_ADAPTER_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    error: { code, message },
  });
}
