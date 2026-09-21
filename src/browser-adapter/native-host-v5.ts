/**
 * The delegated-dispatch native host (ADR-0029).
 *
 * A parallel file to `native-host-v4.ts`, because v4 is frozen and because this host admits into a
 * different identity. The framing, the origin pin, the replay guard and the two-kinds-of-failure
 * rule are the accepted ones, copied deliberately rather than shared: a change made for v5's
 * benefit must not silently alter how the operator adapter behaves.
 *
 * ## What is different, and it is only this
 *
 * The v4 host interprets the protocol. It answers `hello`, `tools.list` and `ping` itself, tracks
 * the bound session, and turns `tool.call` into a link call. This host interprets **almost
 * nothing**: it validates the frame is a v5 request, then forwards the whole envelope to WAG and
 * writes back whatever WAG answered.
 *
 * That is the point. Every v5 decision — is this session bound, does the envelope's session match
 * the admitted one, is this delegation configured, is the budget spent — belongs to the router and
 * the plane inside the gateway, over durable rows. A host that answered any of them would be a
 * second authority, in a process the extension can restart at will, holding state the store does
 * not. So the host owns exactly two things a relay must own: the framing, and which extension is
 * allowed to speak to it.
 *
 * `session.bind` is the one verb it must partly understand, because binding is what causes the
 * *admission*, and admission is what mints the identity the gateway will compare everything else
 * against. Even there the host does not decide anything: it opens a link and lets the gateway's
 * own `session.bind` answer.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { NativeMessageDecoder, encodeNativeMessage } from './native-framing.js';
import {
  DELEGATED_DISPATCH_PROTOCOL_VERSION,
  REQUEST_ID_PATTERN,
  parseDelegatedDispatchRequest,
  parseDelegatedDispatchResponse,
  type DelegatedDispatchRequestEnvelope,
  type DelegatedDispatchResponseEnvelope,
} from './protocol-v5.js';
import {
  parseDelegationAdapterDiscovery,
  type DelegationAdapterDiscovery,
  type LocalDelegationAdapterLink,
} from './local-link-v5.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from './native-host-distribution.js';

/** Exactly one origin, not the shape of one — the same pin the v4 host applies. */
const EXTENSION_ORIGIN = `chrome-extension://${BROWSER_ADAPTER_EXTENSION_ID}/`;

function isAcceptedOrigin(value: string): boolean {
  return value === EXTENSION_ORIGIN;
}

const MAX_TRACKED_REQUEST_IDS = 4096;
const MAX_UNANSWERABLE_FRAMES = 64;

function salvageRequestId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' && candidate.length >= 8 && candidate.length <= 128
    && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : undefined;
}

export interface NativeDelegationHostInvocation {
  expectedOrigin: string;
  discoveryPath: string;
}

export function parseNativeDelegationHostInvocation(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): NativeDelegationHostInvocation {
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
    // Its own file. All four host generations would otherwise share one path, and a v5 runtime
    // would overwrite — and on close delete — a v4 runtime's discovery.
    discoveryPath = join(env.LOCALAPPDATA, 'WebAgentGateway', 'browser-adapter-v5.json');
  }
  return { expectedOrigin: origins[0]!, discoveryPath };
}

export async function loadDelegationAdapterDiscovery(path: string): Promise<DelegationAdapterDiscovery> {
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error('Delegated dispatch adapter discovery unavailable'); }
  return parseDelegationAdapterDiscovery(value);
}

