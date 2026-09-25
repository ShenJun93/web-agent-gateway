import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { GatewayAuthority } from '../caller-context.js';
import { HarnessEffectCoordinator } from '../harness-effect-coordinator.js';
import {
  HarnessEffectLedger,
  type HarnessEffectRecord,
} from '../harness-effect-ledger.js';
import type { CanonicalValue } from '../proposal-fingerprint.js';
import { createNodeProcessBackend } from '../process-harness/node-process-backend.js';
import { createProcessPort } from '../process-harness/process-port.js';
import {
  createBrowserPort,
  type BrowserPort,
  type BrowserSessionHandle,
} from './browser-port.js';
import { createFileBrowserProfileStore } from './browser-profile-store.js';
import { createNodeCdpTransport } from './node-cdp-transport.js';
import { createOwnedEdgeCdpBackend } from './owned-edge-cdp-backend.js';
import { createOwnedEdgeLauncher } from './owned-edge-launcher.js';
import {
  createSemanticBrowser,
  type SemanticBrowser,
  type SemanticNode,
} from './semantic-browser.js';
import { waitForLoopbackCdpReady } from './cdp-readiness.js';

export type BrowserMcpAction =
  | { readonly type: 'navigate'; readonly url: string }
  | { readonly type: 'click'; readonly ref: string }
  | { readonly type: 'fill'; readonly ref: string; readonly text: string }
  | { readonly type: 'press'; readonly key: string };

export interface BrowserMcpSession {
  readonly browserSessionId: string;
  readonly profileId: string;
  readonly backend: string;
  readonly processId?: string;
  readonly pid?: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: string;
}

export interface BrowserMcpSnapshot {
  readonly snapshotId: string;
  readonly browserSessionId: string;
  readonly url: string;
  readonly title: string;
  readonly nodes: readonly SemanticNode[];
  readonly truncated: boolean;
}

export interface BrowserMcpContext {
  open(profileId: string): Promise<BrowserMcpSession>;
  describe(browserSessionId: string): Promise<BrowserMcpSession>;
  snapshot(browserSessionId: string): Promise<BrowserMcpSnapshot>;
  exec(
    browserSessionId: string,
    idempotencyKey: string,
    action: BrowserMcpAction,
  ): Promise<HarnessEffectRecord>;
  screenshot(browserSessionId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(browserSessionId: string): Promise<BrowserMcpSession>;
  closeAll(): Promise<void>;
}

const MAX_SNAPSHOT_NODES = 500;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/u, '');
}

function sessionView(handle: BrowserSessionHandle): BrowserMcpSession {
  return Object.freeze({
    browserSessionId: handle.browserSessionId,
    profileId: handle.profileId,
    backend: handle.backend,
    ...(handle.processId === undefined ? {} : { processId: handle.processId }),
    ...(handle.pid === undefined ? {} : { pid: handle.pid }),
    createdAt: handle.createdAt,
    lastSeenAt: handle.lastSeenAt,
    state: handle.state,
  });
}

function boundedNode(node: SemanticNode): SemanticNode {
  return Object.freeze({
    ref: node.ref,
    role: truncateUtf8(node.role, 512),
    name: truncateUtf8(node.name, 1024),
    ...(node.value === undefined ? {} : { value: truncateUtf8(node.value, 2048) }),
    disabled: node.disabled,
    editable: node.editable,
    focusable: node.focusable,
  });
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  server.unref();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('BrowserPort could not allocate a loopback port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('BrowserPort allocated an invalid loopback port');
  }
  return port;
}

function successDigest(action: BrowserMcpAction): string {
  return `sha256_${createHash('sha256').update(JSON.stringify(action), 'utf8').digest('hex')}`;
}

