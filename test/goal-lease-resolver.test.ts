import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteDurableStore } from '../src/durable-store.js';
import { resolveGoalLease } from '../src/goal-lease-resolver.js';
import type { GoalLeaseBindings, LeaseRequest } from '../src/goal-lease.js';

const ADAPTER = 'private.stdio.v1';
const SESSION_A = 'session_a';
const SESSION_B = 'session_b';
const SESSION_C = 'session_c';

async function scratch() {
  return mkdtemp(join(tmpdir(), 'wag-goal-lease-resolver-'));
}

function commandRequest(sessionId: string, workspaceRoot: string): LeaseRequest {
  return {
    tool: 'command.run',
    sessionId,
    adapterId: ADAPTER,
    workspaceRoot,
    path: '.',
    diffBytes: 0,
  };
}

function commandBindings(sessionId: string, workspaceRoot: string): GoalLeaseBindings {
  return {
    workspaceRoots: [workspaceRoot],
    allowedTools: ['mutation.preview', 'git.commit', 'command.run'],
    pathPatterns: ['**'],
    maxFiles: 16,
    maxBytes: 1024 * 1024,
    maxDiffBytes: 256 * 1024,
    admittedSessions: [sessionId],
    admittedAdapters: [ADAPTER],
    commitSemantics: 'none',
  };
}

function insert(
  store: SqliteDurableStore,
  leaseId: string,
  now: number,
  bindings: GoalLeaseBindings,
) {
  store.insertGoalLease({
    leaseId,
    createdAt: now,
    notBefore: now - 1_000,
    expiresAt: now + 60_000,
    bindings: JSON.stringify(bindings),
  });
}

test('multi-active resolver isolates sessions/workspaces and observes revoke/issue without restart', async (t) => {
  const dir = await scratch();
  const rootA = join(dir, 'a');
  const rootB = join(dir, 'b');
  const rootC = join(dir, 'c');
  await Promise.all([mkdir(rootA), mkdir(rootB), mkdir(rootC)]);

  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.now();

  insert(store, 'lease_a', now, commandBindings(SESSION_A, rootA));
  insert(store, 'lease_b', now, commandBindings(SESSION_B, rootB));

  const ask = (request: LeaseRequest) => resolveGoalLease(store, {
    now,
    requests: [request],
    killSwitch: false,
  });

  const a = ask(commandRequest(SESSION_A, rootA));
  const b = ask(commandRequest(SESSION_B, rootB));
  assert.equal(a.admitted, true);
  assert.equal(b.admitted, true);
  if (a.admitted) assert.equal(a.resolved.lease.leaseId, 'lease_a');
  if (b.admitted) assert.equal(b.resolved.lease.leaseId, 'lease_b');

  assert.equal(ask(commandRequest(SESSION_A, rootB)).admitted, false);
  assert.equal(ask(commandRequest(SESSION_B, rootA)).admitted, false);

  assert.equal(store.revokeGoalLease('lease_a', now + 1), true);
  assert.equal(ask(commandRequest(SESSION_A, rootA)).admitted, false);
  const bAfterARevoke = ask(commandRequest(SESSION_B, rootB));
  assert.equal(bAfterARevoke.admitted, true);
  if (bAfterARevoke.admitted) assert.equal(bAfterARevoke.resolved.lease.leaseId, 'lease_b');

  insert(store, 'lease_c', now, commandBindings(SESSION_C, rootC));
  const c = ask(commandRequest(SESSION_C, rootC));
  assert.equal(c.admitted, true, 'new durable lease must be visible without rebuilding the resolver');
  if (c.admitted) assert.equal(c.resolved.lease.leaseId, 'lease_c');

  const bAfterCIssue = ask(commandRequest(SESSION_B, rootB));
  assert.equal(bAfterCIssue.admitted, true);
  if (bAfterCIssue.admitted) assert.equal(bAfterCIssue.resolved.lease.leaseId, 'lease_b');
});

test('zero matches deny and two matching leases deny as ambiguous', async (t) => {
  const dir = await scratch();
  const root = join(dir, 'lane');
  await mkdir(root);

  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const request = commandRequest(SESSION_A, root);

  const none = resolveGoalLease(store, { now, requests: [request], killSwitch: false });
  assert.equal(none.admitted, false);
  if (!none.admitted) assert.equal(none.code, 'NO_LEASE');

  const bindings = commandBindings(SESSION_A, root);
  insert(store, 'lease_ambiguous_1', now, bindings);
  insert(store, 'lease_ambiguous_2', now, bindings);

  const ambiguous = resolveGoalLease(store, { now, requests: [request], killSwitch: false });
  assert.equal(ambiguous.admitted, false);
  if (!ambiguous.admitted) assert.equal(ambiguous.code, 'AMBIGUOUS_LEASE');
});

test('commit resolution keeps branch/HEAD CAS and requires one lease to cover every path', async (t) => {
  const dir = await scratch();
  const root = join(dir, 'repo');
  await mkdir(root);

  const store = new SqliteDurableStore(join(dir, 'state.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const now = Date.now();
  const head = 'a'.repeat(40);
  const bindings: GoalLeaseBindings = {
    ...commandBindings(SESSION_A, root),
    pathPatterns: ['src/**'],
    commitSemantics: 'commit-to-bound-branch',
    commitBindings: [{ workspaceRoot: root, branch: 'feat/a', headSha: head }],
  };
  insert(store, 'lease_commit', now, bindings);

  const commitRequest = (path: string, branch = 'feat/a', headSha = head): LeaseRequest => ({
    tool: 'git.commit',
    sessionId: SESSION_A,
    adapterId: ADAPTER,
    workspaceRoot: root,
    path,
    diffBytes: 0,
    wantsCommit: true,
    branch,
    headSha,
  });

  const ok = resolveGoalLease(store, {
    now,
    requests: [commitRequest('src/a.ts'), commitRequest('src/b.ts')],
    killSwitch: false,
  });
  assert.equal(ok.admitted, true);

  const wrongHead = resolveGoalLease(store, {
    now,
    requests: [commitRequest('src/a.ts', 'feat/a', 'b'.repeat(40))],
    killSwitch: false,
  });
  assert.equal(wrongHead.admitted, false);

  const wrongBranch = resolveGoalLease(store, {
    now,
    requests: [commitRequest('src/a.ts', 'feat/not-a')],
    killSwitch: false,
  });
  assert.equal(wrongBranch.admitted, false);

  const splitScope = resolveGoalLease(store, {
    now,
    requests: [commitRequest('src/a.ts'), commitRequest('docs/outside.md')],
    killSwitch: false,
  });
  assert.equal(splitScope.admitted, false, 'one commit may not combine partial authority');
});
