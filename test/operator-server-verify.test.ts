import assert from 'node:assert/strict';
import test from 'node:test';
import { startOperatorServer } from '../src/operator-server.js';

function verifyCoordinator() {
  let approvals = 0;
  let rejections = 0;
  const review = {
    requestId: 'verifyreq_12345678-1234-1234-1234-123456789abc',
    workspaceRoot: 'E:/fixture/<unsafe>',
    profileName: 'unit<script>',
    planSha256: 'a'.repeat(64),
    fingerprint: 'b'.repeat(64),
    state: 'PENDING_APPROVAL' as const,
    createdAt: 1_000,
    reviewDeadline: 61_000,
  };
  return {
    listPendingLocal: () => [review],
    reviewLocal: (id: string) => id === review.requestId ? review : undefined,
    approveLocal: async (id: string) => { if (id !== review.requestId) return false; approvals += 1; return true; },
    rejectLocal: (id: string) => { if (id !== review.requestId) return false; rejections += 1; return true; },
    counts: () => ({ approvals, rejections }),
  };
}

function cookiePair(value: string | null): string {
  assert.ok(value);
  return value.split(';', 1)[0]!;
}

test('operator renders verify-specific local review without remote authority fields', async (t) => {
  const verify = verifyCoordinator();
  const server = await startOperatorServer({ verifyCoordinator: verify });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(server.origin, { headers: { cookie } });
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /Verifications/);
  assert.match(html, /Verify unit&lt;script&gt;/);
  assert.match(html, /E:\/fixture\/&lt;unsafe&gt;/);
  assert.match(html, /Approval executes this configured named verification profile/);
  assert.doesNotMatch(html, /ownerId|sessionId|adapterId|bootstrapToken|bearer/i);
  assert.doesNotMatch(html, /<script>/i);

  const detail = await fetch(`${server.origin}/verifications/verifyreq_12345678-1234-1234-1234-123456789abc`, {
    headers: { cookie },
  });
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Plan SHA-256/);
});

test('verify approval requires operator session, exact Origin and CSRF and is single routed action', async (t) => {
  const verify = verifyCoordinator();
  const server = await startOperatorServer({ verifyCoordinator: verify });
  t.after(() => server.close());

  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(server.origin, { headers: { cookie } });
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  const requestId = 'verifyreq_12345678-1234-1234-1234-123456789abc';
  const url = `${server.origin}/verifications/${requestId}/approve`;

  const anonymous = await fetch(url, {
    method: 'POST',
    headers: { origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(anonymous.status, 401);

  const noOrigin = await fetch(url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(noOrigin.status, 403);

  const noCsrf = await fetch(url, {
    method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
    redirect: 'manual',
  });
  assert.equal(noCsrf.status, 403);

  const ok = await fetch(url, {
    method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(ok.status, 303);
  assert.equal(verify.counts().approvals, 1);
});
