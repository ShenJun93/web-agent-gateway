import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import {
  createSandboxPort,
  type SandboxProfile,
} from '../src/sandbox-harness/sandbox-port.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_sandbox_negative',
  sessionId: 'session_sandbox_negative',
  adapterId: 'private.stdio.v1',
};

const PROFILE: SandboxProfile = {
  profileId: 'bounded',
  minimumIsolation: 'container',
  workspaceMode: 'read-only',
  network: { denyByDefault: true, allowedHosts: [], allowUdp: false },
  credentialIds: [],
  maxRunMs: 1000,
  maxOutputBytes: 1024,
  requireWorkspaceScope: true,
  requirePrivateProcessNamespace: true,
};

function portWithResult(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}) {
  return createSandboxPort({
    profileResolver: { async resolve() { return PROFILE; } },
    workspaceResolver: {
      async resolve() {
        return {
          workspaceId: 'workspace_negative',
          root: 'E:\\Projects\\negative',
          identityToken: 'negative-fingerprint',
        };
      },
    },
    backend: {
      async describeCapabilities() {
        return {
          isolation: 'microvm' as const,
          networkPolicyEnforced: true,
          hostCredentialInjection: true,
          workspaceScopeEnforced: true,
          privateProcessNamespace: true,
        };
      },
      async open() {
        return {
          async exec() { return result; },
          async close() {},
        };
      },
    },
    effectAllowed: () => true,
    randomUUID: () => '00000000-0000-4000-8000-000000000099',
  });
}

test('SandboxPort independently enforces output ceiling on backend results', async () => {
  const port = portWithResult({
    exitCode: 0,
    stdout: 'x'.repeat(1025),
    stderr: '',
    timedOut: false,
  });
  const opened = await port.open(OWNER, {
    profileId: 'bounded',
    workspaceId: 'workspace_negative',
  });
  await assert.rejects(
    () => port.exec(OWNER, opened.sandboxSessionId, { argv: ['tool'] }),
    /exceeded output limit/,
  );
});

test('SandboxPort rejects malformed backend execution metadata', async () => {
  const port = portWithResult({
    exitCode: 999,
    stdout: '',
    stderr: '',
    timedOut: false,
  });
  const opened = await port.open(OWNER, {
    profileId: 'bounded',
    workspaceId: 'workspace_negative',
  });
  await assert.rejects(
    () => port.exec(OWNER, opened.sandboxSessionId, { argv: ['tool'] }),
    /invalid exit code/,
  );
});
