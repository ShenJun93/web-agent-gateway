import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVerifyProfile } from '../src/verify-profile.js';

test('verify profile normalization is deterministic and locks effective defaults', () => {
  const a = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { B: '2', A: '1' } });
  const b = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { A: '1', B: '2' } });
  assert.equal(a.planSha256, b.planSha256);
  assert.match(a.planSha256, /^[a-f0-9]{64}$/);
  assert.equal(a.timeoutMs, 10_000);
  assert.equal(a.maxOutputTokens, 4_000);
  assert.equal(a.resumeQueuedAfterRestart, false);
  assert.deepEqual(a.env, { A: '1', B: '2' });
});

test('restart resume policy participates in the durable plan hash', () => {
  const disabled = resolveVerifyProfile({ argv: ['node', 'verify.mjs'] });
  const enabled = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], resumeQueuedAfterRestart: true });
  assert.notEqual(disabled.planSha256, enabled.planSha256);
  assert.equal(enabled.resumeQueuedAfterRestart, true);
});
test('verify profile clamps execution bounds and rejects unsafe argv or env', () => {
  const bounded = resolveVerifyProfile({
    argv: ['node', 'verify.mjs'], timeoutMs: 1, maxOutputTokens: 99_999,
  });
  assert.equal(bounded.timeoutMs, 100);
  assert.equal(bounded.maxOutputTokens, 10_000);
  assert.throws(() => resolveVerifyProfile({ argv: [] }), /Invalid verify profile argv/);
  assert.throws(() => resolveVerifyProfile({ argv: Array.from({ length: 17 }, () => 'x') }), /Invalid verify profile argv/);
  assert.throws(() => resolveVerifyProfile({ argv: ['node', 'bad arg'] }), /Invalid verify profile argv/);
  assert.throws(() => resolveVerifyProfile({ argv: ['node'], env: { API_KEY: 'secret' } }), /Invalid verify profile env/);
  assert.throws(() => resolveVerifyProfile({ argv: ['node'], env: { 'BAD-KEY': 'x' } }), /Invalid verify profile env/);
});

test('verify command keeps the owner token scrub and trusted env assignment', () => {
  const resolved = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { NODE_ENV: 'test' } });
  assert.match(resolved.command, /DEVSPACE_OAUTH_OWNER_TOKEN/);
  assert.match(resolved.command, /NODE_ENV/);
  assert.match(resolved.command, /node verify\.mjs/);
});