export function createPrivateBrowserMcpContext(options: {
  owner: GatewayAuthority;
  edgeExecutablePath: string;
  profileRoot: string;
  effectStatePath: string;
  killSwitch: () => boolean;
  /** Test-only seam; production omits it and receives the concrete owned-Edge backend. */
  port?: BrowserPort;
  /** Test-only semantic seam paired with port. */
  semantic?: SemanticBrowser;
}): BrowserMcpContext {
  const effects = new HarnessEffectLedger(options.effectStatePath);
  effects.reconcileExecuting();
  const coordinator = new HarnessEffectCoordinator(effects);
  const port = options.port ?? (() => {
    const processes = createProcessPort({
      backend: createNodeProcessBackend(),
      effectAllowed: () => !options.killSwitch(),
    });
    const launcher = createOwnedEdgeLauncher({
      processPort: processes,
      executablePath: options.edgeExecutablePath,
      allocateDebugPort: allocateLoopbackPort,
      waitUntilReady: async (endpointUrl, timeoutMs) => {
        await waitForLoopbackCdpReady({ endpointUrl, timeoutMs });
      },
    });
    return createBrowserPort({
      profileStore: createFileBrowserProfileStore({ root: options.profileRoot }),
      backend: createOwnedEdgeCdpBackend({
        launcher,
        connect: (endpointUrl) => createNodeCdpTransport({ endpointUrl }),
      }),
    });
  })();
  const semantic = options.semantic ?? createSemanticBrowser({ port });
  const sessions = new Set<string>();
  const byProfile = new Map<string, string>();
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new Error('Browser MCP runtime is closed');
  }

  function assertEffectAllowed(): void {
    assertOpen();
    if (options.killSwitch()) throw new Error('Browser MCP effect denied by autonomous stop');
  }

  return {
    async open(profileId) {
      assertEffectAllowed();
      const existing = byProfile.get(profileId);
      if (existing) {
        try {
          return sessionView(await port.describe(options.owner, existing));
        } catch {
          byProfile.delete(profileId);
          sessions.delete(existing);
        }
      }
      const handle = await port.open({ profileId, owner: options.owner });
      sessions.add(handle.browserSessionId);
      byProfile.set(profileId, handle.browserSessionId);
      return sessionView(handle);
    },

    async describe(browserSessionId) {
      assertOpen();
      return sessionView(await port.describe(options.owner, browserSessionId));
    },

    async snapshot(browserSessionId) {
      assertOpen();
      const value = await semantic.snapshot(options.owner, browserSessionId);
      const nodes = value.nodes.slice(0, MAX_SNAPSHOT_NODES).map(boundedNode);
      return Object.freeze({
        snapshotId: value.snapshotId,
        browserSessionId: value.browserSessionId,
        url: truncateUtf8(value.url, 4096),
        title: truncateUtf8(value.title, 1024),
        nodes: Object.freeze(nodes),
        truncated: value.nodes.length > nodes.length,
      });
    },

    async exec(browserSessionId, idempotencyKey, action) {
      assertEffectAllowed();
      return coordinator.execute(
        options.owner,
        idempotencyKey,
        {
          kind: `browser.${action.type}`,
          resourceId: browserSessionId,
          arguments: action as unknown as CanonicalValue,
        },
        async () => {
          assertEffectAllowed();
          switch (action.type) {
            case 'navigate':
              await semantic.navigate(options.owner, browserSessionId, action.url);
              break;
            case 'click':
              await semantic.click(options.owner, browserSessionId, action.ref);
              break;
            case 'fill':
              await semantic.fill(options.owner, browserSessionId, action.ref, action.text);
              break;
            case 'press':
              await semantic.press(options.owner, browserSessionId, action.key);
              break;
          }
          return { status: 'CONFIRMED_SUCCESS', resultDigest: successDigest(action) };
        },
      );
    },

    async screenshot(browserSessionId) {
      assertOpen();
      const image = await port.screenshot(options.owner, browserSessionId);
      const sizeBytes = Buffer.from(image.dataBase64, 'base64').length;
      if (sizeBytes > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds size limit');
      return image;
    },

    async close(browserSessionId) {
      assertOpen();
      const handle = await port.close(options.owner, browserSessionId);
      sessions.delete(browserSessionId);
      if (byProfile.get(handle.profileId) === browserSessionId) byProfile.delete(handle.profileId);
      return sessionView(handle);
    },

    async closeAll() {
      if (closed) return;
      closed = true;
      for (const browserSessionId of [...sessions]) {
        await port.close(options.owner, browserSessionId).catch(() => undefined);
      }
      sessions.clear();
      byProfile.clear();
      effects.close();
    },
  };
}
