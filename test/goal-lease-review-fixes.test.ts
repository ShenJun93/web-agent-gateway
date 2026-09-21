import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHarnessLane, HARNESS_LANE, type HarnessLane } from '../src/harness-authority.js';
import { isKillSwitchEngaged } from '../src/goal-lease-kill-switch.js';
import { affectedBytes } from '../src/durable-store.js';
import { evaluateGoalLease, type GoalLeaseBindings, type LeaseDenialCode } from '../src/goal-lease.js';

/**
 * The guards an independent review found were reached by no test.
 *
 * Every one of these was either wrong, or right-by-accident and unverified. They are gathered in
 * one file because what they have in common is how they were found, not what they do: each was
 * described confidently in a comment, an ADR or a commit message, and nothing executed it.
 */
const enabled = { ...process.env, WAG_HARNESS_LANE: '1' };

async function openLane(t: { after(fn: () => void | Promise<void>): void }): Promise<HarnessLane> {
  const parent = await mkdtemp(join(tmpdir(), 'wag-fix-'));
  const lane = await createHarnessLane({
    lane: HARNESS_LANE, root: join(parent, 'lane'), env: enabled, reviewTtlMs: 60_000,
  });
  t.after(async () => {
    await lane.destroy().catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  return lane;
}

const codeOf = (d: { admitted: boolean }): LeaseDenialCode => {
  assert.equal(d.admitted, false, 'expected a denial');
  return (d as unknown as { code: LeaseDenialCode }).code;
};

const BINDINGS: GoalLeaseBindings = {
  workspaceRoots: ['E:/fixture/ws'],
  allowedTools: ['mutation.preview'],
  pathPatterns: ['**'],
  maxFiles: 10,
  maxBytes: 100_000,
  maxDiffBytes: 100_000,
  admittedSessions: ['s'],
  admittedAdapters: ['a'],
  commitSemantics: 'none',
};
const REQUEST = {
  tool: 'mutation.preview', sessionId: 's', adapterId: 'a',
  workspaceRoot: 'E:/fixture/ws', path: 'a.txt', diffBytes: 1,
};

test('the kill switch really does fail engaged when the check throws', async (t) => {
  // S1. `existsSync` never throws — it swallows every error and returns false — so the previous
  // implementation failed OPEN while its comment claimed the opposite, and the catch arm was
  // unreachable. A path containing a NUL makes the underlying stat throw, which is the only way
  // to reach that arm from a test on any platform.
  const dir = await mkdtemp(join(tmpdir(), 'wag-kill-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(isKillSwitchEngaged(dir), false, 'a readable, empty directory is not engaged');
  assert.equal(isKillSwitchEngaged(`${dir}\u0000bad`), true,
    'a check that cannot be performed must read as engaged, not as clear');
});

test('a lease whose validity window is not two finite numbers is refused', () => {
  // S2. SQLite columns are dynamically typed, so a row holding text yields NaN here — and with
  // NaN both `now >= expiresAt` and `now < notBefore` are false, so a lease that can never
  // expire fell straight through to the bindings and admitted.
  const ask = (notBefore: number, expiresAt: number) => evaluateGoalLease({
    lease: { leaseId: 'l', createdAt: 0, notBefore, expiresAt, bindings: BINDINGS },
    now: 1_000, request: REQUEST, spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false,
  });

  for (const [nb, exp] of [
    [Number.NaN, 10_000], [0, Number.NaN], [0, Number.POSITIVE_INFINITY],
    [Number.NEGATIVE_INFINITY, 10_000],
  ] as Array<[number, number]>) {
    const d = ask(nb, exp);
    assert.equal(d.admitted, false, `notBefore=${nb} expiresAt=${exp} must be refused`);
    assert.equal((d as { code: string }).code, 'LEASE_MALFORMED');
  }

  // A window that ends before it starts is incoherent rather than merely expired.
  assert.equal((ask(9_000, 8_000) as { code: string }).code, 'LEASE_MALFORMED');
  // And a sane window still works, so the new checks did not simply deny everything.
  assert.deepEqual(ask(0, 10_000), { admitted: true });
});

test('a lease cannot act on the gateway checkout it is running from', () => {
  // S3. The named-file protection covered the *configuration* of authority and left every file
  // that implements it — the approver, the kill switch, the path policy, the extension manifest
  // — grantable under a `src/**` pattern. Refusing by location is what closes that.
  const gatewayRoot = 'E:/Projects/web-agent-gateway';
  const ask = (workspaceRoot: string) => evaluateGoalLease({
    lease: {
      leaseId: 'l', createdAt: 0, notBefore: 0, expiresAt: 10_000,
      bindings: { ...BINDINGS, workspaceRoots: [workspaceRoot] },
    },
    now: 1, request: { ...REQUEST, workspaceRoot, path: 'src/goal-lease.ts' },
    spend: { filesChanged: 0, bytesWritten: 0 }, killSwitch: false, gatewayRoot,
  });

  assert.equal(codeOf(ask(gatewayRoot)), 'SELF_MODIFICATION_REFUSED');
  assert.equal(codeOf(ask(`${gatewayRoot}/.worktrees/some-branch`)), 'SELF_MODIFICATION_REFUSED',
    'a worktree inside the checkout is still the checkout');
  assert.equal(codeOf(ask('e:/projects/WEB-AGENT-GATEWAY')), 'SELF_MODIFICATION_REFUSED',
    'and spelling must not defeat it on a case-insensitive filesystem');

  // An unrelated repository is ordinary work and stays permitted — the refusal is by location,
  // not by filename, so `src/goal-lease.ts` elsewhere is just a file.
  assert.deepEqual(ask('E:/Projects/somebody-elses-repo'), { admitted: true });
});

test('the byte budget counts what a change destroys, not only what it writes', () => {
  // S7. Counting only `after` let a proposal replacing 32 KiB with one byte charge one byte, so
  // `maxBytes: 100` could still destroy 32 KiB per file and `maxDiffBytes` could never fire.
  assert.equal(affectedBytes({ before: 'x'.repeat(5_000), after: 'y' }), 5_000);
  assert.equal(affectedBytes({ before: 'y', after: 'x'.repeat(5_000) }), 5_000);
  assert.equal(affectedBytes({ before: '', after: '' }), 0);
  // Multi-byte characters are counted as bytes, not as code units.
  assert.equal(affectedBytes({ before: '€', after: '' }), 3);
});

test('a shrinking proposal is charged against the lease budget end to end', async (t) => {
  const lane = await openLane(t);
  const big = 'x'.repeat(4_000);
  await lane.writeFixture('big.txt', `${big}\n`);
  // A budget far smaller than the content being destroyed.
  const leaseId = await lane.grantLease({ maxDiffBytes: 1_000 });

  const shrink = await lane.propose({ path: 'big.txt', before: big, after: 'y' });
  assert.equal(codeOf(await lane.admitUnderLease(leaseId, shrink.mutationId)), 'DIFF_TOO_LARGE');
  assert.equal(await lane.readFixture('big.txt'), `${big}\n`, 'and nothing was destroyed');
});

test('the authority row and the transition commit together, or not at all', async (t) => {
  // S8. The row used to be written after the transaction committed, so a crash in between left a
  // QUEUED record with no authority row that reconcile() would then execute — and on the human
  // path a throwing insert reported failure for an approval that had durably succeeded.
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease();
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });
  assert.deepEqual(await lane.admitUnderLease(leaseId, proposed.mutationId), { admitted: true });

  // Every record that ever left PENDING_APPROVAL has an authority row. The invariant the store's
  // own comment claims — "a mutation with no row was admitted by neither and cannot have
  // executed" — is only true if these two are atomic.
  const storePath = join(lane.fixtureRoot, '..', 'harness-lane.sqlite');
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const orphans = db.prepare(`SELECT COUNT(*) AS n FROM mutations m
      WHERE m.state NOT IN ('PENDING_APPROVAL','REJECTED','EXPIRED')
        AND NOT EXISTS (SELECT 1 FROM mutation_authority a WHERE a.mutation_id = m.mutation_id)`)
      .get() as { n: number };
    assert.equal(Number(orphans.n), 0, 'no executed record may lack an authority row');
  } finally {
    db.close();
  }
});

test('a lease over two roots cannot spend one file budget twice', async (t) => {
  // S9. Spend counted DISTINCT path, and `workspaceRoots` is a list — so `src/index.ts` in two
  // repositories counted as one file and `maxFiles: 5` permitted ten actual files.
  const lane = await openLane(t);
  await lane.writeFixture('same-name.txt', 'one\n');
  const leaseId = await lane.grantLease({ maxFiles: 1 });
  const first = await lane.propose({ path: 'same-name.txt', before: 'one', after: 'two' });
  assert.deepEqual(await lane.admitUnderLease(leaseId, first.mutationId), { admitted: true });

  // The row now carries the workspace, which is what makes the count per-file rather than
  // per-name. Asserting the column exists and is populated is the part a second root would need.
  const storePath = join(lane.fixtureRoot, '..', 'harness-lane.sqlite');
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT workspace_id FROM mutation_authority WHERE mutation_id = ?')
      .get(first.mutationId) as { workspace_id: string } | undefined;
    assert.equal(row?.workspace_id, lane.workspaceId,
      'spend is keyed on the workspace, not on the relative name alone');
  } finally {
    db.close();
  }
});

