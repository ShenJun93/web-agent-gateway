import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DurableMutationCoordinator } from '../src/durable-mutation.js';
import { startOperatorServer } from '../src/operator-server.js';
import { createBrowserOperatorExtensionCore } from '../browser/extension/service-worker-core-v4.js';
import type { FileMutationBackend } from '../src/file-mutation-backend.js';

/**
 * Regressions for four defects found by driving the product against a real signed-in
 * conversation, none of which the suite could see before.
 *
 * Recorded in docs/benchmarks/2026-09-20-claude-autonomous-wag-harness-v1-source-acceptance.md.
 * Each test names the live symptom it reproduces, because the mechanism is in every case one
 * step removed from what the operator actually experienced.
 */

// --- D. The operator's own security header defeated its CSRF Origin check -----------------

function fakeCoordinator(reviewDeadline = Date.now() + 60_000) {
  const review = {
    mutationId: 'mut_test', state: 'PENDING_APPROVAL' as const,
    path: 'ticket-id.js', before: 'old', after: 'new',
    workspaceRoot: String.raw`C:\repos\project`,
    baseSha256: 'a'.repeat(64), resultSha256: 'b'.repeat(64), fingerprint: 'c'.repeat(64),
    additions: 1, removals: 1, reviewDeadline,
  };
  let approvals = 0;
  return {
    listPendingLocal: () => [review],
    reviewLocal: (id: string) => (id === review.mutationId ? review : undefined),
    approveLocal: async (id: string) => { if (id !== review.mutationId) return false; approvals += 1; return true; },
    rejectLocal: (id: string) => id === review.mutationId,
    approvals: () => approvals,
  };
}

const cookiePair = (value: string | null): string => {
  assert.ok(value);
  return value.split(';', 1)[0]!;
};

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

test('the review page sends a referrer policy that does not null out a navigation Origin', async (t) => {
  // This asserts the header, which is all a `fetch()`-driven test can do: Node's fetch is request
  // mode "cors" and is exempt from the rule this is about, so no test in `npm test` can produce
  // the navigation that broke. The behaviour itself is pinned by
  // `npm run test:operator-browser`, which drives a real browser through the real form.
  // Live symptom: an Approve click from an authenticated review page returned Denied, and the
  // durable row kept `reviewed_at` unset, proving the coordinator was never reached.
  //
  // Cause: `referrer-policy: no-referrer`. Per Fetch, a request whose mode is NOT "cors" and
  // whose method is not GET/HEAD serialises its Origin as the string "null" under that policy.
  // A form submission is a navigation, so the browser sent `Origin: null` and the Origin check
  // rejected it before the CSRF value was ever read. Measured in Edge: with the header, Origin
  // arrived as "null"; without it, the real origin arrived. `fetch()` is mode "cors" and is
  // therefore exempt — which is why every existing test passed while the product did not.
  const server = await startOperatorServer({ coordinator: fakeCoordinator() });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const page = await fetch(server.origin, { headers: { cookie } });

  const policy = page.headers.get('referrer-policy');
  assert.notEqual(policy, 'no-referrer',
    'no-referrer makes a navigation POST send Origin: null, which the CSRF check then rejects');
  assert.equal(policy, 'same-origin',
    'same-origin still withholds the referrer cross-origin while preserving a real same-origin Origin');

  // The other headers are load-bearing and must not have been traded away for this.
  assert.match(page.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');
});

test('an Origin of "null" is still refused, and the correct Origin still works', async (t) => {
  // The fix changes which Origin the browser sends; it must not change what the server accepts.
  const coordinator = fakeCoordinator();
  const server = await startOperatorServer({ coordinator });
  t.after(() => server.close());
  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const html = await (await fetch(server.origin, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf);

  const form = (origin: string) => fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });

  assert.equal((await form('null')).status, 403, 'a literal null Origin is not same-origin');
  assert.equal((await form('http://evil.example')).status, 403, 'a cross origin is refused');
  assert.equal(coordinator.approvals(), 0);
  assert.equal((await form(server.origin)).status, 303, 'the real same-origin POST is accepted');
  assert.equal(coordinator.approvals(), 1);
});

