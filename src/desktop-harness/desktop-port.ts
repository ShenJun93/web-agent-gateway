import { randomUUID } from 'node:crypto';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type DesktopSessionState = 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'FAILED';
export type DesktopPattern = 'Invoke' | 'Value' | 'Toggle' | 'SelectionItem';
export type DesktopEffect = 'invoke' | 'setValue' | 'toggle' | 'select';

export interface DesktopTargetIdentity {
  readonly targetId: string;
  readonly pid: number;
  readonly processInstanceId: string;
  readonly executablePath: string;
  readonly nativeWindowId: string;
  readonly title: string;
}

export interface DesktopTargetResolver {
  resolve(owner: GatewayAuthority, targetId: string): Promise<DesktopTargetIdentity>;
}

export interface DesktopBackendNode {
  readonly backendElementId: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly enabled: boolean;
  readonly patterns: readonly DesktopPattern[];
}

export interface DesktopBackendSession {
  snapshot(): Promise<readonly DesktopBackendNode[]>;
  invoke(backendElementId: string): Promise<void>;
  setValue(backendElementId: string, value: string): Promise<void>;
  toggle(backendElementId: string): Promise<void>;
  select(backendElementId: string): Promise<void>;
  screenshot(): Promise<{ readonly mimeType: 'image/png'; readonly dataBase64: string }>;
  close(): Promise<void>;
}

export interface DesktopBackend {
  open(target: DesktopTargetIdentity): Promise<DesktopBackendSession>;
}

export interface DesktopSessionHandle {
  readonly desktopSessionId: string;
  readonly owner: GatewayAuthority;
  readonly target: DesktopTargetIdentity;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly state: DesktopSessionState;
}

export interface DesktopNode {
  readonly ref: string;
  readonly role: string;
  readonly name: string;
  readonly value?: string;
  readonly enabled: boolean;
  readonly patterns: readonly DesktopPattern[];
}

export interface DesktopSnapshot {
  readonly snapshotId: string;
  readonly desktopSessionId: string;
  readonly target: DesktopTargetIdentity;
  readonly nodes: readonly DesktopNode[];
  readonly observedAt: number;
}

export interface DesktopPort {
  open(owner: GatewayAuthority, targetId: string): Promise<DesktopSessionHandle>;
  describe(owner: GatewayAuthority, desktopSessionId: string): Promise<DesktopSessionHandle>;
  snapshot(owner: GatewayAuthority, desktopSessionId: string): Promise<DesktopSnapshot>;
  invoke(owner: GatewayAuthority, desktopSessionId: string, ref: string): Promise<void>;
  setValue(owner: GatewayAuthority, desktopSessionId: string, ref: string, value: string): Promise<void>;
  toggle(owner: GatewayAuthority, desktopSessionId: string, ref: string): Promise<void>;
  select(owner: GatewayAuthority, desktopSessionId: string, ref: string): Promise<void>;
  screenshot(owner: GatewayAuthority, desktopSessionId: string): Promise<{
    readonly mimeType: 'image/png';
    readonly dataBase64: string;
  }>;
  close(owner: GatewayAuthority, desktopSessionId: string): Promise<DesktopSessionHandle>;
}

interface SnapshotBinding {
  readonly snapshotId: string;
  readonly elements: Map<string, {
    readonly backendElementId: string;
    readonly node: DesktopNode;
  }>;
}

interface LiveDesktopSession {
  handle: DesktopSessionHandle;
  backend: DesktopBackendSession;
  binding?: SnapshotBinding;
}

const TARGET_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_ID = /^desktop_[0-9a-f-]{36}$/;
const REF = /^desktop_node_[0-9a-f-]{36}_[0-9]+$/;
const OPAQUE = /^[^\u0000-\u001F]{1,512}$/;
const MAX_VALUE_BYTES = 64 * 1024;

function validateTarget(target: DesktopTargetIdentity): void {
  if (!TARGET_ID.test(target.targetId)) throw new Error('Desktop target id is invalid');
  if (!Number.isInteger(target.pid) || target.pid <= 0) throw new Error('Desktop target pid is invalid');
  if (!OPAQUE.test(target.processInstanceId)) throw new Error('Desktop target process instance is invalid');
  if (typeof target.executablePath !== 'string' || target.executablePath.length < 1
      || target.executablePath.includes('\0') || Buffer.byteLength(target.executablePath, 'utf8') > 4096) {
    throw new Error('Desktop target executable path is invalid');
  }
  if (!OPAQUE.test(target.nativeWindowId)) throw new Error('Desktop target native window id is invalid');
  if (typeof target.title !== 'string' || /[\u0000-\u001F]/.test(target.title)
      || Buffer.byteLength(target.title, 'utf8') > 4096) {
    throw new Error('Desktop target title is invalid');
  }
}

