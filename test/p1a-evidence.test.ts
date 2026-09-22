import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  appendRecord, assertNoSecrets, readRecords, summarize, type P1ATaskRecord,
} from '../scripts/p1a-evidence.js';

/**
 * The recorder's job is to be harder to fool than a notes file. These tests are about the two
 * ways a measurement quietly stops being one: a gesture count that defaults to zero, and a
 * receipt that carries a credential to whoever reads it.
 */
const BASE: P1ATaskRecord = {
  taskId: 't01',
  goal: 'find every caller of ticketId',
  surface: 'browser.chatgpt.native.operator.v4',
  tools: ['repo.search'],
  success: true,
  dcFallback: false,
  humanRun: 1,
  humanApprove: 0,
  reconnectNeeded: false,
  elapsedMs: 4210,
  unexpectedRepair: false,
  recordedAt: '2026-09-21T13:00:00.000Z',
};

async function logPath(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'p1a-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'evidence.jsonl');
}

test('a complete record round-trips', async (t) => {
  const path = await logPath(t);
  appendRecord(path, BASE);
  appendRecord(path, { ...BASE, taskId: 't02', elapsedMs: 900 });
  const records = readRecords(path);
  assert.equal(records.length, 2);
  assert.equal(records[0]?.taskId, 't01');
  assert.equal(records[1]?.elapsedMs, 900);
});

test('gesture counts must be stated, not defaulted', () => {
  // The failure this prevents: a task that needed a human Run recorded as needing none, because
  // the field was simply absent and something helpfully filled in zero.
  for (const field of ['humanRun', 'humanApprove', 'elapsedMs'] as const) {
    const incomplete = { ...BASE };
    delete (incomplete as Record<string, unknown>)[field];
    assert.throws(() => appendRecord('unused', incomplete as P1ATaskRecord),
      new RegExp(`requires ${field}`), `${field} must be required`);
  }
  assert.throws(() => appendRecord('unused', { ...BASE, humanRun: -1 }), /non-negative/);
  assert.throws(() => appendRecord('unused', { ...BASE, humanRun: 1.5 }), /integer/);
});

test('a Desktop Commander fallback must say why WAG could not do it', () => {
  assert.throws(
    () => appendRecord('unused', { ...BASE, dcFallback: true }),
    /must record why/,
    'an unexplained fallback is the one that gets forgotten when the receipt is written',
  );
  // With a reason it is accepted: the fallback is permitted, it is being *measured*.
  assert.doesNotThrow(() => {
    const record = { ...BASE, dcFallback: true, dcReason: 'no WAG tool lists a directory tree' };
    assertNoSecrets(record);
  });
});

test('a record carrying anything credential-shaped is refused', () => {
  const cases: Array<[string, Partial<P1ATaskRecord>]> = [
    ['an operator url file', { goal: 'open browser-operator-v4.sqlite.operator-url' }],
    ['a token parameter', { goal: 'visited http://127.0.0.1:5000/bootstrap?token=abcdef0123456789' }],
    ['a session cookie', { repairNote: 'sent wag_operator_session=deadbeefdeadbeef' }],
    ['the devspace token', { repairNote: 'DEVSPACE_OAUTH_OWNER_TOKEN=some-long-value' }],
    ['a private key', { goal: '-----BEGIN RSA PRIVATE KEY-----' }],
    ['a csrf value', { repairNote: 'csrf: 9f8a7b6c5d4e3f2a1b' }],
  ];
  for (const [what, patch] of cases) {
    assert.throws(() => assertNoSecrets({ ...BASE, ...patch } as P1ATaskRecord),
      /evidence refused/, `${what} must be refused`);
  }
  // An identifier is not a secret: workspace and request ids are exactly what receipts need.
  assert.doesNotThrow(() => assertNoSecrets({
    ...BASE,
    identifiers: { workspaceId: 'ws_0d613571-e66f-478c-9428-d120d3edb3ea', requestId: 'req_12ab' },
  }));
});

test('the summary counts what happened and refuses to infer the rest', () => {
  const records: P1ATaskRecord[] = [];
  for (let i = 1; i <= 10; i += 1) {
    records.push({ ...BASE, taskId: `t${String(i).padStart(2, '0')}`, humanRun: 1, elapsedMs: i * 100 });
  }
  const summary = summarize(records);
  assert.equal(summary.distinctTasks, 10);
  assert.equal(summary.withoutDcFallback, 10);
  assert.equal(summary.totalHumanRun, 10, 'every gesture is counted');
  assert.equal(summary.totalHumanApprove, 0);

  const byId = new Map(summary.criteria.map((c) => [c.id, c]));
  assert.equal(byId.get(1)?.met, true, '10 distinct tasks');
  assert.equal(byId.get(2)?.met, true, 'no DC fallback');
  assert.equal(byId.get(4)?.met, true, 'no anomalies recorded');
  assert.equal(byId.get(5)?.met, true, 'no reconnects');

  // 3 and 6 are judgements a human makes from the evidence. Reporting them as met because
  // nothing contradicted them is how a measurement becomes a rubber stamp.
  assert.equal(byId.get(3)?.met, false);
  assert.equal(byId.get(6)?.met, false);
  assert.match(byId.get(3)?.measured ?? '', /human judgement/);
  assert.equal(summary.passes, false, 'the tool never reports an overall pass by itself');
});

test('one Desktop Commander fallback in ten still meets criterion 2; two does not', () => {
  const ten = Array.from({ length: 10 }, (_, i) => ({
    ...BASE, taskId: `t${i}`, dcFallback: false,
  }));
  const withOne = [...ten];
  withOne[0] = { ...ten[0]!, dcFallback: true, dcReason: 'no WAG tool for this' };
  assert.equal(summarize(withOne).criteria.find((c) => c.id === 2)?.met, true, '9 of 10 is the bar');

  const withTwo = [...withOne];
  withTwo[1] = { ...ten[1]!, dcFallback: true, dcReason: 'no WAG tool for this either' };
  assert.equal(summarize(withTwo).criteria.find((c) => c.id === 2)?.met, false);
});

test('a security anomaly fails criterion 4 outright, whatever else passed', () => {
  const records = Array.from({ length: 10 }, (_, i) => ({ ...BASE, taskId: `t${i}` }));
  records[3] = { ...records[3]!, securityAnomaly: 'a workspace id from another session was accepted' };
  const summary = summarize(records);
  assert.equal(summary.securityAnomalies, 1);
  assert.equal(summary.criteria.find((c) => c.id === 4)?.met, false);
});

test('an empty log passes nothing', () => {
  const summary = summarize([]);
  assert.equal(summary.passes, false);
  for (const criterion of summary.criteria) {
    assert.equal(criterion.met, false, `criterion ${criterion.id} must not pass on no evidence`);
  }
});
