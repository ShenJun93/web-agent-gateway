import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  realpath,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { sameAuthorityTuple } from './authority-tuple.js';
import type { GatewayCallerContext } from './caller-context.js';
import type { SqliteDurableStore, WorkspaceRecord } from './durable-store.js';
import { sanitizeLocalMachineEnvironment } from './environment-policy.js';
import { describeReadableUtf8Text } from './file-read-metadata.js';
import { assertCreateTarget, assertReadTarget, validateReadPath } from './path-policy.js';
import { redactCommandLine, redactSecrets } from './secret-redaction.js';
import {
  WorkspaceIdentityRegistry,
  type WorkspaceIdentityObservation,
} from './workspace-identity.js';

const BACKEND_KIND = 'local-machine';
const MAX_READ_BYTES = 64 * 1024;
const MAX_PAGED_READ_BYTES = 16 * 1024 * 1024;
const MAX_READ_LINES = 1_000;
const MAX_READ_MANY_FILES = 20;
const MAX_COMMAND_ARGS = 32;
const MAX_ARG_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_TOKENS = 4_000;
const MAX_OUTPUT_TOKENS = 20_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILES = 5_000;
const MAX_TERMINAL_BUFFER_BYTES = 64 * 1024;
const MAX_TERMINAL_INPUT_BYTES = 4 * 1024;
const MAX_PROCESS_OBSERVATION_MS = 5 * 60_000;

export async function observeLocalMachineWorkspaceIdentity(
  root: string,
): Promise<WorkspaceIdentityObservation> {
  const canonicalRoot = await realpath(root);
  const info = await stat(canonicalRoot, { bigint: true });
  if (!info.isDirectory()) throw new Error('Gateway denied local-machine root is not a directory');
  return {
    canonicalRoot,
    backendKind: BACKEND_KIND,
    fsDevice: String(info.dev),
    fsInode: String(info.ino),
  };
}

export interface LocalMachineCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
}

export interface LocalMachineSearchOptions {
  ignoreCase?: boolean;
  maxResults?: number;
  contextLines?: number;
  path?: string;
}

export interface LocalMachineReadOptions {
  offset?: number;
  length?: number;
}

interface StartedProcess {
  readonly processId: string;
  readonly workspaceId: string;
  readonly pid: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly startedAt: number;
  creationDate?: string;
  state: 'RUNNING' | 'EXITED' | 'TERMINATED';
  exitCode?: number;
}

interface ObservedProcess {
  readonly processId: string;
  readonly workspaceId: string;
  readonly pid: number;
  readonly creationDate: string;
  readonly observedAt: number;
}

interface TerminalSession {
  readonly terminalId: string;
  readonly workspaceId: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly startedAt: number;
  buffer: string;
  truncated: boolean;
  state: 'RUNNING' | 'EXITED' | 'TERMINATED';
  exitCode?: number;
}

export interface LocalMachineContext {
  open(path: string): Promise<object>;
  describe(workspaceId: string): Promise<object>;
  list(workspaceId: string, path?: string, maxEntries?: number, depth?: number): Promise<object>;
  search(workspaceId: string, query: string, options?: LocalMachineSearchOptions): Promise<object>;
  info(workspaceId: string, path?: string): Promise<object>;
  read(workspaceId: string, path: string, options?: LocalMachineReadOptions): Promise<object>;
  readMany(workspaceId: string, paths: readonly string[], options?: LocalMachineReadOptions): Promise<object>;
  mkdir(workspaceId: string, path: string): Promise<object>;
  move(workspaceId: string, from: string, to: string): Promise<object>;
  delete(workspaceId: string, path: string, recursive?: boolean): Promise<object>;
  commandRun(workspaceId: string, argv: readonly string[], options?: LocalMachineCommandOptions): Promise<object>;
  processList(workspaceId: string): Promise<object>;
  processInspect(workspaceId: string, idOrPid: string): Promise<object>;
  processStart(workspaceId: string, argv: readonly string[], options?: Pick<LocalMachineCommandOptions, 'cwd'>): Promise<object>;
  processTerminate(workspaceId: string, processId: string): Promise<object>;
  terminalOpen(workspaceId: string, shell?: 'powershell' | 'cmd' | 'bash', cwd?: string): Promise<object>;
  terminalList(workspaceId: string): Promise<object>;
  terminalOutput(workspaceId: string, terminalId: string): Promise<object>;
  terminalInput(workspaceId: string, terminalId: string, base64: string): Promise<object>;
  terminalClose(workspaceId: string, terminalId: string): Promise<object>;
}

