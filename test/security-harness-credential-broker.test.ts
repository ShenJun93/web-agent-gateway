import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createCredentialBroker,
  type CredentialRequest,
  type CredentialSecretSource,
  type CredentialTransport,
} from '../src/security-harness/credential-broker.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_security',
  sessionId: 'session_security',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_security',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};

function fixture() {
  const secret = 'super-secret-token';
  let acquired = 0;
  let released = 0;
  let availableChecks = 0;
  const requests: Array<{
    method: string;
    url: string;
    headers: Readonly<Record<string, string>>;
    redirect: string;
    maxResponseBytes: number;
  }> = [];

  const source: CredentialSecretSource = {
    async available(credentialId) {
      availableChecks += 1;
      return credentialId === 'github';
    },
    async acquire(credentialId) {
      acquired += 1;
      if (credentialId !== 'github') throw new Error('no secret');
      return {
        value: secret,
        release() { released += 1; },
      };
    },
  };
  let response = {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: '"abc"',
      'set-cookie': 'session=hidden',
      'x-private': 'not-exposed',
    },
    body: new TextEncoder().encode('{"ok":true}'),
  };
  const transport: CredentialTransport = {
    async send(request) {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        redirect: request.redirect,
        maxResponseBytes: request.maxResponseBytes,
      });
      return response;
    },
  };
  const broker = createCredentialBroker({
    bindings: [{
      credentialId: 'github',
      allowedOrigins: ['https://api.github.com'],
      allowedMethods: ['GET', 'POST'],
      allowedPathPrefixes: ['/repos/', '/user'],
      injectHeader: 'Authorization',
      injectPrefix: 'Bearer ',
      exposedResponseHeaders: ['content-type', 'etag'],
      maxRequestBytes: 1024,
      maxResponseBytes: 4096,
    }],
    source,
    transport,
    credentialAllowed: (owner, credentialId) =>
      owner.sessionId === OWNER.sessionId && credentialId === 'github',
  });

  return {
    broker,
    secret,
    requests,
    counts: () => ({ acquired, released, availableChecks }),
    setResponse(next: typeof response) { response = next; },
  };
}

test('CredentialBroker describes usable bindings without acquiring secret material', async () => {
  const f = fixture();
  const descriptors = await f.broker.describe(OWNER);
  assert.deepEqual(descriptors, [{
    credentialId: 'github',
    available: true,
    allowedOrigins: ['https://api.github.com'],
    allowedMethods: ['GET', 'POST'],
    allowedPathPrefixes: ['/repos/', '/user'],
  }]);
  assert.deepEqual(await f.broker.describe(OTHER), []);
  assert.deepEqual(f.counts(), { acquired: 0, released: 0, availableChecks: 1 });
  assert.equal(JSON.stringify(descriptors).includes(f.secret), false);
});

test('CredentialBroker injects host-only auth after policy checks and exposes only allowed response headers', async () => {
  const f = fixture();
  const response = await f.broker.request(OWNER, {
    credentialId: 'github',
    method: 'GET',
    url: 'https://api.github.com/repos/openai/example?per_page=1',
    headers: {
      accept: 'application/json',
      'user-agent': 'WAG-test',
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.headers, {
    'content-type': 'application/json',
    etag: '"abc"',
  });
  assert.equal(new TextDecoder().decode(response.body), '{"ok":true}');

  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.url, 'https://api.github.com/repos/openai/example?per_page=1');
  assert.equal(f.requests[0]!.redirect, 'manual');
  assert.equal(f.requests[0]!.headers.authorization, `Bearer ${f.secret}`);
  assert.equal(f.requests[0]!.headers.accept, 'application/json');
  assert.deepEqual(f.counts(), { acquired: 1, released: 1, availableChecks: 0 });
});

test('origin, method, path and broker-owned headers are denied before secret acquisition', async () => {
  const f = fixture();

  const deniedRequests: CredentialRequest[] = [
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://evil.example/repos/openai/example',
    },
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://sub.api.github.com/repos/openai/example',
    },
    {
      credentialId: 'github', method: 'DELETE' as const,
      url: 'https://api.github.com/repos/openai/example',
    },
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://api.github.com/orgs/openai',
    },
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://api.github.com/userfoo',
    },
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://api.github.com/repos/openai/example',
      headers: { Authorization: 'caller-value' },
    },
    {
      credentialId: 'github', method: 'GET' as const,
      url: 'https://api.github.com/repos/openai/example',
      headers: { Cookie: 'session=caller' },
    },
  ];

  for (const request of deniedRequests) {
    await assert.rejects(
      () => f.broker.request(OWNER, request),
      /(denied|broker-owned)/,
    );
  }

  assert.deepEqual(f.counts(), { acquired: 0, released: 0, availableChecks: 0 });
  assert.equal(f.requests.length, 0);
});

