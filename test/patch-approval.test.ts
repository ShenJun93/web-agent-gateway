import assert from 'node:assert/strict';
import test from 'node:test';
import { PatchApprovalStore } from '../src/patch-approval.js';

const fingerprint = 'a'.repeat(64);
const summary = { path: 'note.txt', additions: 1, removals: 1 };

test('patch approval rejects invalid or overlong TTL and non-finite clock values', () => {
  assert.throws(() => new PatchApprovalStore({ ttlMs: 0 }), /TTL/);
  assert.throws(() => new PatchApprovalStore({ ttlMs: 60_001 }), /TTL/);
  assert.throws(() => new PatchApprovalStore({ ttlMs: Number.POSITIVE_INFINITY }), /TTL/);

  const store = new PatchApprovalStore({ now: () => Number.NaN });
  assert.throws(() => store.createPending({ fingerprint, summary }), /clock/);
});

test('patch approval pending authority expires exactly at its deadline', () => {
  let now = 7_000;
  const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => now });
  const pending = store.createPending({ fingerprint, summary });
  now = pending.pendingExpiresAt;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), false);
  assert.equal(store.get(pending.approvalId), undefined);
});

test('patch approval requires local approval and is single-use', () => {
  let now = 1_000;
  const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => now });
  const pending = store.createPending({ fingerprint, summary });

  assert.equal(store.consume(pending.approvalId, fingerprint), false);
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), true);
  assert.equal(store.consume(pending.approvalId, fingerprint), true);
  assert.equal(store.consume(pending.approvalId, fingerprint), false);
  now += 1;
});

test('patch approval rejects fingerprint mismatch and expiry', () => {
  let now = 2_000;
  const store = new PatchApprovalStore({ ttlMs: 500, now: () => now });
  const pending = store.createPending({ fingerprint, summary });
  assert.equal(store.approveLocal(pending.approvalId, 'b'.repeat(64)), false);
  now = pending.expiresAt + 1;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), false);
  assert.deepEqual(store.listPending(), []);
});

test('patch approval revoke removes the request and list output is bounded', () => {
  const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => 3_000 });
  const first = store.createPending({ fingerprint, summary });
  const second = store.createPending({ fingerprint: 'c'.repeat(64), summary: { path: 'other.txt', additions: 2, removals: 0 } });

  assert.deepEqual(store.listPending(1), [{
    approvalId: first.approvalId,
    fingerprint,
    expiresAt: first.expiresAt,
    pendingExpiresAt: first.pendingExpiresAt,
    summary,
    approved: false,
  }]);
  assert.equal(store.revoke(first.approvalId), true);
  assert.equal(store.revoke(first.approvalId), false);
  assert.equal(store.listPending().length, 1);
  assert.equal(store.listPending()[0]?.approvalId, second.approvalId);
});

test('patch approval starts a fresh approved-use window without rewriting pending expiry', () => {
  let now = 1_000;
  const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => now });
  const pending = store.createPending({ fingerprint, summary });
  assert.equal(pending.pendingExpiresAt, 2_000);
  assert.equal(pending.expiresAt, 2_000);

  now = 1_999;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), true);
  const approved = store.get(pending.approvalId);
  assert.ok(approved);
  assert.equal(approved.pendingExpiresAt, 2_000);
  assert.equal(approved.expiresAt, 2_000);
  assert.equal(approved.approvedAt, 1_999);
  assert.equal(approved.approvedExpiresAt, 2_999);

  now = 2_001;
  assert.equal(store.consume(pending.approvalId, fingerprint), true);
});

test('patch approval re-approval is idempotent and never extends approved authority', () => {
  let now = 4_000;
  const store = new PatchApprovalStore({ ttlMs: 1_000, now: () => now });
  const pending = store.createPending({ fingerprint, summary });
  now = 4_500;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), true);
  const first = store.get(pending.approvalId);
  assert.ok(first);

  now = 5_000;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), true);
  const repeated = store.get(pending.approvalId);
  assert.ok(repeated);
  assert.equal(repeated.approvedAt, first.approvedAt);
  assert.equal(repeated.approvedExpiresAt, first.approvedExpiresAt);

  now = 5_500;
  assert.equal(store.approveLocal(pending.approvalId, fingerprint), false);
  assert.equal(store.consume(pending.approvalId, fingerprint), false);
});
