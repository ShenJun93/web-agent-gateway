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
  type BrowserOpenMode,
  type BrowserPort,
  type BrowserSessionHandle,
} from './browser-port.js';
import {
  createBrowserBroker,
  resolveBrowserOpenMode,
  type BrowserBroker,
} from './browser-broker.js';
import {
  createAttachedExistingBrowserPort,
  type AttachedExistingBrowserPort,
} from './attached-existing-browser-port.js';
import { BrowserTargetClaimStore } from './browser-target-claim-store.js';
import {
  createExistingBrowserControlClient,
  type ExistingBrowserControlClient,
} from './existing-browser-control-client.js';
import type { ExistingBrowserTarget } from '../browser-adapter/existing-browser-control-protocol.js';
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
  | { readonly type: 'press'; readonly key: string }
  | { readonly type: 'pause_for_user' }
  | { readonly type: 'take_user_control' }
  | { readonly type: 'resume_automation' };

export interface BrowserMcpSession {
  readonly browserSessionId: string;
  readonly profileId: string;
  readonly backend: string;
  readonly executionMode?: string;
  readonly ownershipMode?: string;
  readonly controlState?: string;
  readonly groupId?: string;
  readonly groupTitle?: string;
  readonly rootTargetId?: string;
  readonly targetId?: string;
  readonly targetGeneration?: number;
  readonly claimEpoch?: number;
  readonly claimExpiresAt?: number;
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

export interface BrowserMcpEffect {
  readonly effectId: string;
  readonly kind: string;
  readonly resourceId: string;
  readonly planFingerprint: string;
  readonly state: HarnessEffectRecord['state'];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attemptId?: string;
  readonly resultDigest?: string;
  readonly errorClass?: string;
}

export interface BrowserMcpContext {
  targets(): Promise<readonly ExistingBrowserTarget[]>;
  open(profileId: string, mode?: BrowserOpenMode, targetId?: string, groupTitle?: string): Promise<BrowserMcpSession>;
  describe(browserSessionId: string): Promise<BrowserMcpSession>;
  snapshot(browserSessionId: string): Promise<BrowserMcpSnapshot>;
  exec(
    browserSessionId: string,
    idempotencyKey: string,
    action: BrowserMcpAction,
  ): Promise<BrowserMcpEffect>;
  effect(effectId: string): Promise<BrowserMcpEffect>;
  screenshot(browserSessionId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(browserSessionId: string): Promise<BrowserMcpSession>;
  pauseForUser(browserSessionId: string): Promise<BrowserMcpSession>;
  takeUserControl(browserSessionId: string): Promise<BrowserMcpSession>;
  resumeAutomation(browserSessionId: string): Promise<BrowserMcpSession>;
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
    ...(handle.executionMode === undefined ? {} : { executionMode: handle.executionMode }),
    ...(handle.ownershipMode === undefined ? {} : { ownershipMode: handle.ownershipMode }),
    ...(handle.controlState === undefined ? {} : { controlState: handle.controlState }),
    ...(handle.groupId === undefined ? {} : { groupId: handle.groupId }),
    ...(handle.groupTitle === undefined ? {} : { groupTitle: handle.groupTitle }),
    ...(handle.rootTargetId === undefined ? {} : { rootTargetId: handle.rootTargetId }),
    ...(handle.targetId === undefined ? {} : { targetId: handle.targetId }),
    ...(handle.targetGeneration === undefined ? {} : { targetGeneration: handle.targetGeneration }),
    ...(handle.claimEpoch === undefined ? {} : { claimEpoch: handle.claimEpoch }),
    ...(handle.claimExpiresAt === undefined ? {} : { claimExpiresAt: handle.claimExpiresAt }),
    ...(handle.processId === undefined ? {} : { processId: handle.processId }),
    ...(handle.pid === undefined ? {} : { pid: handle.pid }),
    createdAt: handle.createdAt,
    lastSeenAt: handle.lastSeenAt,
    state: handle.state,
  });
}