test('CredentialBroker refuses automatic redirect semantics and releases the secret lease', async () => {
  const f = fixture();
  f.setResponse({
    status: 302,
    headers: { 'content-type': 'text/plain', etag: '"redirect"', 'set-cookie': 'x=y', 'x-private': 'x' },
    body: new TextEncoder().encode('redirect'),
  });

  await assert.rejects(
    () => f.broker.request(OWNER, {
      credentialId: 'github',
      method: 'GET',
      url: 'https://api.github.com/repos/openai/example',
    }),
    /refused redirect/,
  );
  assert.equal(f.requests[0]!.redirect, 'manual');
  assert.deepEqual(f.counts(), { acquired: 1, released: 1, availableChecks: 0 });
});

test('CredentialBroker blocks direct secret reflection in body or exposed headers', async () => {
  const f = fixture();
  f.setResponse({
    status: 200,
    headers: { 'content-type': 'text/plain', etag: '"safe"', 'set-cookie': 'x=y', 'x-private': 'x' },
    body: new TextEncoder().encode(`echo:${f.secret}`),
  });
  await assert.rejects(
    () => f.broker.request(OWNER, {
      credentialId: 'github',
      method: 'GET',
      url: 'https://api.github.com/repos/openai/example',
    }),
    /blocked secret reflection/,
  );

  f.setResponse({
    status: 200,
    headers: { 'content-type': 'text/plain', etag: f.secret, 'set-cookie': 'x=y', 'x-private': 'x' },
    body: new TextEncoder().encode('safe'),
  });
  await assert.rejects(
    () => f.broker.request(OWNER, {
      credentialId: 'github',
      method: 'GET',
      url: 'https://api.github.com/repos/openai/example',
    }),
    /blocked secret reflection/,
  );
  assert.deepEqual(f.counts(), { acquired: 2, released: 2, availableChecks: 0 });
});

test('transport and secret-source failures return generic errors and never include credential value', async () => {
  const secret = 'should-never-appear';
  const broker = createCredentialBroker({
    bindings: [{
      credentialId: 'service',
      allowedOrigins: ['https://api.example.test'],
      allowedMethods: ['POST'],
      injectHeader: 'x-api-key',
    }],
    source: {
      async available() { return true; },
      async acquire() {
        return { value: secret, release() {} };
      },
    },
    transport: {
      async send() {
        throw new Error(`request failed with x-api-key=${secret}`);
      },
    },
    credentialAllowed: () => true,
  });

  let message = '';
  try {
    await broker.request(OWNER, {
      credentialId: 'service',
      method: 'POST',
      url: 'https://api.example.test/v1/run',
      body: new Uint8Array([1]),
    });
  } catch (error) {
    message = (error as Error).message;
  }
  assert.equal(message, 'Credential broker transport failed');
  assert.equal(message.includes(secret), false);
});

test('CredentialBroker rejects insecure credential origins at construction time', () => {
  assert.throws(() => createCredentialBroker({
    bindings: [{
      credentialId: 'bad',
      allowedOrigins: ['http://api.example.test'],
      allowedMethods: ['GET'],
      injectHeader: 'authorization',
    }],
    source: {
      async available() { return true; },
      async acquire() { return { value: 'x', release() {} }; },
    },
    transport: {
      async send() { return { status: 200, headers: {}, body: new Uint8Array() }; },
    },
    credentialAllowed: () => true,
  }), /must use HTTPS/);
});

test('CredentialBroker enforces request/response byte ceilings', async () => {
  const broker = createCredentialBroker({
    bindings: [{
      credentialId: 'bounded',
      allowedOrigins: ['https://api.example.test'],
      allowedMethods: ['POST'],
      injectHeader: 'x-api-key',
      maxRequestBytes: 2,
      maxResponseBytes: 2,
    }],
    source: {
      async available() { return true; },
      async acquire() { return { value: 'secret', release() {} }; },
    },
    transport: {
      async send() {
        return { status: 200, headers: {}, body: new Uint8Array([1, 2, 3]) };
      },
    },
    credentialAllowed: () => true,
  });

  await assert.rejects(
    () => broker.request(OWNER, {
      credentialId: 'bounded',
      method: 'POST',
      url: 'https://api.example.test/run',
      body: new Uint8Array([1, 2, 3]),
    }),
    /request body exceeds/,
  );

  await assert.rejects(
    () => broker.request(OWNER, {
      credentialId: 'bounded',
      method: 'POST',
      url: 'https://api.example.test/run',
      body: new Uint8Array([1]),
    }),
    /response exceeds/,
  );
});

test('CredentialBroker permits 304 while still requiring manual redirect handling', async () => {
  const f = fixture();
  f.setResponse({
    status: 304,
    headers: { 'content-type': 'application/json', etag: '"cached"', 'set-cookie': 'x=y', 'x-private': 'x' },
    body: new Uint8Array(),
  });

  const response = await f.broker.request(OWNER, {
    credentialId: 'github',
    method: 'GET',
    url: 'https://api.github.com/user',
  });
  assert.equal(response.status, 304);
  assert.equal(f.requests[0]!.redirect, 'manual');
  assert.deepEqual(response.headers, {
    'content-type': 'application/json',
    etag: '"cached"',
  });
});
