/**
 * The delegated-dispatch link (ADR-0029): native host on one side, WAG's v5 route on the other.
 *
 * A parallel file to `local-link-v4.ts`, per the convention that successors do not edit a frozen
 * predecessor — but the shape differs in one way worth naming. The v4 link speaks MCP: it admits,
 * connects a client, and turns each `tool.call` into `client.callTool`. This one speaks **the
 * protocol itself**. It admits, then posts whole v5 envelopes to `/adapter/dispatch` and returns
 * whatever comes back.
 *
 * That is deliberate, and it is the narrower of the two. An MCP client can call any tool the server
 * exposes; this link can send exactly one kind of message to exactly one route. There is no
 * `callTool` here to reach for, so a bug in the host cannot turn into a tool call that no delegation
 * admitted — the host has no verb for it and the route has no handler for it.
 *
 * The link decides nothing. It does not read the envelope it forwards, and it does not interpret the
 * answer: a refusal is passed back verbatim, because the extension needs the reason code and this
 * file is not the place that could improve on it.
 */
import { BROWSER_DELEGATION_ADAPTER_ID } from '../adapter-admission.js';
import {
  DELEGATED_DISPATCH_PROTOCOL_VERSION,
  parseDelegatedDispatchResponse,
  type DelegatedDispatchResponseEnvelope,
} from './protocol-v5.js';

export interface DelegationAdapterDiscovery {
  admissionUrl: string;
  bootstrapToken: string;
  protocolVersion: typeof DELEGATED_DISPATCH_PROTOCOL_VERSION;
  adapterId: typeof BROWSER_DELEGATION_ADAPTER_ID;
}

interface AdmissionResponse {
  dispatchUrl: string;
  bearerToken: string;
}

export interface LocalDelegationAdapterLink {
  /** One envelope in, one envelope out. The only thing this link can do. */
  send(envelope: unknown): Promise<DelegatedDispatchResponseEnvelope>;
  close(): Promise<void>;
}

export class HttpLocalDelegationAdapterLink implements LocalDelegationAdapterLink {
  #closed = false;
  private constructor(
    private readonly dispatchUrl: string,
    private admittedBearer: string | undefined,
  ) {}

  static async admit(discoveryValue: unknown, correlationId: string): Promise<HttpLocalDelegationAdapterLink> {
    const discovery = parseDelegationAdapterDiscovery(discoveryValue);
    let admitted: AdmissionResponse;
    try {
      const response = await fetch(discovery.admissionUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${discovery.bootstrapToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ correlation_id: correlationId }),
      });
      if (!response.ok) throw new Error('admission rejected');
      admitted = parseAdmissionResponse(await response.json(), discovery.admissionUrl);
    } catch {
      throw new Error('Local WAG delegated admission failed');
    }
    return new HttpLocalDelegationAdapterLink(admitted.dispatchUrl, admitted.bearerToken);
  }

  async send(envelope: unknown): Promise<DelegatedDispatchResponseEnvelope> {
    if (this.#closed) throw new Error('LocalDelegationAdapterLink is closed');
    const bearer = this.admittedBearer;
    if (bearer === undefined) throw new Error('LocalDelegationAdapterLink is not admitted');
    const response = await fetch(this.dispatchUrl, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    if (!response.ok) throw new Error('Local WAG delegated dispatch failed');
    // Parsed rather than trusted, even though it came from WAG: the host will write this onto a
    // native port, and a frame that does not satisfy the schema must not leave this process.
    return parseDelegatedDispatchResponse(await response.json());
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const bearer = this.admittedBearer;
    this.admittedBearer = undefined;
    if (bearer === undefined) return;
    try {
      await fetch(new URL('/adapter/release', this.dispatchUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
      });
    } catch {
      // Best effort. A WAG restart invalidates every admitted bearer anyway.
    }
  }
}

export function parseDelegationAdapterDiscovery(value: unknown): DelegationAdapterDiscovery {
  if (!value || typeof value !== 'object') throw new Error('Invalid delegation adapter discovery');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'adapterId,admissionUrl,bootstrapToken,protocolVersion') {
    throw new Error('Invalid delegation adapter discovery');
  }
  if (typeof record.admissionUrl !== 'string' || typeof record.bootstrapToken !== 'string') {
    throw new Error('Invalid delegation adapter discovery');
  }
  // The version and identity are pinned, so a v4 discovery file cannot admit a v5 host and the
  // reverse cannot happen either. They live in different files for the same reason.
  if (record.protocolVersion !== DELEGATED_DISPATCH_PROTOCOL_VERSION
    || record.adapterId !== BROWSER_DELEGATION_ADAPTER_ID) {
    throw new Error('Invalid delegation adapter discovery');
  }
  if (Buffer.byteLength(record.bootstrapToken, 'utf8') < 32) {
    throw new Error('Invalid delegation adapter discovery');
  }
  let url: URL;
  try { url = parseLoopbackUrl(record.admissionUrl, '/adapter/admit'); }
  catch { throw new Error('Invalid delegation adapter discovery'); }
  return {
    admissionUrl: url.toString(),
    bootstrapToken: record.bootstrapToken,
    protocolVersion: DELEGATED_DISPATCH_PROTOCOL_VERSION,
    adapterId: BROWSER_DELEGATION_ADAPTER_ID,
  };
}

function parseAdmissionResponse(value: unknown, admissionUrl: string): AdmissionResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid admission response');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'bearer_token,dispatch_url') {
    throw new Error('Invalid admission response');
  }
  if (typeof record.dispatch_url !== 'string' || typeof record.bearer_token !== 'string') {
    throw new Error('Invalid admission response');
  }
  if (Buffer.byteLength(record.bearer_token, 'utf8') < 32) throw new Error('Invalid admission response');
  const dispatchUrl = parseLoopbackUrl(record.dispatch_url, '/adapter/dispatch');
  // The route WAG names must be on the origin we already admitted against, so a redirected or
  // substituted discovery cannot point the host's traffic somewhere else.
  if (dispatchUrl.origin !== new URL(admissionUrl).origin) throw new Error('Invalid admission response');
  return { dispatchUrl: dispatchUrl.toString(), bearerToken: record.bearer_token };
}

function parseLoopbackUrl(value: string, pathname: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid delegation adapter URL'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'http:' || !loopback || url.pathname !== pathname
    || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid delegation adapter URL');
  }
  return url;
}
