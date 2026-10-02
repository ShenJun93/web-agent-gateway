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
  BrowserBrokerError,
  createBrowserBroker,
  resolveBrowserOpenMode,
  type BrowserBroker,
} from './browser-broker.js';
import {
  createAttachedExistingBrowserPort,
  type AttachedExistingBrowserPort,
} from './attached-existing-browser-port.js';
import { BrowserTargetClaimStore } from './browser-target-claim-store.js';
import { BrowserAttachedSessionStore } from './browser-attached-session-store.js';
import {
  BrowserRuntimeDiagnostics,
  type BrowserDiagnosticAction,
} from './browser-runtime-diagnostics.js';
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
  type BrowserMediaInspection,
  type SemanticBrowser,
  type SemanticNode,
} from './semantic-browser.js';
import {
  evaluateBrowserSemanticConditions,
  type BrowserSemanticCondition,
  type BrowserSemanticEvaluation,
} from './browser-semantic-condition.js';
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

export interface BrowserMcpWaitResult extends BrowserSemanticEvaluation {
  readonly browser_session_id: string;
  readonly snapshot_id: string;
  readonly attempts: number;
  readonly elapsed_ms: number;
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
  readonly diagnostics?: BrowserRuntimeDiagnostics;
  targets(): Promise<readonly ExistingBrowserTarget[]>;
  open(profileId: string, mode?: BrowserOpenMode, targetId?: string, groupTitle?: string): Promise<BrowserMcpSession>;
  describe(browserSessionId: string): Promise<BrowserMcpSession>;
  snapshot(browserSessionId: string): Promise<BrowserMcpSnapshot>;
  exec(
    browserSessionId: string,
    idempotencyKey: string,
    action: BrowserMcpAction,
  ): Promise<BrowserMcpEffect>;
  uploadFile(
    browserSessionId: string,
    idempotencyKey: string,
    workspaceId: string,
    ref: string,
    paths: readonly string[],
  ): Promise<BrowserMcpEffect>;
  waitFor(
    browserSessionId: string,
    conditions: readonly BrowserSemanticCondition[],
    mode?: 'all' | 'any',
    timeoutMs?: number,
    intervalMs?: number,
  ): Promise<BrowserMcpWaitResult>;
  assertSemantic(
    browserSessionId: string,
    conditions: readonly BrowserSemanticCondition[],
    mode?: 'all' | 'any',
  ): Promise<BrowserMcpWaitResult>;
  inspectMedia(browserSessionId: string, ref: string): Promise<BrowserMediaInspection>;
  effect(effectId: string): Promise<BrowserMcpEffect>;
  screenshot(browserSessionId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(browserSessionId: string): Promise<BrowserMcpSession>;
  pauseForUser(browserSessionId: string): Promise<BrowserMcpSession>;
  takeUserControl(browserSessionId: string): Promise<BrowserMcpSession>;
  resumeAutomation(browserSessionId: string): Promise<BrowserMcpSession>;
  suspendForRestart(): Promise<void>;
  closeAll(): Promise<void>;
}

const MAX_SNAPSHOT_NODES = 500;
const MAX_ACTIVE_BROWSER_SESSIONS = 32;
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SCREENSHOT_BASE64_CHARS = 4 * Math.ceil(MAX_SCREENSHOT_BYTES / 3);
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const MAX_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_INTERVAL_MS = 250;
const MIN_WAIT_INTERVAL_MS = 50;
const MAX_WAIT_INTERVAL_MS = 5_000;

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

function successDigest(value: unknown): string {
  return `sha256_${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function createPrivateBrowserMcpContext(options: {
  owner: GatewayAuthority;
  edgeExecutablePath: string;
  profileRoot: string;
  effectStatePath: string;
  targetClaimStatePath?: string;
  attachedSessionStatePath?: string;
  diagnosticsStatePath?: string;
  killSwitch: () => boolean;
  controlDiscoveryPath?: string;
  control?: ExistingBrowserControlClient;
  /** Test-only seam; production omits it and receives the concrete owned-Edge backend. */
  port?: BrowserPort;
  /** Test-only semantic seam paired with port. */
  semantic?: SemanticBrowser;
  resolveUploadFiles?: (
    workspaceId: string,
    paths: readonly string[],
  ) => Promise<readonly { relative_path: string; absolute_path: string; size_bytes: number }[]>;
}): BrowserMcpContext {
  const effects = new HarnessEffectLedger(options.effectStatePath);
  effects.reconcileExecuting();
  const coordinator = new HarnessEffectCoordinator(effects);
  const diagnostics = new BrowserRuntimeDiagnostics({
    statePath: options.diagnosticsStatePath ?? options.effectStatePath + '.browser-diagnostics.json',
  });
  let broker: BrowserBroker | undefined;
  let control: ExistingBrowserControlClient | undefined;
  let targetClaims: BrowserTargetClaimStore | undefined;
  let attachedSessions: BrowserAttachedSessionStore | undefined;
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
      attachedSessions = new BrowserAttachedSessionStore(
        options.attachedSessionStatePath ?? options.effectStatePath + '.attached-sessions.sqlite',
      );
      attachedPort = createAttachedExistingBrowserPort({
        control,
        claims: targetClaims,
        sessionStore: attachedSessions,
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

  function rememberFencing(handle: BrowserSessionHandle): boolean {
    const previous = fencing.get(handle.browserSessionId);
    if (handle.targetId !== undefined && handle.claimEpoch !== undefined) {
      fencing.set(handle.browserSessionId, {
        targetId: handle.targetId,
        claimEpoch: handle.claimEpoch,
      });
      return previous !== undefined && previous.targetId !== handle.targetId;
    }
    fencing.delete(handle.browserSessionId);
    return false;
  }

  function assertOpen(): void {
    if (closed) throw new Error('Browser MCP runtime is closed');
  }

  function assertEffectAllowed(): void {
    assertOpen();
    if (options.killSwitch()) throw new Error('Browser MCP effect denied by autonomous stop');
  }

  function profileKey(
    executionMode: string,
    profileId: string,
    targetId: string | undefined,
  ): string {
    return executionMode + ':' + profileId + ':' + (targetId ?? 'managed');
  }

  function assertSessionCapacity(browserSessionId?: string): void {
    if (browserSessionId !== undefined && sessions.has(browserSessionId)) return;
    if (sessions.size >= MAX_ACTIVE_BROWSER_SESSIONS) {
      throw new Error('Browser active session limit reached');
    }
  }

  function rememberSession(handle: BrowserSessionHandle): void {
    assertSessionCapacity(handle.browserSessionId);
    sessions.add(handle.browserSessionId);
    byProfile.set(profileKey(
      handle.executionMode ?? 'WAG_HEADLESS',
      handle.profileId,
      handle.rootTargetId ?? handle.targetId,
    ), handle.browserSessionId);
    rememberFencing(handle);
  }

  async function ensureSession(browserSessionId: string): Promise<BrowserSessionHandle | undefined> {
    if (sessions.has(browserSessionId)) {
      try {
        const handle = await port.describe(options.owner, browserSessionId);
        rememberFencing(handle);
        return handle;
      } catch (error) {
        const routeLost = error instanceof BrowserBrokerError
          && error.code === 'BROWSER_SESSION_NOT_ROUTED';
        if (!(routeLost && broker && attachedSessions && fencing.has(browserSessionId))) throw error;
        sessions.delete(browserSessionId);
        fencing.delete(browserSessionId);
        for (const [key, value] of byProfile) {
          if (value === browserSessionId) byProfile.delete(key);
        }
      }
    }
    if (broker && attachedSessions) {
      const durable = attachedSessions.get(options.owner, browserSessionId);
      if (durable && (durable.state === 'ACTIVE' || durable.state === 'RECOVERABLE')) {
        assertSessionCapacity(browserSessionId);
        const finish = diagnostics.begin({
          actionType: 'recover',
          browserSessionId,
          targetId: durable.targetId,
          ownershipMode: 'ATTACHED_EXISTING',
          recovered: true,
        });
        try {
          const recovered = await broker.recover(options.owner, browserSessionId);
          rememberSession(recovered);
          finish(true, undefined, {
            targetId: recovered.targetId,
            ownershipMode: recovered.ownershipMode,
            targetChanged: recovered.targetId !== durable.targetId,
            recovered: true,
          });
          return recovered;
        } catch (error) {
          finish(false, error, { recovered: true });
          throw error;
        }
      }
    }
    return undefined;
  }

  async function captureSemantic(browserSessionId: string): Promise<BrowserMcpSnapshot> {
    await ensureSession(browserSessionId);
    const value = await semantic.snapshot(options.owner, browserSessionId);
    const handle = await port.describe(options.owner, browserSessionId);
    rememberFencing(handle);
    const nodes = value.nodes.slice(0, MAX_SNAPSHOT_NODES).map(boundedNode);
    return Object.freeze({
      snapshotId: value.snapshotId,
      browserSessionId: value.browserSessionId,
      url: truncateUtf8(value.url, 4096),
      title: truncateUtf8(value.title, 1024),
      nodes: Object.freeze(nodes),
      truncated: value.truncated === true || value.nodes.length > nodes.length,
    });
  }

  return {
    diagnostics,

    async targets() {
      assertOpen();
      if (!control) throw new Error('Existing browser control host is not configured');
      return control.listTargets();
    },

    async open(profileId, mode, targetId, groupTitle) {
      assertEffectAllowed();
      const resolvedMode = resolveBrowserOpenMode(mode, targetId);
      if ((resolvedMode === 'ATTACH_EXISTING' || resolvedMode === 'AI_TAB_GROUP') && !targetId) {
        throw new Error(resolvedMode + ' requires target_id');
      }
      const key = profileKey(resolvedMode, profileId, targetId);
      const existing = byProfile.get(key);
      if (existing) {
        try {
          const handle = await port.describe(options.owner, existing);
          rememberFencing(handle);
          return sessionView(handle);
        } catch {
          byProfile.delete(key);
          sessions.delete(existing);
          fencing.delete(existing);
        }
      }
      if ((resolvedMode === 'ATTACH_EXISTING' || resolvedMode === 'AI_TAB_GROUP')
          && targetId !== undefined && broker && attachedSessions) {
        const durable = attachedSessions.findRecoverable(
          options.owner,
          profileId,
          resolvedMode,
          targetId,
        ) ?? attachedSessions.findRecoverableByTarget(
          options.owner,
          resolvedMode,
          targetId,
        );
        if (durable) {
          assertSessionCapacity(durable.browserSessionId);
          const finish = diagnostics.begin({
            actionType: 'recover',
            browserSessionId: durable.browserSessionId,
            targetId: durable.targetId,
            ownershipMode: 'ATTACHED_EXISTING',
            recovered: true,
          });
          try {
            const recovered = await broker.recover(options.owner, durable.browserSessionId);
            rememberSession(recovered);
            finish(true, undefined, {
              targetId: recovered.targetId,
              ownershipMode: recovered.ownershipMode,
              targetChanged: recovered.targetId !== durable.targetId,
              recovered: true,
            });
            return sessionView(recovered);
          } catch (error) {
            finish(false, error, { recovered: true });
            throw error;
          }
        }
      }

      assertSessionCapacity();
      const finish = diagnostics.begin({
        actionType: 'open',
        targetId,
        ownershipMode: resolvedMode === 'ATTACH_EXISTING' || resolvedMode === 'AI_TAB_GROUP'
          ? 'ATTACHED_EXISTING'
          : 'WAG_OWNED',
      });
      try {
        const handle = await port.open({
          profileId,
          owner: options.owner,
          mode: resolvedMode,
          ...(targetId === undefined ? {} : { targetId }),
          ...(groupTitle === undefined ? {} : { groupTitle }),
        });
        rememberSession(handle);
        finish(true, undefined, {
          targetId: handle.targetId,
          ownershipMode: handle.ownershipMode,
        });
        return sessionView(handle);
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async describe(browserSessionId) {
      assertOpen();
      const recovered = await ensureSession(browserSessionId);
      if (recovered) return sessionView(recovered);
      const handle = await port.describe(options.owner, browserSessionId);
      rememberSession(handle);
      return sessionView(handle);
    },

    async snapshot(browserSessionId) {
      assertOpen();
      const initialFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'snapshot',
        browserSessionId,
        targetId: initialFence?.targetId,
        ownershipMode: initialFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      try {
        const result = await captureSemantic(browserSessionId);
        const handle = await port.describe(options.owner, browserSessionId);
        finish(true, undefined, {
          targetId: handle.targetId,
          ownershipMode: handle.ownershipMode,
          targetChanged: rememberFencing(handle),
        });
        return result;
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async exec(browserSessionId, idempotencyKey, action) {
      assertEffectAllowed();
      await ensureSession(browserSessionId);
      const expectedFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: action.type as BrowserDiagnosticAction,
        browserSessionId,
        targetId: expectedFence?.targetId,
        ownershipMode: expectedFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      try {
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
        const record = await coordinator.execute(
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
        );
        let completion: {
          targetId?: string;
          ownershipMode?: string;
          targetChanged?: boolean;
        } = {};
        try {
          const handle = await port.describe(options.owner, browserSessionId);
          completion = {
            targetId: handle.targetId,
            ownershipMode: handle.ownershipMode,
            targetChanged: rememberFencing(handle),
          };
        } catch {
          // Diagnostics must never turn a completed exact-once effect into a caller-visible failure.
        }
        finish(record.state === 'SUCCEEDED', undefined, completion);
        return effectView(record);
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async uploadFile(browserSessionId, idempotencyKey, workspaceId, ref, paths) {
      assertEffectAllowed();
      await ensureSession(browserSessionId);
      if (!options.resolveUploadFiles) throw new Error('Browser upload source authority is unavailable');
      if (!Array.isArray(paths) || paths.length < 1 || paths.length > 20
          || paths.some((path) => typeof path !== 'string' || path.length < 1
            || path.includes('\0') || Buffer.byteLength(path, 'utf8') > 4096)) {
        throw new Error('Browser upload path set is invalid');
      }
      const expectedFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'upload_file',
        browserSessionId,
        targetId: expectedFence?.targetId,
        ownershipMode: expectedFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      try {
        const request = {
          workspaceId,
          ref,
          paths: [...paths],
        };
        let effectArguments = request as unknown as CanonicalValue;
        if (expectedFence) {
          const binding = await port.describe(options.owner, browserSessionId);
          if (binding.targetId !== expectedFence.targetId
              || binding.claimEpoch !== expectedFence.claimEpoch) {
            throw new Error('Browser target fencing binding changed');
          }
          effectArguments = {
            request: request as unknown as CanonicalValue,
            targetId: expectedFence.targetId,
            claimEpoch: expectedFence.claimEpoch,
          } as unknown as CanonicalValue;
        }
        const record = await coordinator.execute(
          options.owner,
          idempotencyKey,
          {
            kind: 'browser.upload_file',
            resourceId: browserSessionId,
            arguments: effectArguments,
          },
          async () => {
            assertEffectAllowed();
            const files = await options.resolveUploadFiles!(workspaceId, paths);
            if (files.length !== paths.length) throw new Error('Browser upload source resolution mismatch');
            assertEffectAllowed();
            await semantic.setFiles(
              options.owner,
              browserSessionId,
              ref,
              files.map((file) => file.absolute_path),
            );
            return {
              status: 'CONFIRMED_SUCCESS',
              resultDigest: successDigest({
                request,
                files: files.map((file) => ({
                  relative_path: file.relative_path,
                  size_bytes: file.size_bytes,
                })),
              }),
            };
          },
        );
        let completion: {
          targetId?: string;
          ownershipMode?: string;
          targetChanged?: boolean;
        } = {};
        try {
          const handle = await port.describe(options.owner, browserSessionId);
          completion = {
            targetId: handle.targetId,
            ownershipMode: handle.ownershipMode,
            targetChanged: rememberFencing(handle),
          };
        } catch {
          // Diagnostics must never turn a completed exact-once effect into a caller-visible failure.
        }
        finish(record.state === 'SUCCEEDED', undefined, completion);
        return effectView(record);
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async waitFor(browserSessionId, conditions, mode = 'all', timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, intervalMs = DEFAULT_WAIT_INTERVAL_MS) {
      assertOpen();
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
        throw new Error('Browser wait timeout is invalid');
      }
      if (!Number.isInteger(intervalMs) || intervalMs < MIN_WAIT_INTERVAL_MS || intervalMs > MAX_WAIT_INTERVAL_MS) {
        throw new Error('Browser wait interval is invalid');
      }
      const initialFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'wait_for',
        browserSessionId,
        targetId: initialFence?.targetId,
        ownershipMode: initialFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      const startedAt = Date.now();
      const deadline = startedAt + timeoutMs;
      let attempts = 0;
      try {
        while (true) {
          attempts += 1;
          const snapshot = await captureSemantic(browserSessionId);
          const evaluation = evaluateBrowserSemanticConditions(snapshot, conditions, mode);
          if (evaluation.matched) {
            const handle = await port.describe(options.owner, browserSessionId);
            finish(true, undefined, {
              targetId: handle.targetId,
              ownershipMode: handle.ownershipMode,
              targetChanged: rememberFencing(handle),
            });
            return Object.freeze({
              ...evaluation,
              browser_session_id: browserSessionId,
              snapshot_id: snapshot.snapshotId,
              attempts,
              elapsed_ms: Date.now() - startedAt,
            });
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new Error('Browser wait condition timed out');
          await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(intervalMs, remaining)));
        }
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async assertSemantic(browserSessionId, conditions, mode = 'all') {
      assertOpen();
      const initialFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'assert',
        browserSessionId,
        targetId: initialFence?.targetId,
        ownershipMode: initialFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      const startedAt = Date.now();
      try {
        const snapshot = await captureSemantic(browserSessionId);
        const evaluation = evaluateBrowserSemanticConditions(snapshot, conditions, mode);
        if (!evaluation.matched) throw new Error('Browser semantic assertion failed');
        const handle = await port.describe(options.owner, browserSessionId);
        finish(true, undefined, {
          targetId: handle.targetId,
          ownershipMode: handle.ownershipMode,
          targetChanged: rememberFencing(handle),
        });
        return Object.freeze({
          ...evaluation,
          browser_session_id: browserSessionId,
          snapshot_id: snapshot.snapshotId,
          attempts: 1,
          elapsed_ms: Date.now() - startedAt,
        });
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async inspectMedia(browserSessionId, ref) {
      assertOpen();
      await ensureSession(browserSessionId);
      const initialFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'media_inspect',
        browserSessionId,
        targetId: initialFence?.targetId,
        ownershipMode: initialFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      try {
        const result = await semantic.inspectMedia(options.owner, browserSessionId, ref);
        const handle = await port.describe(options.owner, browserSessionId);
        finish(true, undefined, {
          targetId: handle.targetId,
          ownershipMode: handle.ownershipMode,
          targetChanged: rememberFencing(handle),
        });
        return result;
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async effect(effectId) {
      assertOpen();
      return effectView(effects.get(options.owner, effectId));
    },

    async screenshot(browserSessionId) {
      assertOpen();
      const initialFence = fencing.get(browserSessionId);
      const finish = diagnostics.begin({
        actionType: 'screenshot',
        browserSessionId,
        targetId: initialFence?.targetId,
        ownershipMode: initialFence === undefined ? undefined : 'ATTACHED_EXISTING',
      });
      try {
        await ensureSession(browserSessionId);
        const image = await port.screenshot(options.owner, browserSessionId);
        if (image.dataBase64.length > MAX_SCREENSHOT_BASE64_CHARS) {
          throw new Error('Browser screenshot exceeds size limit');
        }
        const sizeBytes = Buffer.byteLength(image.dataBase64, 'base64');
        if (sizeBytes > MAX_SCREENSHOT_BYTES) throw new Error('Browser screenshot exceeds size limit');
        const handle = await port.describe(options.owner, browserSessionId);
        const targetChanged = rememberFencing(handle);
        finish(true, undefined, {
          targetId: handle.targetId,
          ownershipMode: handle.ownershipMode,
          targetChanged,
        });
        return image;
      } catch (error) {
        finish(false, error);
        throw error;
      }
    },

    async close(browserSessionId) {
      assertOpen();
      if (!sessions.has(browserSessionId) && !fencing.has(browserSessionId) && attachedSessions) {
        const durable = attachedSessions.get(options.owner, browserSessionId);
        if (durable?.state === 'CLOSED') {
          return sessionView({
            browserSessionId: durable.browserSessionId,
            profileId: durable.profileId,
            owner: durable.owner,
            backend: 'cdp',
            executionMode: durable.executionMode,
            ownershipMode: 'ATTACHED_EXISTING',
            controlState: 'STOPPED',
            rootTargetId: durable.rootTargetId,
            targetId: durable.targetId,
            targetGeneration: durable.targetGeneration,
            claimEpoch: durable.claimEpoch,
            claimExpiresAt: durable.claimExpiresAt,
            ...(durable.groupId === undefined ? {} : { groupId: durable.groupId }),
            ...(durable.groupTitle === undefined ? {} : { groupTitle: durable.groupTitle }),
            createdAt: durable.createdAt,
            lastSeenAt: durable.lastSeenAt,
            state: 'CLOSED',
          });
        }
      }
      await ensureSession(browserSessionId);
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
      await ensureSession(browserSessionId);
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.pauseForUser(options.owner, browserSessionId));
    },

    async takeUserControl(browserSessionId) {
      assertOpen();
      await ensureSession(browserSessionId);
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.takeUserControl(options.owner, browserSessionId));
    },

    async resumeAutomation(browserSessionId) {
      assertOpen();
      await ensureSession(browserSessionId);
      if (!broker) throw new Error('Browser takeover is unavailable for an injected BrowserPort');
      return sessionView(await broker.resumeAutomation(options.owner, browserSessionId));
    },

    async suspendForRestart() {
      if (closed) return;
      closed = true;
      const attachedIds = new Set(fencing.keys());
      let failure: unknown;
      try {
        await attachedPort?.suspendForRestart();
      } catch (error) {
        failure = error;
      }
      for (const browserSessionId of [...sessions]) {
        if (attachedIds.has(browserSessionId)) continue;
        try {
          await port.close(options.owner, browserSessionId);
        } catch (error) {
          failure ??= error;
        }
      }
      sessions.clear();
      byProfile.clear();
      fencing.clear();
      attachedPort?.shutdown();
      attachedSessions?.close();
      targetClaims?.close();
      effects.close();
      if (failure) throw failure;
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
      attachedSessions?.close();
      targetClaims?.close();
      effects.close();
    },
  };
}
