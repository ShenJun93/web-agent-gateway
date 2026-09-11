import assert from 'node:assert/strict';
import test from 'node:test';
import { PatchApprovalStore } from '../src/patch-approval.js';
import {
  handleApprovalLine,
  renderPendingApprovals,
} from '../scripts/file-patch-browser-spike.js';

test('browser spike approval command approves exact pending fingerprint locally', () => {
  const approvals = new PatchApprovalStore();
  const pending = approvals.createPending({
    fingerprint: 'a'.repeat(64),
    summary: { path: 'note.txt', additions: 1, removals: 1 },
  });

  const result = handleApprovalLine(`approve ${pending.approvalId} ${pending.fingerprint}`, approvals);
  assert.deepEqual(result, { status: 'approved', approvalId: pending.approvalId });
  assert.equal(approvals.consume(pending.approvalId, pending.fingerprint), true);
});

test('browser spike approval command rejects malformed and mismatched input', () => {
  const approvals = new PatchApprovalStore();
  const pending = approvals.createPending({
    fingerprint: 'b'.repeat(64),
    summary: { path: 'note.txt', additions: 1, removals: 1 },
  });

  assert.deepEqual(handleApprovalLine('approve nope', approvals), { status: 'invalid_command' });
  assert.deepEqual(
    handleApprovalLine(`approve ${pending.approvalId} ${'c'.repeat(64)}`, approvals),
    { status: 'rejected', approvalId: pending.approvalId },
  );
  assert.equal(approvals.consume(pending.approvalId, pending.fingerprint), false);
});

test('pending approval rendering is bounded and omits content and absolute roots', () => {
  const approvals = new PatchApprovalStore();
  const pending = approvals.createPending({
    fingerprint: 'd'.repeat(64),
    summary: { path: 'src/note.txt', additions: 2, removals: 1 },
  });

  const lines = renderPendingApprovals(approvals);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(pending.approvalId));
  assert.match(lines[0], /src\/note\.txt/);
  assert.match(lines[0], /"additions":2/);
  assert.doesNotMatch(lines[0], /E:\\Projects|alpha|beta|canonicalRoot/i);
  assert.ok(lines[0].length < 512);
});