export async function runNativeDelegationHost(options: {
  input: Readable;
  output: Writable;
  linkFactory(correlationId: string): Promise<LocalDelegationAdapterLink>;
  expectedOrigin: string;
}): Promise<void> {
  const { input, output, linkFactory, expectedOrigin } = options;
  const decoder = new NativeMessageDecoder();
  const seen = new Set<string>();
  let boundSession: string | undefined;
  let link: LocalDelegationAdapterLink | undefined;
  let unanswerable = 0;

  try {
    if (!isAcceptedOrigin(expectedOrigin)) throw new Error('Invalid native host caller origin');
    for await (const rawChunk of input) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      for (const value of decoder.push(chunk)) {
        // A frame the *decoder* rejects is connection-fatal (the stream position is unknown); a
        // frame that decoded and only failed the *schema* is answered and the session continues.
        // Killing an admitted session over one bad page-derived frame loses the live workspace for
        // no security gain — a lesson the v4 host learned the hard way.
        let request: DelegatedDispatchRequestEnvelope;
        try {
          request = parseDelegatedDispatchRequest(value);
        } catch {
          const salvaged = salvageRequestId(value);
          if (salvaged === undefined) {
            unanswerable += 1;
            if (unanswerable > MAX_UNANSWERABLE_FRAMES) throw new Error('Too many malformed native frames');
            continue;
          }
          output.write(encodeNativeMessage(
            hostError(salvaged, 'MALFORMED_REQUEST', 'Request rejected by the protocol schema'),
          ));
          continue;
        }
        const response = await handleRequest(request);
        output.write(encodeNativeMessage(parseDelegatedDispatchResponse(response)));
      }
    }
  } finally {
    await link?.close().catch(() => undefined);
  }

  async function handleRequest(
    request: DelegatedDispatchRequestEnvelope,
  ): Promise<DelegatedDispatchResponseEnvelope> {
    if (seen.has(request.requestId)) {
      return hostError(request.requestId, 'DUPLICATE_REQUEST', 'Duplicate request id');
    }
    if (seen.size >= MAX_TRACKED_REQUEST_IDS) {
      return hostError(request.requestId, 'TOO_MANY_REQUESTS', 'Request id budget exhausted for this session');
    }
    seen.add(request.requestId);

    // `hello` is answered locally and deliberately says nothing about authority: the host has none
    // to report. It names the protocol it speaks, which is what a handshake is for.
    if (request.type === 'hello') {
      return hostResult(request.requestId, { version: DELEGATED_DISPATCH_PROTOCOL_VERSION });
    }

    if (request.type === 'session.bind') {
      if (boundSession !== undefined) {
        return hostError(request.requestId, 'SESSION_ALREADY_BOUND', 'A session is already bound');
      }
      // The value the extension sends is a **correlation**, not a session id. WAG hashes it and
      // resolves a durable session whose id is a different string — so the host cannot know the
      // authoritative id until WAG answers, and must not assume the correlation is it.
      let admitted: LocalDelegationAdapterLink;
      try { admitted = await linkFactory(request.sessionId); }
      catch { return hostError(request.requestId, 'SESSION_ADMISSION_FAILED', 'Local WAG admission failed'); }
      link = admitted;

      // Forwarded, not answered. The gateway decides what `bound` means.
      const response = await forward(request);
      const bound = response.type === 'result'
        ? (response.result as { sessionId?: unknown }).sessionId
        : undefined;
      if (typeof bound !== 'string' || bound.length === 0) {
        // Fail closed. A bind whose answer carries no authoritative id leaves the host with nothing
        // to compare later frames against, and guessing would mean inventing an identity.
        await admitted.close().catch(() => undefined);
        link = undefined;
        return response.type === 'error'
          ? response
          : hostError(request.requestId, 'SESSION_ADMISSION_FAILED', 'bind returned no session id');
      }
      boundSession = bound;
      return response;
    }

    if (boundSession !== request.sessionId || link === undefined) {
      return hostError(request.requestId, 'SESSION_NOT_BOUND', 'Request session is not bound');
    }

    if (request.type === 'session.unbind') {
      const response = await forward(request);
      const current = link;
      link = undefined;
      boundSession = undefined;
      // The budget belongs to the session, not to the process.
      seen.clear();
      await current.close().catch(() => undefined);
      return response;
    }

    return forward(request);
  }

  async function forward(
    request: DelegatedDispatchRequestEnvelope,
  ): Promise<DelegatedDispatchResponseEnvelope> {
    if (link === undefined) {
      return hostError(request.requestId, 'SESSION_NOT_BOUND', 'Request session is not bound');
    }
    try {
      return await link.send(request);
    } catch {
      // The host never invents a decision. A transport failure is a transport failure, and it is
      // not reported as a refusal — an extension that saw "REFUSED" here would be told WAG decided
      // something when WAG was never reached.
      return hostError(request.requestId, 'LOCAL_WAG_UNREACHABLE', 'Local WAG delegated dispatch failed');
    }
  }
}

function hostResult(requestId: string, result: unknown): DelegatedDispatchResponseEnvelope {
  return parseDelegatedDispatchResponse({
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'result',
    requestId,
    result,
  });
}

function hostError(requestId: string, code: string, message: string): DelegatedDispatchResponseEnvelope {
  return parseDelegatedDispatchResponse({
    version: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    type: 'error',
    requestId,
    error: { code, message },
  });
}
