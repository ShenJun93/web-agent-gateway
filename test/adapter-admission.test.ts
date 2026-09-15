import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BrowserAdmissionRegistry, BROWSER_ADAPTER_ID } from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';

async function fixture(now = 1_000) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-admission-'));
  const path = join(dir, 'state.sqlite');
  const store = new SqliteDurableStore(path);
  const registry = new BrowserAdmissionRegistry(store, () => now);
  return { dir, path, store, registry };
}

function tokenBytes(token: string): number {
  return Buffer.from(token, 'base64url').byteLength;
}

test('same correlation reuses WAG session while rotating the bearer', async (t) => {
  const f = await fixture();
  t.after(async () => { f.registry.close(); f.store.close(); await rm(f.dir, { recursive: true, force: true }); });

  const first = f.registry.admit('session_corr_A');
  const rotated = f.registry.admit('session_corr_A');

  assert.equal(first.callerContext.adapterId, BROWSER_ADAPTER_ID);
  assert.equal(first.callerContext.sessionId, rotated.callerContext.sessionId);
  assert.notEqual(first.mcpToken, rotated.mcpToken);
  assert.equal(tokenBytes(first.mcpToken), 32);
  assert.equal(tokenBytes(rotated.mcpToken), 32);
  assert.equal(f.registry.resolveMcpToken(first.mcpToken), undefined);
  assert.equal(f.registry.resolveMcpToken(rotated.mcpToken)?.sessionId, first.callerContext.sessionId);
});

test('different correlations receive isolated WAG sessions', async (t) => {
  const f = await fixture();
  t.after(async () => { f.registry.close(); f.store.close(); await rm(f.dir, { recursive: true, force: true }); });

  const a = f.registry.admit('session_corr_A');
  const b = f.registry.admit('session_corr_B');

  assert.notEqual(a.callerContext.sessionId, b.callerContext.sessionId);
  assert.equal(a.callerContext.ownerId, b.callerContext.ownerId);
  assert.equal(a.callerContext.adapterId, BROWSER_ADAPTER_ID);
  assert.equal(b.callerContext.adapterId, BROWSER_ADAPTER_ID);
  assert.equal(f.registry.resolveMcpToken(a.mcpToken)?.sessionId, a.callerContext.sessionId);
  assert.equal(f.registry.resolveMcpToken(b.mcpToken)?.sessionId, b.callerContext.sessionId);
});

test('release and close invalidate only in-memory credentials', async (t) => {
  const f = await fixture();
  t.after(async () => { f.store.close(); await rm(f.dir, { recursive: true, force: true }); });

  const a = f.registry.admit('session_corr_A');
  const b = f.registry.admit('session_corr_B');
  assert.equal(f.registry.releaseMcpToken(a.mcpToken), true);
  assert.equal(f.registry.releaseMcpToken(a.mcpToken), false);
  assert.equal(f.registry.resolveMcpToken(a.mcpToken), undefined);
  assert.equal(f.registry.resolveMcpToken(b.mcpToken)?.sessionId, b.callerContext.sessionId);

  f.registry.close();
  assert.equal(f.registry.resolveMcpToken(b.mcpToken), undefined);

  const reopened = new BrowserAdmissionRegistry(f.store, () => 2_000);
  t.after(() => reopened.close());
  const recovered = reopened.admit('session_corr_B');
  assert.equal(recovered.callerContext.sessionId, b.callerContext.sessionId);
  assert.notEqual(recovered.mcpToken, b.mcpToken);
});

test('correlation validation rejects values outside the v1 browser envelope', async (t) => {
  const f = await fixture();
  t.after(async () => { f.registry.close(); f.store.close(); await rm(f.dir, { recursive: true, force: true }); });

  for (const value of [
    'short',
    'a'.repeat(129),
    'session with space',
    'session_é',
  ]) {
    assert.throws(() => f.registry.admit(value));
  }
  assert.doesNotThrow(() => f.registry.admit('session_A'));
  assert.doesNotThrow(() => f.registry.admit('a'.repeat(128)));
});

test('raw correlation and session credentials are never persisted', async (t) => {
  const f = await fixture();
  t.after(async () => { await rm(f.dir, { recursive: true, force: true }); });
  const rawCorrelation = 'session_corr_secret_A';
  const admitted = f.registry.admit(rawCorrelation);
  const tokenDigest = createHash('sha256')
    .update('wag.mcp-session-token.v1\0', 'utf8')
    .update(admitted.mcpToken, 'utf8')
    .digest('hex');
  assert.doesNotMatch(JSON.stringify(admitted.callerContext), /corr_secret|correlationSha256|mcpToken/);

  f.registry.close();
  f.store.close();
  const bytes = await readFile(f.path);
  assert.equal(bytes.includes(Buffer.from(rawCorrelation, 'utf8')), false);
  assert.equal(bytes.includes(Buffer.from(admitted.mcpToken, 'utf8')), false);
  assert.equal(bytes.includes(Buffer.from(tokenDigest, 'utf8')), false);
});