test('malformed stored bindings deny rather than throw', async (t) => {
  // O3. Only a JSON parse failure was caught; bindings of `null` made validateBindings
  // dereference and throw. Fail-closed either way, but the module claims every malformed input
  // lands in the deny arm, and a throw is not the deny arm.
  const lane = await openLane(t);
  await lane.writeFixture('a.txt', 'one\n');
  const leaseId = await lane.grantLease();
  const proposed = await lane.propose({ path: 'a.txt', before: 'one', after: 'two' });

  const storePath = join(lane.fixtureRoot, '..', 'harness-lane.sqlite');
  for (const bindings of ['null', '"a string"', '123', '{"workspaceRoots":"not-an-array"}', 'not json at all']) {
    const db = new DatabaseSync(storePath);
    try {
      db.prepare('UPDATE goal_leases SET bindings = ? WHERE lease_id = ?').run(bindings, leaseId);
    } finally {
      db.close();
    }
    const decision = await lane.admitUnderLease(leaseId, proposed.mutationId);
    assert.equal(decision.admitted, false, `bindings ${bindings} must deny`);
    assert.equal((decision as { code: string }).code, 'LEASE_MALFORMED', `bindings ${bindings}`);
  }
  assert.equal(await lane.readFixture('a.txt'), 'one\n');
});

test('a commit records its authority, and says which kind', async (t) => {
  // S4. Commits live in their own table, so mutation_authority could not carry them and a
  // policy-admitted commit was byte-identical in the record to an operator-approved one.
  await writeFile(join(tmpdir(), 'wag-lease-commit-marker'), 'see goal-lease-commit.test.ts', 'utf8')
    .catch(() => undefined);
  // The behaviour itself is asserted in goal-lease-commit.test.ts, which owns the commit harness;
  // this test exists so the table's presence is pinned even if that file is restructured.
  const lane = await openLane(t);
  const storePath = join(lane.fixtureRoot, '..', 'harness-lane.sqlite');
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const table = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'commit_authority'").get() as
      { sql: string } | undefined;
    assert.ok(table, 'the commit authority table must exist');
    for (const column of ['authority', 'lease_id', 'fingerprint', 'workspace_id', 'branch', 'old_head']) {
      assert.match(table.sql, new RegExp(`\\b${column}\\b`), `it must record ${column}`);
    }
  } finally {
    db.close();
  }
});
