import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import {
  lstat,
  mkdir,
  realpath,
  writeFile,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 16 * 1024 * 1024;
const DEFAULT_PDF_PAGES = 10;
const MAX_PDF_PAGES = 50;
const DEFAULT_PDF_CHARS = 64 * 1024;
const MAX_PDF_CHARS = 256 * 1024;
const PDF_WORKER_TIMEOUT_MS = 20_000;
const MAX_PDF_WORKER_OUTPUT_BYTES = 512 * 1024;
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
interface SearchCursorPayload {
  version: 1;
  rootHash: string;
  query: string;
  path: string;
  ignoreCase: boolean;
  contextLines: number;
  skipFiles: number;
  skipLine: number | null;
}

export interface LocalMachineReadOptions {
  offset?: number;
  length?: number;
}

export interface LocalMachinePdfExtractOptions {
  startPage?: number;
  maxPages?: number;
  maxChars?: number;
}

interface PdfWorkerPage {
  page: number;
  text: string;
}

interface PdfWorkerResult {
  pageCount: number;
  startPage: number;
  pages: PdfWorkerPage[];
  chars: number;
  hasMore: boolean;
  truncated: boolean;
  sha256: string;
}

async function runPdfWorker(
  target: string,
  startPage: number,
  maxPages: number,
  maxChars: number,
): Promise<PdfWorkerResult> {
  const jsWorker = fileURLToPath(new URL('./pdf-text-worker.js', import.meta.url));
  const workerArgv = existsSync(jsWorker)
    ? [jsWorker, target, String(startPage), String(maxPages), String(maxChars)]
    : [
        '--import',
        import.meta.resolve('tsx'),
        fileURLToPath(new URL('./pdf-text-worker.ts', import.meta.url)),
        target,
        String(startPage),
        String(maxPages),
        String(maxChars),
      ];

  const child = spawn(process.execPath, workerArgv, {
    cwd: dirname(target),
    env: sanitizeLocalMachineEnvironment(process.env),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let overflow = false;
  let timedOut = false;
  const append = (kind: 'stdout' | 'stderr', chunk: Buffer) => {
    if (overflow) return;
    const remaining = MAX_PDF_WORKER_OUTPUT_BYTES - outputBytes;
    if (remaining <= 0) {
      overflow = true;
      child.kill('SIGKILL');
      return;
    }
    const part = chunk.subarray(0, remaining);
    outputBytes += part.length;
    if (kind === 'stdout') stdout += part.toString('utf8');
    else stderr += part.toString('utf8');
    if (part.length !== chunk.length) {
      overflow = true;
      child.kill('SIGKILL');
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
  child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, PDF_WORKER_TIMEOUT_MS);
  timer.unref?.();

  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? -1));
  }).finally(() => clearTimeout(timer));

  if (timedOut) throw new Error('Gateway PDF extraction timed out');
  if (overflow) throw new Error('Gateway PDF extraction output exceeded limit');
  if (exitCode !== 0) {
    const detail = redactSecrets((stderr || stdout).trim()).slice(0, 1024);
    throw new Error('Gateway PDF extraction failed' + (detail ? ': ' + detail : ''));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Gateway rejected invalid PDF worker output');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Gateway rejected invalid PDF worker output');
  const value = parsed as Partial<PdfWorkerResult>;
  if (!Number.isInteger(value.pageCount) || (value.pageCount ?? -1) < 0
    || !Number.isInteger(value.startPage) || (value.startPage ?? 0) < 1
    || !Array.isArray(value.pages)
    || !Number.isInteger(value.chars) || (value.chars ?? -1) < 0
    || typeof value.hasMore !== 'boolean'
    || typeof value.truncated !== 'boolean'
    || typeof value.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error('Gateway rejected invalid PDF worker output');
  }
  for (const page of value.pages) {
    if (!page || typeof page !== 'object'
      || !Number.isInteger((page as PdfWorkerPage).page)
      || (page as PdfWorkerPage).page < 1
      || typeof (page as PdfWorkerPage).text !== 'string') {
      throw new Error('Gateway rejected invalid PDF worker page');
    }
  }
  return value as PdfWorkerResult;
}