function sameTarget(a: DesktopTargetIdentity, b: DesktopTargetIdentity): boolean {
  const executableMatches = process.platform === 'win32'
    ? a.executablePath.toLowerCase() === b.executablePath.toLowerCase()
    : a.executablePath === b.executablePath;
  return a.targetId === b.targetId
    && a.pid === b.pid
    && a.processInstanceId === b.processInstanceId
    && a.nativeWindowId === b.nativeWindowId
    && executableMatches;
}

function cloneTarget(target: DesktopTargetIdentity): DesktopTargetIdentity {
  return Object.freeze({ ...target });
}

function cloneHandle(handle: DesktopSessionHandle): DesktopSessionHandle {
  return Object.freeze({
    ...handle,
    owner: Object.freeze({ ...handle.owner }),
    target: cloneTarget(handle.target),
  });
}

function normalizedPatterns(patterns: readonly DesktopPattern[]): readonly DesktopPattern[] {
  const allowed = new Set<DesktopPattern>(['Invoke', 'Value', 'Toggle', 'SelectionItem']);
  const unique = new Set<DesktopPattern>();
  for (const pattern of patterns) {
    if (!allowed.has(pattern)) throw new Error('Desktop backend returned unsupported control pattern');
    unique.add(pattern);
  }
  return Object.freeze([...unique].sort());
}

