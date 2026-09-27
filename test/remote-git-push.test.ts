import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createGatewayCallerContext } from '../src/caller-context.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import {
  DurableRemoteGitPushCoordinator,
  type RemoteGitPushAutonomousPolicy,
  type RemoteGitPushBackend,
  type RemoteGitPushPlan,
} from '../src/remote-git-push.js';
import { RemoteGitPushStore } from '../src/remote-git-push-store.js';

const ROOT = process.platform === 'win32' ? 'C:\\repo' : '/repo';
const SOURCE = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const DEST = 'refs/heads/feat/remote-push-v1';
const URL = 'https://github.com/example/repo.git';

function plan(overrides: Partial<RemoteGitPushPlan> = {}): RemoteGitPushPlan {
  return {
    repositoryIdentity: 'repo_' + '1'.repeat(64),
    resolvedPushUrl: URL,
    sourceOid: SOURCE,
    destinationRef: DEST,
    expectedRemoteState: { kind: 'OID', oid: OLD },
    commitSubject: 'feat: exact reviewed push',
    changedFilesSummary: '2 files changed',
    aheadCommitCount: 2,
    ...overrides,
  };
}

class FakeBackend implements RemoteGitPushBackend {
  plans: RemoteGitPushPlan[] = [];
  planCalls = 0;
  executeCalls = 0;
  reconcileCalls = 0;
  executeOutcome: Awaited<ReturnType<RemoteGitPushBackend['execute']>> = {
    outcome: 'SUCCEEDED',
    observedRemoteOid: SOURCE,
  };
  reconcileOutcome: Awaited<ReturnType<RemoteGitPushBackend['reconcile']>> = {
    outcome: 'OUTCOME_UNKNOWN',
  };

  async plan(): Promise<RemoteGitPushPlan> {
    this.planCalls += 1;
    return this.plans.shift() ?? plan();
  }

  async execute() {
    this.executeCalls += 1;
    return this.executeOutcome;
  }

  async reconcile() {
    this.reconcileCalls += 1;
    return this.reconcileOutcome;
  }
}

async function fixture(
  t: test.TestContext,
  options: {
    killSwitch?: () => boolean;
    autonomous?: RemoteGitPushAutonomousPolicy;
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'wag-remote-git-push-'));
  const state = join(dir, 'state.sqlite');
  const workspaces = new SqliteDurableStore(state);
  const pushDbPath = join(dir, 'remote-push.sqlite');
  const pushes = new RemoteGitPushStore(pushDbPath);
  t.after(async () => {
    pushes.close();
    workspaces.close();
    await rm(dir, { recursive: true, force: true });
  });
  const caller = createGatewayCallerContext({
    ownerId: 'local.private.stdio',
    sessionId: 'session_a',
    adapterId: 'private.stdio.v1',
  });
  const workspace = workspaces.openWorkspaceRecord({
    ownerId: caller.ownerId,
    sessionId: caller.sessionId,
    adapterId: caller.adapterId,
    canonicalRoot: ROOT,
    backendKind: 'devspace',
    createdAt: 1_000,
  });
  const backend = new FakeBackend();
  let now = 10_000;
  const coordinator = new DurableRemoteGitPushCoordinator({
    store: pushes,
    workspaceStore: workspaces,
    backend,
    now: () => now,
    reviewTtlMs: 60_000,
    activeTtlMs: 60_000,
    ...(options.autonomous === undefined ? {} : { autonomous: options.autonomous }),
    ...(options.killSwitch === undefined ? {} : { killSwitch: options.killSwitch }),
  });
  return {
    caller,
    workspaceId: workspace.workspaceId,
    backend,
    coordinator,
    pushes,
    pushDbPath,
    setNow(value: number) { now = value; },
  };
}

const input = {
  remote: 'origin',
  sourceOid: SOURCE,
  destinationRef: DEST,
  reviewedOid: SOURCE,
  reviewReceiptDigest: 'c'.repeat(64),
};

test('destination namespace rejects protected branches, tags and delete-shaped refs before planning', async (t) => {
  for (const destinationRef of [
    'refs/heads/main',
    'refs/heads/master',
    'refs/tags/v1.0.0',
    'refs/heads/',
    'refs/heads/-danger',
    'refs/heads/feat/../escape',
  ]) {
    const f = await fixture(t);
    await assert.rejects(
      f.coordinator.request(f.caller, f.workspaceId, {
        ...input,
        destinationRef,
      }),
      /destination ref/i,
      destinationRef,
    );
    assert.equal(f.backend.planCalls, 0, destinationRef);
  }
});

