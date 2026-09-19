import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PRIVATE_STDIO_OWNER_ID, loadPrivateGatewayConfig } from '../src/private-config.js';

async function writeConfig(root: string, name: string, value: unknown): Promise<string> {
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value, null, 2));
  return path;
}

function baseConfig(allowedRoot: string) {
  return {
    allowedRoots: [allowedRoot],
    devspace: { baseUrl: 'http://127.0.0.1:7676', resourceUrl: 'http://127.0.0.1:7676/mcp' },
    verifyProfiles: { unit: { argv: ['npm', 'test'], timeoutMs: 30_000, maxOutputTokens: 4_000 } },
  };
}

test('repository engineering config is absent by default and cannot be implied', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const loaded = await loadPrivateGatewayConfig(await writeConfig(root, 'default.json', baseConfig(root)));
  assert.equal(loaded.repositoryEngineering, undefined,
    'an unconfigured gateway must expose no repository-engineering capability');
});

test('repository engineering search defaults to false and is an explicit local opt-in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const implicit = await loadPrivateGatewayConfig(await writeConfig(root, 'implicit.json', {
    ...baseConfig(root), repositoryEngineering: {},
  }));
  assert.equal(implicit.repositoryEngineering?.search, false);
  assert.equal(implicit.repositoryEngineering?.mutation, undefined);

  const explicit = await loadPrivateGatewayConfig(await writeConfig(root, 'explicit.json', {
    ...baseConfig(root), repositoryEngineering: { search: true },
  }));
  assert.equal(explicit.repositoryEngineering?.search, true);
  assert.equal(explicit.repositoryEngineering?.mutation, undefined);
});

test('repository engineering mutation requires an absolute state path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'relative.json', {
    ...baseConfig(root),
    repositoryEngineering: { search: true, mutation: { statePath: 'state/control-plane.sqlite' } },
  })), /absolute/i);

  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'missing.json', {
    ...baseConfig(root),
    repositoryEngineering: { search: true, mutation: {} },
  })), /statePath|invalid|required|expected/i);

  const statePath = join(root, 'state', 'control-plane.sqlite');
  const loaded = await loadPrivateGatewayConfig(await writeConfig(root, 'absolute.json', {
    ...baseConfig(root), repositoryEngineering: { mutation: { statePath } },
  }));
  assert.equal(loaded.repositoryEngineering?.mutation?.statePath, statePath);
  assert.equal(loaded.repositoryEngineering?.search, false,
    'enabling mutation must not implicitly enable search');
});

test('repository engineering owner id defaults locally and rejects unsafe values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.sqlite');

  const defaulted = await loadPrivateGatewayConfig(await writeConfig(root, 'default-owner.json', {
    ...baseConfig(root), repositoryEngineering: { mutation: { statePath } },
  }));
  assert.equal(defaulted.repositoryEngineering?.mutation?.ownerId, DEFAULT_PRIVATE_STDIO_OWNER_ID);

  for (const ownerId of ['has space', 'has/slash', '', 'a'.repeat(129), 'quote"inject']) {
    await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'bad-owner.json', {
      ...baseConfig(root), repositoryEngineering: { mutation: { statePath, ownerId } },
    })), `owner id ${JSON.stringify(ownerId)} must be rejected`);
  }

  const custom = await loadPrivateGatewayConfig(await writeConfig(root, 'custom-owner.json', {
    ...baseConfig(root), repositoryEngineering: { mutation: { statePath, ownerId: 'local.owner-2' } },
  }));
  assert.equal(custom.repositoryEngineering?.mutation?.ownerId, 'local.owner-2');
});

test('repository engineering config stays strict so no key silently grants capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-strict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = join(root, 'state.sqlite');

  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'unknown-top.json', {
    ...baseConfig(root), repositoryEngineering: { search: true, shell: true },
  })), /unrecognized|unknown/i);

  await assert.rejects(async () => loadPrivateGatewayConfig(await writeConfig(root, 'unknown-mutation.json', {
    ...baseConfig(root),
    repositoryEngineering: { mutation: { statePath, autoApprove: true } },
  })), /unrecognized|unknown/i);
});

test('existing private config behavior is unchanged by the repository engineering block', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-dc-config-compat-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const loaded = await loadPrivateGatewayConfig(await writeConfig(root, 'compat.json', {
    ...baseConfig(root),
    browserVerifyProfiles: ['unit'],
    repositoryEngineering: { search: true, mutation: { statePath: join(root, 'state.sqlite') } },
  }));
  assert.deepEqual(loaded.allowedRoots, [root]);
  assert.deepEqual(loaded.browserVerifyProfiles, ['unit']);
  assert.deepEqual(loaded.verifyProfiles.unit.argv, ['npm', 'test']);
  assert.equal(loaded.devspace.resourceUrl, 'http://127.0.0.1:7676/mcp');
});
