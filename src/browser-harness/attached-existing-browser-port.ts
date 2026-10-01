import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';
import type { ExistingBrowserControlClient } from './existing-browser-control-client.js';
import type {
  BrowserExecRequest,
  BrowserPort,
  BrowserSessionHandle,
} from './browser-port.js';
import type {
  BrowserTargetClaimPort,
} from './browser-target-claim-store.js';

interface AttachedSession {
  handle: BrowserSessionHandle;
  targetId: string;
  claimEpoch: number;
}

export interface AttachedExistingBrowserPort extends BrowserPort {
  shutdown(): void;
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export function createAttachedExistingBrowserPort(options: {
  control: ExistingBrowserControlClient;
  claims: BrowserTargetClaimPort;
  now?: () => number;
  randomUUID?: () => string;
  heartbeatIntervalMs?: number;
}): AttachedExistingBrowserPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  if (!Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 60_000) {
    throw new Error('Browser target heartbeat interval is invalid');
  }
  const sessions = new Map<string, AttachedSession>();
  let stopped = false;

  function clone(handle: BrowserSessionHandle): BrowserSessionHandle {
    return Object.freeze({ ...handle, owner: Object.freeze({ ...handle.owner }) });
  }

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

  function heartbeat(session: AttachedSession): void {
    const claim = options.claims.heartbeat(
      session.handle.owner,
      session.targetId,
      session.handle.browserSessionId,
      session.claimEpoch,
    );
    session.handle = Object.freeze({
      ...session.handle,
      claimExpiresAt: claim.expiresAt,
      lastSeenAt: now(),
    });
  }

  const heartbeatTimer = setInterval(() => {
    if (stopped) return;
    for (const session of sessions.values()) {
      if (session.handle.state !== 'ACTIVE') continue;
      try {
        heartbeat(session);
      } catch {
        // A successor claim or durable-store failure is surfaced synchronously on the next
        // browser operation. The timer never performs browser effects and never steals a claim.
      }
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    async open(request) {
      if (request.mode !== 'ATTACH_EXISTING' && request.mode !== 'AI_TAB_GROUP') {
        throw new Error('Attached existing browser port requires ATTACH_EXISTING or AI_TAB_GROUP');
      }
      if (typeof request.targetId !== 'string' || !TARGET_ID.test(request.targetId)) {
        throw new Error(request.mode + ' requires an exact target id');
      }

      const browserSessionId = `browser_${uuid()}`;
      const claim = options.claims.claim(
        request.owner,
        request.targetId,
        browserSessionId,
      );
      let attached = false;

      try {
        const grouped = request.mode === 'AI_TAB_GROUP'
          ? await options.control.groupTarget(
            request.targetId,
            request.groupTitle ?? `WAG • ${request.profileId}`,
          )
          : undefined;
        if (grouped && !grouped.activeStable) {
          throw new Error('AI tab grouping changed the active browser tab');
        }

        const target = await options.control.attach(request.targetId);
        attached = true;
        if (!target.attachable || !target.attached) {
          throw new Error('Existing browser target could not be attached');
        }

        const createdAt = now();
        const handle: BrowserSessionHandle = Object.freeze({
          browserSessionId,
          profileId: request.profileId,
          owner: Object.freeze({ ...request.owner }),
          backend: 'cdp',
          executionMode: request.mode,
          ownershipMode: 'ATTACHED_EXISTING',
          controlState: 'RUNNING',
          targetId: request.targetId,
          claimEpoch: claim.claimEpoch,
          claimExpiresAt: claim.expiresAt,
          ...(grouped === undefined ? {} : {
            groupId: grouped.groupId,
            groupTitle: grouped.groupTitle,
          }),
          createdAt,
          lastSeenAt: createdAt,
          state: 'ACTIVE',
        });
        sessions.set(browserSessionId, {
          handle,
          targetId: request.targetId,
          claimEpoch: claim.claimEpoch,
        });
        return clone(handle);
      } catch (error) {
        if (attached) {
          await options.control.release(request.targetId).catch(() => undefined);
        }
        try {
          options.claims.release(
            request.owner,
            request.targetId,
            browserSessionId,
            claim.claimEpoch,
          );
        } catch {
          // Preserve the original open failure. The short claim lease will expire safely.
        }
        throw error;
      }
    },

    async describe(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      heartbeat(session);
      await options.control.describe(session.targetId);
      return clone(session.handle);
    },

    async snapshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      heartbeat(session);
      const target = await options.control.describe(session.targetId);
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
      heartbeat(session);
      const value = await options.control.exec(session.targetId, request.method, request.params);
      session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
      return value;
    },

    async screenshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      heartbeat(session);
      const value = await options.control.screenshot(session.targetId);
      session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
      return value;
    },

    async close(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);

      // Revalidate and extend the lease before detach. While this lease is current, no successor
      // can claim the target, so an old owner can never detach a newer owner's debugger session.
      heartbeat(session);
      session.handle = Object.freeze({
        ...session.handle,
        state: 'CLOSING',
        lastSeenAt: now(),
      });

      let failure: unknown;
      try {
        await options.control.release(session.targetId);
        options.claims.release(
          owner,
          session.targetId,
          browserSessionId,
          session.claimEpoch,
        );
        session.handle = Object.freeze({
          ...session.handle,
          state: 'CLOSED',
          controlState: 'STOPPED',
          lastSeenAt: now(),
        });
      } catch (error) {
        failure = error;
        session.handle = Object.freeze({
          ...session.handle,
          state: 'FAILED',
          lastSeenAt: now(),
        });
      }
      if (failure) throw failure;
      sessions.delete(browserSessionId);
      return clone(session.handle);
    },

    shutdown() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
    },
  };
}
