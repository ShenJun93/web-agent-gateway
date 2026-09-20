import assert from 'node:assert/strict';
import test from 'node:test';
import { startOperatorServer } from '../src/operator-server.js';

function fakeCoordinator() {
  let approvals = 0;
  let rejections = 0;
  const review = {
    mutationId: 'mut_test', state: 'PENDING_APPROVAL' as const,
    path: '<script>.txt', before: '<b>old</b>', after: '<script>alert(1)</script>',
    workspaceRoot: String.raw`C:\repos\<mutation>-project`,
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
  // Which repository the change lands in is part of what is being approved: two workspaces can
  // hold the same relative path, and the page used to name only the path.
  assert.match(html, /Repository: C:\\repos\\&lt;mutation&gt;-project/);
  assert.doesNotMatch(html, /canonicalRoot|ownerId|sessionId|adapterId/i);
});
/**
 * The commit review page is the one control the whole design rests on, and everything it renders
 * is untrusted: the repository owns its filenames and its git config, the caller owns the message.
 */
function fakeCommitCoordinator() {
  const review = {
    commitId: 'cmt_test', state: 'PENDING_APPROVAL' as const,
    branch: 'work', oldHead: 'a'.repeat(40), treeSha: 'b'.repeat(40),
    author: 'Someone Else <someone@example.invalid>',
    committer: 'Different Committer <evil@example.invalid>',
    eolNormalized: ['src/inno​cent.ts'],
    workspaceRoot: 'C:\\repos\\project',
    // A right-to-left override in a filename displays the name in a different order than it
    // will be committed under; a zero-width space hides a difference entirely.
    paths: ['src/app\u202Egpj.sj', 'src/inno\u200Bcent.ts'],
    changes: [
      { status: 'M' as const, path: 'src/app\u202Egpj.sj' },
      { status: 'A' as const, path: 'src/inno\u200Bcent.ts' },
    ],
    message: 'fix: harmless\u202E tiderc',
    fingerprint: 'c'.repeat(64), reviewDeadline: Date.now() + 60_000,
  };
  return {
    listPendingLocal: () => [review],
    reviewLocal: (id: string) => id === review.commitId ? review : undefined,
    approveLocal: async (id: string) => id === review.commitId,
    rejectLocal: (id: string) => id === review.commitId,
  };
}

test('commit review names the repository, the author and the change set, and defuses bidi text', async (t) => {
  const server = await startOperatorServer({
    coordinator: fakeCoordinator(),
    commitCoordinator: fakeCommitCoordinator(),
  });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const html = await (await fetch(`${server.origin}/commits/cmt_test`, { headers: { cookie } })).text();

  assert.match(html, /Repository: C:\\repos\\project/, 'the operator must know which repository this is');
  assert.match(html, /Author: Someone Else &lt;someone@example\.invalid&gt;/,
    'the operator must know who the commit will be attributed to');
  assert.match(html, /M src\/app/, 'the resulting change set must be shown');
  assert.match(html, /A src\/inno/);

  // Rendered as visible code points, never as active formatting.
  assert.equal(html.includes('\u202E'), false, 'a bidi override must never reach the page verbatim');
  assert.equal(html.includes('\u200B'), false, 'a zero-width space must never reach the page verbatim');
  assert.match(html, /&lt;U\+202E&gt;/);
  assert.match(html, /&lt;U\+200B&gt;/);
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