// --- C. A refusal told the operator nothing ----------------------------------------------

test('a refusal is locally diagnosable without disclosing a secret', async (t) => {
  // Live symptom: three different failures all rendered the body "Denied", and the server logs
  // no requests, so the cause had to be inferred from durable state instead of read off the
  // response. An unauthenticated caller still learns nothing; a caller that already holds a
  // session learns which check failed, because it already passed the one that guards secrets.
  // The whole event, not a projection of it: an earlier version pushed only status and code, so
  // the "no secret in the diagnostics" assertion below inspected a value this test had built and
  // was vacuously true. `path` is the field that could carry one.
  const denials: Array<{ status: number; code: string; path: string }> = [];
  const coordinator = fakeCoordinator();
  const server = await startOperatorServer({
    coordinator,
    onDeny: (event) => denials.push(event),
  });
  t.after(() => server.close());

  const unauthenticated = await fetch(`${server.origin}/`);
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.text()).trim(), 'Denied',
    'the unauthenticated surface stays generic');

  const boot = await fetch(server.bootstrapUrl, { redirect: 'manual' });
  const cookie = cookiePair(boot.headers.get('set-cookie'));
  const html = await (await fetch(server.origin, { headers: { cookie } })).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1]!;

  const badOrigin = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST',
    headers: { cookie, origin: 'http://evil.example', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(badOrigin.status, 403);
  const badOriginBody = await badOrigin.text();
  assert.match(badOriginBody, /ORIGIN_MISMATCH/);

  const badCsrf = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'wrong' }),
  });
  assert.equal(badCsrf.status, 403);
  assert.match(await badCsrf.text(), /CSRF_INVALID/);

  // Fetch metadata is corroboration, and it has its own code: a diagnostic that could not tell a
  // Sec-Fetch-Site refusal from an Origin refusal would be no better than the single `Denied`
  // this change replaces. It must never *accept* anything the Origin check would refuse.
  const wrongSite = await fetch(`${server.origin}/mutations/mut_test/approve`, {
    method: 'POST',
    headers: {
      cookie, origin: server.origin, 'sec-fetch-site': 'cross-site',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(wrongSite.status, 403);
  assert.match(await wrongSite.text(), /SITE_MISMATCH/);
  assert.equal(coordinator.approvals(), 0, 'a correct Origin does not rescue a cross-site claim');

  const missing = await fetch(`${server.origin}/mutations/mut_absent/approve`, {
    method: 'POST',
    headers: { cookie, origin: server.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
  });
  assert.equal(missing.status, 409);
  assert.match(await missing.text(), /NOT_ACTIONABLE/);

  assert.deepEqual(denials.map((d) => d.code),
    ['UNAUTHENTICATED', 'ORIGIN_MISMATCH', 'CSRF_INVALID', 'SITE_MISMATCH', 'NOT_ACTIONABLE'],
    'every refusal is reported locally, in order, with a distinguishable reason');

  // Nothing that could help an attacker may appear in any body or in the local diagnostics. The
  // bootstrap token lives in a query string, so this also pins that `path` is the pathname and
  // not `pathname + search` — the reason a refusal on /bootstrap is safe to report at all.
  const emitted = [badOriginBody, JSON.stringify(denials)].join(' ');
  const bootstrapToken = new URL(server.bootstrapUrl).searchParams.get('token')!;
  assert.equal(emitted.includes(csrf), false, 'the CSRF value is never echoed');
  assert.equal(emitted.includes(cookie.split('=')[1] ?? 'x'), false, 'the session id is never echoed');
  assert.equal(emitted.includes(bootstrapToken), false, 'the bootstrap token is never echoed');
  assert.equal(denials.every((d) => !d.path.includes('?')), true, 'a denial path carries no query string');
});

// --- B. An expired record was offered with a working Approve button -----------------------

test('a record past its review deadline is not offered as pending, and is reconciled', async (t) => {
  // Live symptom: the review page rendered an Approve button for a mutation whose deadline had
  // passed. The pending query selects on state alone; the approval statement additionally
  // requires `review_deadline > ?`. So the operator was invited to press a button that could
  // only ever be refused, while racing a five-minute clock.
  const dir = await mkdtemp(join(tmpdir(), 'wag-dogfood-'));
  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });

  const original = 'alpha\n';
  await writeFile(join(dir, 'note.txt'), original);

  const backend: FileMutationBackend = {
    kind: 'test-fs',
    async readExact(root, path) { return readFile(join(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      try { return await readFile(join(root, path), 'utf8'); } catch { return undefined; }
    },
    async createNew(root, path, candidate) { await writeFile(join(root, path), candidate, { flag: 'wx' }); },
    async updateExisting(root, path, _before, candidate) { await writeFile(join(root, path), candidate); },
  };

  const at = { value: 1_000_000 };
  const caller = createGatewayCallerContext({ ownerId: 'o', sessionId: 's', adapterId: 'a' });
  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: dir, backendKind: backend.kind, createdAt: at.value,
  });
  const coordinator = new DurableMutationCoordinator({
    store, backends: [backend], reviewTtlMs: 60_000, now: () => at.value,
  });

  const created = await coordinator.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'alpha', after: 'ALPHA',
  });
  assert.equal(created.status, 'approval_required');
  const mutationId = created.mutationId!;
  assert.equal(coordinator.listPendingLocal().length, 1, 'it is pending while the window is open');

  at.value += 60_001; // the window closes

  assert.equal(coordinator.listPendingLocal().length, 0,
    'a record the server would refuse must not be offered as actionable');
  assert.equal(store.getMutation(mutationId)?.state, 'EXPIRED',
    'and the durable state is reconciled by the same transition reconcile() uses, not merely hidden');
});

