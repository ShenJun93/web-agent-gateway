import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  evaluateGoalLease,
  validateBindings,
  type GoalLeaseBindings,
  type GoalLeaseRecord,
  type LeaseRequest,
} from '../src/goal-lease.js';
import {
  WorkspaceIdentityRegistry,
  workspaceIdentityFingerprint,
  type WorkspaceIdentityObservation,
} from '../src/workspace-identity.js';

const ROOT = 'E:/fixture/repo';
const NOW = 1_000_000;
const OBSERVATION: WorkspaceIdentityObservation = {
  canonicalRoot: ROOT,
  backendKind: 'devspace',
  fsDevice: '123',
  fsInode: '456',
  gitTopLevel: ROOT,
  gitDir: 'E:/fixture/repo/.git/worktrees/lane-a',
  gitCommonDir: 'E:/fixture/repo/.git',
};
const FINGERPRINT = workspaceIdentityFingerprint(OBSERVATION);

function bindings(identity = true): GoalLeaseBindings {
  return {
    workspaceRoots: [ROOT],
    ...(identity ? { workspaceIdentities: [{ workspaceRoot: ROOT, fingerprint: FINGERPRINT }] } : {}),
    allowedTools: ['command.run'],
    pathPatterns: ['**'],
    maxFiles: 8,
    maxBytes: 64 * 1024,
    maxDiffBytes: 8 * 1024,
    admittedSessions: ['session_a'],
    admittedAdapters: ['private.stdio.v1'],
    commitSemantics: 'none',
  };
}

function lease(value: GoalLeaseBindings): GoalLeaseRecord {
  return {
    leaseId: 'lease_identity_test',
    createdAt: NOW - 100,
    notBefore: NOW - 100,
    expiresAt: NOW + 60_000,
    bindings: value,
  };
}

function request(workspaceFingerprint?: string): LeaseRequest {
  return {
    tool: 'command.run',
    sessionId: 'session_a',
    adapterId: 'private.stdio.v1',
    workspaceRoot: ROOT,
    ...(workspaceFingerprint === undefined ? {} : { workspaceFingerprint }),
    path: '.',
    diffBytes: 0,
  };
}

test('workspace identity fingerprint binds filesystem and git worktree identity but not mutable HEAD', () => {
  assert.equal(workspaceIdentityFingerprint(OBSERVATION), FINGERPRINT);
  assert.notEqual(
    workspaceIdentityFingerprint({ ...OBSERVATION, fsInode: '457' }),
    FINGERPRINT,
  );
  assert.notEqual(
    workspaceIdentityFingerprint({ ...OBSERVATION, gitDir: 'E:/fixture/repo/.git/worktrees/lane-b' }),
    FINGERPRINT,
  );
});

test('workspace identity registry is durable and refuses identity drift for one workspace id', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-workspace-identity-'));
  const statePath = join(dir, 'state.sqlite');
  t.after(() => rm(dir, { recursive: true, force: true }));

  let registry = new WorkspaceIdentityRegistry(statePath);
  const first = registry.record('ws_identity-a', OBSERVATION, NOW);
  assert.equal(first.fingerprint, FINGERPRINT);
  registry.close();

  registry = new WorkspaceIdentityRegistry(statePath);
  assert.equal(registry.fingerprint('ws_identity-a'), FINGERPRINT);
  assert.throws(
    () => registry.record('ws_identity-a', { ...OBSERVATION, fsInode: '999' }, NOW + 1),
    /workspace identity drift/i,
  );
  registry.close();
});

test('identity-bound lease admits exact workspace fingerprint and fails closed on missing or changed identity', () => {
  const granted = evaluateGoalLease({
    lease: lease(bindings()),
    now: NOW,
    request: request(FINGERPRINT),
    spend: { filesChanged: 0, bytesWritten: 0 },
    killSwitch: false,
  });
  assert.deepEqual(granted, { admitted: true });

  for (const bad of [undefined, '0'.repeat(64)]) {
    const denied = evaluateGoalLease({
      lease: lease(bindings()),
      now: NOW,
      request: request(bad),
      spend: { filesChanged: 0, bytesWritten: 0 },
      killSwitch: false,
    });
    assert.equal(denied.admitted, false);
    if (!denied.admitted) assert.equal(denied.code, 'WORKSPACE_IDENTITY_MISMATCH');
  }
});

test('legacy root-only leases remain valid while malformed identity bindings are refused', () => {
  const legacy = evaluateGoalLease({
    lease: lease(bindings(false)),
    now: NOW,
    request: request(),
    spend: { filesChanged: 0, bytesWritten: 0 },
    killSwitch: false,
  });
  assert.deepEqual(legacy, { admitted: true });

  const malformed = {
    ...bindings(false),
    workspaceIdentities: [{ workspaceRoot: ROOT, fingerprint: 'not-a-sha' }],
  } as GoalLeaseBindings;
  assert.match(validateBindings(malformed) ?? '', /fingerprints must be lowercase SHA-256/);

  const incomplete = {
    ...bindings(false),
    workspaceRoots: [ROOT, 'E:/fixture/other'],
    workspaceIdentities: [{ workspaceRoot: ROOT, fingerprint: FINGERPRINT }],
  } as GoalLeaseBindings;
  assert.match(validateBindings(incomplete) ?? '', /cover every workspaceRoot exactly once/);
});
