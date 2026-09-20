import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessLane, HARNESS_LANE, type HarnessLane, type LaneOperator } from '../src/harness-authority.js';

/**
 * The iteration loops the harness runs without a human.
 *
 * `harness-authority.test.ts` asks what the lane refuses — whether it can reach a production
 * record. This file asks the opposite question: whether the lane can actually *drive* the things
 * the mission needs iterated — TTL expiry, restart, and the operator server's CSRF and Origin
 * checks — so that a regression in any of them fails here instead of costing a human gesture to
 * discover.
 *
 * Everything below runs against production code. The operator server is `startOperatorServer`
 * with its checks intact; the coordinator is `DurableMutationCoordinator`. Only the *store* is
 * the lane's.
 */
const enabled = { ...process.env, WAG_HARNESS_LANE: '1' };

async function openLane(t: { after(fn: () => void | Promise<void>): void }, options: {
  reviewTtlMs?: number;
  startMs?: number;
} = {}): Promise<HarnessLane> {
  const parent = await mkdtemp(join(tmpdir(), 'wag-loop-'));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, ...options });
  // One hook: `node:test` runs them in registration order, and a directory removal registered
  // separately would run while the store handle is still open and fail EBUSY on Windows.
  t.after(async () => {
    await lane.destroy();
    await rm(parent, { recursive: true, force: true });
  });
  return lane;
}

const BEFORE = 'export const id = (raw) => String(raw).trim();\n';
const AFTER = 'export const id = (raw) => String(raw ?? "").trim();\n';

/** Drives the operator exactly as a browser does: bootstrap, then a form POST carrying the CSRF. */
async function bootstrap(operator: LaneOperator): Promise<{ cookie: string; csrf: string }> {
  const redirect = await fetch(operator.bootstrapUrl, { redirect: 'manual' });
  assert.equal(redirect.status, 303, 'bootstrap redirects to the review root');
  const setCookie = redirect.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  assert.match(cookie, /^wag_operator_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);

  const root = await fetch(`${operator.origin}/`, { headers: { cookie } });
  assert.equal(root.status, 200, 'the review root renders once a session is held');
  const body = await root.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(body)?.[1];
  assert.ok(csrf, 'the review page carries a CSRF token');
  return { cookie, csrf };
}

test('the TTL loop: a record expires on its own deadline and can no longer be approved', async (t) => {
  // A five-second window, driven by the lane's clock rather than by waiting.
  const lane = await openLane(t, { reviewTtlMs: 5_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  assert.equal((await lane.pending()).length, 1, 'inside the window the record is offered');

  lane.advanceClock(5_001);

  // Listing is what sweeps: this is defect 3's repair, and the loop that proves it stays fixed.
  assert.deepEqual(await lane.pending(), [], 'past the deadline it is no longer offered');
  assert.equal(await lane.approve(proposed.mutationId), false,
    'and approving it does nothing — the CAS requires a deadline still in the future');
  assert.equal(await lane.readFixture('ticket-id.js'), BEFORE, 'an expired record never reaches disk');
});

test('the restart loop: a pending record survives a store reopen with the deadline it already had', async (t) => {
  const lane = await openLane(t, { reviewTtlMs: 60_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });
  const workspaceBefore = lane.workspaceId;

  await lane.reopen();

  assert.equal(lane.workspaceId, workspaceBefore,
    'the reopen rebinds to the same workspace rather than creating a second one');
  assert.deepEqual(
    (await lane.pending()).map((r) => r.mutationId), [proposed.mutationId],
    'the record is still there and still pending',
  );

  // And it is still approvable, which is the part that matters: a restart must not strand a
  // record in a state where the operator can see it but not act on it.
  assert.equal(await lane.approve(proposed.mutationId), true);
  assert.equal(await lane.readFixture('ticket-id.js'), AFTER);
});

test('the restart loop does not resurrect a deadline: reopening past it still expires', async (t) => {
  const lane = await openLane(t, { reviewTtlMs: 5_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  lane.advanceClock(5_001);
  await lane.reopen();

  assert.deepEqual(await lane.pending(), [], 'the deadline is durable, not a property of the process');
  assert.equal(await lane.approve(proposed.mutationId), false);
  assert.equal(await lane.readFixture('ticket-id.js'), BEFORE);
});

test('the operator loop: a real review server approves over HTTP, and that is what writes the file', async (t) => {
  const lane = await openLane(t, { reviewTtlMs: 60_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  const operator = await lane.serveOperator();
  const { cookie, csrf } = await bootstrap(operator);

  const approve = await fetch(`${operator.origin}/mutations/${proposed.mutationId}/approve`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      cookie,
      origin: operator.origin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.equal(approve.status, 303, 'a well-formed approval is accepted');

  assert.equal(await lane.readFixture('ticket-id.js'), AFTER,
    'and the effect happened through the same path the operator uses');
  assert.deepEqual(operator.denials, [], 'nothing was refused along the way');
});

test('the CSRF loop: the review server refuses a wrong Origin and a wrong token, and says which', async (t) => {
  const lane = await openLane(t, { reviewTtlMs: 60_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  const operator = await lane.serveOperator();
  const { cookie, csrf } = await bootstrap(operator);
  const url = `${operator.origin}/mutations/${proposed.mutationId}/approve`;
  const form = { cookie, 'content-type': 'application/x-www-form-urlencoded' };

  // A cross-origin submission carrying a *valid* token. This is the case the Origin check exists
  // for, and the one a CSRF token alone would not stop if it ever leaked.
  const crossOrigin = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { ...form, origin: 'http://evil.localhost' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.equal(crossOrigin.status, 403);

  // The right origin, a wrong token.
  const badToken = await fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { ...form, origin: operator.origin },
    body: new URLSearchParams({ csrf: 'not-the-token' }).toString(),
  });
  assert.equal(badToken.status, 403);

  assert.deepEqual(
    operator.denials.map((d) => d.code),
    ['ORIGIN_MISMATCH', 'CSRF_INVALID'],
    'the local process is told which check failed, in order — defect 4, kept fixed',
  );

  // Neither refusal touched anything, and the record is still live for a legitimate approval.
  assert.equal(await lane.readFixture('ticket-id.js'), BEFORE);
  assert.equal((await lane.pending()).length, 1);
});

test('the operator loop is single-use: a replayed approval changes nothing a second time', async (t) => {
  const lane = await openLane(t, { reviewTtlMs: 60_000 });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  const operator = await lane.serveOperator();
  const { cookie, csrf } = await bootstrap(operator);
  const url = `${operator.origin}/mutations/${proposed.mutationId}/approve`;
  const send = () => fetch(url, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: operator.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString(),
  });

  assert.equal((await send()).status, 303);
  await lane.writeFixture('ticket-id.js', 'tampered\n');

  // The replay must not re-run the effect over the tampered content.
  const replay = await send();
  assert.equal(replay.status, 409, 'the transition already happened, and it happens once');
  assert.equal(await lane.readFixture('ticket-id.js'), 'tampered\n',
    'a replayed approval writes nothing');
});

test('the lane closes its own review servers, so an iteration leaves no listening port', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'wag-loop-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const lane = await createHarnessLane({ lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled });

  const operator = await lane.serveOperator();
  const origin = operator.origin;
  assert.equal((await fetch(`${origin}/`)).status, 401, 'serving, and refusing the unauthenticated');

  // Closing the lane, not the server: a test that forgets the server must not leak it.
  await lane.destroy();

  await assert.rejects(fetch(`${origin}/`), 'the port is gone with the lane');
});