export function createLocalMachineContext(options: {
  store: SqliteDurableStore;
  callerContext: GatewayCallerContext;
  workspaceIdentities: WorkspaceIdentityRegistry;
  killSwitch: () => boolean;
}): LocalMachineContext {
  const { store, callerContext, workspaceIdentities } = options;
  const startedProcesses = new Map<string, StartedProcess>();
  const observedProcesses = new Map<string, ObservedProcess>();
  const terminals = new Map<string, TerminalSession>();

  function assertEffectAllowed(): void {
    if (options.killSwitch()) {
      throw new Error('Gateway denied local-machine effect: KILL_SWITCH_ENGAGED');
    }
  }

  async function ownedWorkspace(workspaceId: string): Promise<{ workspace: WorkspaceRecord }> {
    const workspace = store.getWorkspace(workspaceId);
    if (!workspace || workspace.backendKind !== BACKEND_KIND || !sameAuthorityTuple(workspace, callerContext)) {
      throw new Error('Gateway denied local-machine workspace');
    }
    const observation = await observeLocalMachineWorkspaceIdentity(workspace.canonicalRoot);
    workspaceIdentities.record(workspaceId, observation);
    return { workspace };
  }

  async function resolveCwd(root: string, requested?: string): Promise<string> {
    if (requested === undefined || requested === '' || requested === '.') return root;
    const safe = validateReadPath(requested.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''));
    await assertReadTarget(root, safe);
    const target = await realpath(resolve(root, safe));
    const info = await stat(target);
    if (!info.isDirectory()) throw new Error('Gateway denied local-machine cwd is not a directory');
    return target;
  }

  async function inspectPid(pid: number): Promise<Record<string, unknown> | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Gateway rejected process id');
    if (process.platform !== 'win32') {
      try {
        process.kill(pid, 0);
        return { ProcessId: pid, Name: 'process', CreationDate: undefined };
      } catch {
        return undefined;
      }
    }
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
      'if($null -eq $p){exit 3}',
      '$p | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate,CommandLine | ConvertTo-Json -Compress',
    ].join('; ');
    const result = await runBounded(
      ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script],
      process.cwd(),
      10_000,
      4_000,
    );
    if (result.exitCode === 3) return undefined;
    if (result.exitCode !== 0) throw new Error('Gateway process inspection failed');
    const value = JSON.parse(result.output || '{}') as Record<string, unknown>;
    if (typeof value.CommandLine === 'string') value.CommandLine = redactCommandLine(value.CommandLine);
    return value;
  }

  function terminal(workspaceId: string, terminalId: string): TerminalSession {
    const session = terminals.get(terminalId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new Error('Gateway denied terminal session');
    }
    return session;
  }

  async function readLocalText(root: string, path: string, readOptions: LocalMachineReadOptions = {}): Promise<object> {
    const safePath = validateReadPath(path);
    await assertReadTarget(root, safePath);
    const target = await realpath(resolve(root, safePath));
    const bytes = await readFile(target);
    const paged = readOptions.offset !== undefined || readOptions.length !== undefined;
    const maxBytes = paged ? MAX_PAGED_READ_BYTES : MAX_READ_BYTES;
    if (bytes.length > maxBytes) {
      throw new Error(paged
        ? 'Gateway rejected paged local-machine read exceeds 16 MiB'
        : 'Gateway rejected local-machine read exceeds 64 KiB; use offset/length pagination');
    }
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Gateway rejected local-machine non-UTF-8 content'); }

    if (!paged) return redactRead(describeReadableUtf8Text(raw));

    const offset = readOptions.offset ?? 0;
    const length = Math.min(Math.max(readOptions.length ?? 200, 1), MAX_READ_LINES);
    if (!Number.isInteger(offset) || offset < -1_000_000 || offset > 1_000_000) {
      throw new Error('Gateway rejected local-machine read offset');
    }
    const lines = raw.split(/\r?\n/);
    const start = offset < 0 ? Math.max(lines.length + offset, 0) : Math.min(offset, lines.length);
    const wanted = lines.slice(start, start + length);
    const bounded: string[] = [];
    let outputBytes = 0;
    let outputTruncated = false;
    for (const line of wanted) {
      const nextBytes = Buffer.byteLength(line, 'utf8') + (bounded.length === 0 ? 0 : 1);
      if (outputBytes + nextBytes > MAX_READ_BYTES) {
        outputTruncated = true;
        break;
      }
      bounded.push(line);
      outputBytes += nextBytes;
    }
    const metadata = describeReadableUtf8Text(raw);
    const unredacted = bounded.join('\n');
    const content = redactSecrets(unredacted);
    return {
      ...metadata,
      content,
      redacted: content !== unredacted,
      raw_sha256: createHash('sha256').update(bytes).digest('hex'),
      offset: start,
      length: bounded.length,
      total_lines: lines.length,
      has_more: start + bounded.length < lines.length,
      truncated: outputTruncated || wanted.length > bounded.length,
    };
  }

  return {
    async open(path) {
      const requested = path.trim();
      if (!requested || !isAbsolute(requested) || requested.includes('\0')) {
        throw new Error('Gateway denied invalid local-machine root');
      }
      if (process.platform === 'win32' && requested.replaceAll('/', '\\').startsWith('\\\\')) {
        throw new Error('Gateway denied unsafe local-machine namespace');
      }
      const observation = await observeLocalMachineWorkspaceIdentity(requested);
      const workspace = store.openWorkspaceRecord({
        ownerId: callerContext.ownerId,
        sessionId: callerContext.sessionId,
        adapterId: callerContext.adapterId,
        canonicalRoot: observation.canonicalRoot,
        backendKind: BACKEND_KIND,
        createdAt: Date.now(),
      });
      workspaceIdentities.record(workspace.workspaceId, observation);
      return {
        workspace_id: workspace.workspaceId,
        root: observation.canonicalRoot,
        authority: { mode: 'AUTONOMOUS_LOCAL', kill_switch: options.killSwitch() ? 'ENGAGED' : 'CLEAR' },
      };
    },

    async describe(workspaceId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      return {
        workspace_id: workspaceId,
        root: workspace.canonicalRoot,
        backend: BACKEND_KIND,
        authority: {
          mode: 'AUTONOMOUS_LOCAL',
          kill_switch: options.killSwitch() ? 'ENGAGED' : 'CLEAR',
        },
      };
    },

    async list(workspaceId, path = '.', maxEntries = 200, depth = 1) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = path === '.' ? '.' : validateReadPath(path);
      const target = safePath === '.'
        ? workspace.canonicalRoot
        : await realpath(resolve(workspace.canonicalRoot, safePath));
      if (safePath !== '.') await assertReadTarget(workspace.canonicalRoot, safePath);
      const limit = Math.min(Math.max(maxEntries, 1), 1_000);
      const maxDepth = Math.min(Math.max(depth, 1), 8);
      const collected: Array<{ name: string; type: string; path?: string; depth?: number }> = [];
      let truncated = false;

      const walk = async (dir: string, relativeBase: string, currentDepth: number): Promise<void> => {
        if (truncated) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (collected.length >= limit) {
            truncated = true;
            break;
          }
          const type = entry.isDirectory() ? 'directory'
            : entry.isFile() ? 'file'
            : entry.isSymbolicLink() ? 'symlink'
            : 'other';
          const rel = relativeBase === '.' ? entry.name : relativeBase + '/' + entry.name;
          collected.push(maxDepth === 1
            ? { name: entry.name, type }
            : { name: entry.name, type, path: rel, depth: currentDepth });
          if (entry.isDirectory() && !entry.isSymbolicLink() && currentDepth < maxDepth) {
            await walk(resolve(dir, entry.name), rel, currentDepth + 1);
          }
        }
      };

      await walk(target, safePath, 1);
      return { path: safePath, depth: maxDepth, entries: collected, truncated };
    },

    async search(workspaceId, query, searchOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      if (
        !query
        || query.includes('\0')
        || query.includes('\r')
        || query.includes('\n')
        || Buffer.byteLength(query, 'utf8') > 256
      ) {
        throw new Error('Gateway denied search query');
      }
      const maxResults = Math.min(Math.max(searchOptions.maxResults ?? 20, 1), MAX_SEARCH_RESULTS);
      const contextLines = Math.min(Math.max(searchOptions.contextLines ?? 1, 0), 2);
      const startPath = searchOptions.path === undefined || searchOptions.path === '.'
        ? '.'
        : validateReadPath(searchOptions.path);
      const start = startPath === '.'
        ? workspace.canonicalRoot
        : resolve(workspace.canonicalRoot, startPath);
      if (startPath !== '.') await assertReadTarget(workspace.canonicalRoot, startPath);

      const needle = searchOptions.ignoreCase ? query.toLocaleLowerCase() : query;
      const matches: Array<{
        path: string;
        line: number;
        text: string;
        before: string[];
        after: string[];
      }> = [];
      let visitedFiles = 0;
      let truncated = false;

      const walk = async (dir: string): Promise<void> => {
        if (truncated) return;
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (truncated) break;
          if (entry.isSymbolicLink()) continue;
          const full = resolve(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
            continue;
          }
          if (!entry.isFile()) continue;
          visitedFiles += 1;
          if (visitedFiles > MAX_SEARCH_FILES) {
            truncated = true;
            break;
          }
          const info = await stat(full);
          if (info.size > MAX_READ_BYTES) continue;
          let raw: string;
          try {
            raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(full));
          } catch {
            continue;
          }
          const lines = raw.split(/\r?\n/);
          for (let index = 0; index < lines.length; index += 1) {
            const hay = searchOptions.ignoreCase ? lines[index]!.toLocaleLowerCase() : lines[index]!;
            if (!hay.includes(needle)) continue;
            const rel = relative(workspace.canonicalRoot, full).replaceAll('\\', '/');
            matches.push({
              path: rel,
              line: index + 1,
              text: redactSecrets(lines[index]!),
              before: lines.slice(Math.max(0, index - contextLines), index).map(redactSecrets),
              after: lines.slice(index + 1, index + 1 + contextLines).map(redactSecrets),
            });
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }
          }
        }
      };

      await walk(start);
      return { matches, truncated, visited_files: visitedFiles };
    },

    async info(workspaceId, path = '.') {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = path === '.' ? '.' : validateReadPath(path);
      const target = safePath === '.' ? workspace.canonicalRoot : resolve(workspace.canonicalRoot, safePath);
      if (safePath !== '.') await assertReadTarget(workspace.canonicalRoot, safePath);
      const [meta, real] = await Promise.all([lstat(target), realpath(target)]);
      return {
        path: safePath,
        realpath: real,
        type: meta.isDirectory() ? 'directory'
          : meta.isFile() ? 'file'
          : meta.isSymbolicLink() ? 'symlink'
          : 'other',
        size_bytes: meta.size,
        created_at: meta.birthtime.toISOString(),
        modified_at: meta.mtime.toISOString(),
        mode: meta.mode,
      };
    },

    async read(workspaceId, path, readOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      return readLocalText(workspace.canonicalRoot, path, readOptions);
    },

    async readMany(workspaceId, paths, readOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_READ_MANY_FILES) {
        throw new Error('Gateway rejected local-machine multi-read file count');
      }
      const files: Array<{ path: string; result?: object; error?: string }> = [];
      for (const path of paths) {
        try {
          files.push({ path, result: await readLocalText(workspace.canonicalRoot, path, readOptions) });
        } catch (error) {
          files.push({ path, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { files };
    },

    async mkdir(workspaceId, path) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = validateReadPath(path);
      assertEffectAllowed();
      await assertCreateTarget(workspace.canonicalRoot, safePath);
      assertEffectAllowed();
      await mkdir(resolve(workspace.canonicalRoot, safePath));
      return { path: safePath, created: true };
    },

    async move(workspaceId, from, to) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const source = validateReadPath(from);
      const target = validateReadPath(to);
      assertEffectAllowed();
      await assertReadTarget(workspace.canonicalRoot, source);
      await assertCreateTarget(workspace.canonicalRoot, target);
      assertEffectAllowed();
      await rename(resolve(workspace.canonicalRoot, source), resolve(workspace.canonicalRoot, target));
      return { from: source, to: target, moved: true };
    },

    async delete(workspaceId, path, recursive = false) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const safePath = validateReadPath(path);
      assertEffectAllowed();
      await assertReadTarget(workspace.canonicalRoot, safePath);
      const target = resolve(workspace.canonicalRoot, safePath);
      const meta = await lstat(target);
      if (meta.isDirectory() && !recursive) {
        const children = await readdir(target);
        if (children.length > 0) throw new Error('Gateway denied non-empty directory delete without recursive=true');
      }
      assertEffectAllowed();
      if (meta.isDirectory() && !recursive) {
        await rmdir(target);
      } else {
        await rm(target, { recursive, force: false });
      }
      return { path: safePath, deleted: true, recursive };
    },

    async commandRun(workspaceId, argv, commandOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      validateArgv(argv);
      assertEffectAllowed();
      const cwd = await resolveCwd(workspace.canonicalRoot, commandOptions.cwd);
      const timeoutMs = Math.min(Math.max(commandOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS, 100), MAX_TIMEOUT_MS);
      const maxOutputTokens = Math.min(
        Math.max(commandOptions.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS, 100),
        MAX_OUTPUT_TOKENS,
      );
      assertEffectAllowed();
      return runBounded(argv, cwd, timeoutMs, maxOutputTokens);
    },

    async processList(workspaceId) {
      await ownedWorkspace(workspaceId);
      if (process.platform !== 'win32') {
        const owned = [...startedProcesses.values()].map((record) => ({
          process_id: record.processId,
          pid: record.pid,
          executable: record.argv[0],
          cwd: record.cwd,
          state: record.state,
          started_at: new Date(record.startedAt).toISOString(),
        }));
        return { processes: owned, owned_only: true };
      }
      const script = [
        "$ErrorActionPreference='Stop'",
        '$p=Get-CimInstance Win32_Process | Select-Object -First 500 ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate',
        '$p | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 2 }',
      ].join('; ');
      const result = await runBounded(
        ['powershell.exe', '-NoLogo', '-NoProfile', '-Command', script],
        process.cwd(),
        15_000,
        MAX_OUTPUT_TOKENS,
      );
      if (result.exitCode !== 0) throw new Error('Gateway process list failed');
      const values: Array<Record<string, unknown>> = [];
      const lines = result.output.split(/\r?\n/).filter(Boolean);
      for (let index = 0; index < lines.length; index += 1) {
        try {
          values.push(JSON.parse(lines[index]!) as Record<string, unknown>);
        } catch {
          if (result.truncated && index === lines.length - 1) break;
          throw new Error('Gateway process list returned invalid data');
        }
      }
      const ownedByPid = new Map([...startedProcesses.values()].map((record) => [record.pid, record]));
      return {
        processes: values.map((value) => {
          const pid = Number(value.ProcessId);
          const owned = ownedByPid.get(pid);
          return {
            pid,
            parent_pid: Number(value.ParentProcessId),
            name: String(value.Name ?? ''),
            executable_path: value.ExecutablePath == null ? undefined : String(value.ExecutablePath),
            creation_date: value.CreationDate == null ? undefined : String(value.CreationDate),
            ...(owned === undefined ? {} : {
              process_id: owned.processId,
              owned: true,
              state: owned.state,
            }),
          };
        }),
        truncated: result.truncated || values.length >= 500,
      };
    },

    async processInspect(workspaceId, idOrPid) {
      await ownedWorkspace(workspaceId);
      const owned = startedProcesses.get(idOrPid);
      if (owned && owned.workspaceId !== workspaceId) throw new Error('Gateway denied process record');
      const observed = observedProcesses.get(idOrPid);
      if (observed && observed.workspaceId !== workspaceId) throw new Error('Gateway denied process record');
      if (!owned && !observed && /^(?:proc|obs)_/.test(idOrPid)) {
        throw new Error('Gateway denied process record');
      }
      const pid = owned ? owned.pid : observed ? observed.pid : Number(idOrPid);
      const value = await inspectPid(pid);
      if (!value) return { found: false, pid };

      let processId = owned?.processId ?? observed?.processId;
      let observedExternal = observed;
      const creationDate = value.CreationDate == null ? undefined : String(value.CreationDate);
      if (!owned && !observed && creationDate) {
        processId = `obs_${randomUUID()}`;
        observedExternal = {
          processId,
          workspaceId,
          pid,
          creationDate,
          observedAt: Date.now(),
        };
        observedProcesses.set(processId, observedExternal);
      }

      return {
        found: true,
        ...(owned === undefined ? {
          ...(processId === undefined ? {} : { process_id: processId }),
          observed: observedExternal !== undefined,
          terminable: observedExternal !== undefined,
        } : {
          process_id: owned.processId,
          owned: true,
          terminable: true,
          state: owned.state,
        }),
        pid,
        parent_pid: Number(value.ParentProcessId),
        name: String(value.Name ?? ''),
        executable_path: value.ExecutablePath == null ? undefined : String(value.ExecutablePath),
        creation_date: creationDate,
        command_line: value.CommandLine == null ? undefined : String(value.CommandLine),
      };
    },

    async processStart(workspaceId, argv, commandOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      validateArgv(argv);
      assertEffectAllowed();
      const cwd = await resolveCwd(workspace.canonicalRoot, commandOptions.cwd);
      assertEffectAllowed();
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: sanitizeLocalMachineEnvironment(process.env),
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      const pid = child.pid;
      if (!pid) throw new Error('Gateway local-machine process did not start');
      const processId = `proc_${randomUUID()}`;
      const record: StartedProcess = {
        processId,
        workspaceId,
        pid,
        argv: [...argv],
        cwd,
        startedAt: Date.now(),
        state: 'RUNNING',
      };
      startedProcesses.set(processId, record);
      child.once('exit', (code) => {
        record.state = record.state === 'TERMINATED' ? 'TERMINATED' : 'EXITED';
        record.exitCode = code ?? -1;
      });
      child.unref();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const inspected = await inspectPid(pid).catch(() => undefined);
        if (inspected) {
          record.creationDate = inspected.CreationDate == null ? undefined : String(inspected.CreationDate);
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
      return { process_id: processId, pid, cwd, started: true };
    },

    async processTerminate(workspaceId, processId) {
      await ownedWorkspace(workspaceId);
      const owned = startedProcesses.get(processId);
      const observed = observedProcesses.get(processId);
      if (owned && owned.workspaceId !== workspaceId) throw new Error('Gateway denied process record');
      if (observed && observed.workspaceId !== workspaceId) throw new Error('Gateway denied process record');
      if (!owned && !observed) throw new Error('Gateway denied process record');
      if (observed && Date.now() - observed.observedAt > MAX_PROCESS_OBSERVATION_MS) {
        observedProcesses.delete(processId);
        throw new Error('Gateway denied expired process observation; inspect the PID again');
      }

      assertEffectAllowed();
      const pid = owned?.pid ?? observed!.pid;
      const inspected = await inspectPid(pid);
      if (!inspected) {
        if (owned) owned.state = 'EXITED';
        observedProcesses.delete(processId);
        return { process_id: processId, pid, terminated: false, state: 'EXITED' };
      }
      const liveCreation = inspected.CreationDate == null ? undefined : String(inspected.CreationDate);
      const expectedCreation = owned?.creationDate ?? observed?.creationDate;
      if (!expectedCreation || !liveCreation || expectedCreation !== liveCreation) {
        throw new Error('Gateway denied process PID reuse or missing creation identity');
      }

      assertEffectAllowed();
      if (process.platform === 'win32') {
        const result = await runBounded(
          ['taskkill.exe', '/PID', String(pid), '/T', '/F'],
          process.cwd(),
          10_000,
          2_000,
        );
        if (result.exitCode !== 0) throw new Error('Gateway process termination failed');
      } else {
        if (observed) throw new Error('Gateway denied external process termination without creation identity');
        process.kill(pid, 'SIGTERM');
      }
      if (owned) owned.state = 'TERMINATED';
      observedProcesses.delete(processId);
      return {
        process_id: processId,
        pid,
        terminated: true,
        state: 'TERMINATED',
        observed: observed !== undefined,
      };
    },

    async terminalOpen(workspaceId, shell = 'powershell', requestedCwd) {
      const { workspace } = await ownedWorkspace(workspaceId);
      assertEffectAllowed();
      const cwd = await resolveCwd(workspace.canonicalRoot, requestedCwd);
      let argv: string[];
      if (shell === 'powershell') {
        if (process.platform !== 'win32') throw new Error('Gateway denied unavailable shell');
        argv = ['powershell.exe', '-NoLogo', '-NoProfile'];
      } else if (shell === 'cmd') {
        if (process.platform !== 'win32') throw new Error('Gateway denied unavailable shell');
        argv = ['cmd.exe', '/d', '/q'];
      } else {
        argv = ['bash', '--noprofile', '--norc'];
      }
      assertEffectAllowed();
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd,
        env: sanitizeLocalMachineEnvironment(process.env),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!child.pid) throw new Error('Gateway terminal did not start');
      const terminalId = `term_${randomUUID()}`;
      const session: TerminalSession = {
        terminalId,
        workspaceId,
        child,
        cwd,
        startedAt: Date.now(),
        buffer: '',
        truncated: false,
        state: 'RUNNING',
      };
      const append = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        session.buffer += text;
        const bytes = Buffer.byteLength(session.buffer, 'utf8');
        if (bytes > MAX_TERMINAL_BUFFER_BYTES) {
          const keep = Buffer.from(session.buffer, 'utf8').subarray(bytes - MAX_TERMINAL_BUFFER_BYTES);
          session.buffer = keep.toString('utf8');
          session.truncated = true;
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      child.once('exit', (code) => {
        session.state = session.state === 'TERMINATED' ? 'TERMINATED' : 'EXITED';
        session.exitCode = code ?? -1;
      });
      terminals.set(terminalId, session);
      return { terminal_id: terminalId, pid: child.pid, shell, cwd, state: session.state };
    },

    async terminalList(workspaceId) {
      await ownedWorkspace(workspaceId);
      return {
        terminals: [...terminals.values()]
          .filter((session) => session.workspaceId === workspaceId)
          .map((session) => ({
            terminal_id: session.terminalId,
            pid: session.child.pid,
            cwd: session.cwd,
            started_at: new Date(session.startedAt).toISOString(),
            state: session.state,
            exit_code: session.exitCode,
            buffered_bytes: Buffer.byteLength(session.buffer, 'utf8'),
            truncated: session.truncated,
          })),
      };
    },

    async terminalOutput(workspaceId, terminalId) {
      await ownedWorkspace(workspaceId);
      const session = terminal(workspaceId, terminalId);
      const output = redactSecrets(session.buffer);
      const truncated = session.truncated;
      session.buffer = '';
      session.truncated = false;
      return {
        terminal_id: terminalId,
        state: session.state,
        exit_code: session.exitCode,
        output,
        truncated,
      };
    },

    async terminalInput(workspaceId, terminalId, base64) {
      await ownedWorkspace(workspaceId);
      const session = terminal(workspaceId, terminalId);
      assertEffectAllowed();
      if (session.state !== 'RUNNING') throw new Error('Gateway terminal is not running');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Gateway rejected terminal input encoding');
      const payload = Buffer.from(base64, 'base64');
      if (payload.length === 0 || payload.length > MAX_TERMINAL_INPUT_BYTES) {
        throw new Error('Gateway rejected terminal input size');
      }
      assertEffectAllowed();
      await new Promise<void>((resolvePromise, reject) => {
        session.child.stdin.write(payload, (error) => error ? reject(error) : resolvePromise());
      });
      return { terminal_id: terminalId, bytes_written: payload.length, state: session.state };
    },

    async terminalClose(workspaceId, terminalId) {
      await ownedWorkspace(workspaceId);
      const session = terminal(workspaceId, terminalId);
      assertEffectAllowed();
      if (session.state === 'RUNNING') {
        session.state = 'TERMINATED';
        session.child.kill('SIGTERM');
      }
      return { terminal_id: terminalId, state: session.state, closed: true };
    },
  };
}

