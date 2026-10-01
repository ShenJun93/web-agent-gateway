import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createSandboxPort,
  type SandboxBackend,
  type SandboxBackendCapabilities,
  type SandboxProfile,
  type SandboxWorkspaceIdentity,
} from '../src/sandbox-harness/sandbox-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_sandbox',
  sessionId: 'session_sandbox',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_sandbox',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};

const PROFILE: SandboxProfile = {
  profileId: 'untrusted-code',
  minimumIsolation: 'microvm',
  workspaceMode: 'read-write',
  network: {
    denyByDefault: true,
    allowedHosts: ['registry.npmjs.org:443', 'api.github.com'],
    allowUdp: false,
  },
  credentialIds: ['github'],
  maxRunMs: 5000,
  maxOutputBytes: 4096,
  requireWorkspaceScope: true,
  requirePrivateProcessNamespace: true,
};

const WORKSPACE: SandboxWorkspaceIdentity = {
  workspaceId: 'workspace_owned',
  root: 'E:\\Projects\\owned',
  identityToken: 'workspace-fingerprint-1',
};

const MICROVM: SandboxBackendCapabilities = {
  isolation: 'microvm',
  networkPolicyEnforced: true,
  hostCredentialInjection: true,
  workspaceScopeEnforced: true,
  privateProcessNamespace: true,
};

function fixture(capabilities: SandboxBackendCapabilities = MICROVM) {
  let profile: SandboxProfile = PROFILE;
  let workspace: SandboxWorkspaceIdentity = WORKSPACE;
  let allowed = true;
  let closed = 0;
  const plans: unknown[] = [];
  const execs: unknown[] = [];

  const backend: SandboxBackend = {
    async describeCapabilities() { return capabilities; },
    async open(plan) {
      plans.push(plan);
      return {
        async exec(request) {
          execs.push(request);
          return {
            exitCode: 0,
            stdout: 'sandbox-ok',
            stderr: '',
            timedOut: false,
          };
        },
        async close() { closed += 1; },
      };
    },
  };

  let n = 1;
  const port = createSandboxPort({
    profileResolver: {
      async resolve(owner, profileId) {
        if (owner.sessionId !== OWNER.sessionId) throw new Error('profile not owned');
        if (profileId !== profile.profileId) throw new Error('profile not found');
        return profile;
      },
    },
    workspaceResolver: {
      async resolve(owner, workspaceId) {
        if (owner.sessionId !== OWNER.sessionId) throw new Error('workspace not owned');
        if (workspaceId !== workspace.workspaceId) throw new Error('workspace not found');
        return workspace;
      },
    },
    backend,
    effectAllowed: () => allowed,
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });

  return {
    port,
    plans,
    execs,
    closed: () => closed,
    setAllowed(value: boolean) { allowed = value; },
    setProfile(value: SandboxProfile) { profile = value; },
    setWorkspace(value: SandboxWorkspaceIdentity) { workspace = value; },
  };
}

test('SandboxPort opens an attested microVM plan without credential values and owns it by exact authority', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, {
    profileId: 'untrusted-code',
    workspaceId: 'workspace_owned',
  });

  assert.equal(opened.sandboxSessionId, 'sandbox_00000000-0000-4000-8000-000000000001');
  assert.equal(opened.state, 'ACTIVE');
  assert.equal(opened.backendCapabilities.isolation, 'microvm');
  assert.deepEqual(opened.profile.network.allowedHosts, [
    'api.github.com',
    'registry.npmjs.org:443',
  ]);
  assert.deepEqual(opened.profile.credentialIds, ['github']);
  assert.equal(JSON.stringify(f.plans).includes('secret'), false);
  assert.equal(JSON.stringify(f.plans).includes('token'), false);

  await assert.rejects(
    () => f.port.describe(OTHER, opened.sandboxSessionId),
    /another authority/,
  );
  await assert.rejects(
    () => f.port.open(OWNER, {
      profileId: 'untrusted-code',
      workspaceId: 'workspace_owned',
    }),
    /already has an active session/,
  );
});

test('SandboxPort rejects a backend below required isolation before backend open', async () => {
  const f = fixture({
    ...MICROVM,
    isolation: 'container',
  });

  await assert.rejects(
    () => f.port.open(OWNER, {
      profileId: 'untrusted-code',
      workspaceId: 'workspace_owned',
    }),
    /does not satisfy required isolation/,
  );
  assert.equal(f.plans.length, 0);
});

test('SandboxPort requires host credential injection and declared containment capabilities', async () => {
  for (const [capabilities, pattern] of [
    [{ ...MICROVM, hostCredentialInjection: false }, /keep credentials host-side/],
    [{ ...MICROVM, networkPolicyEnforced: false }, /does not enforce network policy/],
    [{ ...MICROVM, workspaceScopeEnforced: false }, /does not enforce workspace scope/],
    [{ ...MICROVM, privateProcessNamespace: false }, /private process namespace/],
  ] as const) {
    const f = fixture(capabilities);
    await assert.rejects(
      () => f.port.open(OWNER, {
        profileId: 'untrusted-code',
        workspaceId: 'workspace_owned',
      }),
      pattern,
    );
    assert.equal(f.plans.length, 0);
  }
});