function isPdfBytes(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
}

export interface LocalMachineImageRead {
  path: string;
  mime_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  size_bytes: number;
  sha256: string;
  data_base64: string;
}

interface StartedProcess {
  readonly processId: string;
  readonly workspaceRoot: string;
  readonly pid: number;
  readonly executable: string;
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

interface PersistentTerminalStatus {
  version: 1;
  terminal_id: string;
  workspace_root: string;
  broker_pid: number;
  shell_pid: number;
  shell: 'powershell' | 'cmd' | 'bash';
  cwd: string;
  started_at: string;
  state: 'RUNNING' | 'EXITED' | 'TERMINATED';
  exit_code?: number;
  port: number;
}

export interface LocalMachineContext {
  open(path: string): Promise<object>;
  describe(workspaceId: string): Promise<object>;
  list(workspaceId: string, path?: string, maxEntries?: number, depth?: number): Promise<object>;
  search(workspaceId: string, query: string, options?: LocalMachineSearchOptions): Promise<object>;
  searchContinue(workspaceId: string, cursor: string, maxResults?: number): Promise<object>;
  info(workspaceId: string, path?: string): Promise<object>;
  read(workspaceId: string, path: string, options?: LocalMachineReadOptions): Promise<object>;
  readMany(workspaceId: string, paths: readonly string[], options?: LocalMachineReadOptions): Promise<object>;
  readImage(workspaceId: string, path: string): Promise<LocalMachineImageRead>;
  extractPdf(workspaceId: string, path: string, options?: LocalMachinePdfExtractOptions): Promise<object>;
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
  processRegistryPath?: string;
  terminalRegistryPath?: string;
}): LocalMachineContext {
  const { store, callerContext, workspaceIdentities } = options;
  const startedProcesses = loadStartedProcessRegistry(options.processRegistryPath);
  const observedProcesses = new Map<string, ObservedProcess>();
  const terminals = new Map<string, TerminalSession>();

  function sameCanonicalRoot(left: string, right: string): boolean {
    return process.platform === 'win32'
      ? left.toLowerCase() === right.toLowerCase()
      : left === right;
  }

  function persistStartedProcesses(): void {
    if (!options.processRegistryPath) return;
    const records = [...startedProcesses.values()]
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-200);
    const payload = JSON.stringify({ version: 1, records }, null, 2) + '\n';
    const temp = options.processRegistryPath + '.tmp';
    writeFileSync(temp, payload, { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, options.processRegistryPath);
  }

  function ownedProcessForWorkspace(
    record: StartedProcess | undefined,
    workspace: WorkspaceRecord,
  ): StartedProcess | undefined {
    return record && sameCanonicalRoot(record.workspaceRoot, workspace.canonicalRoot)
      ? record
      : undefined;
  }

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

  function terminalBrokerScript(): { argv: string[] } {
    const modulePath = fileURLToPath(import.meta.url);
    const sourceMode = modulePath.endsWith('.ts');
    const brokerPath = resolve(dirname(modulePath), sourceMode
      ? 'local-terminal-broker.ts'
      : 'local-terminal-broker.js');
    return {
      argv: sourceMode
        ? [process.execPath, '--import', import.meta.resolve('tsx'), brokerPath]
        : [process.execPath, brokerPath],
    };
  }

  function persistentTerminalDir(terminalId: string): string {
    if (!options.terminalRegistryPath) throw new Error('Gateway terminal registry is unavailable');
    if (!/^term_[A-Za-z0-9-]+$/.test(terminalId)) throw new Error('Gateway denied terminal session');
    return join(options.terminalRegistryPath, terminalId);
  }

  async function readPersistentTerminalStatus(terminalId: string): Promise<PersistentTerminalStatus> {
    const path = join(persistentTerminalDir(terminalId), 'status.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      throw new Error('Gateway denied terminal session');
    }
    const status = parsed as Partial<PersistentTerminalStatus>;
    if (status.version !== 1
      || status.terminal_id !== terminalId
      || !isAbsolute(status.workspace_root ?? '')
      || !Number.isSafeInteger(status.broker_pid) || (status.broker_pid ?? 0) <= 0
      || !Number.isSafeInteger(status.shell_pid) || (status.shell_pid ?? 0) <= 0
      || !Number.isSafeInteger(status.port) || (status.port ?? 0) <= 0 || (status.port ?? 0) > 65_535
      || !['powershell', 'cmd', 'bash'].includes(status.shell ?? '')
      || !['RUNNING', 'EXITED', 'TERMINATED'].includes(status.state ?? '')
      || !isAbsolute(status.cwd ?? '')
      || typeof status.started_at !== 'string') {
      throw new Error('Gateway denied invalid terminal registry');
    }
    return status as PersistentTerminalStatus;
  }

  async function persistentTerminalRequest(
    workspace: WorkspaceRecord,
    terminalId: string,
    request: { op: 'status' | 'output' | 'input' | 'close'; base64?: string },
  ): Promise<Record<string, unknown>> {
    const status = await readPersistentTerminalStatus(terminalId);
    if (!sameCanonicalRoot(status.workspace_root, workspace.canonicalRoot)) {
      throw new Error('Gateway denied terminal session');
    }
    let token: string;
    try {
      const raw = (await readFile(join(persistentTerminalDir(terminalId), 'token.txt'), 'utf8')).trim();
      token = raw.startsWith('TERMINAL_TOKEN=') ? raw.slice('TERMINAL_TOKEN='.length) : '';
    } catch {
      throw new Error('Gateway denied terminal session');
    }
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Gateway denied terminal session');

    const payload = JSON.stringify({ token, ...request }) + '\n';
    const response = await new Promise<string>((resolvePromise, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: status.port });
      let output = '';
      const timer = setTimeout(() => {
        socket.destroy(new Error('terminal broker timeout'));
      }, 5_000);
      timer.unref?.();
      socket.setEncoding('utf8');
      socket.once('connect', () => socket.write(payload));
      socket.on('data', (chunk) => {
        output += chunk;
        if (Buffer.byteLength(output, 'utf8') > 128 * 1024) {
          socket.destroy(new Error('terminal broker response too large'));
        }
      });
      socket.once('error', reject);
      socket.once('end', () => {
        clearTimeout(timer);
        resolvePromise(output);
      });
    });
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(response.trim()) as Record<string, unknown>; }
    catch { throw new Error('Gateway terminal broker returned invalid response'); }
    if (parsed.ok !== true) throw new Error('Gateway terminal broker refused request');
    return parsed;
  }

  async function listPersistentTerminals(workspace: WorkspaceRecord): Promise<object[]> {
    if (!options.terminalRegistryPath) return [];
    let entries;
    try {
      entries = await readdir(options.terminalRegistryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const result: object[] = [];
    for (const entry of entries.slice(0, 200)) {
      if (!entry.isDirectory() || !/^term_[A-Za-z0-9-]+$/.test(entry.name)) continue;
      try {
        const status = await readPersistentTerminalStatus(entry.name);
        if (!sameCanonicalRoot(status.workspace_root, workspace.canonicalRoot)) continue;
        result.push({
          terminal_id: status.terminal_id,
          pid: status.shell_pid,
          broker_pid: status.broker_pid,
          cwd: status.cwd,
          started_at: status.started_at,
          state: status.state,
          exit_code: status.exit_code,
          shell: status.shell,
          persistent: true,
        });
      } catch {
        // Ignore malformed or incomplete broker directories in listing; direct access still fails.
      }
    }
    return result;
  }

  async function extractPdfBytes(
    safePath: string,
    target: string,
    bytes: Buffer,
    options: LocalMachinePdfExtractOptions = {},
  ): Promise<object> {
    if (bytes.length > MAX_PDF_BYTES) throw new Error('Gateway rejected local-machine PDF exceeds 16 MiB');
    if (!isPdfBytes(bytes)) throw new Error('Gateway rejected target is not a PDF');

    const startPage = options.startPage ?? 1;
    const maxPages = options.maxPages ?? DEFAULT_PDF_PAGES;
    const maxChars = options.maxChars ?? DEFAULT_PDF_CHARS;
    if (!Number.isInteger(startPage) || startPage < 1 || startPage > 1_000_000) {
      throw new Error('Gateway rejected PDF start page');
    }
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PDF_PAGES) {
      throw new Error('Gateway rejected PDF page limit');
    }
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_PDF_CHARS) {
      throw new Error('Gateway rejected PDF character limit');
    }

    const result = await runPdfWorker(target, startPage, maxPages, maxChars);
    const rawSha256 = createHash('sha256').update(bytes).digest('hex');
    if (result.sha256 !== rawSha256) throw new Error('Gateway rejected PDF worker identity mismatch');

    let redacted = false;
    const pages = result.pages.map((page) => {
      const pageText = redactSecrets(page.text);
      if (pageText !== page.text) redacted = true;
      return { page: page.page, text: pageText };
    });
    return {
      path: safePath,
      mime_type: 'application/pdf',
      size_bytes: bytes.length,
      raw_sha256: rawSha256,
      page_count: result.pageCount,
      start_page: result.startPage,
      extracted_pages: pages.length,
      extracted_chars: result.chars,
      pages,
      content: pages.map((page) => page.text).join('\n\n'),
      has_more: result.hasMore,
      truncated: result.truncated,
      redacted,
    };
  }

  async function readLocalPdf(
    root: string,
    path: string,
    options: LocalMachinePdfExtractOptions = {},
  ): Promise<object> {
    const safePath = validateReadPath(path);
    await assertReadTarget(root, safePath);
    const target = await realpath(resolve(root, safePath));
    const meta = await stat(target);
    if (!meta.isFile()) throw new Error('Gateway rejected local-machine PDF target is not a file');
    if (meta.size > MAX_PDF_BYTES) throw new Error('Gateway rejected local-machine PDF exceeds 16 MiB');
    const bytes = await readFile(target);
    return extractPdfBytes(safePath, target, bytes, options);
  }

  async function readLocalText(root: string, path: string, readOptions: LocalMachineReadOptions = {}): Promise<object> {
    const safePath = validateReadPath(path);
    await assertReadTarget(root, safePath);
    const target = await realpath(resolve(root, safePath));
    const bytes = await readFile(target);
    if (isPdfBytes(bytes)) {
      if (readOptions.offset !== undefined || readOptions.length !== undefined) {
        throw new Error('Gateway rejected line pagination for PDF; use machine.pdf.extract');
      }
      return extractPdfBytes(safePath, target, bytes);
    }
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

  async function readLocalImage(root: string, path: string): Promise<LocalMachineImageRead> {
    const safePath = validateReadPath(path);
    await assertReadTarget(root, safePath);
    const target = await realpath(resolve(root, safePath));
    const meta = await stat(target);
    if (!meta.isFile()) throw new Error('Gateway rejected local-machine image target is not a file');
    if (meta.size > MAX_IMAGE_BYTES) throw new Error('Gateway rejected local-machine image exceeds 4 MiB');
    const bytes = await readFile(target);
    const mime = detectImageMime(bytes);
    if (!mime) throw new Error('Gateway rejected unsupported local-machine image format');
    return {
      path: safePath,
      mime_type: mime,
      size_bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      data_base64: bytes.toString('base64'),
    };
  }

  function validateSearchQuery(query: string): void {
    if (!query || query.includes("\0") || query.includes("\r") || query.includes("\n")
      || Buffer.byteLength(query, 'utf8') > 256) throw new Error('Gateway denied search query');
  }

  function searchRootHash(root: string): string {
    const value = process.platform === 'win32' ? root.toLowerCase() : root;
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  function encodeSearchCursor(value: SearchCursorPayload): string {
    return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  }

  function decodeSearchCursor(cursor: string): SearchCursorPayload {
    if (!cursor || cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Gateway denied search cursor');
    let parsed;
    try { parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); }
    catch { throw new Error('Gateway denied search cursor'); }
    const value = parsed;
    if (value?.version !== 1 || typeof value.rootHash !== "string" || !/^[a-f0-9]{64}$/.test(value.rootHash)
      || typeof value.query !== "string" || typeof value.path !== "string"
      || typeof value.ignoreCase !== "boolean" || !Number.isInteger(value.contextLines)
      || value.contextLines < 0 || value.contextLines > 2 || !Number.isInteger(value.skipFiles)
      || value.skipFiles < 0 || value.skipFiles > 10000000
      || (value.skipLine !== null && (!Number.isInteger(value.skipLine) || value.skipLine < 0 || value.skipLine > 1000000))) {
      throw new Error('Gateway denied search cursor');
    }
    validateSearchQuery(value.query);
    const path = value.path === '.' ? '.' : validateReadPath(value.path);
    return { ...value, path };
  }

  async function searchPage(workspace: WorkspaceRecord, query: string, searchOptions: LocalMachineSearchOptions = {}, resume?: SearchCursorPayload): Promise<object> {
    validateSearchQuery(query);
    const maxResults = Math.min(Math.max(searchOptions.maxResults ?? 20, 1), MAX_SEARCH_RESULTS);
    const contextLines = Math.min(Math.max(searchOptions.contextLines ?? 1, 0), 2);
    const startPath = searchOptions.path === undefined || searchOptions.path === '.' ? '.' : validateReadPath(searchOptions.path);
    const start = startPath === '.' ? workspace.canonicalRoot : resolve(workspace.canonicalRoot, startPath);
    if (startPath !== '.') await assertReadTarget(workspace.canonicalRoot, startPath);
    if (resume && (resume.rootHash !== searchRootHash(workspace.canonicalRoot) || resume.query !== query
      || resume.path !== startPath || resume.ignoreCase !== (searchOptions.ignoreCase ?? false)
      || resume.contextLines !== contextLines)) throw new Error("Gateway denied search cursor workspace/options mismatch");

    const needle = searchOptions.ignoreCase ? query.toLocaleLowerCase() : query;
    const matches: Array<{ path: string; line: number; text: string; before: string[]; after: string[] }> = [];
    let absoluteFiles = 0;
    let visitedFiles = 0;
    let stopped = false;
    let nextCursor: string | undefined;
    const skipFiles = resume?.skipFiles ?? 0;
    const skipLine = resume?.skipLine ?? null;
    const cursorFor = (files: number, line: number | null): string => encodeSearchCursor({
      version: 1, rootHash: searchRootHash(workspace.canonicalRoot), query, path: startPath,
      ignoreCase: searchOptions.ignoreCase ?? false, contextLines, skipFiles: files, skipLine: line,
    });

    const walk = async (dir: string): Promise<void> => {
      if (stopped) return;
      const entries = await readdir(dir, { withFileTypes: true });
      entries.sort((a,b)=>a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (stopped) break;
        if (entry.isSymbolicLink()) continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) { await walk(full); continue; }
        if (!entry.isFile()) continue;
        if (absoluteFiles < skipFiles) { absoluteFiles += 1; continue; }
        if (visitedFiles >= MAX_SEARCH_FILES) { nextCursor = cursorFor(absoluteFiles, null); stopped = true; break; }
        visitedFiles += 1;
        const currentFile = absoluteFiles;
        absoluteFiles += 1;
        const info = await stat(full);
        if (info.size > MAX_READ_BYTES) continue;
        let raw;
        try { raw = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(full)); } catch { continue; }
        const lines = raw.split(/\r?\n/);
        const firstLine = currentFile === skipFiles && skipLine !== null ? Math.min(skipLine + 1, lines.length) : 0;
        for (let index=firstLine; index<lines.length; index+=1) {
          const hay = searchOptions.ignoreCase ? lines[index].toLocaleLowerCase() : lines[index];
          if (!hay.includes(needle)) continue;
          const rel = relative(workspace.canonicalRoot, full).replaceAll('\\', '/');
          matches.push({ path: rel, line: index + 1, text: redactSecrets(lines[index]),
            before: lines.slice(Math.max(0,index-contextLines),index).map(redactSecrets),
            after: lines.slice(index+1,index+1+contextLines).map(redactSecrets) });
          if (matches.length >= maxResults) { nextCursor = cursorFor(currentFile, index); stopped = true; break; }
        }
      }
    };
    await walk(start);
    if (resume && absoluteFiles <= skipFiles && !stopped) throw new Error("Gateway denied stale search cursor");
    return { matches, truncated: nextCursor !== undefined, visited_files: visitedFiles,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }) };
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
      return searchPage(workspace, query, searchOptions);
    },

    async searchContinue(workspaceId, cursor, maxResults) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const resume = decodeSearchCursor(cursor);
      if (resume.rootHash !== searchRootHash(workspace.canonicalRoot)) throw new Error("Gateway denied search cursor workspace/options mismatch");
      return searchPage(workspace, resume.query, { path: resume.path, ignoreCase: resume.ignoreCase,
        contextLines: resume.contextLines, ...(maxResults === undefined ? {} : { maxResults }) }, resume);
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

    async readImage(workspaceId, path) {
      const { workspace } = await ownedWorkspace(workspaceId);
      return readLocalImage(workspace.canonicalRoot, path);
    },

    async extractPdf(workspaceId, path, extractOptions = {}) {
      const { workspace } = await ownedWorkspace(workspaceId);
      return readLocalPdf(workspace.canonicalRoot, path, extractOptions);
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
      const { workspace } = await ownedWorkspace(workspaceId);
      if (process.platform !== 'win32') {
        const owned = [...startedProcesses.values()]
          .filter((record) => sameCanonicalRoot(record.workspaceRoot, workspace.canonicalRoot))
          .map((record) => ({
          process_id: record.processId,
          pid: record.pid,
          executable: record.executable,
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
      const ownedByPid = new Map(
        [...startedProcesses.values()]
          .filter((record) => sameCanonicalRoot(record.workspaceRoot, workspace.canonicalRoot))
          .map((record) => [record.pid, record]),
      );
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
      const { workspace } = await ownedWorkspace(workspaceId);
      const rawOwned = startedProcesses.get(idOrPid);
      const owned = ownedProcessForWorkspace(rawOwned, workspace);
      if (rawOwned && !owned) throw new Error('Gateway denied process record');
      const observed = observedProcesses.get(idOrPid);
      if (observed && observed.workspaceId !== workspaceId) throw new Error('Gateway denied process record');
      if (!owned && !observed && /^(?:proc|obs)_/.test(idOrPid)) {
        throw new Error('Gateway denied process record');
      }
      const pid = owned ? owned.pid : observed ? observed.pid : Number(idOrPid);
      const value = await inspectPid(pid);
      if (!value) {
        if (owned && owned.state === 'RUNNING') {
          owned.state = 'EXITED';
          persistStartedProcesses();
        }
        return { found: false, pid, ...(owned === undefined ? {} : { process_id: owned.processId, state: owned.state }) };
      }

      let processId = owned?.processId ?? observed?.processId;
      let observedExternal = observed;
      const creationDate = value.CreationDate == null ? undefined : String(value.CreationDate);
      if (owned?.creationDate && creationDate && owned.creationDate !== creationDate) {
        owned.state = 'EXITED';
        persistStartedProcesses();
        return {
          found: false,
          process_id: owned.processId,
          pid,
          state: owned.state,
          pid_reused: true,
        };
      }
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
        workspaceRoot: workspace.canonicalRoot,
        pid,
        executable: argv[0]!,
        cwd,
        startedAt: Date.now(),
        state: 'RUNNING',
      };
      startedProcesses.set(processId, record);
      child.once('exit', (code) => {
        record.state = record.state === 'TERMINATED' ? 'TERMINATED' : 'EXITED';
        record.exitCode = code ?? -1;
        persistStartedProcesses();
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
      persistStartedProcesses();
      return { process_id: processId, pid, cwd, started: true, registry_persisted: options.processRegistryPath !== undefined };
    },

    async processTerminate(workspaceId, processId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const rawOwned = startedProcesses.get(processId);
      const owned = ownedProcessForWorkspace(rawOwned, workspace);
      const observed = observedProcesses.get(processId);
      if (rawOwned && !owned) throw new Error('Gateway denied process record');
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
        if (owned) {
          owned.state = 'EXITED';
          persistStartedProcesses();
        }
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
      if (owned) {
        owned.state = 'TERMINATED';
        persistStartedProcesses();
      }
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

      if (options.terminalRegistryPath) {
        if (shell === 'powershell' && process.platform !== 'win32') throw new Error('Gateway denied unavailable shell');
        if (shell === 'cmd' && process.platform !== 'win32') throw new Error('Gateway denied unavailable shell');
        const terminalId = `term_${randomUUID()}`;
        await mkdir(options.terminalRegistryPath, { recursive: true });
        const dir = persistentTerminalDir(terminalId);
        await mkdir(dir, { recursive: false });
        const tokenFile = join(dir, 'token.txt');
        const token = randomBytes(32).toString('hex');
        await writeFile(tokenFile, `TERMINAL_TOKEN=${token}\n`, { encoding: 'utf8', mode: 0o600 });

        const broker = terminalBrokerScript();
        assertEffectAllowed();
        const child = spawn(
          broker.argv[0]!,
          [...broker.argv.slice(1),
            '--dir', dir,
            '--token-file', tokenFile,
            '--shell', shell,
            '--cwd', cwd,
            '--workspace-root', workspace.canonicalRoot,
            '--terminal-id', terminalId],
          {
            cwd,
            env: sanitizeLocalMachineEnvironment(process.env),
            shell: false,
            windowsHide: true,
            detached: true,
            stdio: 'ignore',
          },
        );
        if (!child.pid) throw new Error('Gateway terminal broker did not start');
        child.unref();

        let status: PersistentTerminalStatus | undefined;
        for (let attempt = 0; attempt < 80; attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
          try {
            status = await readPersistentTerminalStatus(terminalId);
            if (status.state === 'RUNNING' && status.port > 0) break;
          } catch {
            // Broker writes status only after the loopback listener is ready.
          }
        }
        if (!status || status.state !== 'RUNNING') {
          try { process.kill(child.pid, 'SIGTERM'); } catch {}
          throw new Error('Gateway terminal broker did not become ready');
        }
        return {
          terminal_id: terminalId,
          pid: status.shell_pid,
          broker_pid: status.broker_pid,
          shell,
          cwd,
          state: status.state,
          persistent: true,
        };
      }

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
      return { terminal_id: terminalId, pid: child.pid, shell, cwd, state: session.state, persistent: false };
    },

    async terminalList(workspaceId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      const persistent = await listPersistentTerminals(workspace);
      return {
        terminals: [
          ...persistent,
          ...[...terminals.values()]
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
              persistent: false,
            })),
        ],
      };
    },

    async terminalOutput(workspaceId, terminalId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      if (options.terminalRegistryPath) {
        return persistentTerminalRequest(workspace, terminalId, { op: 'output' });
      }
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
      const { workspace } = await ownedWorkspace(workspaceId);
      assertEffectAllowed();
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Gateway rejected terminal input encoding');
      const payload = Buffer.from(base64, 'base64');
      if (payload.length === 0 || payload.length > MAX_TERMINAL_INPUT_BYTES) {
        throw new Error('Gateway rejected terminal input size');
      }
      assertEffectAllowed();
      if (options.terminalRegistryPath) {
        return persistentTerminalRequest(workspace, terminalId, { op: 'input', base64 });
      }
      const session = terminal(workspaceId, terminalId);
      if (session.state !== 'RUNNING') throw new Error('Gateway terminal is not running');
      await new Promise<void>((resolvePromise, reject) => {
        session.child.stdin.write(payload, (error) => error ? reject(error) : resolvePromise());
      });
      return { terminal_id: terminalId, bytes_written: payload.length, state: session.state };
    },

    async terminalClose(workspaceId, terminalId) {
      const { workspace } = await ownedWorkspace(workspaceId);
      assertEffectAllowed();
      if (options.terminalRegistryPath) {
        const status = await readPersistentTerminalStatus(terminalId);
        if (!sameCanonicalRoot(status.workspace_root, workspace.canonicalRoot)) {
          throw new Error('Gateway denied terminal session');
        }
        const result = await persistentTerminalRequest(workspace, terminalId, { op: 'close' });

        let brokerAlive = true;
        let shellAlive = true;
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && (brokerAlive || shellAlive)) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
          [brokerAlive, shellAlive] = await Promise.all([
            inspectPid(status.broker_pid).then((value) => value !== undefined),
            inspectPid(status.shell_pid).then((value) => value !== undefined),
          ]);
        }
        if (brokerAlive || shellAlive) {
          throw new Error('Gateway terminal did not terminate cleanly');
        }
        await rm(persistentTerminalDir(terminalId), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 50,
        });
        return result;
      }
      const session = terminal(workspaceId, terminalId);
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

