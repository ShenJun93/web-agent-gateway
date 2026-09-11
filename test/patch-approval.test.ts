import assert from 'node:assert/strict';
import test from 'node:test';
import { PatchApprovalStore } from '../src/patch-approval.js';

const fingerprint = 'a'.repeat(64);
const summary = { path: 'note.txt', additions: 1, removals: 1 };

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
    summary,
    approved: false,
  }]);
  assert.equal(store.revoke(first.approvalId), true);
  assert.equal(store.revoke(first.approvalId), false);
  assert.equal(store.listPending().length, 1);
  assert.equal(store.listPending()[0]?.approvalId, second.approvalId);
});
