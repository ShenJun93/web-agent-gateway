import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { HarnessEffectCoordinator } from '../src/harness-effect-coordinator.js';
import { HarnessEffectLedger } from '../src/harness-effect-ledger.js';
import {
  createNotebook99Acceptance,
  type Notebook99Driver,
} from '../src/browser-harness/notebook99-acceptance.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_n99', sessionId: 'session_n99', adapterId: 'private.stdio.v1' };
const SOURCES = ['Registry', 'EntryPoint', 'Eval', 'World'] as const;
const REQUEST = {
  browserSessionId: 'browser_00000000-0000-4000-8000-000000000099',
  idempotencyKey: 'RUN-0119-N99-RAW-H3-20260924-A1',
  promptTag: 'RUN-0119-N99-RAW-H3-20260924-A1',
  prompt: 'Run raw H3 for Registry + EntryPoint + Eval + World.',
  expectedSources: SOURCES,
} as const;

async function fixture(t: test.TestContext, driver: Notebook99Driver) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-notebook99-'));
  let n = 200;
  const ledger = new HarnessEffectLedger(join(dir, 'effects.sqlite'), {
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });
  const effects = new HarnessEffectCoordinator(ledger);
  const acceptance = createNotebook99Acceptance({ effects, driver });
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { ledger, acceptance };
}

test('Notebook99 acceptance submits once, verifies exact persistence and reuses durable success on retry', async (t) => {
  let inspections = 0;
  let submissions = 0;
  let observations = 0;
  const submitted: string[] = [];
  const driver: Notebook99Driver = {
    async inspect() {
      inspections += 1;
      return { selectedSources: SOURCES };
    },
    async submit(_owner, _session, prompt) {
      submissions += 1;
      submitted.push(prompt);
    },
    async observeResult() {
      observations += 1;
      return { responseText: 'REGISTRY=PASS ENTRYPOINT=PASS EVAL=PASS WORLD=PASS', persistedTagCount: 1 };
    },
  };
  const { acceptance } = await fixture(t, driver);

  const first = await acceptance.run(OWNER, REQUEST);
  const retry = await acceptance.run(OWNER, REQUEST);
  assert.equal(first.state, 'SUCCEEDED');
  assert.match(first.resultDigest ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.equal(retry.effectId, first.effectId);
  assert.equal(retry.resultDigest, first.resultDigest);
  assert.equal(inspections, 1);
  assert.equal(submissions, 1);
  assert.equal(observations, 1);
  assert.match(submitted[0]!, /IDEMPOTENCY_TAG=RUN-0119-N99-RAW-H3-20260924-A1/);
});

test('Notebook99 source mismatch is a proven no-effect and never submits', async (t) => {
  let submissions = 0;
  const driver: Notebook99Driver = {
    async inspect() { return { selectedSources: ['Registry', 'EntryPoint', 'Eval'] }; },
    async submit() { submissions += 1; },
    async observeResult() { throw new Error('must not run'); },
  };
  const { acceptance } = await fixture(t, driver);
  const result = await acceptance.run(OWNER, REQUEST);
  assert.equal(result.state, 'FAILED_NO_EFFECT');
  assert.equal(result.errorClass, 'NOTEBOOK_SOURCE_TOPOLOGY_MISMATCH');
  assert.equal(submissions, 0);
});

test('Notebook99 loss after submit becomes outcome-unknown and cannot blindly replay', async (t) => {
  let submissions = 0;
  const driver: Notebook99Driver = {
    async inspect() { return { selectedSources: SOURCES }; },
    async submit() { submissions += 1; },
    async observeResult() { throw new Error('browser disconnected after submit'); },
  };
  const { acceptance } = await fixture(t, driver);
  const result = await acceptance.run(OWNER, REQUEST);
  assert.equal(result.state, 'OUTCOME_UNKNOWN');
  assert.equal(result.errorClass, 'NOTEBOOK_RESULT_OBSERVATION_FAILED');
  assert.equal(submissions, 1);

  await assert.rejects(() => acceptance.run(OWNER, REQUEST), /not claimable from OUTCOME_UNKNOWN/);
  assert.equal(submissions, 1);
});

test('Notebook99 duplicate persistence is never reported as success', async (t) => {
  const driver: Notebook99Driver = {
    async inspect() { return { selectedSources: SOURCES }; },
    async submit() {},
    async observeResult() {
      return { responseText: 'duplicate', persistedTagCount: 2 };
    },
  };
  const { acceptance } = await fixture(t, driver);
  const result = await acceptance.run(OWNER, REQUEST);
  assert.equal(result.state, 'OUTCOME_UNKNOWN');
  assert.equal(result.errorClass, 'NOTEBOOK_DUPLICATE_PERSISTENCE');
});
