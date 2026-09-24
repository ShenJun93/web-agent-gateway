import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import type { BrowserDownloadDriver, BrowserDownloadedBytes } from './browser-download.js';

export interface BrowserLevelCdpClient {
  call(
    owner: GatewayAuthority,
    browserSessionId: string,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<unknown>;
  onEvent(
    owner: GatewayAuthority,
    browserSessionId: string,
    method: string,
    listener: (params: Readonly<Record<string, unknown>>) => void,
  ): () => void;
}

export interface BrowserDownloadStorage {
  allocate(owner: GatewayAuthority, browserSessionId: string): Promise<string>;
  read(downloadDirectory: string, guid: string, maxBytes: number): Promise<Uint8Array>;
  cleanup(downloadDirectory: string): Promise<void>;
}

interface DownloadWillBegin {
  readonly guid: string;
  readonly url: string;
  readonly suggestedFilename: string;
}

type DownloadTerminal =
  | { readonly state: 'completed' }
  | { readonly state: 'canceled' };

const GUID = /^[A-Za-z0-9._-]{1,200}$/;
const MAX_DEFAULT_BYTES = 32 * 1024 * 1024;

function parseWillBegin(params: Readonly<Record<string, unknown>>): DownloadWillBegin {
  const { guid, url, suggestedFilename } = params;
  if (typeof guid !== 'string' || !GUID.test(guid)) {
    throw new Error('CDP download guid is invalid');
  }
  if (typeof url !== 'string' || url.length < 1 || url.length > 16 * 1024) {
    throw new Error('CDP download URL is invalid');
  }
  if (typeof suggestedFilename !== 'string' || suggestedFilename.length < 1
      || Buffer.byteLength(suggestedFilename, 'utf8') > 1024
      || /[\u0000-\u001F]/.test(suggestedFilename)) {
    throw new Error('CDP download suggested filename is invalid');
  }
  return { guid, url, suggestedFilename };
}

function parseProgress(params: Readonly<Record<string, unknown>>): { guid: string; terminal?: DownloadTerminal } {
  const guid = params.guid;
  if (typeof guid !== 'string' || !GUID.test(guid)) {
    throw new Error('CDP download progress guid is invalid');
  }
  const state = params.state;
  if (state === 'completed') return { guid, terminal: { state: 'completed' } };
  if (state === 'canceled') return { guid, terminal: { state: 'canceled' } };
  if (state === 'inProgress') return { guid };
  throw new Error('CDP download progress state is invalid');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function createFileBrowserDownloadStorage(options: {
  root: string;
  randomUUID?: () => string;
}): BrowserDownloadStorage {
  if (!isAbsolute(options.root)) throw new Error('Browser download storage root must be absolute');
  const uuid = options.randomUUID ?? randomUUID;
  let rootPromise: Promise<string> | undefined;

  async function root(): Promise<string> {
    if (!rootPromise) {
      rootPromise = (async () => {
        await mkdir(options.root, { recursive: true });
        return realpath(options.root);
      })();
    }
    return rootPromise;
  }

  return {
    async allocate(_owner, _browserSessionId) {
      const base = await root();
      const directory = resolve(base, `capture_${uuid()}`);
      const prefix = `${base}${sep}`;
      const matches = process.platform === 'win32'
        ? directory.toLowerCase().startsWith(prefix.toLowerCase())
        : directory.startsWith(prefix);
      if (!matches) throw new Error('Browser download directory escapes storage root');
      await mkdir(directory);
      return realpath(directory);
    },

    async read(downloadDirectory, guid, maxBytes) {
      if (!GUID.test(guid)) throw new Error('Browser download guid is invalid');
      const directory = await realpath(downloadDirectory);
      const target = resolve(directory, guid);
      const prefix = `${directory}${sep}`;
      const matches = process.platform === 'win32'
        ? target.toLowerCase().startsWith(prefix.toLowerCase())
        : target.startsWith(prefix);
      if (!matches) throw new Error('Browser download target escapes capture directory');

      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Browser download target is not a regular file');
      if (info.size > maxBytes) throw new Error('Browser download exceeds size limit');
      const bytes = await readFile(target);
      if (bytes.length > maxBytes) throw new Error('Browser download exceeds size limit');
      return bytes;
    },

    async cleanup(downloadDirectory) {
      const base = await root();
      const directory = await realpath(downloadDirectory).catch(() => downloadDirectory);
      const prefix = `${base}${sep}`;
      const matches = process.platform === 'win32'
        ? directory.toLowerCase().startsWith(prefix.toLowerCase())
        : directory.startsWith(prefix);
      if (!matches) throw new Error('Browser download cleanup target escapes storage root');
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function createCdpBrowserDownloadDriver(options: {
  client: BrowserLevelCdpClient;
  storage: BrowserDownloadStorage;
  maxBytes?: number;
}): BrowserDownloadDriver {
  const maxBytes = options.maxBytes ?? MAX_DEFAULT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 256 * 1024 * 1024) {
    throw new Error('Browser download maxBytes is invalid');
  }
  const active = new Set<string>();

  return {
    async captureNext(owner, browserSessionId, trigger, timeoutMs): Promise<BrowserDownloadedBytes> {
      if (active.has(browserSessionId)) {
        throw new Error('Browser download capture is already active for this session');
      }
      active.add(browserSessionId);

      let downloadDirectory: string | undefined;
      let unsubscribeBegin: () => void = () => undefined;
      let unsubscribeProgress: () => void = () => undefined;

      try {
        downloadDirectory = await options.storage.allocate(owner, browserSessionId);

        let first: DownloadWillBegin | undefined;
        let terminalResolve!: (value: DownloadTerminal) => void;
        let terminalReject!: (error: Error) => void;
        const terminalPromise = new Promise<DownloadTerminal>((resolvePromise, reject) => {
          terminalResolve = resolvePromise;
          terminalReject = reject;
        });

        unsubscribeBegin = options.client.onEvent(
          owner,
          browserSessionId,
          'Browser.downloadWillBegin',
          (params) => {
            try {
              const observed = parseWillBegin(params);
              if (!first) {
                first = observed;
                return;
              }
              if (first.guid !== observed.guid) {
                terminalReject(new Error('Browser download trigger produced multiple downloads'));
              }
            } catch (error) {
              terminalReject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
        unsubscribeProgress = options.client.onEvent(
          owner,
          browserSessionId,
          'Browser.downloadProgress',
          (params) => {
            try {
              const progress = parseProgress(params);
              if (!first || progress.guid !== first.guid || !progress.terminal) return;
              terminalResolve(progress.terminal);
            } catch (error) {
              terminalReject(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );

        await options.client.call(owner, browserSessionId, 'Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: downloadDirectory,
          eventsEnabled: true,
        });
        await trigger();

        const terminal = await withTimeout(
          terminalPromise,
          timeoutMs,
          'Browser download timed out',
        );
        if (!first) throw new Error('Browser download completed without downloadWillBegin');
        if (terminal.state === 'canceled') throw new Error('Browser download was canceled');

        // allowAndName saves the payload under the CDP download guid. We still read the file bytes
        // from the dedicated capture directory rather than trusting Browser.downloadProgress.filePath:
        // the protocol explicitly says filePath may be absent and does not guarantee file existence.
        const bytes = await options.storage.read(downloadDirectory, first.guid, maxBytes);
        return Object.freeze({
          filename: first.suggestedFilename,
          bytes,
          sourceUrl: first.url,
        });
      } finally {
        unsubscribeProgress();
        unsubscribeBegin();
        active.delete(browserSessionId);
        if (downloadDirectory !== undefined) {
          await options.storage.cleanup(downloadDirectory).catch(() => undefined);
        }
      }
    },
  };
}
