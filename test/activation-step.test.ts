import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SCRIPT = 'scripts/promote-autonomous-runtime.ts';

test('autonomous runtime promotion has no per-goal authority or rollover path', async () => {
  const source = await readFile(SCRIPT, 'utf8');

  for (const forbidden of [
    '--approve-multi-workspace',
    '--preview-rollover',
    '--apply-rollover',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden + ' must not exist in runtime promotion');
  }

  for (const required of [
    '--promote-current',
    '--prepare-runtime',
    '--activate-prepared-runtime',
    '--activate-prepared-runtime-worker',
    'RUNTIME.json',
    'rollback',
    'fileURLToPath(import.meta.url)',
  ]) {
    assert.equal(source.includes(required), true, required + ' must remain in runtime promotion');
  }
  for (const supportFile of [
    'scripts/wag-local-doctor.ps1',
    'scripts/wag-local-product-health.ps1',
    'docs/benchmarks/devspace-pin.json',
    'packaging/runtime-package-lock.json',
  ]) {
    assert.equal(source.includes(supportFile), true, supportFile + ' must ship in every promoted runtime');
  }

  assert.equal(
    source.includes('claude-autonomous-wag-harness-v1'),
    false,
    'runtime promotion must bind to the checkout containing the helper, not a historical worktree',
  );
});

test('promotion CLI fails closed before touching the machine when mode selection is invalid', () => {
  const none = spawnSync(
    process.execPath,
    ['--import', 'tsx', SCRIPT],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(none.status, 0);
  assert.match(String(none.stderr), /Choose exactly one mode/);

  const malformed = spawnSync(
    process.execPath,
    ['--import', 'tsx', SCRIPT, '--prepare-runtime', 'not-a-head'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.notEqual(malformed.status, 0);
  assert.match(String(malformed.stderr), /40-hex source HEAD/);
});