test('a pending mutation survives a store reopen, and the sweep does not eat a live one', async (t) => {
  // The overdue sweep is new and runs in front of every render, so it meets restart recovery
  // head-on: a runtime restart reconciles, and the review page then lists. A record whose window
  // is still open must come back listed, with the deadline it already had — `browser-verify-request`
  // has had this property tested since it was written, and the mutation path now needs it too,
  // because before this change nothing on that path wrote during a read.
  const dir = await mkdtemp(join(tmpdir(), 'wag-restart-'));
  const original = 'alpha\n';
  await writeFile(join(dir, 'note.txt'), original);

  const backend: FileMutationBackend = {
    kind: 'test-fs',
    async readExact(root, path) { return readFile(join(root, path), 'utf8'); },
    async readExactIfPresent(root, path) {
      try { return await readFile(join(root, path), 'utf8'); } catch { return undefined; }
    },
    async createNew(root, path, candidate) { await writeFile(join(root, path), candidate, { flag: 'wx' }); },
    async updateExisting(root, path, _before, candidate) { await writeFile(join(root, path), candidate); },
  };

  const at = { value: 5_000_000 };
  const caller = createGatewayCallerContext({ ownerId: 'o', sessionId: 's', adapterId: 'a' });
  const storePath = join(dir, 'state.sqlite');

  let store = new SqliteDurableStore(storePath);
  const opened: SqliteDurableStore[] = [store];
  t.after(async () => {
    for (const handle of opened) { try { handle.close(); } catch { /* already closed */ } }
    await rm(dir, { recursive: true, force: true });
  });

  const workspace = store.openWorkspaceRecord({
    ...caller, canonicalRoot: dir, backendKind: backend.kind, createdAt: at.value,
  });
  const before = new DurableMutationCoordinator({
    store, backends: [backend], reviewTtlMs: 60_000, now: () => at.value,
  });
  const created = await before.preview(caller, workspace.workspaceId, {
    path: 'note.txt', baseSha256: sha256(original), before: 'alpha', after: 'ALPHA',
  });
  assert.equal(created.status, 'approval_required');
  const mutationId = created.mutationId!;
  const deadline = store.getMutation(mutationId)!.reviewDeadline;

  // Restart: the store is closed and reopened, exactly as a runtime restart does.
  store.close();
  at.value += 10_000; // time passes while nothing is running, well inside the window
  store = new SqliteDurableStore(storePath);
  opened.push(store);
  const after = new DurableMutationCoordinator({
    store, backends: [backend], reviewTtlMs: 60_000, now: () => at.value,
  });
  await after.reconcile();

  const listed = after.listPendingLocal();
  assert.equal(listed.length, 1, 'a live record comes back listed after a restart');
  assert.equal(listed[0]!.mutationId, mutationId);
  assert.equal(store.getMutation(mutationId)!.reviewDeadline, deadline,
    'and its deadline is the one it already had — a restart does not buy more review time');
  assert.equal(await readFile(join(dir, 'note.txt'), 'utf8'), original, 'nothing was written by any of this');

  // Past the deadline the same call expires it, which is the whole point of the sweep.
  at.value = deadline + 1;
  assert.equal(after.listPendingLocal().length, 0);
  assert.equal(store.getMutation(mutationId)!.state, 'EXPIRED');
  assert.equal(await after.approveLocal(mutationId), false, 'and it cannot be approved afterwards');
});

