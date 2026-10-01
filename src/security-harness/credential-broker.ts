import type { GatewayAuthority } from '../caller-context.js';

export type CredentialHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface CredentialBinding {
  readonly credentialId: string;
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods: readonly CredentialHttpMethod[];
  readonly allowedPathPrefixes?: readonly string[];
  readonly injectHeader: string;
  readonly injectPrefix?: string;
  readonly exposedResponseHeaders?: readonly string[];
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

export interface CredentialDescriptor {
  readonly credentialId: string;
  readonly available: boolean;
  readonly allowedOrigins: readonly string[];
  readonly allowedMethods: readonly CredentialHttpMethod[];
  readonly allowedPathPrefixes: readonly string[];
}

export interface CredentialRequest {
  readonly credentialId: string;
  readonly method: CredentialHttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface CredentialResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface CredentialSecretLease {
  readonly value: string;
  release(): void;
}

export interface CredentialSecretSource {
  available(credentialId: string): Promise<boolean>;
  acquire(credentialId: string): Promise<CredentialSecretLease>;
}

export interface CredentialTransportRequest {
  readonly method: CredentialHttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
  readonly redirect: 'manual';
  readonly maxResponseBytes: number;
}

export interface CredentialTransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface CredentialTransport {
  send(request: CredentialTransportRequest): Promise<CredentialTransportResponse>;
}

export interface CredentialBroker {
  describe(owner: GatewayAuthority): Promise<readonly CredentialDescriptor[]>;
  request(owner: GatewayAuthority, request: CredentialRequest): Promise<CredentialResponse>;
}

interface NormalizedBinding {
  readonly credentialId: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly allowedOriginList: readonly string[];
  readonly allowedMethods: ReadonlySet<CredentialHttpMethod>;
  readonly allowedMethodList: readonly CredentialHttpMethod[];
  readonly allowedPathPrefixes: readonly string[];
  readonly injectHeader: string;
  readonly injectPrefix: string;
  readonly exposedResponseHeaders: ReadonlySet<string>;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
}

const CREDENTIAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_HEADERS = 64;
const MAX_HEADER_VALUE_BYTES = 16 * 1024;
const FORBIDDEN_CALLER_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);
const DEFAULT_EXPOSED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'etag',
  'last-modified',
  'retry-after',
] as const;

function normalizeOrigin(input: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:') throw new Error('Credential origin must use HTTPS');
  if (url.username || url.password) throw new Error('Credential origin must not contain userinfo');
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Credential allowed origin must not contain path, query, or fragment');
  }
  return url.origin;
}

function normalizePathPrefixes(input: readonly string[] | undefined): readonly string[] {
  const prefixes = input ?? ['/'];
  if (prefixes.length < 1 || prefixes.length > 64) {
    throw new Error('Credential path prefix set is invalid');
  }
  const output = new Set<string>();
  for (const prefix of prefixes) {
    if (typeof prefix !== 'string'
        || !prefix.startsWith('/')
        || prefix.includes('\0')
        || prefix.includes('?')
        || prefix.includes('#')
        || Buffer.byteLength(prefix, 'utf8') > 2048) {
      throw new Error('Credential path prefix is invalid');
    }
    output.add(prefix);
  }
  return Object.freeze([...output].sort());
}

function byteLimit(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 0 || result > MAX_LIMIT_BYTES) {
    throw new Error(`Credential ${label} byte limit is invalid`);
  }
  return result;
}

