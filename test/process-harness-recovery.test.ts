import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { GatewayAuthority } from '../src/caller-context.js';
import type { ProcessHandle, ProcessStartSpec } from '../src/process-harness/process-port.js';
import {
  ProcessRecoveryLedger,
  type ProcessInstanceIdentity,
} from '../src/process-harness/process-recovery-ledger.js';
import {
  ProcessRecoveryCoordinator,
  type ProcessIdentityObserver,
} from '../src/process-harness/process-recovery-coordinator.js';

const OWNER: GatewayAuthority = {
  ownerId: 'owner_recovery',
  sessionId: 'session_recovery',
  adapterId: 'private.stdio.v1',
};
const OTHER: GatewayAuthority = {
  ownerId: 'owner_recovery',
  sessionId: 'session_other',
  adapterId: 'private.stdio.v1',
};

const SPEC: ProcessStartSpec = {
  argv: ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', '--remote-debugging-port=9333'],
  cwd: 'E:\\AI-BROWSER\\profiles\\owned',
};

function handle(processId: string, pid: number): ProcessHandle {
  return {
    processId,
    owner: OWNER,
    pid,
    state: 'RUNNING',
    createdAt: 100,
    updatedAt: 100,
  };
}

function identity(pid: number, instanceId = `created:${pid}:100`): ProcessInstanceIdentity {
  return {
    pid,
    instanceId,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  };
}

function observerFixture() {
  const current = new Map<number, ProcessInstanceIdentity>();
  const stopped: ProcessInstanceIdentity[] = [];
  const observer: ProcessIdentityObserver = {
    async observe(pid) {
      return current.get(pid) ?? null;
    },
    async stopExact(expected) {
      stopped.push(expected);
      const actual = current.get(expected.pid);
      if (actual?.instanceId === expected.instanceId
          && actual.executablePath.toLowerCase() === expected.executablePath.toLowerCase()) {
        current.delete(expected.pid);
      }
    },
  };
  return { observer, current, stopped };
}

test('process recovery record survives ledger restart and remains exact-authority owned', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-recovery-'));
  const path = join(dir, 'recovery.sqlite');
  let ledger = new ProcessRecoveryLedger(path, { now: () => 1000 });
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });

  const f = observerFixture();
  f.current.set(4100, identity(4100));

  let coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });
  const recorded = await coordinator.recordStarted(
    OWNER,
    handle('process_00000000-0000-4000-8000-000000000001', 4100),
    SPEC,
  );
  assert.equal(recorded.state, 'RUNNING');
  assert.match(recorded.specFingerprint, /^processfp_[a-f0-9]{64}$/);
  ledger.close();

  ledger = new ProcessRecoveryLedger(path, { now: () => 2000 });
  coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });

  const recovered = await coordinator.inspect(OWNER, recorded.processId);
  assert.equal(recovered.state, 'RUNNING');
  assert.equal(recovered.instanceId, 'created:4100:100');
  assert.equal(ledger.list(OWNER).length, 1);
  assert.deepEqual(ledger.list(OTHER), []);
  assert.throws(() => ledger.get(OTHER, recorded.processId), /not owned by caller/);
});

test('reconcile marks vanished processes EXITED and PID reuse STALE_IDENTITY without killing either', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-recovery-'));
  const path = join(dir, 'recovery.sqlite');
  const ledger = new ProcessRecoveryLedger(path);
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = observerFixture();
  const coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });

  f.current.set(4201, identity(4201, 'instance-a'));
  f.current.set(4202, identity(4202, 'instance-b'));
  await coordinator.recordStarted(
    OWNER,
    handle('process_00000000-0000-4000-8000-000000000002', 4201),
    SPEC,
  );
  await coordinator.recordStarted(
    OWNER,
    handle('process_00000000-0000-4000-8000-000000000003', 4202),
    SPEC,
  );

  f.current.delete(4201);
  f.current.set(4202, identity(4202, 'pid-reused-by-other-process'));
  const reconciled = await coordinator.reconcileRunning();

  assert.deepEqual(reconciled, { exited: 1, staleIdentity: 1, stillRunning: 0 });
  assert.equal(ledger.get(OWNER, 'process_00000000-0000-4000-8000-000000000002').state, 'EXITED');
  assert.equal(ledger.get(OWNER, 'process_00000000-0000-4000-8000-000000000003').state, 'STALE_IDENTITY');
  assert.deepEqual(f.stopped, []);
});

test('stopRecovered terminates only an exact observed process instance and verifies disappearance', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-recovery-'));
  const path = join(dir, 'recovery.sqlite');
  const ledger = new ProcessRecoveryLedger(path);
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = observerFixture();
  const coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });

  const expected = identity(4300, 'instance-owned');
  f.current.set(4300, expected);
  const processId = 'process_00000000-0000-4000-8000-000000000004';
  await coordinator.recordStarted(OWNER, handle(processId, 4300), SPEC);

  const stopped = await coordinator.stopRecovered(OWNER, processId);
  assert.equal(stopped.state, 'STOPPED');
  assert.deepEqual(f.stopped, [expected]);
  assert.equal(await f.observer.observe(4300), null);
});

test('stopRecovered refuses PID reuse and never calls stopExact on the replacement process', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-recovery-'));
  const path = join(dir, 'recovery.sqlite');
  const ledger = new ProcessRecoveryLedger(path);
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = observerFixture();
  const coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });

  f.current.set(4400, identity(4400, 'original-instance'));
  const processId = 'process_00000000-0000-4000-8000-000000000005';
  await coordinator.recordStarted(OWNER, handle(processId, 4400), SPEC);
  f.current.set(4400, identity(4400, 'replacement-instance'));

  await assert.rejects(
    () => coordinator.stopRecovered(OWNER, processId),
    /identity mismatch; refusing to stop/,
  );
  assert.equal(ledger.get(OWNER, processId).state, 'STALE_IDENTITY');
  assert.deepEqual(f.stopped, []);
});

test('recordStarted fails closed when the newly started PID cannot be independently observed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'wag-process-recovery-'));
  const path = join(dir, 'recovery.sqlite');
  const ledger = new ProcessRecoveryLedger(path);
  t.after(async () => {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  });
  const f = observerFixture();
  const coordinator = new ProcessRecoveryCoordinator({ ledger, observer: f.observer });

  await assert.rejects(
    () => coordinator.recordStarted(
      OWNER,
      handle('process_00000000-0000-4000-8000-000000000006', 4500),
      SPEC,
    ),
    /could not observe/,
  );
  assert.deepEqual(ledger.list(OWNER), []);
});
