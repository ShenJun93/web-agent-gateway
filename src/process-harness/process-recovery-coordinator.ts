import type { GatewayAuthority } from '../caller-context.js';
import type { ProcessHandle, ProcessStartSpec } from './process-port.js';
import {
  ProcessRecoveryLedger,
  sameProcessInstance,
  type ProcessInstanceIdentity,
  type ProcessRecoveryRecord,
} from './process-recovery-ledger.js';

export interface ProcessIdentityObserver {
  observe(pid: number): Promise<ProcessInstanceIdentity | null>;
  stopExact(identity: ProcessInstanceIdentity): Promise<void>;
}

export class ProcessRecoveryCoordinator {
  readonly #ledger: ProcessRecoveryLedger;
  readonly #observer: ProcessIdentityObserver;

  constructor(options: {
    ledger: ProcessRecoveryLedger;
    observer: ProcessIdentityObserver;
  }) {
    this.#ledger = options.ledger;
    this.#observer = options.observer;
  }

  async recordStarted(
    owner: GatewayAuthority,
    handle: ProcessHandle,
    spec: ProcessStartSpec,
  ): Promise<ProcessRecoveryRecord> {
    const identity = await this.#observer.observe(handle.pid);
    if (!identity) throw new Error('Process recovery could not observe the started process');
    return this.#ledger.recordStarted(owner, handle, spec, identity);
  }

  async inspect(owner: GatewayAuthority, processId: string): Promise<ProcessRecoveryRecord> {
    const record = this.#ledger.get(owner, processId);
    if (record.state !== 'RUNNING') return record;
    const current = await this.#observer.observe(record.pid);
    if (!current) return this.#ledger.transition(processId, 'RUNNING', 'EXITED');
    if (!sameProcessInstance(record, current)) {
      return this.#ledger.transition(processId, 'RUNNING', 'STALE_IDENTITY');
    }
    return record;
  }

  async stopRecovered(owner: GatewayAuthority, processId: string): Promise<ProcessRecoveryRecord> {
    const record = this.#ledger.get(owner, processId);
    if (record.state !== 'RUNNING') return record;

    const current = await this.#observer.observe(record.pid);
    if (!current) return this.#ledger.transition(processId, 'RUNNING', 'EXITED');
    if (!sameProcessInstance(record, current)) {
      this.#ledger.transition(processId, 'RUNNING', 'STALE_IDENTITY');
      throw new Error('Process recovery identity mismatch; refusing to stop reused or foreign PID');
    }

    await this.#observer.stopExact(current);

    const after = await this.#observer.observe(record.pid);
    if (after === null) return this.#ledger.transition(processId, 'RUNNING', 'STOPPED');
    if (!sameProcessInstance(record, after)) {
      return this.#ledger.transition(processId, 'RUNNING', 'STALE_IDENTITY');
    }
    throw new Error('Process recovery stop did not terminate the expected process instance');
  }

  async reconcileRunning(): Promise<{
    readonly exited: number;
    readonly staleIdentity: number;
    readonly stillRunning: number;
  }> {
    let exited = 0;
    let staleIdentity = 0;
    let stillRunning = 0;

    for (const record of this.#ledger.listRunning()) {
      const current = await this.#observer.observe(record.pid);
      if (!current) {
        this.#ledger.transition(record.processId, 'RUNNING', 'EXITED');
        exited += 1;
      } else if (!sameProcessInstance(record, current)) {
        this.#ledger.transition(record.processId, 'RUNNING', 'STALE_IDENTITY');
        staleIdentity += 1;
      } else {
        stillRunning += 1;
      }
    }

    return Object.freeze({ exited, staleIdentity, stillRunning });
  }
}
