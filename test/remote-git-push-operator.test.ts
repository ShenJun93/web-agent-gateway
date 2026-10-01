import assert from 'node:assert/strict';
import test from 'node:test';

import { startOperatorServer } from '../src/operator-server.js';
import type { RemoteGitPushLocalReviewView } from '../src/remote-git-push.js';

const review: RemoteGitPushLocalReviewView = {
  pushId: 'push_fixture_123',
  status: 'approval_required',
  state: 'PENDING',
  sourceOid: 'a'.repeat(40),
  destinationRef: 'refs/heads/feat/remote-push-v1',
  remoteDisplayName: 'origin',
  resolvedPushUrl: 'https://github.com/example/repo.git',
  expectedRemoteState: { kind: 'OID', oid: 'b'.repeat(40) },
  grantFingerprint: 'c'.repeat(64),
  reviewDeadline: 123_456,
  workspaceRoot: process.platform === 'win32' ? 'C:\\repo' : '/repo',
  repositoryIdentity: 'repo_' + '1'.repeat(64),
  commitSubject: 'feat: bounded remote push',
  changedFilesSummary: '2 files changed',
  aheadCommitCount: 2,
  reviewedCommitOid: 'a'.repeat(40),
  reviewReceiptDigest: 'd'.repeat(64),
  maxUses: 1,
  activeGrantTtlMs: 120_000,
};

async function bootstrap(origin: string, bootstrapUrl: string) {
  const response = await fetch(bootstrapUrl, { redirect: 'manual' });
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie);
  const page = await fetch(origin + '/', { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);
  return { cookie, csrf, html };
}

test('remote push operator review is Human-session gated and approval only activates the exact grant', async (t) => {
  let approvals = 0;
  let rejections = 0;
  const coordinator = {
    listPendingLocal() { return [review]; },
    reviewLocal(pushId: string) { return pushId === review.pushId ? review : undefined; },
    async approveLocal(pushId: string) {
      assert.equal(pushId, review.pushId);
      approvals += 1;
      return true;
    },
    rejectLocal(pushId: string) {
      assert.equal(pushId, review.pushId);
      rejections += 1;
      return true;
    },
  };

  const server = await startOperatorServer({ pushCoordinator: coordinator });
  t.after(() => server.close());

  const unauthenticated = await fetch(server.origin + '/');
  assert.equal(unauthenticated.status, 401);

  const { cookie, csrf, html } = await bootstrap(server.origin, server.bootstrapUrl);
  assert.match(html, /REMOTE GIT PUSH/);
  assert.match(html, new RegExp(review.repositoryIdentity));
  assert.match(html, new RegExp(review.sourceOid));
  assert.match(html, /refs\/heads\/feat\/remote-push-v1/);
  assert.match(html, /Expected remote state/);
  assert.match(html, new RegExp('b'.repeat(40)));
  assert.match(html, /Force: NO/);
  assert.match(html, /Delete: NO/);
  assert.match(html, /Tags: NO/);
  assert.match(html, /Uses: 1/);
  assert.match(html, /Grant TTL after approval: 120000 ms/);
  assert.match(html, /Review deadline: 1970-01-01T00:02:03\.456Z/);
  assert.match(html, /does not execute the push/i);

  const secondBootstrap = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  assert.equal(secondBootstrap.status, 403, 'bootstrap credential is one-time');

  const wrongOrigin = await fetch(
    server.origin + '/pushes/' + encodeURIComponent(review.pushId) + '/approve',
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        origin: 'http://127.0.0.1:9',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    },
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal(approvals, 0);

  const badCsrf = await fetch(
    server.origin + '/pushes/' + encodeURIComponent(review.pushId) + '/approve',
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        origin: server.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf: 'wrong' }),
    },
  );
  assert.equal(badCsrf.status, 403);
  assert.equal(approvals, 0);

  const approved = await fetch(
    server.origin + '/pushes/' + encodeURIComponent(review.pushId) + '/approve',
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        origin: server.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    },
  );
  assert.equal(approved.status, 303);
  assert.equal(approvals, 1);
  assert.equal(rejections, 0);
});

test('ABSENT remote push review labels the blast radius as newly reachable commits', async (t) => {
  const absentReview: RemoteGitPushLocalReviewView = {
    ...review,
    expectedRemoteState: { kind: 'ABSENT' },
    aheadCommitCount: 57,
    changedFilesSummary: 'newly reachable files (showing 2): private/a.ts; private/b.ts',
  };
  const coordinator = {
    listPendingLocal() { return [absentReview]; },
    reviewLocal(pushId: string) { return pushId === absentReview.pushId ? absentReview : undefined; },
    async approveLocal() { return true; },
    rejectLocal() { return true; },
  };
  const server = await startOperatorServer({ pushCoordinator: coordinator });
  t.after(() => server.close());

  const { html } = await bootstrap(server.origin, server.bootstrapUrl);
  assert.match(html, /Newly reachable commits: 57/);
  assert.match(html, /newly reachable files \(showing 2\): private\/a\.ts; private\/b\.ts/);
  assert.doesNotMatch(html, /Ahead commits: 57/);
});

test('remote push operator rejection is same-origin CSRF-bound and never needs a model-callable grant API', async (t) => {
  let rejected = '';
  const coordinator = {
    listPendingLocal() { return [review]; },
    reviewLocal(pushId: string) { return pushId === review.pushId ? review : undefined; },
    async approveLocal() { throw new Error('unused'); },
    rejectLocal(pushId: string) {
      rejected = pushId;
      return true;
    },
  };
  const server = await startOperatorServer({ pushCoordinator: coordinator });
  t.after(() => server.close());
  const { cookie, csrf } = await bootstrap(server.origin, server.bootstrapUrl);

  const response = await fetch(
    server.origin + '/pushes/' + encodeURIComponent(review.pushId) + '/reject',
    {
      method: 'POST',
      redirect: 'manual',
      headers: {
        cookie,
        origin: server.origin,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ csrf }),
    },
  );
  assert.equal(response.status, 303);
  assert.equal(rejected, review.pushId);
});
