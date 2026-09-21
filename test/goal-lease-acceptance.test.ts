import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHarnessLane, HARNESS_LANE, type HarnessLane } from '../src/harness-authority.js';
import type { LeaseDenialCode } from '../src/goal-lease.js';

/**
 * Autonomous Goal Lease v1, end to end (ADR-0028).
 *
 * These are the acceptance criteria, run against the real coordinator and the real durable store
 * through the fixture lane — so a full admit-and-execute cycle happens here with no Run and no
 * Approve, which is the whole point, while production's human path is asserted untouched.
 */
const enabled = { ...process.env, WAG_HARNESS_LANE: '1' };
const BEFORE = 'export const id = (raw) => String(raw).trim();\n';
const AFTER = 'export const id = (raw) => String(raw ?? "").trim();\n';

async function openLane(t: { after(fn: () => void | Promise<void>): void }, options: {
  reviewTtlMs?: number;
} = {}): Promise<HarnessLane> {
  const parent = await mkdtemp(join(tmpdir(), 'wag-lease-'));
  const lane = await createHarnessLane({
    lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, reviewTtlMs: 60_000, ...options,
  });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  return lane;
}

const codeOf = (decision: Awaited<ReturnType<HarnessLane['admitUnderLease']>>): LeaseDenialCode => {
  assert.equal(decision.admitted, false, 'expected a denial');
  return (decision as { code: LeaseDenialCode }).code;
};

test('an autonomous mutation cycle completes with no Run and no Approve', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('src/ticket-id.ts', BEFORE);
  const leaseId = await lane.grantLease({ pathPatterns: ['src/**/*.ts'] });

  const proposed = await lane.propose({ path: 'src/ticket-id.ts', before: BEFORE, after: AFTER });
  assert.equal(await lane.readFixture('src/ticket-id.ts'), BEFORE, 'proposing still changes nothing');

  const decision = await lane.admitUnderLease(leaseId, proposed.mutationId);
  assert.deepEqual(decision, { admitted: true });

  // The effect happened, and the bytes are the reviewed bytes.
  assert.equal(await lane.readFixture('src/ticket-id.ts'), AFTER);
  const authority = lane.authorityOf(proposed.mutationId);
  assert.equal(authority?.authority, 'POLICY_APPROVED');
  assert.equal(authority?.leaseId, leaseId);
  assert.equal(authority?.resultSha256, proposed.resultSha256);
});

test('the durable record distinguishes POLICY_APPROVED from HUMAN_APPROVED', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  await lane.writeFixture('b.txt', 'one\n');

  // Human path: the same approval the operator's button reaches.
  const human = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(await lane.approve(human.mutationId), true);

  // Policy path.
  const leaseId = await lane.grantLease();
  const policy = await lane.propose({ path: 'b.txt', before: 'one', after: 'two' });
  assert.deepEqual(await lane.admitUnderLease(leaseId, policy.mutationId), { admitted: true });

  assert.equal(lane.authorityOf(human.mutationId)?.authority, 'HUMAN_APPROVED');
  assert.equal(lane.authorityOf(human.mutationId)?.leaseId, undefined,
    'a human approval is bound to no lease');
  assert.equal(lane.authorityOf(policy.mutationId)?.authority, 'POLICY_APPROVED');
  assert.equal(lane.authorityOf(policy.mutationId)?.leaseId, leaseId);

  // Both executed, so the distinction is not an artefact of one having failed.
  assert.equal(await lane.readFixture('a.txt'), 'two\n');
  assert.equal(await lane.readFixture('b.txt'), 'two\n');
});

test('an out-of-scope file is denied and nothing is written', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('src/ok.ts', BEFORE);
  await lane.writeFixture('secrets.env', 'KEY=1\n');
  const leaseId = await lane.grantLease({ pathPatterns: ['src/**/*.ts'] });

  const outside = await lane.propose({ path: 'secrets.env', before: 'KEY=1', after: 'KEY=2' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, outside.mutationId)), 'PATH_NOT_GRANTED');
  assert.equal(await lane.readFixture('secrets.env'), 'KEY=1\n', 'the denied file is untouched');
  assert.equal(lane.authorityOf(outside.mutationId), undefined, 'and it carries no authority row');
});

test('an out-of-scope tool is denied', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  // A lease that grants only a tool this coordinator never uses.
  const leaseId = await lane.grantLease({ allowedTools: ['git.commit'] });
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, proposed.mutationId)), 'TOOL_NOT_GRANTED');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('an expired lease is denied', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease({ ttlMs: 5_000 });
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  lane.advanceClock(5_001);
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, proposed.mutationId)), 'LEASE_EXPIRED');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('a lease that is not yet valid is denied', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease({ notBeforeMs: 10_000 });
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, proposed.mutationId)), 'LEASE_NOT_YET_VALID');
});

test('a revoked lease is denied, and revocation is one-way', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease();
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  assert.equal(await lane.revokeLease(leaseId), true);
  assert.equal(await lane.revokeLease(leaseId), false, 'revoking twice is idempotent, not a toggle');
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, proposed.mutationId)), 'LEASE_REVOKED');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('the kill switch stops admission immediately, without touching the lease', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  await lane.writeFixture('b.txt', 'one\n');
  const leaseId = await lane.grantLease();

  lane.setKillSwitch(true);
  const blocked = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, blocked.mutationId)), 'KILL_SWITCH_ENGAGED');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');

  // Still a valid lease underneath: the switch is a stop, not a revocation.
  lane.setKillSwitch(false);
  const allowed = await lane.propose({ path: 'b.txt', before: 'one', after: 'two' });
  assert.deepEqual(await lane.admitUnderLease(leaseId, allowed.mutationId), { admitted: true });
});

