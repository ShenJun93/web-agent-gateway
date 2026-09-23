import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SqliteDurableStore } from '../src/durable-store.js';
import type { DevspaceExecutor, ExecResult } from '../src/executor/devspace.js';
import type { PrivateGatewayConfig } from '../src/private-config.js';
import {
  PRIVATE_STDIO_ADAPTER_ID,
  startRepositoryEngineeringRuntime,
} from '../src/repository-engineering-runtime.js';
import {
  workspaceIdentityFingerprint,
  type WorkspaceIdentityObservation,
} from '../src/workspace-identity.js';

test('direct command authority re-observes workspace identity after workspace.open', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-workspace-runtime-revalidation-'));
  const root = await realpath(dir);
  const statePath = join(root, 'state.sqlite');
  const ownerId = 'local.private.stdio';
  const correlation = 'session_12345678-1234-4234-8234-123456789abc';

  let observation: WorkspaceIdentityObservation = {
    canonicalRoot: root,
    backendKind: 'devspace',
    fsDevice: '100',
    fsInode: '200',
  };

  const executor = {
    async openWorkspace(_path: string): Promise<string> {
      return 'devspace_identity_runtime';
    },
    async execCommand(): Promise<ExecResult> {
      return {
        output: JSON.stringify(observation),
        exitCode: 0,
        running: false,
      };
    },
    async interruptCommand(): Promise<void> {},
  } as unknown as DevspaceExecutor;

  const config: PrivateGatewayConfig = {
    allowedRoots: [root],
    devspace: {
      baseUrl: 'http://127.0.0.1:7676',
      resourceUrl: 'http://127.0.0.1:7676/mcp',
    },
    verifyProfiles: {},
    repositoryEngineering: {
      inspect: true,
      mutation: {
        statePath,
        ownerId,
        sessionCorrelation: correlation,
      },
      gitCommit: {},
    },
  };

  const runtime = await startRepositoryEngineeringRuntime(config, {
    startOperatorServer: async () => ({
      origin: 'http://127.0.0.1:1',
      bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=x',
      close: async () => {},
    }),
  });
  t.after(async () => {
    await runtime.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  });

  await runtime.attach(executor);
  const workspaceId = runtime.openWorkspaceId!(root);
  await runtime.bindWorkspaceIdentity!(workspaceId, root, 'devspace_identity_runtime');

  const originalFingerprint = workspaceIdentityFingerprint(observation);
  const store = new SqliteDurableStore(statePath);
  try {
    const now = Date.now();
    store.insertGoalLease({
      leaseId: 'lease_workspace_identity_runtime',
      createdAt: now,
      notBefore: now - 1_000,
      expiresAt: now + 60_000,
      bindings: JSON.stringify({
        workspaceRoots: [root],
        workspaceIdentities: [{ workspaceRoot: root, fingerprint: originalFingerprint }],
        allowedTools: ['command.run'],
        pathPatterns: ['**'],
        maxFiles: 4,
        maxBytes: 10_000,
        maxDiffBytes: 4_000,
        admittedSessions: [runtime.profile.stableSessionId!],
        admittedAdapters: [PRIVATE_STDIO_ADAPTER_ID],
        commitSemantics: 'none',
      }),
    });

    await runtime.commandContext!.authorize(workspaceId);

    observation = {
      ...observation,
      fsInode: '201',
    };

    await assert.rejects(
      async () => runtime.commandContext!.authorize(workspaceId),
      /workspace identity|WORKSPACE_IDENTITY/i,
      'replacing the filesystem object at the same canonical root must invalidate command authority',
    );
  } finally {
    store.close();
  }
});
