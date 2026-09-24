import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { HarnessEffectLedger } from '../src/harness-effect-ledger.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_fx', sessionId: 'session_fx', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_fx', sessionId: 'session_other', adapterId: 'private.stdio.v1' };
const PLAN = {
  kind: 'browser.notebook.submit',
  resourceId: 'browser:notebook99',
  arguments: { promptTag: 'RUN-0119-N99-RAW-H3-20260924-A1', notebook: '99' },
} as const;

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'wag-effect-ledger-'));
  const file = join(dir, 'effects.sqlite');
  return { dir, file };
}

test('same idempotency key and same plan returns the same durable effect while a different plan conflicts', async (t) => {
  const { file, dir } = await fixture();
  let n = 1;
  const ledger = new HarnessEffectLedger(file, {
    now: () => 1000,
    randomUUID: () => `00000000-0000-4000-8000-00000000010${n++}`,
  });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });

  const first = ledger.reserve(OWNER, 'RUN-0119-N99-RAW-H3-20260924-A1', PLAN);
  const second = ledger.reserve(OWNER, 'RUN-0119-N99-RAW-H3-20260924-A1', PLAN);
  assert.equal(second.effectId, first.effectId);
  assert.equal(second.planFingerprint, first.planFingerprint);
  assert.throws(() => ledger.reserve(OWNER, 'RUN-0119-N99-RAW-H3-20260924-A1', {
    ...PLAN,
    arguments: { ...PLAN.arguments, notebook: 'different' },
  }), /conflicts with a different effect plan/);
});

test('claim is exact-once and foreign authority cannot observe or claim the effect', async (t) => {
  const { file, dir } = await fixture();
  let n = 10;
  const ledger = new HarnessEffectLedger(file, {
    randomUUID: () => `00000000-0000-4000-8000-0000000001${n++}`,
  });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });

  const effect = ledger.reserve(OWNER, 'key-1', PLAN);
  assert.throws(() => ledger.get(OTHER, effect.effectId), /not owned/);
  const claimed = ledger.claim(OWNER, effect.effectId);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.record.state, 'EXECUTING');
  assert.match(claimed.record.attemptId!, /^attempt_/);
  assert.throws(() => ledger.claim(OWNER, effect.effectId), /not claimable from EXECUTING/);
});

test('a succeeded effect is idempotent and cannot change its result digest', async (t) => {
  const { file, dir } = await fixture();
  let n = 20;
  const ledger = new HarnessEffectLedger(file, {
    randomUUID: () => `00000000-0000-4000-8000-0000000002${n++}`,
  });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });

  const effect = ledger.reserve(OWNER, 'key-success', PLAN);
  ledger.claim(OWNER, effect.effectId);
  const done = ledger.confirmSuccess(OWNER, effect.effectId, 'sha256:verified-once');
  assert.equal(done.state, 'SUCCEEDED');
  assert.equal(done.resultDigest, 'sha256:verified-once');
  assert.deepEqual(ledger.claim(OWNER, effect.effectId), { claimed: false, record: done });
  assert.equal(ledger.confirmSuccess(OWNER, effect.effectId, 'sha256:verified-once').state, 'SUCCEEDED');
  assert.throws(
    () => ledger.confirmSuccess(OWNER, effect.effectId, 'sha256:different'),
    /success digest conflicts/,
  );
});

test('restart reconciliation turns EXECUTING into OUTCOME_UNKNOWN and blocks blind replay', async (t) => {
  const { file, dir } = await fixture();
  let n = 30;
  const first = new HarnessEffectLedger(file, {
    randomUUID: () => `00000000-0000-4000-8000-0000000003${n++}`,
  });
  const effect = first.reserve(OWNER, 'key-restart', PLAN);
  first.claim(OWNER, effect.effectId);
  first.close();

  const second = new HarnessEffectLedger(file);
  t.after(async () => { second.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal(second.reconcileExecuting(), 1);
  const unknown = second.get(OWNER, effect.effectId);
  assert.equal(unknown.state, 'OUTCOME_UNKNOWN');
  assert.equal(unknown.errorClass, 'RUNTIME_RESTART');
  assert.throws(() => second.claim(OWNER, effect.effectId), /not claimable from OUTCOME_UNKNOWN/);

  const confirmed = second.confirmSuccess(OWNER, effect.effectId, 'persisted-tag:1');
  assert.equal(confirmed.state, 'SUCCEEDED');
  assert.equal(confirmed.resultDigest, 'persisted-tag:1');
});

test('known no-effect failure and unknown outcome are distinct terminal evidence', async (t) => {
  const { file, dir } = await fixture();
  let n = 40;
  const ledger = new HarnessEffectLedger(file, {
    randomUUID: () => `00000000-0000-4000-8000-0000000004${n++}`,
  });
  t.after(async () => { ledger.close(); await rm(dir, { recursive: true, force: true }); });

  const noEffect = ledger.reserve(OWNER, 'key-no-effect', PLAN);
  ledger.claim(OWNER, noEffect.effectId);
  assert.equal(ledger.failNoEffect(OWNER, noEffect.effectId, 'BEFORE_SUBMIT').state, 'FAILED_NO_EFFECT');

  const unknown = ledger.reserve(OWNER, 'key-unknown', { ...PLAN, resourceId: 'browser:notebook99:2' });
  ledger.claim(OWNER, unknown.effectId);
  assert.equal(ledger.markOutcomeUnknown(OWNER, unknown.effectId, 'CONNECTION_LOST_AFTER_SUBMIT').state, 'OUTCOME_UNKNOWN');
});