function normalizeBinding(binding: CredentialBinding): NormalizedBinding {
  if (!CREDENTIAL_ID.test(binding.credentialId)) {
    throw new Error('Credential id is invalid');
  }
  if (!Array.isArray(binding.allowedOrigins)
      || binding.allowedOrigins.length < 1
      || binding.allowedOrigins.length > 64) {
    throw new Error('Credential origin set is invalid');
  }
  const origins = new Set(binding.allowedOrigins.map(normalizeOrigin));
  if (!Array.isArray(binding.allowedMethods)
      || binding.allowedMethods.length < 1
      || binding.allowedMethods.length > 5) {
    throw new Error('Credential method set is invalid');
  }
  const methods = new Set<CredentialHttpMethod>();
  for (const method of binding.allowedMethods) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      throw new Error('Credential HTTP method is invalid');
    }
    methods.add(method);
  }
  if (!HEADER_NAME.test(binding.injectHeader)) {
    throw new Error('Credential injection header is invalid');
  }
  const injectHeader = binding.injectHeader.toLowerCase();
  if (['host', 'content-length', 'connection', 'transfer-encoding'].includes(injectHeader)) {
    throw new Error('Credential injection header is unsafe');
  }
  const injectPrefix = binding.injectPrefix ?? '';
  if (injectPrefix.includes('\0') || /[\r\n]/.test(injectPrefix)
      || Buffer.byteLength(injectPrefix, 'utf8') > 1024) {
    throw new Error('Credential injection prefix is invalid');
  }

  const exposed = new Set<string>();
  for (const name of binding.exposedResponseHeaders ?? DEFAULT_EXPOSED_RESPONSE_HEADERS) {
    if (!HEADER_NAME.test(name)) throw new Error('Credential exposed response header is invalid');
    const normalized = name.toLowerCase();
    if (normalized === 'set-cookie'
        || normalized === 'authorization'
        || normalized === 'proxy-authorization') {
      throw new Error('Credential exposed response header is sensitive');
    }
    exposed.add(normalized);
  }

  return Object.freeze({
    credentialId: binding.credentialId,
    allowedOrigins: origins,
    allowedOriginList: Object.freeze([...origins].sort()),
    allowedMethods: methods,
    allowedMethodList: Object.freeze([...methods].sort()),
    allowedPathPrefixes: normalizePathPrefixes(binding.allowedPathPrefixes),
    injectHeader,
    injectPrefix,
    exposedResponseHeaders: exposed,
    maxRequestBytes: byteLimit(binding.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 'request'),
    maxResponseBytes: byteLimit(binding.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'response'),
  });
}

function validateUrl(binding: NormalizedBinding, input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Credential request URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('Credential request requires HTTPS');
  if (url.username || url.password) throw new Error('Credential request URL userinfo is denied');
  if (!binding.allowedOrigins.has(url.origin)) {
    throw new Error('Credential request origin is denied');
  }
  const pathAllowed = binding.allowedPathPrefixes.some((prefix) =>
    prefix === '/'
      || url.pathname === prefix
      || (prefix.endsWith('/') ? url.pathname.startsWith(prefix) : url.pathname.startsWith(`${prefix}/`)));
  if (!pathAllowed) {
    throw new Error('Credential request path is denied');
  }
  return url;
}

function normalizeCallerHeaders(
  binding: NormalizedBinding,
  input: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const output: Record<string, string> = {};
  const entries = Object.entries(input ?? {});
  if (entries.length > MAX_HEADERS) throw new Error('Credential request has too many headers');

  for (const [rawName, rawValue] of entries) {
    if (!HEADER_NAME.test(rawName)) throw new Error('Credential request header name is invalid');
    if (typeof rawValue !== 'string'
        || rawValue.includes('\0')
        || /[\r\n]/.test(rawValue)
        || Buffer.byteLength(rawValue, 'utf8') > MAX_HEADER_VALUE_BYTES) {
      throw new Error('Credential request header value is invalid');
    }
    const name = rawName.toLowerCase();
    if (FORBIDDEN_CALLER_HEADERS.has(name) || name === binding.injectHeader) {
      throw new Error('Credential request header is broker-owned');
    }
    if (Object.hasOwn(output, name)) throw new Error('Credential request header is duplicated');
    output[name] = rawValue;
  }
  return output;
}

function validateSecret(value: string): void {
  if (typeof value !== 'string'
      || value.length < 1
      || value.includes('\0')
      || /[\r\n]/.test(value)
      || Buffer.byteLength(value, 'utf8') > 64 * 1024) {
    throw new Error('Credential source returned invalid secret material');
  }
}

function containsSecret(value: Uint8Array, secret: string): boolean {
  const needle = Buffer.from(secret, 'utf8');
  if (needle.length === 0 || value.byteLength < needle.length) return false;
  return Buffer.from(value).includes(needle);
}

