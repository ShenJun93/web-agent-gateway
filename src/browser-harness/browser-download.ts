import type { ArtifactHandle } from '../artifact-harness/artifact-port.js';
import type { GatewayAuthority } from '../caller-context.js';

export interface BrowserDownloadedBytes {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly sourceUrl?: string;
}

export interface BrowserDownloadDriver {
  captureNext(
    owner: GatewayAuthority,
    browserSessionId: string,
    trigger: () => Promise<void>,
    timeoutMs: number,
  ): Promise<BrowserDownloadedBytes>;
}

export interface ArtifactByteWriter {
  createBytes(
    owner: GatewayAuthority,
    filename: string,
    bytes: Uint8Array,
  ): Promise<ArtifactHandle>;
}

export interface BrowserDownloadController {
  download(
    owner: GatewayAuthority,
    browserSessionId: string,
    trigger: () => Promise<void>,
    options?: { readonly timeoutMs?: number },
  ): Promise<ArtifactHandle>;
}

export function createBrowserDownloadController(options: {
  driver: BrowserDownloadDriver;
  artifacts: ArtifactByteWriter;
  defaultTimeoutMs?: number;
}): BrowserDownloadController {
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  if (!Number.isInteger(defaultTimeoutMs) || defaultTimeoutMs < 1_000 || defaultTimeoutMs > 120_000) {
    throw new Error('Browser download default timeout is invalid');
  }

  return {
    async download(owner, browserSessionId, trigger, request = {}) {
      if (typeof trigger !== 'function') throw new Error('Browser download trigger is invalid');
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) {
        throw new Error('Browser download timeout is invalid');
      }
      const downloaded = await options.driver.captureNext(
        owner,
        browserSessionId,
        trigger,
        timeoutMs,
      );
      if (typeof downloaded.filename !== 'string' || downloaded.filename.length === 0) {
        throw new Error('Browser download filename is invalid');
      }
      if (!(downloaded.bytes instanceof Uint8Array)) {
        throw new Error('Browser download bytes are invalid');
      }
      return options.artifacts.createBytes(owner, downloaded.filename, downloaded.bytes);
    },
  };
}