function effectView(value: HarnessEffectRecord): BrowserMcpEffect {
  return Object.freeze({
    effectId: value.effectId,
    kind: value.kind,
    resourceId: value.resourceId,
    planFingerprint: value.planFingerprint,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(value.attemptId === undefined ? {} : { attemptId: value.attemptId }),
    ...(value.resultDigest === undefined ? {} : { resultDigest: value.resultDigest }),
    ...(value.errorClass === undefined ? {} : { errorClass: value.errorClass }),
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
  targetClaimStatePath?: string;
  killSwitch: () => boolean;
  controlDiscoveryPath?: string;
  control?: ExistingBrowserControlClient;
  /** Test-only seam; production omits it and receives the concrete owned-Edge backend. */
  port?: BrowserPort;
  /** Test-only semantic seam paired with port. */
  semantic?: SemanticBrowser;
}): BrowserMcpContext {
  const effects = new HarnessEffectLedger(options.effectStatePath);
  effects.reconcileExecuting();
  const coordinator = new HarnessEffectCoordinator(effects);
  let broker: BrowserBroker | undefined;
  let control: ExistingBrowserControlClient | undefined;
  let targetClaims: BrowserTargetClaimStore | undefined;
  let attachedPort: AttachedExistingBrowserPort | undefined;
  const port = options.port ?? (() => {
    const processes = createProcessPort({
      backend: createNodeProcessBackend(),
      effectAllowed: () => !options.killSwitch(),
    });
    const profileStore = createFileBrowserProfileStore({ root: options.profileRoot });
    const launch = (
      executionMode: 'WAG_HEADLESS' | 'WAG_VISIBLE',
    ) => createOwnedEdgeLauncher({
      processPort: processes,
      executablePath: options.edgeExecutablePath,
      allocateDebugPort: allocateLoopbackPort,
      executionMode,
      waitUntilReady: async (endpointUrl, timeoutMs) => {
        await waitForLoopbackCdpReady({ endpointUrl, timeoutMs });
      },
    });
    const managed = (executionMode: 'WAG_HEADLESS' | 'WAG_VISIBLE') => createBrowserPort({
      profileStore,
      executionMode,
      backend: createOwnedEdgeCdpBackend({
        launcher: launch(executionMode),
        connect: (endpointUrl) => createNodeCdpTransport({ endpointUrl }),
      }),
    });
    control = options.control ?? (options.controlDiscoveryPath === undefined
      ? undefined
      : createExistingBrowserControlClient({ discoveryPath: options.controlDiscoveryPath }));
    if (control !== undefined) {
      targetClaims = new BrowserTargetClaimStore(
        options.targetClaimStatePath ?? options.effectStatePath + '.target-claims.sqlite',
      );
      attachedPort = createAttachedExistingBrowserPort({
        control,
        claims: targetClaims,
      });
    }
    broker = createBrowserBroker({
      headless: managed('WAG_HEADLESS'),
      visible: managed('WAG_VISIBLE'),
      ...(attachedPort === undefined ? {} : { attached: attachedPort }),
    });
    return broker;
  })();
  const semantic = options.semantic ?? createSemanticBrowser({ port });
  const sessions = new Set<string>();
  const byProfile = new Map<string, string>();
  const fencing = new Map<string, { targetId: string; claimEpoch: number }>();
  let closed = false;

  function rememberFencing(handle: BrowserSessionHandle): void {
    if (handle.targetId !== undefined && handle.claimEpoch !== undefined) {
      fencing.set(handle.browserSessionId, {
        targetId: handle.targetId,
        claimEpoch: handle.claimEpoch,
      });
    } else {
      fencing.delete(handle.browserSessionId);
    }
  }

  function assertOpen(): void {
    if (closed) throw new Error('Browser MCP runtime is closed');
  }

  function assertEffectAllowed(): void {
    assertOpen();
    if (options.killSwitch()) throw new Error('Browser MCP effect denied by autonomous stop');
  }

  return {
    async targets() {
      assertOpen();
      if (!control) throw new Error('Existing browser control host is not configured');
      return control.listTargets();
    },

    async open(profileId, mode, targetId, groupTitle) {
      assertEffectAllowed();
      const resolvedMode = resolveBrowserOpenMode(mode);
      if ((resolvedMode === 'ATTACH_EXISTING' || resolvedMode === 'AI_TAB_GROUP') && !targetId) {
        throw new Error(resolvedMode + ' requires target_id');
      }
      const profileKey = resolvedMode + ':' + profileId + ':' + (targetId ?? 'managed');
      const existing = byProfile.get(profileKey);
      if (existing) {
        try {
          const handle = await port.describe(options.owner, existing);
          rememberFencing(handle);
          return sessionView(handle);
        } catch {
          byProfile.delete(profileKey);
          sessions.delete(existing);
          fencing.delete(existing);
        }
      }
      const handle = await port.open({
        profileId,
        owner: options.owner,
        mode: resolvedMode,
        ...(targetId === undefined ? {} : { targetId }),
        ...(groupTitle === undefined ? {} : { groupTitle }),
      });
      sessions.add(handle.browserSessionId);
      byProfile.set(profileKey, handle.browserSessionId);
      rememberFencing(handle);
      return sessionView(handle);
    },

    async describe(browserSessionId) {
      assertOpen();
      const handle = await port.describe(options.owner, browserSessionId);
      rememberFencing(handle);
      return sessionView(handle);
    },

    async snapshot(browserSessionId) {
      assertOpen();
      const value = await semantic.snapshot(options.owner, browserSessionId);
      rememberFencing(await port.describe(options.owner, browserSessionId));
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
      const expectedFence = fencing.get(browserSessionId);
      let effectArguments = action as unknown as CanonicalValue;
      if (expectedFence) {
        const binding = await port.describe(options.owner, browserSessionId);
        if (binding.targetId !== expectedFence.targetId
            || binding.claimEpoch !== expectedFence.claimEpoch) {
          throw new Error('Browser target fencing binding changed');
        }
        effectArguments = {
          action: action as unknown as CanonicalValue,
          targetId: expectedFence.targetId,
          claimEpoch: expectedFence.claimEpoch,
        } as unknown as CanonicalValue;
      }
      return effectView(await coordinator.execute(
        options.owner,
        idempotencyKey,
        {
          kind: `browser.${action.type}`,
          resourceId: browserSessionId,
          arguments: effectArguments,
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
            case 'pause_for_user':
              if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
              await broker.pauseForUser(options.owner, browserSessionId);
              break;
            case 'take_user_control':
              if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
              await broker.takeUserControl(options.owner, browserSessionId);
              break;
            case 'resume_automation':
              if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
              await broker.resumeAutomation(options.owner, browserSessionId);
              break;
          }
          return { status: 'CONFIRMED_SUCCESS', resultDigest: successDigest(action) };
        },
      ));
    },

    async effect(effectId) {
      assertOpen();
      return effectView(effects.get(options.owner, effectId));
    },

    async screenshot(browserSessionId) {
      assertOpen();
      const image = await port.screenshot(options.owner, browserSessionId);
      rememberFencing(await port.describe(options.owner, browserSessionId));
      const sizeBytes = Buffer.from(image.dataBase64, 'base64').length;
      if (sizeBytes > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds size limit');
      return image;
    },

    async close(browserSessionId) {
      assertOpen();
      const handle = await port.close(options.owner, browserSessionId);
      sessions.delete(browserSessionId);
      fencing.delete(browserSessionId);
      for (const [key, value] of byProfile) {
        if (value === browserSessionId) byProfile.delete(key);
      }
      return sessionView(handle);
    },

    async pauseForUser(browserSessionId) {
      assertOpen();
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.pauseForUser(options.owner, browserSessionId));
    },

    async takeUserControl(browserSessionId) {
      assertOpen();
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.takeUserControl(options.owner, browserSessionId));
    },

    async resumeAutomation(browserSessionId) {
      assertOpen();
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.resumeAutomation(options.owner, browserSessionId));
    },

    async closeAll() {
      if (closed) return;
      closed = true;
      for (const browserSessionId of [...sessions]) {
        await port.close(options.owner, browserSessionId).catch(() => undefined);
      }
      sessions.clear();
      byProfile.clear();
      fencing.clear();
      attachedPort?.shutdown();
      targetClaims?.close();
      effects.close();
    },
  };
}