function safeResponseHeaders(
  binding: NormalizedBinding,
  headers: Readonly<Record<string, string>>,
  secret: string,
): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (!HEADER_NAME.test(rawName) || typeof rawValue !== 'string') continue;
    const name = rawName.toLowerCase();
    if (!binding.exposedResponseHeaders.has(name)) continue;
    if (rawValue.includes(secret)) {
      throw new Error('Credential broker blocked secret reflection');
    }
    output[name] = rawValue;
  }
  return Object.freeze(output);
}

export function createCredentialBroker(options: {
  bindings: readonly CredentialBinding[];
  source: CredentialSecretSource;
  transport: CredentialTransport;
  credentialAllowed(owner: GatewayAuthority, credentialId: string): boolean;
}): CredentialBroker {
  const bindings = new Map<string, NormalizedBinding>();
  if (!Array.isArray(options.bindings) || options.bindings.length < 1) {
    throw new Error('Credential broker requires at least one binding');
  }
  for (const raw of options.bindings) {
    const binding = normalizeBinding(raw);
    if (bindings.has(binding.credentialId)) {
      throw new Error('Credential broker has duplicate credential id');
    }
    bindings.set(binding.credentialId, binding);
  }

  return {
    async describe(owner) {
      const output: CredentialDescriptor[] = [];
      for (const binding of bindings.values()) {
        if (!options.credentialAllowed(owner, binding.credentialId)) continue;
        let available = false;
        try {
          available = await options.source.available(binding.credentialId);
        } catch {
          available = false;
        }
        output.push(Object.freeze({
          credentialId: binding.credentialId,
          available,
          allowedOrigins: binding.allowedOriginList,
          allowedMethods: binding.allowedMethodList,
          allowedPathPrefixes: binding.allowedPathPrefixes,
        }));
      }
      return Object.freeze(output);
    },

    async request(owner, request) {
      if (!CREDENTIAL_ID.test(request.credentialId)) {
        throw new Error('Credential id is invalid');
      }
      const binding = bindings.get(request.credentialId);
      if (!binding || !options.credentialAllowed(owner, request.credentialId)) {
        throw new Error('Credential is not available to caller');
      }
      if (!binding.allowedMethods.has(request.method)) {
        throw new Error('Credential request method is denied');
      }
      const url = validateUrl(binding, request.url);
      const headers = normalizeCallerHeaders(binding, request.headers);
      const body = request.body;
      if (body !== undefined && !(body instanceof Uint8Array)) {
        throw new Error('Credential request body is invalid');
      }
      if (body !== undefined && body.byteLength > binding.maxRequestBytes) {
        throw new Error('Credential request body exceeds size limit');
      }
      if (request.method === 'GET' && body !== undefined && body.byteLength > 0) {
        throw new Error('Credential GET request body is denied');
      }

      let lease: CredentialSecretLease;
      try {
        lease = await options.source.acquire(binding.credentialId);
      } catch {
        throw new Error('Credential material is unavailable');
      }

      try {
        validateSecret(lease.value);
        const injectedHeaders = Object.freeze({
          ...headers,
          [binding.injectHeader]: `${binding.injectPrefix}${lease.value}`,
        });

        let response: CredentialTransportResponse;
        try {
          response = await options.transport.send({
            method: request.method,
            url: url.toString(),
            headers: injectedHeaders,
            ...(body === undefined ? {} : { body: new Uint8Array(body) }),
            redirect: 'manual',
            maxResponseBytes: binding.maxResponseBytes,
          });
        } catch {
          throw new Error('Credential broker transport failed');
        }

        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
          throw new Error('Credential broker received invalid response status');
        }
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          throw new Error('Credential broker refused redirect response');
        }
        if (!(response.body instanceof Uint8Array)
            || response.body.byteLength > binding.maxResponseBytes) {
          throw new Error('Credential broker response exceeds size limit');
        }
        if (containsSecret(response.body, lease.value)) {
          throw new Error('Credential broker blocked secret reflection');
        }

        return Object.freeze({
          status: response.status,
          headers: safeResponseHeaders(binding, response.headers, lease.value),
          body: new Uint8Array(response.body),
        });
      } finally {
        try { lease.release(); } catch { /* secret source owns cleanup semantics */ }
      }
    },
  };
}
