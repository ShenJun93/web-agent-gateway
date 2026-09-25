import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createFileBrowserProfileStore,
  createMemoryBrowserProfileStore,
} from '../src/browser-harness/browser-profile-store.js';

const OWNER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_a', adapterId: 'private.stdio.v1' };
const OTHER: GatewayAuthority = { ownerId: 'owner_a', sessionId: 'session_b', adapterId: 'private.stdio.v1' };

test('memory profile store keeps persistent authority ownership after active release', async () => {
  const store = createMemoryBrowserProfileStore();
  const first = await store.acquire('profile_a', OWNER);
  await assert.rejects(() => store.acquire('profile_a', OWNER), /already active/);
  await store.release(first, OWNER);
  assert.equal((await store.acquire('profile_a', OWNER)).profileId, 'profile_a');
  await assert.rejects(() => store.acquire('profile_a', OTHER), /another authority/);
});

test('file profile store writes canonical browser-policy OWNER.json and reopens only for same authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileBrowserProfileStore({ root, now: () => 1234 });
  const first = await store.acquire('notebook99', OWNER);
  const profilePath = join(root, 'notebook99');
  assert.equal(first.userDataDir, profilePath);
  const owner = JSON.parse(await readFile(join(profilePath, 'OWNER.json'), 'utf8')) as {
    version: number;
    profileId: string;
    owner: GatewayAuthority;
    createdAt: number;
    session: string;
    caller: string;
    purpose: string;
    created_at: string;
    profile_path: string;
  };
  assert.deepEqual(owner, {
    version: 1,
    profileId: 'notebook99',
    owner: OWNER,
    createdAt: 1234,
    session: 'notebook99',
    caller: 'owner_a/session_a/private.stdio.v1',
    purpose: 'WAG BrowserPort dedicated profile',
    created_at: '1970-01-01T00:00:01.234Z',
    profile_path: profilePath,
  });
  await store.release(first, OWNER);

  const reopened = await store.acquire('notebook99', OWNER);
  assert.equal(reopened.userDataDir, first.userDataDir);
  await store.release(reopened, OWNER);

  await assert.rejects(() => store.acquire('notebook99', OTHER), /another authority/);
});

test('profile ids cannot escape the configured profile root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'wag-browser-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createFileBrowserProfileStore({ root });
  for (const profileId of ['../escape', 'x/y', 'x\\y', '', ' '.repeat(2)]) {
    await assert.rejects(() => store.acquire(profileId, OWNER), /profile id is invalid/);
  }
});
