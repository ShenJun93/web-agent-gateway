import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Socket } from 'node:net';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { sanitizeLocalMachineEnvironment } from './environment-policy.js';
import { nextTerminalRemoteEffectPolicyBuffer } from './remote-effect-policy.js';
import { redactSecrets } from './secret-redaction.js';

const MAX_BUFFER_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 4 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;

interface Args {
  dir: string;
  tokenFile: string;
  shell: 'powershell' | 'cmd' | 'bash';
  cwd: string;
  workspaceRoot: string;
  terminalId: string;
}

interface BrokerStatus {
  version: 1;
  terminal_id: string;
  workspace_root: string;
  broker_pid: number;
  shell_pid: number;
  shell: Args['shell'];
  cwd: string;
  started_at: string;
  state: 'RUNNING' | 'EXITED' | 'TERMINATED';
  exit_code?: number;
  port: number;
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string): string => {
    const index = argv.indexOf(name);
    const result = index < 0 ? undefined : argv[index + 1];
    if (!result) throw new Error('Missing ' + name);
    return result;
  };
  const shell = value('--shell');
  if (shell !== 'powershell' && shell !== 'cmd' && shell !== 'bash') {
    throw new Error('Invalid shell');
  }
  return {
    dir: value('--dir'),
    tokenFile: value('--token-file'),
    shell,
    cwd: value('--cwd'),
    workspaceRoot: value('--workspace-root'),
    terminalId: value('--terminal-id'),
  };
}

function shellArgv(shell: Args['shell']): string[] {
  if (shell === 'powershell') {
    if (process.platform !== 'win32') throw new Error('PowerShell terminal unavailable');
    return ['powershell.exe', '-NoLogo', '-NoProfile'];
  }
  if (shell === 'cmd') {
    if (process.platform !== 'win32') throw new Error('cmd terminal unavailable');
    return ['cmd.exe', '/d', '/q'];
  }
  return ['bash', '--noprofile', '--norc'];
}

function boundedAppend(current: string, chunk: Buffer): { value: string; truncated: boolean } {
  let value = current + chunk.toString('utf8');
  let truncated = false;
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > MAX_BUFFER_BYTES) {
    value = Buffer.from(value, 'utf8').subarray(bytes - MAX_BUFFER_BYTES).toString('utf8');
    truncated = true;
  }
  return { value, truncated };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const rawToken = (await readFile(args.tokenFile, 'utf8')).trim();
  const token = rawToken.startsWith('TERMINAL_TOKEN=')
    ? rawToken.slice('TERMINAL_TOKEN='.length)
    : '';
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid terminal token file');

  const argv = shellArgv(args.shell);
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: args.cwd,
    env: sanitizeLocalMachineEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  if (!child.pid) throw new Error('Terminal shell failed to start');

  let state: BrokerStatus['state'] = 'RUNNING';
  let exitCode: number | undefined;
  let buffer = '';
  let truncated = false;
  let remoteEffectPolicyBuffer = '';
  const startedAt = new Date().toISOString();
  let port = 0;

  const statusPath = args.dir + '/status.json';
  async function persistStatus(): Promise<void> {
    const value: BrokerStatus = {
      version: 1,
      terminal_id: args.terminalId,
      workspace_root: args.workspaceRoot,
      broker_pid: process.pid,
      shell_pid: child.pid!,
      shell: args.shell,
      cwd: args.cwd,
      started_at: startedAt,
      state,
      ...(exitCode === undefined ? {} : { exit_code: exitCode }),
      port,
    };
    const temp = statusPath + '.tmp';
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    await rename(temp, statusPath);
  }

  const append = (chunk: Buffer) => {
    const next = boundedAppend(buffer, chunk);
    buffer = next.value;
    truncated = truncated || next.truncated;
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  child.once('exit', (code) => {
    state = state === 'TERMINATED' ? 'TERMINATED' : 'EXITED';
    exitCode = code ?? -1;
    void persistStatus();
  });

  async function reply(socket: Socket, body: object): Promise<void> {
    socket.end(JSON.stringify(body) + '\n');
  }

  const server = createServer((socket) => {
    let input = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      input += chunk;
      if (Buffer.byteLength(input, 'utf8') > MAX_REQUEST_BYTES) socket.destroy();
      if (!input.includes('\n')) return;

      const line = input.slice(0, input.indexOf('\n'));
      void (async () => {
        let request: { token?: unknown; op?: unknown; base64?: unknown };
        try { request = JSON.parse(line) as typeof request; }
        catch { await reply(socket, { ok: false, error: 'INVALID_REQUEST' }); return; }
        if (request.token !== token) {
          await reply(socket, { ok: false, error: 'AUTH_DENIED' });
          return;
        }

        if (request.op === 'status') {
          await reply(socket, {
            ok: true,
            terminal_id: args.terminalId,
            broker_pid: process.pid,
            pid: child.pid,
            state,
            exit_code: exitCode,
            cwd: args.cwd,
            shell: args.shell,
            started_at: startedAt,
            buffered_bytes: Buffer.byteLength(buffer, 'utf8'),
            truncated,
          });
          return;
        }

        if (request.op === 'output') {
          const output = redactSecrets(buffer);
          const wasTruncated = truncated;
          buffer = '';
          truncated = false;
          await reply(socket, {
            ok: true,
            terminal_id: args.terminalId,
            state,
            exit_code: exitCode,
            output,
            truncated: wasTruncated,
          });
          return;
        }

        if (request.op === 'input') {
          if (state !== 'RUNNING') {
            await reply(socket, { ok: false, error: 'NOT_RUNNING' });
            return;
          }
          if (typeof request.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.base64)) {
            await reply(socket, { ok: false, error: 'INVALID_INPUT' });
            return;
          }
          const payload = Buffer.from(request.base64, 'base64');
          if (payload.length === 0 || payload.length > MAX_INPUT_BYTES) {
            await reply(socket, { ok: false, error: 'INVALID_INPUT_SIZE' });
            return;
          }
          try {
            remoteEffectPolicyBuffer = nextTerminalRemoteEffectPolicyBuffer(
              remoteEffectPolicyBuffer,
              payload.toString('utf8'),
            );
          } catch (error) {
            remoteEffectPolicyBuffer = '';
            await new Promise<void>((resolvePromise) => {
              child.stdin.write(Buffer.from([0x03]), () => resolvePromise());
            }).catch(() => undefined);
            await reply(socket, {
              ok: false,
              error: error instanceof Error ? error.message : 'REMOTE_EFFECT_POLICY_DENIED',
            });
            return;
          }
          await new Promise<void>((resolvePromise, reject) => {
            child.stdin.write(payload, (error) => error ? reject(error) : resolvePromise());
          });
          await reply(socket, { ok: true, terminal_id: args.terminalId, bytes_written: payload.length, state });
          return;
        }

        if (request.op === 'close') {
          if (state === 'RUNNING') {
            state = 'TERMINATED';
            child.kill('SIGTERM');
            await persistStatus();
          }
          await reply(socket, { ok: true, terminal_id: args.terminalId, state, closed: true });
          setTimeout(() => server.close(() => process.exit(0)), 100).unref();
          return;
        }

        await reply(socket, { ok: false, error: 'UNKNOWN_OPERATION' });
      })().catch(async (error) => {
        await reply(socket, { ok: false, error: error instanceof Error ? error.message : String(error) })
          .catch(() => undefined);
      });
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Terminal broker address unavailable');
  port = address.port;
  await persistStatus();

  const shutdown = () => {
    if (state === 'RUNNING') {
      state = 'TERMINATED';
      child.kill('SIGTERM');
      void persistStatus();
    }
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

await main();
