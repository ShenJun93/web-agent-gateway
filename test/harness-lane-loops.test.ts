import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('the HTTP path is guarded too: a tampered marker stops the review server mid-flight', async (t) => {
  // The server's coordinator entries used to forward straight through, so the one path that
  // actually causes an effect was the only one with neither the marker check nor the workspace
  // check on it — while the module header claimed both ran before every durable write.
  const parent = await mkdtemp(join(tmpdir(), 'wag-loop-'));
  const lane = await createHarnessLane({
    lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, reviewTtlMs: 60_000,
  });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });

  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });
  const operator = await lane.serveOperator();
  const { cookie, csrf } = await bootstrap(operator);

  // Tamper *after* the server is up, so only a per-request check can catch it.
  const markerPath = join(resolve(parent), 'lane', 'harness-lane.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { laneId: string };
  await writeFile(markerPath, JSON.stringify({ ...marker, laneId: 'lane_someone_else' }));

  const approve = await fetch(`${operator.origin}/mutations/${proposed.mutationId}/approve`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: operator.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.notEqual(approve.status, 303, 'the approval must not go through a swapped lane');

  await writeFile(markerPath, JSON.stringify(marker));
  assert.equal(await lane.readFixture('ticket-id.js'), BEFORE, 'and nothing reached disk');
});

test('the review server offers only this lane workspace, so it cannot show what approve would refuse', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'wag-loop-'));
  const lane = await createHarnessLane({
    lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, reviewTtlMs: 60_000,
  });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  await lane.writeFixture('ticket-id.js', BEFORE);
  await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  // A second workspace inside the lane's OWN store, with a pending record against it. The lane's
  // own `pending()` filters these out; before the fix the HTTP listing did not, so the page
  // rendered a record with a working Approve button that `lane.approve()` would have rejected.
  const storePath = join(resolve(parent), 'lane', 'harness-lane.sqlite');
  const db = new DatabaseSync(storePath);
  const foreignWorkspace = 'ws_not_this_lane';
  const row = db.prepare('SELECT * FROM workspaces LIMIT 1').get() as Record<string, unknown>;
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO workspaces (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
    .run(...cols.map((c) => (c === 'workspace_id' ? foreignWorkspace : row[c] as never)));
  const mutation = db.prepare("SELECT * FROM mutations WHERE state='PENDING_APPROVAL' LIMIT 1").get() as Record<string, unknown>;
  const mcols = Object.keys(mutation);
  db.prepare(`INSERT INTO mutations (${mcols.join(',')}) VALUES (${mcols.map(() => '?').join(',')})`)
    .run(...mcols.map((c) => (
      c === 'mutation_id' ? 'mut_foreign'
        : c === 'workspace_id' ? foreignWorkspace
          : mutation[c] as never)));
  db.close();

  const operator = await lane.serveOperator();
  const { cookie, csrf } = await bootstrap(operator);

  const list = await (await fetch(`${operator.origin}/`, { headers: { cookie } })).text();
  assert.equal(list.includes('mut_foreign'), false, 'a record from another workspace is not offered');

  const approve = await fetch(`${operator.origin}/mutations/mut_foreign/approve`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, origin: operator.origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }).toString(),
  });
  assert.notEqual(approve.status, 303, 'and approving it directly is refused too');
});

test('approval re-derives the workspace, not just its id', async (t) => {
  // `assertOwnRecord` has two arms. The id comparison is covered; this is the second — the one
  // the lane receipt has claimed since fabd369 was covered, and which would pass deleted.
  const parent = await mkdtemp(join(tmpdir(), 'wag-loop-'));
  const lane = await createHarnessLane({
    lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, reviewTtlMs: 60_000,
  });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  await lane.writeFixture('ticket-id.js', BEFORE);
  const proposed = await lane.propose({ path: 'ticket-id.js', before: BEFORE, after: AFTER });

  // Repoint the lane's own workspace at somewhere else. The record's workspace_id still matches,
  // so only the re-derivation arm can catch this.
  const storePath = join(resolve(parent), 'lane', 'harness-lane.sqlite');
  const db = new DatabaseSync(storePath);
  db.prepare('UPDATE workspaces SET canonical_root = ? WHERE workspace_id = ?')
    .run(join(resolve(parent), 'elsewhere'), lane.workspaceId);
  db.close();

  await assert.rejects(lane.approve(proposed.mutationId), /does not resolve to this lane fixture/i);
  assert.equal(await lane.readFixture('ticket-id.js'), BEFORE);
});

test('the clock only moves forward', async (t) => {
  const lane = await openLane(t);
  assert.throws(() => lane.advanceClock(-1), /only moves forward/);
  assert.throws(() => lane.advanceClock(Number.NaN), /only moves forward/);
  assert.throws(() => lane.advanceClock(Number.POSITIVE_INFINITY), /only moves forward/);
});

test('the lane is still excluded from the shipped build', async () => {
  // ADR-0027 condition 7. It held only because a line in tsconfig.build.json says so, and
  // nothing failed if that line were deleted — which is how the lane shipped into dist/ once
  // already, before af5f14b removed it.
  const config = JSON.parse(await readFile(new URL('../tsconfig.build.json', import.meta.url), 'utf8')) as {
    exclude?: string[];
  };
  assert.ok(config.exclude?.includes('src/harness-authority.ts'),
    'a test-only authority surface must not land in dist/ beside the production modules');
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
