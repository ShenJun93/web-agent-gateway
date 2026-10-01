import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { harnessEffectCorrelationFromError } from '../src/effect-correlation.js';
import { HarnessEffectCoordinator } from '../src/harness-effect-coordinator.js';
import { HarnessEffectLedger } from '../src/harness-effect-ledger.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_coord', sessionId: 'session_coord', adapterId: 'private.stdio.v1' };
const PLAN = {
  kind: 'browser.notebook.submit',
  resourceId: 'browser:notebook99',
  arguments: { promptTag: 'RUN-0119-N99-RAW-H3-20260924-A1' },
} as const;

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-effect-coord-'));
  const file = join(dir, 'state.sqlite');
  let n = 70;
  const ledger = new HarnessEffectLedger(file, {
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });
  const coordinator = new HarnessEffectCoordinator(ledger);
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ledger, coordinator };
}

test('coordinator executes a confirmed effect once and returns the durable result on retry', async (t) => {
  const { coordinator } = await fixture(t);
  let executions = 0;
  const execute = async () => {
    executions += 1;
    return { status: 'CONFIRMED_SUCCESS' as const, resultDigest: 'persisted-tag:1' };
  };

  const first = await coordinator.execute(OWNER, 'RUN-0119-N99-RAW-H3-20260924-A1', PLAN, execute);
  const retry = await coordinator.execute(OWNER, 'RUN-0119-N99-RAW-H3-20260924-A1', PLAN, execute);
  assert.equal(first.state, 'SUCCEEDED');
  assert.equal(retry.effectId, first.effectId);
  assert.equal(retry.resultDigest, 'persisted-tag:1');
  assert.equal(executions, 1);
});

test('executor throw is outcome-unknown, carries recovery correlation, and never blindly replays', async (t) => {
  const { ledger, coordinator } = await fixture(t);
  let executions = 0;
  let thrown: unknown;
  try {
    await coordinator.execute(OWNER, 'key-throw', PLAN, async () => {
      executions += 1;
      throw new Error('connection lost after submit');
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Error);
  assert.match(thrown.message, /connection lost after submit/);

  const effect = ledger.reserve(OWNER, 'key-throw', PLAN);
  const correlation = harnessEffectCorrelationFromError(thrown);
  assert.equal(correlation?.effectId, effect.effectId);
  assert.equal(correlation?.attemptId, effect.attemptId);
  assert.equal(effect.state, 'OUTCOME_UNKNOWN');
  assert.equal(effect.errorClass, 'EXECUTOR_THROW');

  await assert.rejects(
    () => coordinator.execute(OWNER, 'key-throw', PLAN, async () => {
      executions += 1;
      return { status: 'CONFIRMED_SUCCESS' as const, resultDigest: 'should-not-run' };
    }),
    /not claimable from OUTCOME_UNKNOWN/,
  );
  assert.equal(executions, 1);

  assert.equal(ledger.confirmSuccess(OWNER, effect.effectId, 'persisted-tag:1').state, 'SUCCEEDED');
});

test('coordinator records explicit no-effect separately from uncertain effects', async (t) => {
  const { coordinator } = await fixture(t);
  const noEffect = await coordinator.execute(OWNER, 'key-before-submit', PLAN, async () => ({
    status: 'NO_EFFECT',
    errorClass: 'TARGET_NOT_FOUND',
  }));
  assert.equal(noEffect.state, 'FAILED_NO_EFFECT');

  const unknown = await coordinator.execute(OWNER, 'key-after-submit', {
    ...PLAN,
    resourceId: 'browser:notebook99:2',
  }, async () => ({
    status: 'OUTCOME_UNKNOWN',
    errorClass: 'RESPONSE_LOST',
  }));
  assert.equal(unknown.state, 'OUTCOME_UNKNOWN');
});