test('a wrong session or adapter is denied even with a valid lease', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  const wrongSession = await lane.grantLease({ admittedSessions: ['session_somebody_else'] });
  assert.equal(codeOf(await lane.admitUnderLease(wrongSession, proposed.mutationId)), 'SESSION_NOT_ADMITTED');

  const wrongAdapter = await lane.grantLease({ admittedAdapters: ['browser.chatgpt.native.verify.v3'] });
  assert.equal(codeOf(await lane.admitUnderLease(wrongAdapter, proposed.mutationId)), 'ADAPTER_NOT_ADMITTED');

  const wrongRoot = await lane.grantLease({ workspaceRoots: ['E:/not/this/lane'] });
  assert.equal(codeOf(await lane.admitUnderLease(wrongRoot, proposed.mutationId)), 'WORKSPACE_NOT_GRANTED');

  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('budgets are enforced across the lease, not per request', async (t) => {
  const lane = await openLane(t);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await lane.writeFixture(name, 'one\n');
  const leaseId = await lane.grantLease({ maxFiles: 2 });

  for (const name of ['a.txt', 'b.txt']) {
    const p = await lane.propose({ path: name, before: 'one', after: 'two' });
    assert.deepEqual(await lane.admitUnderLease(leaseId, p.mutationId), { admitted: true }, name);
  }
  const third = await lane.propose({ path: 'c.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, third.mutationId)), 'FILE_BUDGET_EXHAUSTED');
  assert.equal(await lane.readFixture('c.txt'), 'one\n');
});

test('a lease cannot authorize edits to its own authority files', async (t) => {
  const lane = await openLane(t);
  const leaseId = await lane.grantLease({ pathPatterns: ['**'] });
  for (const path of ['.claude/settings.json', 'AGENTS.md', 'docs/adr/0026-x.md']) {
    await lane.writeFixture(path, 'one\n');
    const proposed = await lane.propose({ path, before: 'one', after: 'two' });
    assert.equal(codeOf(await lane.admitUnderLease(leaseId, proposed.mutationId)),
      'AUTHORITY_FILE_PROTECTED', path);
    assert.equal(await lane.readFixture(path), 'one\n', `${path} untouched`);
  }
});

test('one lane cannot admit another lane record, so leases do not cross sessions', async (t) => {
  const a = await openLane(t);
  const b = await openLane(t);
  await a.writeFixture('a.txt', 'one\n');
  await b.writeFixture('a.txt', 'one\n');

  const leaseA = await a.grantLease();
  const inB = await b.propose({ path: 'a.txt', before: 'one', after: 'two' });

  // A's lease, B's record: A's store has never heard of it.
  await assert.rejects(a.admitUnderLease(leaseA, inB.mutationId), /no such record in this lane/i);
  assert.equal(await b.readFixture('a.txt'), 'one\n');
});

test('a restart does not widen a lease: the expiry and revocation survive', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  await lane.writeFixture('b.txt', 'one\n');

  const revoked = await lane.grantLease();
  await lane.revokeLease(revoked);
  const expiring = await lane.grantLease({ ttlMs: 5_000 });
  lane.advanceClock(5_001);

  await lane.reopen();

  const p1 = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(revoked, p1.mutationId)), 'LEASE_REVOKED');
  const p2 = await lane.propose({ path: 'b.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(expiring, p2.mutationId)), 'LEASE_EXPIRED');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
  assert.equal(await lane.readFixture('b.txt'), 'one\n');
});

test('spend survives a restart, so a restart cannot refill a budget', async (t) => {
  const lane = await openLane(t);
  for (const name of ['a.txt', 'b.txt']) await lane.writeFixture(name, 'one\n');
  const leaseId = await lane.grantLease({ maxFiles: 1 });

  const first = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.deepEqual(await lane.admitUnderLease(leaseId, first.mutationId), { admitted: true });

  await lane.reopen();

  const second = await lane.propose({ path: 'b.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, second.mutationId)), 'FILE_BUDGET_EXHAUSTED');
  assert.equal(await lane.readFixture('b.txt'), 'one\n');
});

test('an unknown lease id is denied rather than treated as unrestricted', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.equal(codeOf(await lane.admitUnderLease('lease_does_not_exist', proposed.mutationId)), 'NO_LEASE');
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('an already-admitted record cannot be admitted twice', async (t) => {
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease();
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  assert.deepEqual(await lane.admitUnderLease(leaseId, proposed.mutationId), { admitted: true });
  await lane.writeFixture('a.txt', 'tampered\n');
  const replay = await lane.admitUnderLease(leaseId, proposed.mutationId);
  assert.equal(replay.admitted, false, 'the record is no longer awaiting review');
  assert.equal(await lane.readFixture('a.txt'), 'tampered\n', 'and nothing was rewritten');
});

test('the human path still works when no lease is configured at all', async (t) => {
  // Production's manual mode, unchanged. No lease is granted in this test.
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  assert.equal(codeOf(await lane.admitUnderLease('', proposed.mutationId)), 'NO_LEASE',
    'with no lease, autonomous admission refuses');
  assert.equal(await lane.approve(proposed.mutationId), true, 'and the human approval still works');
  assert.equal(await lane.readFixture('a.txt'), 'two\n');
  assert.equal(lane.authorityOf(proposed.mutationId)?.authority, 'HUMAN_APPROVED');
});
