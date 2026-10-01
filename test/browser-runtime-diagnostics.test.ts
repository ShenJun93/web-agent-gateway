import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BrowserRuntimeDiagnostics } from '../src/browser-harness/browser-runtime-diagnostics.js';

const SESSION = 'browser_00000000-0000-4000-8000-000000000801';

test('browser diagnostics retains only bounded safe metadata and never secret-bearing content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-diagnostics-'));
  const statePath = join(root, 'browser-diagnostics.json');
  let wall = 1_700_000_000_000;
  let mono = 10;
  const diagnostics = new BrowserRuntimeDiagnostics({
    capacity: 16,
    statePath,
    now: () => wall,
    monotonicNow: () => mono,
  });
  t.after(() => rm(root, { recursive: true, force: true }));

  const finish = diagnostics.begin({
    actionType: 'fill',
    browserSessionId: SESSION,
    targetId: 'tab_7',
    ownershipMode: 'ATTACHED_EXISTING',
  });
  mono += 12.5;
  finish(
    false,
    new TypeError(
      'password=hunter2 token=secret https://example.test/private?code=oauth form=private-value',
    ),
    { targetId: 'tab_8', targetChanged: true },
  );

  const recent = diagnostics.recent({ limit: 10 });
  assert.equal(recent.events.length, 1);
  assert.deepEqual(recent.events[0], {
    sequence: 1,
    started_at_utc: new Date(wall).toISOString(),
    duration_ms: 12.5,
    action_type: 'fill',
    success: false,
    browser_session_id: SESSION,
    target_id: 'tab_8',
    ownership_mode: 'ATTACHED_EXISTING',
    error_class: 'TypeError',
    target_changed: true,
    recovered: false,
  });

  const serialized = await readFile(statePath, 'utf8');
  for (const forbidden of [
    'hunter2',
    'secret',
    'example.test',
    'oauth',
    'private-value',
    'password=',
    'token=',
    'form=',
  ]) {
    assert.equal(serialized.includes(forbidden), false, 'diagnostics leaked ' + forbidden);
  }
});

test('browser diagnostics ring is bounded, restart-persistent and ignores malformed state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-diagnostics-ring-'));
  const statePath = join(root, 'browser-diagnostics.json');
  t.after(() => rm(root, { recursive: true, force: true }));

  let diagnostics = new BrowserRuntimeDiagnostics({ capacity: 16, statePath });
  for (let index = 0; index < 20; index += 1) {
    diagnostics.begin({
      actionType: index % 2 === 0 ? 'snapshot' : 'click',
      browserSessionId: SESSION,
      targetId: 'tab_7',
      ownershipMode: 'ATTACHED_EXISTING',
    })(true);
  }
  assert.equal(diagnostics.recent({ limit: 100 }).events.length, 16);
  assert.equal(diagnostics.recent({ limit: 100 }).events[0]?.sequence, 5);

  diagnostics = new BrowserRuntimeDiagnostics({ capacity: 16, statePath });
  assert.equal(diagnostics.recent({ limit: 100 }).events.length, 16);
  diagnostics.begin({ actionType: 'recover', browserSessionId: SESSION, recovered: true })(true);
  const usage = diagnostics.usage();
  assert.equal(usage.total, 16);
  assert.equal(usage.recovered, 1);

  await writeFile(statePath, JSON.stringify({
    version: 1,
    next_sequence: 2,
    events: [{
      sequence: 1,
      started_at_utc: new Date().toISOString(),
      duration_ms: 1,
      action_type: 'fill',
      success: true,
      browser_session_id: SESSION,
      target_id: 'tab_7',
      ownership_mode: 'ATTACHED_EXISTING',
      target_changed: false,
      recovered: false,
      page_text: 'must-never-be-accepted',
    }],
  }));
  const malformed = new BrowserRuntimeDiagnostics({ capacity: 16, statePath });
  assert.deepEqual(malformed.recent().events, []);
});
