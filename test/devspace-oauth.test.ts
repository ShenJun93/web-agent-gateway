import assert from 'node:assert/strict';
import test from 'node:test';
import { createDevspaceOAuthSession } from '../src/executor/devspace-oauth.js';

interface FakeOAuth {
  fetchFn: typeof fetch;
  registerCount: number;
  authorizeCount: number;
  refreshTokensSeen: string[];
  ownerTokensSeen: string[];
  failNextRefresh(): void;
}

function createFakeOAuth(expiresIn = 10): FakeOAuth {
  let registerCount = 0;
  let authorizeCount = 0;
  let tokenSerial = 0;
  let failRefresh = false;
  const refreshTokensSeen: string[] = [];
  const ownerTokensSeen: string[] = [];

  const fake: FakeOAuth = {
    get registerCount() { return registerCount; },
    get authorizeCount() { return authorizeCount; },
    refreshTokensSeen,
    ownerTokensSeen,
    failNextRefresh() { failRefresh = true; },
    fetchFn: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/register') {
        registerCount += 1;
        return new Response(JSON.stringify({ client_id: `client-${registerCount}` }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/authorize') {
        authorizeCount += 1;
        const body = new URLSearchParams(String(init?.body ?? ''));
        ownerTokensSeen.push(body.get('owner_token') ?? '');
        const location = new URL(body.get('redirect_uri') ?? 'http://127.0.0.1/callback');
        location.searchParams.set('code', `code-${authorizeCount}`);
        location.searchParams.set('state', body.get('state') ?? '');
        return new Response(null, { status: 302, headers: { location: location.href } });
      }
      if (url.pathname !== '/token') return new Response('not found', { status: 404 });

      const body = new URLSearchParams(String(init?.body ?? ''));
      if (body.get('grant_type') === 'refresh_token') {
        refreshTokensSeen.push(body.get('refresh_token') ?? '');
        if (failRefresh) {
          failRefresh = false;
          return new Response('invalid refresh', { status: 400 });
        }
      }
      tokenSerial += 1;
      return new Response(JSON.stringify({
        access_token: `access-${tokenSerial}`,
        refresh_token: `refresh-${tokenSerial}`,
        token_type: 'bearer',
        expires_in: expiresIn,
        scope: 'devspace',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch,
  };
  return fake;
}

function options(fake: FakeOAuth, now: () => number) {
  return {
    baseUrl: 'http://127.0.0.1:7676',
    resourceUrl: 'http://127.0.0.1:7676/mcp',
    ownerToken: 'owner-token-long-enough-for-test',
    fetchFn: fake.fetchFn,
    now,
  };
}

test('OAuth session bootstraps and rotates consumed refresh tokens', async () => {
  const fake = createFakeOAuth(10);
  let nowMs = 0;
  const session = await createDevspaceOAuthSession(options(fake, () => nowMs));
  assert.equal(await session.getAccessToken(), 'access-1');
  nowMs = 6_000;
  assert.equal(await session.getAccessToken(), 'access-2');
  nowMs = 12_000;
  assert.equal(await session.getAccessToken(), 'access-3');
  assert.deepEqual(fake.refreshTokensSeen, ['refresh-1', 'refresh-2']);
  assert.deepEqual(fake.ownerTokensSeen, ['owner-token-long-enough-for-test']);
  session.close();
});

test('OAuth refresh is single-flight and forced refresh rotates immediately', async () => {
  const fake = createFakeOAuth(10);
  let nowMs = 0;
  const session = await createDevspaceOAuthSession(options(fake, () => nowMs));
  assert.equal(await session.refreshAfterUnauthorized(), 'access-2');
  assert.deepEqual(fake.refreshTokensSeen, ['refresh-1']);

  nowMs = 6_000;
  const values = await Promise.all([
    session.getAccessToken(),
    session.getAccessToken(),
    session.getAccessToken(),
  ]);
  assert.deepEqual(values, ['access-3', 'access-3', 'access-3']);
  assert.deepEqual(fake.refreshTokensSeen, ['refresh-1', 'refresh-2']);
  session.close();
});
test('OAuth refresh failure re-bootstraps once and close releases the session', async () => {
  const fake = createFakeOAuth(10);
  let nowMs = 0;
  const session = await createDevspaceOAuthSession(options(fake, () => nowMs));
  fake.failNextRefresh();
  nowMs = 6_000;
  assert.equal(await session.getAccessToken(), 'access-2');
  assert.equal(fake.registerCount, 2);
  assert.equal(fake.authorizeCount, 2);
  assert.deepEqual(fake.refreshTokensSeen, ['refresh-1']);

  session.close();
  await assert.rejects(() => session.getAccessToken(), /closed/i);
  await assert.rejects(() => session.refreshAfterUnauthorized(), /closed/i);
});