test('first exact git.push request creates only a human-review proposal', async (t) => {
  const f = await fixture(t);
  const first = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(first.status, 'approval_required');
  assert.equal(first.state, 'PENDING');
  assert.equal(f.backend.executeCalls, 0);
  const result = f.coordinator.result(f.caller, first.pushId);
  assert.equal(result.state, 'PENDING');
});

test('human approval creates one active exact grant and the same request consumes it once', async (t) => {
  const f = await fixture(t);
  const first = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(first.pushId), true);
  assert.equal(f.coordinator.result(f.caller, first.pushId).state, 'ACTIVE');

  const executed = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(executed.status, 'succeeded');
  assert.equal(executed.state, 'CONSUMED');
  assert.equal(executed.observedRemoteOid, SOURCE);
  assert.equal(f.backend.executeCalls, 1);

  const replay = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(replay.status, 'approval_required');
  assert.notEqual(replay.pushId, first.pushId, 'a consumed grant can never authorize a retry');
  assert.equal(f.backend.executeCalls, 1);
});

test('autonomous standing policy executes an exact allowlisted push on the first request', async (t) => {
  const f = await fixture(t, {
    autonomous: {
      permits(target) {
        return target.resolvedPushUrl === URL && target.destinationRef === DEST;
      },
      denyUnmatched: true,
    },
  });

  const result = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.state, 'CONSUMED');
  assert.equal(result.observedRemoteOid, SOURCE);
  assert.equal(f.backend.planCalls, 1);
  assert.equal(f.backend.executeCalls, 1);
  assert.equal(f.pushes.listPending(20).length, 0);

  const stored = f.pushes.get(result.pushId);
  assert.equal(stored?.useCount, 1);
  assert.ok(stored?.approvedAt !== undefined);
  assert.ok(stored?.executionStartedAt !== undefined);
  assert.equal(stored?.approvedAt, stored?.executionStartedAt,
    'autonomous activation and execution claim are one atomic authority transition');
});

test('autonomous-only policy denies unmatched targets without creating a Human approval proposal', async (t) => {
  const f = await fixture(t, {
    autonomous: {
      permits() { return false; },
      denyUnmatched: true,
    },
  });

  await assert.rejects(
    f.coordinator.request(f.caller, f.workspaceId, input),
    /AUTONOMOUS_REMOTE_POLICY_DENIED/,
  );
  assert.equal(f.backend.planCalls, 1);
  assert.equal(f.backend.executeCalls, 0);
  assert.equal(f.pushes.listPending(20).length, 0);
});

test('autonomous policy still fails closed at the kill switch before the remote effect', async (t) => {
  let checks = 0;
  const f = await fixture(t, {
    autonomous: {
      permits(target) {
        return target.resolvedPushUrl === URL && target.destinationRef === DEST;
      },
      denyUnmatched: true,
    },
    killSwitch: () => {
      checks += 1;
      return checks >= 2;
    },
  });

  const result = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(result.state, 'REVOKED');
  assert.equal(result.outcomeClass, 'KILL_SWITCH_ENGAGED');
  assert.equal(f.backend.executeCalls, 0);
});

test('active grant is exact to source, destination and caller session', async (t) => {
  const f = await fixture(t);
  const first = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(first.pushId), true);

  f.backend.plans.push(plan({ sourceOid: 'd'.repeat(40) }));
  const wrongSource = await f.coordinator.request(f.caller, f.workspaceId, {
    ...input,
    sourceOid: 'd'.repeat(40),
    reviewedOid: 'd'.repeat(40),
  });
  assert.equal(wrongSource.status, 'approval_required');
  assert.equal(f.backend.executeCalls, 0);

  const foreign = createGatewayCallerContext({
    ownerId: f.caller.ownerId,
    sessionId: 'session_b',
    adapterId: f.caller.adapterId,
  });
  assert.throws(
    () => f.coordinator.result(foreign, first.pushId),
    /denied remote git push/i,
  );
});

test('expired proposals and active grants fail closed', async (t) => {
  const f = await fixture(t);
  const pending = await f.coordinator.request(f.caller, f.workspaceId, input);
  f.setNow(80_001);
  assert.equal(await f.coordinator.approveLocal(pending.pushId), false);
  assert.equal(f.coordinator.result(f.caller, pending.pushId).state, 'EXPIRED');

  f.setNow(100_000);
  const fresh = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(fresh.pushId), true);
  f.setNow(160_001);
  const result = f.coordinator.result(f.caller, fresh.pushId);
  assert.equal(result.state, 'EXPIRED');
});

