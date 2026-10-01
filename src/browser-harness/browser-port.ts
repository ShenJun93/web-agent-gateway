import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';
import {
  createMemoryBrowserProfileStore,
  type BrowserProfileHandle,
  type BrowserProfileStore,
} from './browser-profile-store.js';

export type { BrowserProfileHandle, BrowserProfileStore } from './browser-profile-store.js';

export type BrowserSessionState = 'ACTIVE' | 'ORPHANED' | 'RECOVERABLE' | 'CLOSING' | 'CLOSED' | 'FAILED';
export type BrowserBackendKind = 'cdp' | 'playwright-cdp';
export type BrowserExecutionMode = 'ATTACH_EXISTING' | 'AI_TAB_GROUP' | 'WAG_VISIBLE' | 'WAG_HEADLESS';
export type BrowserOpenMode = 'AUTO' | BrowserExecutionMode;
export type BrowserOwnershipMode = 'ATTACHED_EXISTING' | 'WAG_OWNED';
export type BrowserControlState = 'RUNNING' | 'PAUSED_FOR_USER' | 'USER_CONTROL' | 'RESUMING' | 'STOPPED';

export interface BrowserSessionHandle {
  readonly browserSessionId: string;
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly backend: BrowserBackendKind;
  readonly executionMode?: BrowserExecutionMode;
  readonly ownershipMode?: BrowserOwnershipMode;
  readonly controlState?: BrowserControlState;
  readonly groupId?: string;
  readonly groupTitle?: string;
  readonly processId?: string;
  readonly pid?: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: BrowserSessionState;
}

export interface BrowserOpenRequest {
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly mode?: BrowserOpenMode;
  readonly targetId?: string;
  readonly groupTitle?: string;
}

export interface BrowserSnapshot {
  readonly browserSessionId: string;
  readonly url: string;
  readonly title: string;
  readonly targetId: string;
  readonly observedAt: number;
}

export interface BrowserExecRequest {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface BrowserBackendSession {
  readonly targetId: string;
  readonly processId?: string;
  readonly pid?: number;
  describe(): Promise<{ url: string; title: string }>;
  exec(request: BrowserExecRequest): Promise<unknown>;
  screenshot(): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(): Promise<void>;
}

export interface BrowserBackend {
  readonly kind: BrowserBackendKind;
  open(profile: BrowserProfileHandle): Promise<BrowserBackendSession>;
}

export interface BrowserPort {
  open(request: BrowserOpenRequest): Promise<BrowserSessionHandle>;
  describe(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
  snapshot(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSnapshot>;
  exec(owner: GatewayAuthority, browserSessionId: string, request: BrowserExecRequest): Promise<unknown>;
  screenshot(owner: GatewayAuthority, browserSessionId: string): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
}

interface LiveBrowserSession {
  handle: BrowserSessionHandle;
  profile: BrowserProfileHandle;
  backend: BrowserBackendSession;
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

function assertSessionId(browserSessionId: string): void {
  if (!SESSION_ID.test(browserSessionId)) throw new Error('Browser session id is invalid');
}

function cloneHandle(handle: BrowserSessionHandle): BrowserSessionHandle {
  return Object.freeze({ ...handle, owner: Object.freeze({ ...handle.owner }) });
}

export function createBrowserPort(options: {
  backend: BrowserBackend;
  profileStore?: BrowserProfileStore;
  executionMode?: Exclude<BrowserExecutionMode, 'ATTACH_EXISTING' | 'AI_TAB_GROUP'>;
  ownershipMode?: BrowserOwnershipMode;
  now?: () => number;
  randomUUID?: () => string;
}): BrowserPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const profileStore = options.profileStore ?? createMemoryBrowserProfileStore();
  const executionMode = options.executionMode ?? 'WAG_HEADLESS';
  const ownershipMode = options.ownershipMode ?? 'WAG_OWNED';
  const sessions = new Map<string, LiveBrowserSession>();

  function owned(owner: GatewayAuthority, browserSessionId: string): LiveBrowserSession {
    assertSessionId(browserSessionId);
    const session = sessions.get(browserSessionId);
    if (!session) throw new Error('Browser session not found');
    if (!sameAuthorityTuple(session.handle.owner, owner)) throw new Error('Browser session is owned by another authority');
    if (session.handle.state !== 'ACTIVE') throw new Error(`Browser session is not active: ${session.handle.state}`);
    return session;
  }

  function touch(session: LiveBrowserSession): void {
    session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
  }

  return {
    async open(request) {
      const profile = await profileStore.acquire(request.profileId, request.owner);
      let backend: BrowserBackendSession;
      try {
        backend = await options.backend.open(profile);
      } catch (error) {
        await profileStore.release(profile, request.owner);
        throw error;
      }
      const createdAt = now();
      const browserSessionId = `browser_${uuid()}`;
      const handle: BrowserSessionHandle = Object.freeze({
        browserSessionId,
        profileId: request.profileId,
        owner: Object.freeze({ ...request.owner }),
        backend: options.backend.kind,
        executionMode,
        ownershipMode,
        controlState: 'RUNNING',
        ...(backend.processId === undefined ? {} : { processId: backend.processId }),
        ...(backend.pid === undefined ? {} : { pid: backend.pid }),
        createdAt,
        lastSeenAt: createdAt,
        state: 'ACTIVE',
      });
      sessions.set(browserSessionId, { handle, profile, backend });
      return cloneHandle(handle);
    },

    async describe(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      touch(session);
      return cloneHandle(session.handle);
    },

    async snapshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      const described = await session.backend.describe();
      touch(session);
      return Object.freeze({
        browserSessionId,
        url: described.url,
        title: described.title,
        targetId: session.backend.targetId,
        observedAt: now(),
      });
    },

    async exec(owner, browserSessionId, request) {
      if (!CDP_METHOD.test(request.method)) throw new Error('Browser exec method is invalid');
      const session = owned(owner, browserSessionId);
      const result = await session.backend.exec(request);
      touch(session);
      return result;
    },

    async screenshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      const result = await session.backend.screenshot();
      touch(session);
      return result;
    },

    async close(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      session.handle = Object.freeze({ ...session.handle, state: 'CLOSING', lastSeenAt: now() });
      let failure: unknown;
      try {
        await session.backend.close();
        session.handle = Object.freeze({ ...session.handle, state: 'CLOSED', lastSeenAt: now() });
      } catch (error) {
        failure = error;
        session.handle = Object.freeze({ ...session.handle, state: 'FAILED', lastSeenAt: now() });
      }
      try {
        await profileStore.release(session.profile, owner);
      } catch (error) {
        failure ??= error;
        session.handle = Object.freeze({ ...session.handle, state: 'FAILED', lastSeenAt: now() });
      }
      if (failure) throw failure;
      return cloneHandle(session.handle);
    },
  };
}
