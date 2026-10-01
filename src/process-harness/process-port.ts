import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type ProcessState = 'RUNNING' | 'STOPPING' | 'EXITED' | 'STOPPED' | 'FAILED';

export interface ProcessStartSpec {
  readonly argv: readonly string[];
  readonly cwd?: string;
}

export interface ProcessHandle {
  readonly processId: string;
  readonly owner: GatewayAuthority;
  readonly pid: number;
  readonly state: ProcessState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly exitCode?: number;
  readonly signal?: string;
}

export interface ProcessOutput {
  readonly processId: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessBackendHandle {
  readonly pid: number;
  read(): ProcessOutputSnapshot;
  write(data: string): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<{ exitCode: number | null; signal: string | null }>;
  stopTree(): Promise<void>;
}

export interface ProcessOutputSnapshot {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessBackend {
  start(spec: ProcessStartSpec): Promise<ProcessBackendHandle>;
}

export interface ProcessPort {
  start(owner: GatewayAuthority, spec: ProcessStartSpec): Promise<ProcessHandle>;
  describe(owner: GatewayAuthority, processId: string): Promise<ProcessHandle>;
  list(owner: GatewayAuthority): Promise<readonly ProcessHandle[]>;
  read(owner: GatewayAuthority, processId: string): Promise<ProcessOutput>;
  write(owner: GatewayAuthority, processId: string, data: string): Promise<void>;
  closeStdin(owner: GatewayAuthority, processId: string): Promise<void>;
  wait(owner: GatewayAuthority, processId: string, timeoutMs?: number): Promise<ProcessHandle>;
  stop(owner: GatewayAuthority, processId: string): Promise<ProcessHandle>;
}

interface LiveProcess {
  handle: ProcessHandle;
  backend: ProcessBackendHandle;
}

const PROCESS_ID = /^process_[0-9a-f-]{36}$/;
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_STDIN_BYTES = 64 * 1024;

function validateSpec(spec: ProcessStartSpec): void {
  if (!Array.isArray(spec.argv) || spec.argv.length < 1 || spec.argv.length > MAX_ARGS) {
    throw new Error('ProcessPort rejected argv');
  }
  for (const value of spec.argv) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0')
        || Buffer.byteLength(value, 'utf8') > MAX_ARG_BYTES) {
      throw new Error('ProcessPort rejected argv');
    }
  }
  if (spec.cwd !== undefined && (typeof spec.cwd !== 'string' || valueHasNul(spec.cwd))) {
    throw new Error('ProcessPort rejected cwd');
  }
}

function valueHasNul(value: string): boolean {
  return value.includes('\0');
}

function clone(handle: ProcessHandle): ProcessHandle {
  return Object.freeze({ ...handle, owner: Object.freeze({ ...handle.owner }) });
}

function finalState(state: ProcessState): boolean {
  return state === 'EXITED' || state === 'STOPPED' || state === 'FAILED';
}

export function createProcessPort(options: {
  backend: ProcessBackend;
  effectAllowed: () => boolean;
  now?: () => number;
  randomUUID?: () => string;
}): ProcessPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const processes = new Map<string, LiveProcess>();

  function effectAllowed(): void {
    if (!options.effectAllowed()) throw new Error('ProcessPort effect denied');
  }

  function owned(owner: GatewayAuthority, processId: string): LiveProcess {
    if (!PROCESS_ID.test(processId)) throw new Error('ProcessPort process id is invalid');
    const process = processes.get(processId);
    if (!process) throw new Error('ProcessPort process not found');
    if (!sameAuthorityTuple(process.handle.owner, owner)) {
      throw new Error('ProcessPort process is owned by another authority');
    }
    return process;
  }

  function update(process: LiveProcess, patch: Partial<ProcessHandle>): void {
    process.handle = Object.freeze({ ...process.handle, ...patch, updatedAt: now() });
  }

  async function observeExit(process: LiveProcess): Promise<void> {
    const result = await process.backend.wait();
    if (finalState(process.handle.state)) return;
    update(process, {
      state: 'EXITED',
      ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
      ...(result.signal === null ? {} : { signal: result.signal }),
    });
  }

  return {
    async start(owner, spec) {
      validateSpec(spec);
      effectAllowed();
      const backend = await options.backend.start(spec);
      try {
        effectAllowed();
      } catch (error) {
        await backend.stopTree().catch(() => undefined);
        throw error;
      }
      const createdAt = now();
      const handle: ProcessHandle = Object.freeze({
        processId: `process_${uuid()}`,
        owner: Object.freeze({ ...owner }),
        pid: backend.pid,
        state: 'RUNNING',
        createdAt,
        updatedAt: createdAt,
      });
      const live = { handle, backend };
      processes.set(handle.processId, live);
      void observeExit(live).catch(() => {
        if (!finalState(live.handle.state)) update(live, { state: 'FAILED' });
      });
      return clone(handle);
    },

    async describe(owner, processId) {
      return clone(owned(owner, processId).handle);
    },

    async list(owner) {
      return [...processes.values()]
        .filter((process) => sameAuthorityTuple(process.handle.owner, owner))
        .map((process) => clone(process.handle));
    },

    async read(owner, processId) {
      const process = owned(owner, processId);
      const snapshot = process.backend.read();
      return Object.freeze({ processId, ...snapshot });
    },

    async write(owner, processId, data) {
      const process = owned(owner, processId);
      if (process.handle.state !== 'RUNNING') throw new Error('ProcessPort process is not running');
      if (typeof data !== 'string' || valueHasNul(data) || Buffer.byteLength(data, 'utf8') > MAX_STDIN_BYTES) {
        throw new Error('ProcessPort rejected stdin');
      }
      effectAllowed();
      await process.backend.write(data);
    },

    async closeStdin(owner, processId) {
      const process = owned(owner, processId);
      if (process.handle.state !== 'RUNNING') throw new Error('ProcessPort process is not running');
      effectAllowed();
      await process.backend.closeStdin();
    },

    async wait(owner, processId, timeoutMs = 30_000) {
      const process = owned(owner, processId);
      if (finalState(process.handle.state)) return clone(process.handle);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 120_000) {
        throw new Error('ProcessPort wait timeout is invalid');
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('ProcessPort wait timed out')), timeoutMs);
        timer.unref?.();
      });
      try {
        await Promise.race([observeExit(process), timeout]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      return clone(process.handle);
    },

    async stop(owner, processId) {
      const process = owned(owner, processId);
      if (finalState(process.handle.state)) return clone(process.handle);
      update(process, { state: 'STOPPING' });
      try {
        // Cleanup remains available even when the kill switch/effect gate is engaged.
        await process.backend.stopTree();
        const result = await process.backend.wait();
        update(process, {
          state: 'STOPPED',
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          ...(result.signal === null ? {} : { signal: result.signal }),
        });
      } catch (error) {
        update(process, { state: 'FAILED' });
        throw error;
      }
      return clone(process.handle);
    },
  };
}