test('uncertain attempt never blind-retries and reconciles to a terminal authority state', async (t) => {
  const f = await fixture(t);
  const first = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(first.pushId), true);

  f.backend.executeOutcome = {
    outcome: 'OUTCOME_UNKNOWN',
    errorClass: 'TransportTimeout',
  };
  f.backend.reconcileOutcome = {
    outcome: 'NOT_OBSERVED',
    observedRemoteOid: OLD,
    errorClass: 'TransportTimeout',
  };

  const attempted = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(attempted.state, 'REVOKED');
  assert.equal(attempted.status, 'not_observed');
  assert.equal(f.backend.executeCalls, 1);
  assert.equal(f.backend.reconcileCalls, 1);

  const next = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(next.status, 'approval_required');
  assert.notEqual(next.pushId, first.pushId);
  assert.equal(f.backend.executeCalls, 1);
});

test('review binding refuses a source different from reviewed oid before proposal storage', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.coordinator.request(f.caller, f.workspaceId, {
      ...input,
      reviewedOid: 'f'.repeat(40),
    }),
    /reviewed oid/i,
  );
  assert.equal(f.pushes.listPending(20).length, 0);
});


test('kill switch prevents proposal/approval and closes a race before the remote effect', async (t) => {
  let checks = 0;
  const f = await fixture(t, {
    killSwitch: () => {
      checks += 1;
      return checks >= 4;
    },
  });

  const proposed = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(proposed.state, 'PENDING');
  assert.equal(await f.coordinator.approveLocal(proposed.pushId), true);

  const attempted = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(attempted.state, 'REVOKED');
  assert.equal(attempted.outcomeClass, 'KILL_SWITCH_ENGAGED');
  assert.equal(f.backend.executeCalls, 0);
});

test('restart reconciliation consumes an interrupted grant only when the remote proves the source oid', async (t) => {
  const f = await fixture(t);
  const proposed = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(proposed.pushId), true);
  assert.ok(f.pushes.claimExecution(proposed.pushId, 10_001));

  f.backend.reconcileOutcome = {
    outcome: 'SUCCEEDED',
    observedRemoteOid: SOURCE,
  };
  await f.coordinator.reconcile();

  const result = f.coordinator.result(f.caller, proposed.pushId);
  assert.equal(result.state, 'CONSUMED');
  assert.equal(result.observedRemoteOid, SOURCE);
  assert.equal(f.backend.executeCalls, 0);
  assert.equal(f.backend.reconcileCalls, 1);
});

test('restart reconciliation quarantines an interrupted grant on divergent remote state', async (t) => {
  const f = await fixture(t);
  const proposed = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(proposed.pushId), true);
  assert.ok(f.pushes.claimExecution(proposed.pushId, 10_001));

  f.backend.reconcileOutcome = {
    outcome: 'DIVERGENT_REMOTE',
    observedRemoteOid: 'd'.repeat(40),
  };
  await f.coordinator.reconcile();

  const result = f.coordinator.result(f.caller, proposed.pushId);
  assert.equal(result.state, 'QUARANTINED');
  assert.equal(result.status, 'quarantined');
  assert.equal(result.observedRemoteOid, 'd'.repeat(40));
});

test('duplicate matching active grants fail closed as ambiguous remote authority', async (t) => {
  const f = await fixture(t);
  const proposed = await f.coordinator.request(f.caller, f.workspaceId, input);
  assert.equal(await f.coordinator.approveLocal(proposed.pushId), true);

  const db = new DatabaseSync(f.pushDbPath);
  try {
    const columns = db.prepare('PRAGMA table_info(remote_git_push_grants)').all()
      .map((row) => String((row as { name: string }).name));
    const quoted = columns.map((name) => '"' + name.replaceAll('"', '""') + '"');
    const expressions = columns.map((name) => (
      name === 'push_id' ? "'push_duplicate_authority'" : '"' + name.replaceAll('"', '""') + '"'
    ));
    db.exec(
      'INSERT INTO remote_git_push_grants (' + quoted.join(',') + ') '
      + 'SELECT ' + expressions.join(',') + ' FROM remote_git_push_grants '
      + "WHERE push_id = '" + proposed.pushId.replaceAll("'", "''") + "'",
    );
  } finally {
    db.close();
  }

  await assert.rejects(
    f.coordinator.request(f.caller, f.workspaceId, input),
    /AMBIGUOUS_REMOTE_EFFECT_GRANT/,
  );
  assert.equal(f.backend.executeCalls, 0);
});
