import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateBrowserSemanticConditions } from '../src/browser-harness/browser-semantic-condition.js';
import type { BrowserMcpSnapshot } from '../src/browser-harness/browser-mcp-runtime.js';

const SNAPSHOT: BrowserMcpSnapshot = {
  snapshotId: '00000000-0000-4000-8000-000000000201',
  browserSessionId: 'browser_00000000-0000-4000-8000-000000000202',
  url: 'https://studio.example.test/upload/42',
  title: 'Video processing',
  nodes: [{
    ref: 'node_00000000-0000-4000-8000-000000000201_0',
    role: 'status',
    name: 'Checks complete',
    value: 'Ready',
    disabled: false,
    editable: false,
    focusable: false,
  }],
  truncated: false,
};

test('semantic condition engine supports all/any URL, title and node predicates', () => {
  const all = evaluateBrowserSemanticConditions(SNAPSHOT, [
    { kind: 'url', operator: 'contains', value: '/upload/' },
    { kind: 'title', operator: 'equals', value: 'video PROCESSING', ignoreCase: true },
    { kind: 'node', role: 'status', name: 'checks COMPLETE', value: 'ready', ignoreCase: true },
  ], 'all');
  assert.equal(all.matched, true);
  assert.equal(all.results.length, 3);
  assert.equal(all.results[2]?.evidence?.ref, SNAPSHOT.nodes[0]?.ref);

  const any = evaluateBrowserSemanticConditions(SNAPSHOT, [
    { kind: 'node', name: 'Saving' },
    { kind: 'node', name: 'Checks complete' },
  ], 'any');
  assert.equal(any.matched, true);
});

test('semantic condition engine supports explicit absence without selector or script execution', () => {
  const absent = evaluateBrowserSemanticConditions(SNAPSHOT, [
    { kind: 'node', name: 'Processing failed', present: false },
  ]);
  assert.equal(absent.matched, true);

  const present = evaluateBrowserSemanticConditions(SNAPSHOT, [
    { kind: 'node', name: 'Checks complete', present: false },
  ]);
  assert.equal(present.matched, false);
  assert.equal(present.results[0]?.evidence?.name, 'Checks complete');
});

test('semantic condition engine fails closed on empty or predicate-free conditions', () => {
  assert.throws(() => evaluateBrowserSemanticConditions(SNAPSHOT, []), /condition count/i);
  assert.throws(
    () => evaluateBrowserSemanticConditions(SNAPSHOT, [{ kind: 'node' }]),
    /requires at least one predicate/i,
  );
});
