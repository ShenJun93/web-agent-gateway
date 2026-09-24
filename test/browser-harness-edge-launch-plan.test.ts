import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import { createEdgeCdpLaunchPlan } from '../src/browser-harness/edge-launch-plan.js';

const OWNER: GatewayAuthority = { ownerId: 'owner', sessionId: 'session', adapterId: 'private.stdio.v1' };
const profile = {
  profileId: 'notebook99',
  owner: OWNER,
  userDataDir: 'E:\\AI-BROWSER\\profiles\\notebook99',
};

test('Edge launch plan always binds CDP to a dedicated custom profile and loopback endpoint', () => {
  const plan = createEdgeCdpLaunchPlan({
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    profile,
    debugPort: 9333,
    initialUrl: 'https://notebooklm.google.com/',
    extraArgs: ['--disable-background-networking'],
  });
  assert.equal(plan.endpointUrl, 'http://127.0.0.1:9333');
  assert.equal(plan.userDataDir, profile.userDataDir);
  assert.deepEqual(plan.argv, [
    '--user-data-dir=E:\\AI-BROWSER\\profiles\\notebook99',
    '--remote-debugging-port=9333',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    'https://notebooklm.google.com/',
  ]);
});

test('Edge launch plan refuses missing dedicated profile and caller overrides of authority-sensitive flags', () => {
  assert.throws(() => createEdgeCdpLaunchPlan({
    executablePath: 'C:\\Edge\\msedge.exe',
    profile: { profileId: 'p', owner: OWNER },
    debugPort: 9333,
  }), /dedicated profile directory/);

  for (const argument of [
    '--user-data-dir=C:\\other',
    '--remote-debugging-port=9444',
    '--remote-debugging-pipe',
  ]) {
    assert.throws(() => createEdgeCdpLaunchPlan({
      executablePath: 'C:\\Edge\\msedge.exe',
      profile,
      debugPort: 9333,
      extraArgs: [argument],
    }), /argument is reserved/);
  }
});

test('Edge launch plan rejects relative executables and invalid debug ports', () => {
  assert.throws(() => createEdgeCdpLaunchPlan({
    executablePath: 'msedge.exe',
    profile,
    debugPort: 9333,
  }), /must be absolute/);

  for (const debugPort of [0, 80, 65536, 9222.5]) {
    assert.throws(() => createEdgeCdpLaunchPlan({
      executablePath: 'C:\\Edge\\msedge.exe',
      profile,
      debugPort,
    }), /CDP port/);
  }
});
