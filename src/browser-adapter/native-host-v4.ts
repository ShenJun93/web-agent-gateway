/**
 * The browser operator native host (ADR-0026).
 *
 * A parallel file rather than an edit to the v3 host, because v3 is frozen. The message loop,
 * framing and session rules are the accepted ones; what differs is the identity it announces,
 * the exact extension origin it accepts, and a bounded replay guard.
 *
 * A malformed or oversized frame is still connection-fatal by design: the decoder cannot be
 * assumed to be in a known position afterwards, so the host closes rather than guessing.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import {
  parseBrowserOperatorRequest,
  parseBrowserOperatorResponse,
  BROWSER_OPERATOR_PROTOCOL_VERSION,
  type BrowserOperatorAdapterRequest,
  type BrowserOperatorAdapterResponse,
} from './protocol-v4.js';
import {
  parseOperatorAdapterDiscovery,
  type OperatorAdapterDiscovery,
  type LocalOperatorAdapterLink,
} from './local-link-v4.js';
import { BROWSER_OPERATOR_ADAPTER_ID } from '../adapter-admission.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from './native-host-distribution.js';

/**
 * Exactly one origin, not the shape of one.
 *
 * The v3 host accepted any `chrome-extension://[a-p]{32}/`, and relied on Chrome enforcing
 * the real identity through the native-host manifest. That is true and it is also the only
 * check on the binary itself, so the successor pins the accepted id here as well.
 */
const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;

function isAcceptedOrigin(value: string): boolean {
  return value === EXTENSION_ORIGIN;
}

/** One session cannot replay ids forever; the guard is bounded rather than unbounded. */
const MAX_TRACKED_REQUEST_IDS = 4096;

export interface NativeOperatorHostInvocation {
  expectedOrigin: string;
  discoveryPath: string;
}

export function parseNativeOperatorHostInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): NativeOperatorHostInvocation {
  const origins = argv.filter((arg) => isAcceptedOrigin(arg));
  if (origins.length !== 1) throw new Error('Native host requires exactly one extension origin');

  const overrideIndex = argv.indexOf('--discovery');
  let discoveryPath: string;
  if (overrideIndex >= 0) {
    const value = argv[overrideIndex + 1];
    if (!value || !isAbsolute(value)) throw new Error('Discovery override must be absolute');
    discoveryPath = value;
  } else {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required for native host discovery');
    // Versioned: all three host generations otherwise share one path, and a v4 runtime would
    // overwrite — and on close delete — a v3 runtime's discovery file.
    discoveryPath = join(env.LOCALAPPDATA, 'WebAgentGateway', 'browser-adapter-v4.json');
  }
  return { expectedOrigin: origins[0]!, discoveryPath };
}

export async function loadOperatorAdapterDiscovery(path: string): Promise<OperatorAdapterDiscovery> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Browser operator adapter discovery unavailable'); }
  return parseOperatorAdapterDiscovery(value);
}

export async function runNativeOperatorHost(options: {
  input: Readable;
  output: Writable;
  linkFactory(correlationId: string): Promise<LocalOperatorAdapterLink>;
  expectedOrigin: string;
}): Promise<void> {
  const { input, output, linkFactory, expectedOrigin } = options;
  const decoder = new NativeMessageDecoder();
  const seen = new Set<string>();
  let boundSession: string | undefined;
  let link: LocalOperatorAdapterLink | undefined;

  try {
    if (!isAcceptedOrigin(expectedOrigin)) throw new Error('Invalid native host caller origin');
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      const messages = decoder.push(chunk);
      for (const value of messages) {
        const request = parseBrowserOperatorRequest(value);
        const response = await handleRequest(request);
        output.write(encodeNativeMessage(parseBrowserOperatorResponse(response)));
      }
    }
  } finally {
    await link?.close().catch(() => undefined);
  }

  async function handleRequest(request: BrowserOperatorAdapterRequest): Promise<BrowserOperatorAdapterResponse> {
    if (seen.has(request.requestId)) return hostError(request.requestId, 'DUPLICATE_REQUEST', 'Duplicate request id');
    if (seen.size >= MAX_TRACKED_REQUEST_IDS) {
      return hostError(request.requestId, 'TOO_MANY_REQUESTS', 'Request id budget exhausted for this session');
    }
    seen.add(request.requestId);

    if (request.type === 'hello') {
      return hostResult(request.requestId, {
        protocolVersion: BROWSER_OPERATOR_PROTOCOL_VERSION,
        adapterId: BROWSER_OPERATOR_ADAPTER_ID,
      });
    }
    if (request.type === 'session.bind') {
      if (boundSession !== undefined) return hostError(request.requestId, 'SESSION_ALREADY_BOUND', 'A session is already bound');
      let admitted: LocalOperatorAdapterLink;
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
      // The budget belongs to the session, not to the process.
      seen.clear();
      await current.close().catch(() => undefined);
      return hostResult(request.requestId, { unbound: true });
    }
    if (request.type === 'tools.list') return hostResult(request.requestId, { tools: await link.listTools() });
    if (request.type === 'ping') return hostResult(request.requestId, { alive: true });
    return link.call(request);
  }
}

function hostResult(requestId: string, result: unknown): BrowserOperatorAdapterResponse {
  return parseBrowserOperatorResponse({
    version: BROWSER_OPERATOR_PROTOCOL_VERSION,
    type: 'result',
    requestId,
    result,
  });
}

function hostError(requestId: string, code: string, message: string): BrowserOperatorAdapterResponse {
  return parseBrowserOperatorResponse({
    version: BROWSER_OPERATOR_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    error: { code, message },
  });
}
