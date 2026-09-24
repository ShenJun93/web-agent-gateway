import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { sanitizeLocalMachineEnvironment } from '../environment-policy.js';
import type {
  ProcessBackend,
  ProcessBackendHandle,
  ProcessOutputSnapshot,
  ProcessStartSpec,
} from './process-port.js';

const DEFAULT_MAX_STREAM_BYTES = 1024 * 1024;

interface StreamBuffer {
  value: string;
  bytes: number;
  truncated: boolean;
}

function append(buffer: StreamBuffer, chunk: Buffer, maxBytes: number): void {
  if (buffer.truncated) return;
  const remaining = maxBytes - buffer.bytes;
  if (remaining <= 0) {
    buffer.truncated = true;
    return;
  }
  const part = chunk.subarray(0, remaining);
  buffer.value += part.toString('utf8');
  buffer.bytes += part.length;
  if (part.length !== chunk.length) buffer.truncated = true;
}

async function waitChild(child: ChildProcessWithoutNullStreams): Promise<{
  exitCode: number | null;
  signal: string | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code, signal }));
  });
}

async function killExactTree(pid: number, child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
        env: sanitizeLocalMachineEnvironment(process.env),
      });
      killer.once('error', reject);
      killer.once('exit', (code) => {
        if (code === 0 || child.exitCode !== null || child.signalCode !== null) resolve();
        else reject(new Error(`taskkill failed for owned PID ${pid} with exit code ${code ?? -1}`));
      });
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') throw error;
  }
}

export function createNodeProcessBackend(options: {
  maxStreamBytes?: number;
  envSource?: NodeJS.ProcessEnv;
} = {}): ProcessBackend {
  const maxStreamBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  if (!Number.isInteger(maxStreamBytes) || maxStreamBytes < 1024 || maxStreamBytes > 16 * 1024 * 1024) {
    throw new Error('Node ProcessPort max stream size is invalid');
  }

  return {
    async start(spec: ProcessStartSpec): Promise<ProcessBackendHandle> {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        env: sanitizeLocalMachineEnvironment(options.envSource ?? process.env),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const pid = child.pid;
      if (!pid) {
        child.kill('SIGKILL');
        throw new Error('ProcessPort child did not start');
      }

      const stdout: StreamBuffer = { value: '', bytes: 0, truncated: false };
      const stderr: StreamBuffer = { value: '', bytes: 0, truncated: false };
      child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk, maxStreamBytes));
      child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk, maxStreamBytes));
      const settled = waitChild(child);

      return {
        pid,
        read(): ProcessOutputSnapshot {
          return Object.freeze({
            stdout: stdout.value,
            stderr: stderr.value,
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
          });
        },
        async write(data) {
          if (!child.stdin.writable) throw new Error('ProcessPort stdin is closed');
          await new Promise<void>((resolve, reject) => {
            child.stdin.write(data, (error) => error ? reject(error) : resolve());
          });
        },
        async closeStdin() {
          if (!child.stdin.destroyed) child.stdin.end();
        },
        wait() {
          return settled;
        },
        stopTree() {
          return killExactTree(pid, child);
        },
      };
    },
  };
}
