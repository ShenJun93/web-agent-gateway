import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type BrowserSessionState = 'ACTIVE' | 'ORPHANED' | 'RECOVERABLE' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface BrowserSessionHandle {
  readonly browserSessionId: string;
  readonly profileId: string;
  readonly owner: GatewayAuthority;
  readonly backend: 'cdp';
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: BrowserSessionState;
}

export interface BrowserOpenRequest {
  readonly profileId: string;
  readonly owner: GatewayAuthority;
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
  describe(): Promise<{ url: string; title: string }>;
  exec(request: BrowserExecRequest): Promise<unknown>;
  screenshot(): Promise<{ mimeType: 'image/png'; dataBase64: string }>;
  close(): Promise<void>;
}

export interface BrowserBackend {
  open(profileId: string): Promise<BrowserBackendSession>;
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
  backend: BrowserBackendSession;
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const PROFILE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const CDP_METHOD = /^[A-Za-z][A-Za-z0-9]*\.[A-Za-z][A-Za-z0-9]*$/;

function assertProfileId(profileId: string): void {
  if (!PROFILE_ID.test(profileId)) throw new Error('Browser profile id is invalid');
}

function assertSessionId(browserSessionId: string): void {
  if (!SESSION_ID.test(browserSessionId)) throw new Error('Browser session id is invalid');
}

function cloneHandle(handle: BrowserSessionHandle): BrowserSessionHandle {
  return Object.freeze({ ...handle, owner: Object.freeze({ ...handle.owner }) });
}

export function createBrowserPort(options: {
  backend: BrowserBackend;
  now?: () => number;
  randomUUID?: () => string;
}): BrowserPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const sessions = new Map<string, LiveBrowserSession>();
  const profileOwners = new Map<string, string>();

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
      assertProfileId(request.profileId);
      if (profileOwners.has(request.profileId)) throw new Error('Browser profile is already owned by an active session');
      const backend = await options.backend.open(request.profileId);
      const createdAt = now();
      const browserSessionId = `browser_${uuid()}`;
      const handle: BrowserSessionHandle = Object.freeze({
        browserSessionId,
        profileId: request.profileId,
        owner: Object.freeze({ ...request.owner }),
        backend: 'cdp',
        createdAt,
        lastSeenAt: createdAt,
        state: 'ACTIVE',
      });
      sessions.set(browserSessionId, { handle, backend });
      profileOwners.set(request.profileId, browserSessionId);
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
      try {
        await session.backend.close();
        session.handle = Object.freeze({ ...session.handle, state: 'CLOSED', lastSeenAt: now() });
      } catch (error) {
        session.handle = Object.freeze({ ...session.handle, state: 'FAILED', lastSeenAt: now() });
        throw error;
      } finally {
        profileOwners.delete(session.handle.profileId);
      }
      return cloneHandle(session.handle);
    },
  };
}
