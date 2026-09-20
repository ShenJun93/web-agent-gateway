import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveVerifyProfile } from '../src/verify-profile.js';
import { VERIFY_ALLOWED_ENV_KEYS, VERIFY_TREE_KILL_GRACE_MS } from '../src/verify-runner.js';

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

/**
 * The command used to be `set "DEVSPACE_OAUTH_OWNER_TOKEN=" && set "NODE_ENV=test" && node
 * verify.mjs` — a shell string whose safety rested entirely on a character class, and which
 * scrubbed exactly one inherited secret. It is now a base64url envelope around WAG's own runner,
 * so the argv and the profile environment are data rather than syntax.
 */
test('the verify command carries argv and environment as data, not as shell syntax', async () => {
  const resolved = resolveVerifyProfile({ argv: ['node', 'verify.mjs'], env: { NODE_ENV: 'test' } });
  // The stub is `node -e "<program>"`; everything after its closing quote is the payload.
  const parts = resolved.command.slice(resolved.command.indexOf('" ') + 2).split(' ');

  assert.equal(parts.length, 2, 'the runner and its payload, nothing else');
  for (const encoded of parts) {
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, 'every argument must be base64url');
  }
  assert.equal(resolved.command.includes('&&'), false, 'no shell chaining');
  assert.equal(resolved.command.includes('verify.mjs'), false, 'the argv must not appear as syntax');
  assert.equal(resolved.command.includes('NODE_ENV'), false, 'the profile env must not appear as syntax');

  const { gunzipSync } = await import('node:zlib');
  const payload = JSON.parse(gunzipSync(Buffer.from(parts[1]!, 'base64url')).toString('utf8')) as {
    argv: string[]; env: Record<string, string>; treeKillAfterMs: number;
  };
  assert.deepEqual(payload.argv, ['node', 'verify.mjs']);
  assert.deepEqual(payload.env, { NODE_ENV: 'test' });
  assert.equal(payload.treeKillAfterMs, resolved.timeoutMs + VERIFY_TREE_KILL_GRACE_MS,
    'the tree-kill deadline sits after the executor yield, so it changes no reported outcome');

  const runner = gunzipSync(Buffer.from(parts[0]!, 'base64url')).toString('utf8');
  for (const key of ['DEVSPACE_OAUTH_OWNER_TOKEN', 'NODE_OPTIONS']) {
    assert.equal(VERIFY_ALLOWED_ENV_KEYS.includes(key), false, `${key} must never be inherited`);
    assert.equal(runner.includes(key), false, `${key} must not appear in the runner at all`);
  }
  assert.ok(runner.includes('taskkill'), 'cancellation must reap the process tree');
});
/**
 * Drives the real runner program with a short deadline, so the descendant cleanup is exercised
 * rather than asserted from its source. Cancellation used to be a Ctrl+C, which does not reap a
 * process tree: a grandchild outlived the job.
 */
test('the runner reaps the whole process tree, and leaves unrelated processes alone', async (t) => {
  const { gunzipSync, gzipSync } = await import('node:zlib');
  const { spawn } = await import('node:child_process');
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const scratch = await mkdtemp(join(tmpdir(), 'wag-verify-tree-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const resolved = resolveVerifyProfile({ argv: ['node', 'child.js'] });
  const runnerSource = gunzipSync(Buffer.from(
    resolved.command.slice(resolved.command.indexOf('" ') + 2).split(' ')[0]!, 'base64url',
  )).toString('utf8');
  await writeFile(join(scratch, 'runner.js'), runnerSource);

  const grandchildPid = join(scratch, 'grandchild.pid');
  await writeFile(join(scratch, 'grandchild.js'), [
    `require('fs').writeFileSync(${JSON.stringify(grandchildPid)}, String(process.pid));`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  await writeFile(join(scratch, 'child.js'), [
    "const { spawn } = require('child_process');",
    "spawn(process.execPath, ['grandchild.js'], { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  // An unrelated long-running process the runner must not touch.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => bystander.kill());

  const payload = gzipSync(Buffer.from(JSON.stringify({
    argv: ['node', 'child.js'], env: {}, treeKillAfterMs: 1_500,
  }), 'utf8')).toString('base64url');

  // Run as a file: argv[2] is the payload either way, because the real form is
  // .
  // Run as a file rather than through the stub: either way the payload is argv[2], because the
  // production form is `node -e <stub> <runner> <payload>`.
  const exitCode = await new Promise<number>((resolve) => {
    const runner = spawn(process.execPath, [join(scratch, 'runner.js'), payload], {
      cwd: scratch, stdio: 'ignore', windowsHide: true,
    });
    runner.on('exit', (code) => resolve(code ?? -1));
  });
  assert.equal(exitCode, 124, 'the runner exits with its deadline code');

  const pid = Number((await readFile(grandchildPid, 'utf8')).trim());
  assert.ok(Number.isInteger(pid) && pid > 0, 'the grandchild must have recorded its pid');
  // Signal 0 probes liveness without delivering anything.
  assert.throws(() => process.kill(pid, 0), 'the grandchild must have been reaped with the tree');
  assert.doesNotThrow(() => process.kill(bystander.pid!, 0), 'an unrelated process must survive');
});