export function createDesktopPort(options: {
  resolver: DesktopTargetResolver;
  backend: DesktopBackend;
  effectAllowed(owner: GatewayAuthority, target: DesktopTargetIdentity, effect: DesktopEffect): boolean;
  now?: () => number;
  randomUUID?: () => string;
}): DesktopPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const sessions = new Map<string, LiveDesktopSession>();
  const activeTargets = new Map<string, string>();

  function owned(owner: GatewayAuthority, desktopSessionId: string): LiveDesktopSession {
    if (!SESSION_ID.test(desktopSessionId)) throw new Error('Desktop session id is invalid');
    const session = sessions.get(desktopSessionId);
    if (!session) throw new Error('Desktop session not found');
    if (!sameAuthorityTuple(session.handle.owner, owner)) {
      throw new Error('Desktop session is owned by another authority');
    }
    if (session.handle.state !== 'ACTIVE') {
      throw new Error(`Desktop session is not active: ${session.handle.state}`);
    }
    return session;
  }

  function touch(session: LiveDesktopSession): void {
    session.handle = Object.freeze({ ...session.handle, lastSeenAt: now() });
  }

  async function revalidate(session: LiveDesktopSession): Promise<void> {
    const current = await options.resolver.resolve(session.handle.owner, session.handle.target.targetId);
    validateTarget(current);
    if (!sameTarget(session.handle.target, current)) {
      throw new Error('Desktop target identity changed');
    }
  }

  function element(session: LiveDesktopSession, ref: string, pattern: DesktopPattern) {
    if (!REF.test(ref)) throw new Error('Desktop element ref is invalid');
    const binding = session.binding;
    const resolved = binding?.elements.get(ref);
    if (!binding || !resolved) throw new Error('Desktop element ref is stale or unknown');
    if (!resolved.node.enabled) throw new Error('Desktop target element is disabled');
    if (!resolved.node.patterns.includes(pattern)) {
      throw new Error(`Desktop target does not support ${pattern}`);
    }
    return resolved;
  }

  async function effect(
    owner: GatewayAuthority,
    desktopSessionId: string,
    ref: string,
    pattern: DesktopPattern,
    effectName: DesktopEffect,
    run: (backend: DesktopBackendSession, backendElementId: string) => Promise<void>,
  ): Promise<void> {
    const session = owned(owner, desktopSessionId);
    await revalidate(session);
    const resolved = element(session, ref, pattern);
    if (!options.effectAllowed(owner, session.handle.target, effectName)) {
      throw new Error('Desktop effect denied');
    }
    // UI Automation providers may remove an element immediately after an action. Invalidate the
    // whole binding before crossing the effect boundary so no stale ref can be replayed.
    session.binding = undefined;
    await run(session.backend, resolved.backendElementId);
    touch(session);
  }

  return {
    async open(owner, targetId) {
      if (!TARGET_ID.test(targetId)) throw new Error('Desktop target id is invalid');
      if (activeTargets.has(targetId)) throw new Error('Desktop target already has an active session');
      const target = await options.resolver.resolve(owner, targetId);
      validateTarget(target);
      const backend = await options.backend.open(target);
      const createdAt = now();
      const handle: DesktopSessionHandle = Object.freeze({
        desktopSessionId: `desktop_${uuid()}`,
        owner: Object.freeze({ ...owner }),
        target: cloneTarget(target),
        createdAt,
        lastSeenAt: createdAt,
        state: 'ACTIVE',
      });
      sessions.set(handle.desktopSessionId, { handle, backend });
      activeTargets.set(target.targetId, handle.desktopSessionId);
      return cloneHandle(handle);
    },

    async describe(owner, desktopSessionId) {
      const session = owned(owner, desktopSessionId);
      await revalidate(session);
      touch(session);
      return cloneHandle(session.handle);
    },

    async snapshot(owner, desktopSessionId) {
      const session = owned(owner, desktopSessionId);
      await revalidate(session);
      const snapshotId = uuid();
      const backendNodes = await session.backend.snapshot();
      const elements = new Map<string, { backendElementId: string; node: DesktopNode }>();
      const nodes: DesktopNode[] = [];
      let index = 0;
      for (const backendNode of backendNodes) {
        if (typeof backendNode.backendElementId !== 'string' || !OPAQUE.test(backendNode.backendElementId)) {
          throw new Error('Desktop backend element id is invalid');
        }
        if (typeof backendNode.role !== 'string' || typeof backendNode.name !== 'string') {
          throw new Error('Desktop backend element metadata is invalid');
        }
        const ref = `desktop_node_${snapshotId}_${index++}`;
        const node: DesktopNode = Object.freeze({
          ref,
          role: backendNode.role,
          name: backendNode.name,
          ...(backendNode.value === undefined ? {} : { value: backendNode.value }),
          enabled: backendNode.enabled === true,
          patterns: normalizedPatterns(backendNode.patterns),
        });
        elements.set(ref, { backendElementId: backendNode.backendElementId, node });
        nodes.push(node);
      }
      session.binding = { snapshotId, elements };
      touch(session);
      return Object.freeze({
        snapshotId,
        desktopSessionId,
        target: cloneTarget(session.handle.target),
        nodes: Object.freeze(nodes),
        observedAt: now(),
      });
    },

    invoke(owner, desktopSessionId, ref) {
      return effect(owner, desktopSessionId, ref, 'Invoke', 'invoke',
        (backend, id) => backend.invoke(id));
    },

    setValue(owner, desktopSessionId, ref, value) {
      if (typeof value !== 'string' || value.includes('\0')
          || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        throw new Error('Desktop value is invalid');
      }
      return effect(owner, desktopSessionId, ref, 'Value', 'setValue',
        (backend, id) => backend.setValue(id, value));
    },

    toggle(owner, desktopSessionId, ref) {
      return effect(owner, desktopSessionId, ref, 'Toggle', 'toggle',
        (backend, id) => backend.toggle(id));
    },

    select(owner, desktopSessionId, ref) {
      return effect(owner, desktopSessionId, ref, 'SelectionItem', 'select',
        (backend, id) => backend.select(id));
    },

    async screenshot(owner, desktopSessionId) {
      const session = owned(owner, desktopSessionId);
      await revalidate(session);
      const image = await session.backend.screenshot();
      touch(session);
      return image;
    },

    async close(owner, desktopSessionId) {
      const session = owned(owner, desktopSessionId);
      session.binding = undefined;
      session.handle = Object.freeze({ ...session.handle, state: 'CLOSING', lastSeenAt: now() });
      try {
        await session.backend.close();
        session.handle = Object.freeze({ ...session.handle, state: 'CLOSED', lastSeenAt: now() });
      } catch (error) {
        session.handle = Object.freeze({ ...session.handle, state: 'FAILED', lastSeenAt: now() });
        throw error;
      } finally {
        activeTargets.delete(session.handle.target.targetId);
      }
      return cloneHandle(session.handle);
    },
  };
}