async function runBounded(
  argv: readonly string[],
  cwd: string,
  timeoutMs: number,
  maxOutputTokens: number,
): Promise<{ exitCode: number; output: string; timedOut: boolean; truncated: boolean; durationMs: number; cwd: string }> {
  const startedAt = Date.now();
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd,
    env: sanitizeLocalMachineEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const maxBytes = maxOutputTokens * 4;
  let output = '';
  let bytes = 0;
  let truncated = false;
  let timedOut = false;
  const append = (chunk: Buffer) => {
    if (truncated) return;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) { truncated = true; return; }
    const part = chunk.subarray(0, remaining);
    output += part.toString('utf8');
    bytes += part.length;
    if (part.length !== chunk.length) truncated = true;
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);
  timer.unref?.();

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? -1));
  }).finally(() => clearTimeout(timer));

  return {
    exitCode,
    output: redactSecrets(output.trimEnd()),
    timedOut,
    truncated,
    durationMs: Date.now() - startedAt,
    cwd,
  };
}

function validateArgv(argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_COMMAND_ARGS) {
    throw new Error('Gateway rejected local-machine argv');
  }
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.includes('\0')
      || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      throw new Error('Gateway rejected local-machine argv');
    }
  }
}

function redactRead<T extends { content: string }>(value: T): T & { redacted: boolean } {
  const content = redactSecrets(value.content);
  return { ...value, content, redacted: content !== value.content };
}
