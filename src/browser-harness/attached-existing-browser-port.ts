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
import type {
  BrowserAttachedSessionStore,
  DurableAttachedBrowserSession,
} from './browser-attached-session-store.js';

interface AttachedSession {
  handle: BrowserSessionHandle;
  rootTargetId: string;
  targetId: string;
  claimEpoch: number;
  targetGeneration: number;
  claims: Map<string, number>;
  groupedTargets: Set<string>;
}

export interface AttachedExistingBrowserPort extends BrowserPort {
  recover(owner: GatewayAuthority, browserSessionId: string): Promise<BrowserSessionHandle>;
  suspendForRestart(): Promise<void>;
  shutdown(): void;
}

const SESSION_ID = /^browser_[0-9a-f-]{36}$/;
const TARGET_ID = /^tab_[0-9]+$/;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;

export function createAttachedExistingBrowserPort(options: {
  control: ExistingBrowserControlClient;
  claims: BrowserTargetClaimPort;
  sessionStore?: BrowserAttachedSessionStore;
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

  function durable(session: AttachedSession, state: DurableAttachedBrowserSession['state']): DurableAttachedBrowserSession {
    const executionMode = session.handle.executionMode;
    if (executionMode !== 'ATTACH_EXISTING' && executionMode !== 'AI_TAB_GROUP') {
      throw new Error('Attached browser session mode is invalid');
    }
    return {
      browserSessionId: session.handle.browserSessionId,
      profileId: session.handle.profileId,
      owner: session.handle.owner,
      executionMode,
      controlState: session.handle.controlState ?? 'RUNNING',
      rootTargetId: session.rootTargetId,
      targetId: session.targetId,
      targetGeneration: session.targetGeneration,
      claimEpoch: session.claimEpoch,
      claimExpiresAt: session.handle.claimExpiresAt ?? now(),
      ...(session.handle.groupId === undefined ? {} : { groupId: session.handle.groupId }),
      ...(session.handle.groupTitle === undefined ? {} : { groupTitle: session.handle.groupTitle }),
      claims: session.claims,
      groupedTargets: session.groupedTargets,
      createdAt: session.handle.createdAt,
      lastSeenAt: session.handle.lastSeenAt,
      state,
    };
  }

  function persist(session: AttachedSession, state: DurableAttachedBrowserSession['state'] = 'ACTIVE'): void {
    options.sessionStore?.save(durable(session, state));
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
    let currentExpiresAt = session.handle.claimExpiresAt;
    for (const [targetId, claimEpoch] of session.claims) {
      const claim = options.claims.heartbeat(
        session.handle.owner,
        targetId,
        session.handle.browserSessionId,
        claimEpoch,
      );
      if (targetId === session.targetId) currentExpiresAt = claim.expiresAt;
    }
    session.handle = Object.freeze({
      ...session.handle,
      ...(currentExpiresAt === undefined ? {} : { claimExpiresAt: currentExpiresAt }),
      lastSeenAt: now(),
    });
    persist(session);
  }

  async function switchTarget(session: AttachedSession, targetId: string): Promise<void> {
    if (targetId === session.targetId) return;
    if (!TARGET_ID.test(targetId)) throw new Error('Browser continuity target id is invalid');

    let claimEpoch = session.claims.get(targetId);
    let newClaim = false;
    let claimExpiresAt = session.handle.claimExpiresAt;
    if (claimEpoch === undefined) {
      const claim = options.claims.claim(
        session.handle.owner,
        targetId,
        session.handle.browserSessionId,
      );
      claimEpoch = claim.claimEpoch;
      claimExpiresAt = claim.expiresAt;
      session.claims.set(targetId, claimEpoch);
      newClaim = true;
    } else {
      const claim = options.claims.heartbeat(
        session.handle.owner,
        targetId,
        session.handle.browserSessionId,
        claimEpoch,
      );
      claimExpiresAt = claim.expiresAt;
    }

    let grouped: Awaited<ReturnType<ExistingBrowserControlClient['groupTarget']>> | undefined;
    try {
      if (session.handle.executionMode === 'AI_TAB_GROUP' && !session.groupedTargets.has(targetId)) {
        grouped = await options.control.groupTarget(
          targetId,
          session.handle.groupTitle ?? `WAG • ${session.handle.profileId}`,
        );
        if (!grouped.activeStable) throw new Error('OAuth successor grouping changed the active browser tab');
        session.groupedTargets.add(targetId);
      }
      const target = await options.control.attach(targetId);
      if (!target.attachable || !target.attached) {
        throw new Error('OAuth successor target could not be attached');
      }
    } catch (error) {
      if (newClaim && claimEpoch !== undefined) {
        session.claims.delete(targetId);
        try {
          options.claims.release(
            session.handle.owner,
            targetId,
            session.handle.browserSessionId,
            claimEpoch,
          );
        } catch {}
      }
      throw error;
    }

    const previousTargetId = session.targetId;
    await options.control.release(previousTargetId).catch(() => undefined);
    session.targetId = targetId;
    session.claimEpoch = claimEpoch;
    session.targetGeneration += 1;
    session.handle = Object.freeze({
      ...session.handle,
      targetId,
      claimEpoch,
      ...(claimExpiresAt === undefined ? {} : { claimExpiresAt }),
      targetGeneration: session.targetGeneration,
      ...(grouped === undefined ? {} : {
        groupId: grouped.groupId,
        groupTitle: grouped.groupTitle,
      }),
      lastSeenAt: now(),
    });
    persist(session);
  }

  async function refreshContinuity(session: AttachedSession): Promise<void> {
    const resolved = await options.control.resolveContinuity(
      session.rootTargetId,
      session.targetId,
    );
    const targetId = resolved.target?.targetId;
    if (targetId && targetId !== session.targetId) await switchTarget(session, targetId);
  }


  async function recoverSession(
    owner: GatewayAuthority,
    browserSessionId: string,
  ): Promise<BrowserSessionHandle> {
    const live = sessions.get(browserSessionId);
    if (live) {
      if (!sameAuthorityTuple(live.handle.owner, owner)) {
        throw new Error('Browser session is owned by another authority');
      }
      return clone(live.handle);
    }
    if (!options.sessionStore) throw new Error('Durable browser session recovery is not configured');

    const stored = options.sessionStore.required(owner, browserSessionId);
    if (stored.state === 'CLOSED' || stored.state === 'FAILED') {
      throw new Error('Durable browser session is not recoverable');
    }

    const recoveredClaims = new Map<string, number>();
    let currentExpiresAt = stored.claimExpiresAt;
    let attached = false;
    try {
      const recovered = options.claims.recoverMany(owner, browserSessionId, stored.claims);
      for (const [targetId, claim] of recovered) {
        recoveredClaims.set(targetId, claim.claimEpoch);
        if (targetId === stored.targetId) currentExpiresAt = claim.expiresAt;
      }
      const currentEpoch = recoveredClaims.get(stored.targetId);
      if (currentEpoch === undefined) throw new Error('Recovered browser session lost its current target claim');

      let groupId = stored.groupId;
      let groupTitle = stored.groupTitle;
      const groupedTargets = new Set(stored.groupedTargets);
      if (stored.executionMode === 'AI_TAB_GROUP') {
        const grouped = await options.control.groupTarget(
          stored.targetId,
          stored.groupTitle ?? `WAG • ${stored.profileId}`,
        );
        if (!grouped.activeStable) throw new Error('Recovered AI tab grouping changed the active browser tab');
        groupId = grouped.groupId;
        groupTitle = grouped.groupTitle;
        groupedTargets.add(stored.targetId);
      }

      const target = await options.control.attach(stored.targetId);
      attached = true;
      if (!target.attachable || !target.attached) {
        throw new Error('Recovered browser target could not be attached');
      }
      await options.control.watchContinuity(stored.rootTargetId);

      const controlState = stored.controlState === 'RESUMING' || stored.controlState === 'STOPPED'
        ? 'PAUSED_FOR_USER'
        : stored.controlState;
      const handle: BrowserSessionHandle = Object.freeze({
        browserSessionId,
        profileId: stored.profileId,
        owner: Object.freeze({ ...owner }),
        backend: 'cdp',
        executionMode: stored.executionMode,
        ownershipMode: 'ATTACHED_EXISTING',
        controlState,
        rootTargetId: stored.rootTargetId,
        targetId: stored.targetId,
        targetGeneration: stored.targetGeneration,
        claimEpoch: currentEpoch,
        claimExpiresAt: currentExpiresAt,
        ...(groupId === undefined ? {} : { groupId }),
        ...(groupTitle === undefined ? {} : { groupTitle }),
        createdAt: stored.createdAt,
        lastSeenAt: now(),
        state: 'ACTIVE',
      });
      const session: AttachedSession = {
        handle,
        rootTargetId: stored.rootTargetId,
        targetId: stored.targetId,
        claimEpoch: currentEpoch,
        targetGeneration: stored.targetGeneration,
        claims: recoveredClaims,
        groupedTargets,
      };
      sessions.set(browserSessionId, session);
      persist(session);
      return clone(handle);
    } catch (error) {
      if (attached) await options.control.release(stored.targetId).catch(() => undefined);
      for (const [targetId, claimEpoch] of recoveredClaims) {
        try {
          options.claims.release(owner, targetId, browserSessionId, claimEpoch);
        } catch {
          // Preserve the original recovery failure. Any unreleased claim remains short-lived.
        }
      }
      throw error;
    }
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
    async recover(owner, browserSessionId) {
      return recoverSession(owner, browserSessionId);
    },

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
        await options.control.watchContinuity(request.targetId);

        const createdAt = now();
        const handle: BrowserSessionHandle = Object.freeze({
          browserSessionId,
          profileId: request.profileId,
          owner: Object.freeze({ ...request.owner }),
          backend: 'cdp',
          executionMode: request.mode,
          ownershipMode: 'ATTACHED_EXISTING',
          controlState: 'RUNNING',
          rootTargetId: request.targetId,
          targetId: request.targetId,
          targetGeneration: 0,
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
        const session: AttachedSession = {
          handle,
          rootTargetId: request.targetId,
          targetId: request.targetId,
          claimEpoch: claim.claimEpoch,
          targetGeneration: 0,
          claims: new Map([[request.targetId, claim.claimEpoch]]),
          groupedTargets: new Set(grouped === undefined ? [] : [request.targetId]),
        };
        sessions.set(browserSessionId, session);
        persist(session);
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
      await refreshContinuity(session);
      await options.control.describe(session.targetId);
      return clone(session.handle);
    },

    async snapshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      heartbeat(session);
      await refreshContinuity(session);
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
      await refreshContinuity(session);
      const value = await options.control.exec(session.targetId, request.method, request.params);
      session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
      persist(session);
      return value;
    },

    async screenshot(owner, browserSessionId) {
      const session = owned(owner, browserSessionId);
      heartbeat(session);
      await refreshContinuity(session);
      const value = await options.control.screenshot(session.targetId);
      session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
      persist(session);
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
        for (const [targetId, claimEpoch] of session.claims) {
          options.claims.release(
            owner,
            targetId,
            browserSessionId,
            claimEpoch,
          );
        }
        session.claims.clear();
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
      if (failure) {
        options.sessionStore?.markClosed(owner, browserSessionId, 'FAILED', now());
        throw failure;
      }
      options.sessionStore?.markClosed(owner, browserSessionId, 'CLOSED', now());
      sessions.delete(browserSessionId);
      return clone(session.handle);
    },

    async suspendForRestart() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      let failure: unknown;
      for (const [browserSessionId, session] of sessions) {
        if (session.handle.state !== 'ACTIVE') continue;
        let detached = false;
        try {
          await options.control.release(session.targetId);
          detached = true;
        } catch (error) {
          failure ??= error;
        }
        if (detached) {
          for (const [targetId, claimEpoch] of session.claims) {
            try {
              options.claims.release(
                session.handle.owner,
                targetId,
                browserSessionId,
                claimEpoch,
              );
            } catch (error) {
              failure ??= error;
            }
          }
        }
        session.handle = Object.freeze({
          ...session.handle,
          state: 'RECOVERABLE',
          lastSeenAt: now(),
        });
        try {
          options.sessionStore?.markRecoverable(session.handle.owner, browserSessionId, now());
        } catch (error) {
          failure ??= error;
        }
      }
      sessions.clear();
      if (failure) throw failure;
    },

    shutdown() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
    },
  };
}
