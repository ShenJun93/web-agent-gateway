import assert from 'node:assert/strict';
import test from 'node:test';
import { startOperatorServer } from '../src/operator-server.js';

function fakeCoordinator() {
  let approvals = 0;
  let rejections = 0;
  const review = {
    mutationId: 'mut_test', state: 'PENDING_APPROVAL' as const,
    path: '<script>.txt', before: '<b>old</b>', after: '<script>alert(1)</script>',
    baseSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), fingerprint: 'c'.repeat(64),
    additions: 1, removals: 1, reviewDeadline: Date.now() + 60_000,
  };
  return {
    listPendingLocal: () => [review],
    reviewLocal: (id: string) => id === review.mutationId ? review : undefined,
    approveLocal: async (id: string) => { if (id !== review.mutationId) return false; approvals += 1; return true; },
    rejectLocal: (id: string) => { if (id !== review.mutationId) return false; rejections += 1; return true; },
    counts: () => ({ approvals, rejections }),
  };
}

function cookiePair(value: string | null): string {
  assert.ok(value);
  return value.split(';', 1)[0]!;
}
test('operator server is loopback-only and bootstrap is single-use', async (t) => {
  const coordinator = fakeCoordinator();
  await assert.rejects(startOperatorServer({ coordinator, host: '0.0.0.0' }), /loopback/i);

  const server = await startOperatorServer({ coordinator });
  t.after(() => server.close());
  const first = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  assert.equal(first.status, 303);
  assert.equal(first.headers.get('location'), '/');
  const setCookie = first.headers.get('set-cookie');
  assert.match(setCookie ?? '', /HttpOnly/i);
  assert.match(setCookie ?? '', /SameSite=Strict/i);
  assert.doesNotMatch(first.headers.get('location') ?? '', /token=/i);

  const replay = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  assert.equal(replay.status, 403);
});

test('operator page escapes review content and emits restrictive headers', async (t) => {
  const server = await startOperatorServer({ coordinator: fakeCoordinator() });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(server.origin, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;\.txt/);
  assert.match(html, /&lt;b&gt;old&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /canonicalRoot|ownerId|sessionId|adapterId/i);
});
test('operator mutations require exact Origin, session cookie, and CSRF', async (t) => {
  const coordinator = fakeCoordinator();
  const server = await startOperatorServer({ coordinator });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(server.origin, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const noOrigin = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }), redirect: 'manual',
  });
  assert.equal(noOrigin.status, 403);

  const noCsrf = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST', headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: '', redirect: 'manual',
  });
  assert.equal(noCsrf.status, 403);

  const ok = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST', headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }), redirect: 'manual',
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/');
  assert.equal(coordinator.counts().approvals, 1);
});
