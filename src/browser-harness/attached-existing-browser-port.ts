import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';
import type { ExistingBrowserControlClient } from './existing-browser-control-client.js';
import type {
  BrowserExecRequest,
  BrowserPort,
  BrowserSessionHandle,
} from './browser-port.js';

interface AttachedSession {
  handle: BrowserSessionHandle;
  targetId: string;
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;

export function createAttachedExistingBrowserPort(options: {
  control: ExistingBrowserControlClient;
  now?: () => number;
  randomUUID?: () => string;
}): BrowserPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const sessions = new Map<string, AttachedSession>();

  function owned(owner: GatewayAuthority, browserSessionId: string): AttachedSession {
    if (!SESSION_ID.test(browserSessionId)) throw new Error('Browser session id is invalid');
    const session = sessions.get(browserSessionId);
    if (!session) throw new Error('Browser session not found');
    if (!sameAuthorityTuple(session.handle.owner, owner)) {
      throw new Error('Browser session is owned by another authority');
    }
    if (session.handle.state !== 'ACTIVE') {
      throw new Error(`Browser session is not active: ${session.handle.state}`);
    }
    return session;
  }

  function touch(session: AttachedSession): void {
    session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
  }

  return {
    async open(request) {
      if (request.mode !== 'ATTACH_EXISTING' && request.mode !== 'AI_TAB_GROUP') {
        throw new Error('Attached existing browser port requires ATTACH_EXISTING or AI_TAB_GROUP');
      }
      if (typeof request.targetId !== 'string' || !TARGET_ID.test(request.targetId)) {
        throw new Error(request.mode + ' requires an exact target id');
      }
      const grouped = request.mode === 'AI_TAB_GROUP'
        ? await options.control.groupTarget(request.targetId, request.groupTitle ?? `WAG • ${request.profileId}`)
        : undefined;
      if (grouped && !grouped.activeStable) {
        throw new Error('AI tab grouping changed the active browser tab');
      }
      const target = await options.control.attach(request.targetId);
      if (!target.attachable || !target.attached) {
        throw new Error('Existing browser target could not be attached');
      }
      const createdAt = now();
      const browserSessionId = `browser_${uuid()}`;
      const handle: BrowserSessionHandle = Object.freeze({
        browserSessionId,
        profileId: request.profileId,
        owner: Object.freeze({ ...request.owner }),
        backend: 'cdp',
        executionMode: request.mode,
        ownershipMode: 'ATTACHED_EXISTING',
        controlState: 'RUNNING',
        ...(grouped === undefined ? {} : { groupId: grouped.groupId, groupTitle: grouped.groupTitle }),
        createdAt,
        lastSeenAt: createdAt,
        state: 'ACTIVE',
      });
      sessions.set(browserSessionId, { handle, targetId: request.targetId });
      return Object.freeze({ ...handle, owner: Object.freeze({ ...handle.owner }) });
    },

    async describe(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      await options.control.describe(session.targetId);
      touch(session);
      return Object.freeze({ ...session.handle, owner: Object.freeze({ ...session.handle.owner }) });
    },

    async snapshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      const target = await options.control.describe(session.targetId);
      touch(session);
      return Object.freeze({
        browserSessionId,
        url: target.url ?? '',
        title: target.title,
        targetId: target.targetId,
        observedAt: now(),
      });
    },

    async exec(owner, browserSessionId, request: BrowserExecRequest) {
      const session = owned(owner, browserSessionId);
      const value = await options.control.exec(session.targetId, request.method, request.params);
      touch(session);
      return value;
    },

    async screenshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      const value = await options.control.screenshot(session.targetId);
      touch(session);
      return value;
    },

    async close(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      session.handle = Object.freeze({ ...session.handle, state: 'CLOSING', lastSeenAt: now() });
      let failure: unknown;
      try {
        await options.control.release(session.targetId);
        session.handle = Object.freeze({
          ...session.handle,
          state: 'CLOSED',
          controlState: 'STOPPED',
          lastSeenAt: now(),
        });
      } catch (error) {
        failure = error;
        session.handle = Object.freeze({ ...session.handle, state: 'FAILED', lastSeenAt: now() });
      }
      if (failure) throw failure;
      return Object.freeze({ ...session.handle, owner: Object.freeze({ ...session.handle.owner }) });
    },
  };
}