test('SandboxPort v1 rejects open-network, UDP and wildcard host profiles', async () => {
  for (const profile of [
    {
      ...PROFILE,
      network: { ...PROFILE.network, denyByDefault: false },
    },
    {
      ...PROFILE,
      network: { ...PROFILE.network, allowUdp: true },
    },
    {
      ...PROFILE,
      network: { ...PROFILE.network, allowedHosts: ['*.example.com'] },
    },
  ] as unknown as SandboxProfile[]) {
    const f = fixture();
    f.setProfile(profile);
    await assert.rejects(
      () => f.port.open(OWNER, {
        profileId: 'untrusted-code',
        workspaceId: 'workspace_owned',
      }),
      /(deny-by-default|network host is invalid)/,
    );
    assert.equal(f.plans.length, 0);
  }
});

test('SandboxPort revalidates workspace identity and profile before every exec', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, {
    profileId: 'untrusted-code',
    workspaceId: 'workspace_owned',
  });

  f.setWorkspace({
    ...WORKSPACE,
    identityToken: 'workspace-replaced',
  });
  await assert.rejects(
    () => f.port.exec(OWNER, opened.sandboxSessionId, {
      argv: ['npm', 'test'],
    }),
    /workspace identity changed/,
  );
  assert.equal(f.execs.length, 0);
});

test('SandboxPort validates argv, relative cwd, timeout and backend output ceiling', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, {
    profileId: 'untrusted-code',
    workspaceId: 'workspace_owned',
  });

  assert.deepEqual(
    await f.port.exec(OWNER, opened.sandboxSessionId, {
      argv: ['npm', 'test'],
      cwdRelative: 'packages/core',
      timeoutMs: 1000,
    }),
    { exitCode: 0, stdout: 'sandbox-ok', stderr: '', timedOut: false },
  );
  assert.deepEqual(f.execs[0], {
    argv: ['npm', 'test'],
    cwdRelative: 'packages/core',
    timeoutMs: 1000,
    maxOutputBytes: 4096,
  });

  for (const request of [
    { argv: [] as string[] },
    { argv: ['npm'], cwdRelative: '../escape' },
    { argv: ['npm'], cwdRelative: 'C:\\escape' },
    { argv: ['npm'], timeoutMs: 6000 },
  ]) {
    await assert.rejects(
      () => f.port.exec(OWNER, opened.sandboxSessionId, request),
      /(argv is invalid|workspace-relative|timeout is invalid)/,
    );
  }
});

test('SandboxPort effect revocation blocks exec but never blocks owned cleanup', async () => {
  const f = fixture();
  const opened = await f.port.open(OWNER, {
    profileId: 'untrusted-code',
    workspaceId: 'workspace_owned',
  });
  f.setAllowed(false);

  await assert.rejects(
    () => f.port.exec(OWNER, opened.sandboxSessionId, { argv: ['node', '--version'] }),
    /execution denied/,
  );
  const closed = await f.port.close(OWNER, opened.sandboxSessionId);
  assert.equal(closed.state, 'CLOSED');
  assert.equal(f.closed(), 1);
});

test('SandboxPort reserves profile/workspace while async open is in flight', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const backend: SandboxBackend = {
    async describeCapabilities() { return MICROVM; },
    async open() {
      await gate;
      return {
        async exec() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
        async close() {},
      };
    },
  };
  let n = 30;
  const port = createSandboxPort({
    profileResolver: { async resolve() { return PROFILE; } },
    workspaceResolver: { async resolve() { return WORKSPACE; } },
    backend,
    effectAllowed: () => true,
    randomUUID: () => `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  });

  const first = port.open(OWNER, {
    profileId: 'untrusted-code',
    workspaceId: 'workspace_owned',
  });
  await assert.rejects(
    () => port.open(OWNER, {
      profileId: 'untrusted-code',
      workspaceId: 'workspace_owned',
    }),
    /already has an active session/,
  );
  release();
  assert.equal((await first).state, 'ACTIVE');
});

test('SandboxPort closes a just-opened backend if authority changes before admission completes', async () => {
  let profile = PROFILE;
  let resolveCount = 0;
  let closed = 0;
  const port = createSandboxPort({
    profileResolver: {
      async resolve() {
        resolveCount += 1;
        if (resolveCount >= 2) {
          profile = { ...PROFILE, maxRunMs: 4000 };
        }
        return profile;
      },
    },
    workspaceResolver: { async resolve() { return WORKSPACE; } },
    backend: {
      async describeCapabilities() { return MICROVM; },
      async open() {
        return {
          async exec() { return { exitCode: 0, stdout: '', stderr: '', timedOut: false }; },
          async close() { closed += 1; },
        };
      },
    },
    effectAllowed: () => true,
  });

  await assert.rejects(
    () => port.open(OWNER, {
      profileId: 'untrusted-code',
      workspaceId: 'workspace_owned',
    }),
    /authority changed during open/,
  );
  assert.equal(closed, 1);
});