// --- A. The side panel never learned about a newly queued proposal -------------------------

test('the core announces a newly queued proposal, and stays silent on a repeat observation', async () => {
  // Scope, stated plainly: this covers the core's hook. The wiring that carries it to a panel —
  // `service-worker.js` sending `panel.pending`, and `sidepanel.js` refreshing on it and on
  // `visibilitychange` — is extension-host code with no test harness in this repo, and is
  // verified in the live dogfood instead. Do not read this test as covering the panel.
  // Live symptom: session storage held a queued proposal while the side panel showed an empty
  // pending list across two opens. Results are pushed to the panel; proposals were not, and the
  // panel document survives being hidden and shown, so its load-time refresh never re-ran.
  const store = new Map<string, unknown>();
  const storageSession = {
    get: async (key: string) => ({ [key]: store.get(key) }),
    set: async (obj: Record<string, unknown>) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); },
    remove: async (key: string) => { store.delete(key); },
  };

  const queued: number[] = [];
  const core = createBrowserOperatorExtensionCore(storageSession, { onQueued: (count: number) => queued.push(count) });
  await core.restore();

  const request = {
    version: 4 as const, type: 'tool.call' as const, requestId: 'req_1', sessionId: 'session_x',
    tool: 'mutation.preview' as const,
    arguments: { workspace_id: 'ws_1', path: 'f.txt', base_sha256: 'a'.repeat(64), before: 'a', after: 'b' },
  };
  const sender = { url: 'https://chatgpt.com/c/1', tabId: 7 };

  assert.equal(core.queueProviderRequest(sender, request, 'msg-1'), true);
  assert.deepEqual(queued, [1], 'the panel is told as soon as a proposal is queued');

  // A rescan re-observes the same message and must not notify again, or the panel would flicker
  // and the idempotency guarantee would be invisible to it.
  assert.equal(core.queueProviderRequest(sender, { ...request, requestId: 'req_2' }, 'msg-1'), false);
  assert.deepEqual(queued, [1], 'a repeat observation is silent');

  assert.equal(core.queueProviderRequest(sender, { ...request, requestId: 'req_3' }, 'msg-2'), true);
  assert.deepEqual(queued, [1, 2], 'a genuinely new proposal notifies again');
});
