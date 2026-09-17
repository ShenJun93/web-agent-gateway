import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeTicketId } from '../src/lib/ticket-id.js';

test('normalizes outer whitespace and case', () => {
  assert.equal(canonicalizeTicketId('  AbC-123  '), 'abc-123');
});

test('preserves internal ticket punctuation', () => {
  assert.equal(canonicalizeTicketId('XYZ-9'), 'xyz-9');
});