function loadStartedProcessRegistry(path: string | undefined): Map<string, StartedProcess> {
  const records = new Map<string, StartedProcess>();
  if (!path) return records;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return records;
    throw new Error('Gateway rejected invalid local process registry');
  }
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { records?: unknown }).records)) {
    throw new Error('Gateway rejected invalid local process registry');
  }
  for (const value of (parsed as { records: unknown[] }).records) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Partial<StartedProcess>;
    if (!/^proc_[A-Za-z0-9-]+$/.test(record.processId ?? '')
      || !isAbsolute(record.workspaceRoot ?? '')
      || !Number.isSafeInteger(record.pid) || (record.pid ?? 0) <= 0
      || typeof record.executable !== 'string' || record.executable.length === 0
      || !isAbsolute(record.cwd ?? '')
      || !Number.isFinite(record.startedAt)
      || !['RUNNING', 'EXITED', 'TERMINATED'].includes(record.state ?? '')) {
      continue;
    }
    records.set(record.processId!, {
      processId: record.processId!,
      workspaceRoot: record.workspaceRoot!,
      pid: record.pid!,
      executable: record.executable!,
      cwd: record.cwd!,
      startedAt: record.startedAt!,
      ...(typeof record.creationDate === 'string' ? { creationDate: record.creationDate } : {}),
      state: record.state as StartedProcess['state'],
      ...(Number.isInteger(record.exitCode) ? { exitCode: record.exitCode } : {}),
    });
  }
  return records;
}

function detectImageMime(bytes: Buffer): LocalMachineImageRead['mime_type'] | undefined {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 6) {
    const signature = bytes.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  return undefined;
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
