import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { GatewayAuthority } from '../caller-context.js';
import { sameAuthorityTuple } from '../authority-tuple.js';

export type SandboxIsolation = 'host-bounded' | 'container' | 'microvm';
export type SandboxWorkspaceMode = 'read-only' | 'read-write';
export type SandboxSessionState = 'ACTIVE' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface SandboxNetworkPolicy {
  readonly denyByDefault: true;
  readonly allowedHosts: readonly string[];
  readonly allowUdp: false;
}

export interface SandboxProfile {
  readonly profileId: string;
  readonly minimumIsolation: SandboxIsolation;
  readonly workspaceMode: SandboxWorkspaceMode;
  readonly network: SandboxNetworkPolicy;
  readonly credentialIds: readonly string[];
  readonly maxRunMs: number;
  readonly maxOutputBytes: number;
  readonly requireWorkspaceScope: boolean;
  readonly requirePrivateProcessNamespace: boolean;
}

export interface SandboxWorkspaceIdentity {
  readonly workspaceId: string;
  readonly root: string;
  readonly identityToken: string;
}

export interface SandboxBackendCapabilities {
  readonly isolation: SandboxIsolation;
  readonly networkPolicyEnforced: boolean;
  readonly hostCredentialInjection: boolean;
  readonly workspaceScopeEnforced: boolean;
  readonly privateProcessNamespace: boolean;
}

export interface SandboxProfileResolver {
  resolve(owner: GatewayAuthority, profileId: string): Promise<SandboxProfile>;
}

export interface SandboxWorkspaceResolver {
  resolve(owner: GatewayAuthority, workspaceId: string): Promise<SandboxWorkspaceIdentity>;
}

export interface SandboxOpenPlan {
  readonly profile: SandboxProfile;
  readonly workspace: SandboxWorkspaceIdentity;
  readonly backendCapabilities: SandboxBackendCapabilities;
}

export interface SandboxExecRequest {
  readonly argv: readonly string[];
  readonly cwdRelative?: string;
  readonly timeoutMs?: number;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export interface SandboxBackendSession {
  exec(request: {
    readonly argv: readonly string[];
    readonly cwdRelative?: string;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }): Promise<SandboxExecResult>;
  close(): Promise<void>;
}

export interface SandboxBackend {
  describeCapabilities(): Promise<SandboxBackendCapabilities>;
  open(plan: SandboxOpenPlan): Promise<SandboxBackendSession>;
}

export interface SandboxSessionHandle {
  readonly sandboxSessionId: string;
  readonly owner: GatewayAuthority;
  readonly profile: SandboxProfile;
  readonly workspace: SandboxWorkspaceIdentity;
  readonly backendCapabilities: SandboxBackendCapabilities;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly state: SandboxSessionState;
}

export interface SandboxPort {
  open(
    owner: GatewayAuthority,
    request: { readonly profileId: string; readonly workspaceId: string },
  ): Promise<SandboxSessionHandle>;
  describe(owner: GatewayAuthority, sandboxSessionId: string): Promise<SandboxSessionHandle>;
  exec(
    owner: GatewayAuthority,
    sandboxSessionId: string,
    request: SandboxExecRequest,
  ): Promise<SandboxExecResult>;
  close(owner: GatewayAuthority, sandboxSessionId: string): Promise<SandboxSessionHandle>;
}

interface LiveSandboxSession {
  handle: SandboxSessionHandle;
  backend: SandboxBackendSession;
}

const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const SESSION_ID = /^sandbox_[0-9a-f-]{36}$/;
const HOST = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?)(?::[1-9][0-9]{0,4})?$/;
const TOKEN = /^[^\u0000-\u001F]{1,1024}$/;
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 16 * 1024;
const MAX_RUN_MS = 30 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const ISOLATION_RANK: Readonly<Record<SandboxIsolation, number>> = Object.freeze({
  'host-bounded': 0,
  container: 1,
  microvm: 2,
});

function validateCapabilities(capabilities: SandboxBackendCapabilities): void {
  if (!(capabilities.isolation in ISOLATION_RANK)) {
    throw new Error('Sandbox backend isolation is invalid');
  }
  for (const value of [
    capabilities.networkPolicyEnforced,
    capabilities.hostCredentialInjection,
    capabilities.workspaceScopeEnforced,
    capabilities.privateProcessNamespace,
  ]) {
    if (typeof value !== 'boolean') throw new Error('Sandbox backend capability is invalid');
  }
}

function normalizeHosts(hosts: readonly string[]): readonly string[] {
  if (!Array.isArray(hosts) || hosts.length > 128) {
    throw new Error('Sandbox network host set is invalid');
  }
  const output = new Set<string>();
  for (const raw of hosts) {
    if (typeof raw !== 'string'
        || !HOST.test(raw)
        || raw.includes('..')
        || raw.startsWith('.')
        || raw.endsWith('.')) {
      throw new Error('Sandbox network host is invalid');
    }
    const host = raw.toLowerCase();
    const portMatch = host.match(/:(\d+)$/);
    if (portMatch && Number(portMatch[1]) > 65535) {
      throw new Error('Sandbox network host port is invalid');
    }
    output.add(host);
  }
  return Object.freeze([...output].sort());
}

function normalizeProfile(profile: SandboxProfile): SandboxProfile {
  if (!ID.test(profile.profileId)) throw new Error('Sandbox profile id is invalid');
  if (!(profile.minimumIsolation in ISOLATION_RANK)) {
    throw new Error('Sandbox profile isolation is invalid');
  }
  if (profile.workspaceMode !== 'read-only' && profile.workspaceMode !== 'read-write') {
    throw new Error('Sandbox workspace mode is invalid');
  }
  if (profile.network.denyByDefault !== true || profile.network.allowUdp !== false) {
    throw new Error('Sandbox v1 requires deny-by-default TCP-only network policy');
  }
  const credentialIds = new Set<string>();
  for (const credentialId of profile.credentialIds) {
    if (!ID.test(credentialId)) throw new Error('Sandbox credential id is invalid');
    credentialIds.add(credentialId);
  }
  if (!Number.isInteger(profile.maxRunMs) || profile.maxRunMs < 100 || profile.maxRunMs > MAX_RUN_MS) {
    throw new Error('Sandbox run time limit is invalid');
  }
  if (!Number.isInteger(profile.maxOutputBytes)
      || profile.maxOutputBytes < 1024
      || profile.maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw new Error('Sandbox output limit is invalid');
  }
  if (typeof profile.requireWorkspaceScope !== 'boolean'
      || typeof profile.requirePrivateProcessNamespace !== 'boolean') {
    throw new Error('Sandbox profile requirements are invalid');
  }
  return Object.freeze({
    ...profile,
    network: Object.freeze({
      denyByDefault: true,
      allowedHosts: normalizeHosts(profile.network.allowedHosts),
      allowUdp: false,
    }),
    credentialIds: Object.freeze([...credentialIds].sort()),
  });
}

function validateWorkspace(workspace: SandboxWorkspaceIdentity): void {
  if (!ID.test(workspace.workspaceId)) throw new Error('Sandbox workspace id is invalid');
  if (!isAbsolute(workspace.root)
      || workspace.root.includes('\0')
      || Buffer.byteLength(workspace.root, 'utf8') > 4096) {
    throw new Error('Sandbox workspace root is invalid');
  }
  if (!TOKEN.test(workspace.identityToken)) throw new Error('Sandbox workspace identity token is invalid');
}

function sameWorkspace(a: SandboxWorkspaceIdentity, b: SandboxWorkspaceIdentity): boolean {
  const rootMatches = process.platform === 'win32'
    ? a.root.toLowerCase() === b.root.toLowerCase()
    : a.root === b.root;
  return a.workspaceId === b.workspaceId
    && rootMatches
    && a.identityToken === b.identityToken;
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameProfile(a: SandboxProfile, b: SandboxProfile): boolean {
  return a.profileId === b.profileId
    && a.minimumIsolation === b.minimumIsolation
    && a.workspaceMode === b.workspaceMode
    && a.maxRunMs === b.maxRunMs
    && a.maxOutputBytes === b.maxOutputBytes
    && a.requireWorkspaceScope === b.requireWorkspaceScope
    && a.requirePrivateProcessNamespace === b.requirePrivateProcessNamespace
    && a.network.denyByDefault === b.network.denyByDefault
    && a.network.allowUdp === b.network.allowUdp
    && sameStringArray(a.network.allowedHosts, b.network.allowedHosts)
    && sameStringArray(a.credentialIds, b.credentialIds);
}

function validateBackendForProfile(
  profile: SandboxProfile,
  capabilities: SandboxBackendCapabilities,
): void {
  if (ISOLATION_RANK[capabilities.isolation] < ISOLATION_RANK[profile.minimumIsolation]) {
    throw new Error('Sandbox backend does not satisfy required isolation');
  }
  if (!capabilities.networkPolicyEnforced) {
    throw new Error('Sandbox backend does not enforce network policy');
  }
  if (profile.credentialIds.length > 0 && !capabilities.hostCredentialInjection) {
    throw new Error('Sandbox backend cannot keep credentials host-side');
  }
  if (profile.requireWorkspaceScope && !capabilities.workspaceScopeEnforced) {
    throw new Error('Sandbox backend does not enforce workspace scope');
  }
  if (profile.requirePrivateProcessNamespace && !capabilities.privateProcessNamespace) {
    throw new Error('Sandbox backend does not provide a private process namespace');
  }
}

function validateArgv(argv: readonly string[]): readonly string[] {
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGS) {
    throw new Error('Sandbox argv is invalid');
  }
  const output: string[] = [];
  for (const arg of argv) {
    if (typeof arg !== 'string'
        || arg.length < 1
        || arg.includes('\0')
        || Buffer.byteLength(arg, 'utf8') > MAX_ARG_BYTES) {
      throw new Error('Sandbox argv is invalid');
    }
    output.push(arg);
  }
  return Object.freeze(output);
}

function validateCwdRelative(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value === '' || value.includes('\0') || value.startsWith('/') || value.startsWith('\\')
      || /^[A-Za-z]:/.test(value)) {
    throw new Error('Sandbox cwd must be workspace-relative');
  }
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Sandbox cwd must be workspace-relative');
  }
  return parts.join('/');
}

function cloneProfile(profile: SandboxProfile): SandboxProfile {
  return Object.freeze({
    ...profile,
    network: Object.freeze({
      ...profile.network,
      allowedHosts: Object.freeze([...profile.network.allowedHosts]),
    }),
    credentialIds: Object.freeze([...profile.credentialIds]),
  });
}

function cloneWorkspace(workspace: SandboxWorkspaceIdentity): SandboxWorkspaceIdentity {
  return Object.freeze({ ...workspace });
}

function cloneCapabilities(capabilities: SandboxBackendCapabilities): SandboxBackendCapabilities {
  return Object.freeze({ ...capabilities });
}

function cloneHandle(handle: SandboxSessionHandle): SandboxSessionHandle {
  return Object.freeze({
    ...handle,
    owner: Object.freeze({ ...handle.owner }),
    profile: cloneProfile(handle.profile),
    workspace: cloneWorkspace(handle.workspace),
    backendCapabilities: cloneCapabilities(handle.backendCapabilities),
  });
}

export function createSandboxPort(options: {
  profileResolver: SandboxProfileResolver;
  workspaceResolver: SandboxWorkspaceResolver;
  backend: SandboxBackend;
  effectAllowed(
    owner: GatewayAuthority,
    profile: SandboxProfile,
    workspace: SandboxWorkspaceIdentity,
  ): boolean;
  now?: () => number;
  randomUUID?: () => string;
}): SandboxPort {
  const now = options.now ?? Date.now;
  const uuid = options.randomUUID ?? randomUUID;
  const sessions = new Map<string, LiveSandboxSession>();
  const opening = new Set<string>();
  const active = new Set<string>();

  function key(profileId: string, workspaceId: string): string {
    return `${profileId}\0${workspaceId}`;
  }

  function owned(owner: GatewayAuthority, sandboxSessionId: string): LiveSandboxSession {
    if (!SESSION_ID.test(sandboxSessionId)) throw new Error('Sandbox session id is invalid');
    const session = sessions.get(sandboxSessionId);
    if (!session) throw new Error('Sandbox session not found');
    if (!sameAuthorityTuple(session.handle.owner, owner)) {
      throw new Error('Sandbox session is owned by another authority');
    }
    if (session.handle.state !== 'ACTIVE') {
      throw new Error(`Sandbox session is not active: ${session.handle.state}`);
    }
    return session;
  }

  function update(session: LiveSandboxSession, patch: Partial<SandboxSessionHandle>): void {
    session.handle = Object.freeze({ ...session.handle, ...patch, updatedAt: now() });
  }

  async function revalidate(session: LiveSandboxSession): Promise<void> {
    const [profileRaw, workspace] = await Promise.all([
      options.profileResolver.resolve(session.handle.owner, session.handle.profile.profileId),
      options.workspaceResolver.resolve(session.handle.owner, session.handle.workspace.workspaceId),
    ]);
    const profile = normalizeProfile(profileRaw);
    validateWorkspace(workspace);
    if (!sameProfile(session.handle.profile, profile)) {
      throw new Error('Sandbox profile changed');
    }
    if (!sameWorkspace(session.handle.workspace, workspace)) {
      throw new Error('Sandbox workspace identity changed');
    }
    validateBackendForProfile(profile, session.handle.backendCapabilities);
  }

  return {
    async open(owner, request) {
      if (!ID.test(request.profileId) || !ID.test(request.workspaceId)) {
        throw new Error('Sandbox open request is invalid');
      }
      const resourceKey = key(request.profileId, request.workspaceId);
      if (opening.has(resourceKey) || active.has(resourceKey)) {
        throw new Error('Sandbox profile/workspace already has an active session');
      }
      opening.add(resourceKey);

      try {
        const [profileRaw, workspace, capabilities] = await Promise.all([
          options.profileResolver.resolve(owner, request.profileId),
          options.workspaceResolver.resolve(owner, request.workspaceId),
          options.backend.describeCapabilities(),
        ]);
        const profile = normalizeProfile(profileRaw);
        validateWorkspace(workspace);
        validateCapabilities(capabilities);
        validateBackendForProfile(profile, capabilities);
        if (!options.effectAllowed(owner, profile, workspace)) {
          throw new Error('Sandbox execution denied');
        }

        const backend = await options.backend.open({
          profile,
          workspace,
          backendCapabilities: capabilities,
        });
        try {
          const [profileAfterRaw, workspaceAfter] = await Promise.all([
            options.profileResolver.resolve(owner, request.profileId),
            options.workspaceResolver.resolve(owner, request.workspaceId),
          ]);
          const profileAfter = normalizeProfile(profileAfterRaw);
          validateWorkspace(workspaceAfter);
          if (!sameProfile(profile, profileAfter) || !sameWorkspace(workspace, workspaceAfter)) {
            throw new Error('Sandbox authority changed during open');
          }
          if (!options.effectAllowed(owner, profileAfter, workspaceAfter)) {
            throw new Error('Sandbox execution denied');
          }
        } catch (error) {
          await backend.close().catch(() => undefined);
          throw error;
        }

        const createdAt = now();
        const handle: SandboxSessionHandle = Object.freeze({
          sandboxSessionId: `sandbox_${uuid()}`,
          owner: Object.freeze({ ...owner }),
          profile: cloneProfile(profile),
          workspace: cloneWorkspace(workspace),
          backendCapabilities: cloneCapabilities(capabilities),
          createdAt,
          updatedAt: createdAt,
          state: 'ACTIVE',
        });
        sessions.set(handle.sandboxSessionId, { handle, backend });
        active.add(resourceKey);
        return cloneHandle(handle);
      } finally {
        opening.delete(resourceKey);
      }
    },

    async describe(owner, sandboxSessionId) {
      const session = owned(owner, sandboxSessionId);
      await revalidate(session);
      return cloneHandle(session.handle);
    },

    async exec(owner, sandboxSessionId, request) {
      const session = owned(owner, sandboxSessionId);
      await revalidate(session);
      if (!options.effectAllowed(owner, session.handle.profile, session.handle.workspace)) {
        throw new Error('Sandbox execution denied');
      }

      const argv = validateArgv(request.argv);
      const cwdRelative = validateCwdRelative(request.cwdRelative);
      const timeoutMs = request.timeoutMs ?? session.handle.profile.maxRunMs;
      if (!Number.isInteger(timeoutMs)
          || timeoutMs < 100
          || timeoutMs > session.handle.profile.maxRunMs) {
        throw new Error('Sandbox execution timeout is invalid');
      }

      const result = await session.backend.exec({
        argv,
        ...(cwdRelative === undefined ? {} : { cwdRelative }),
        timeoutMs,
        maxOutputBytes: session.handle.profile.maxOutputBytes,
      });
      if (!Number.isInteger(result.exitCode) || result.exitCode < -1 || result.exitCode > 255) {
        throw new Error('Sandbox backend returned invalid exit code');
      }
      if (typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
        throw new Error('Sandbox backend returned invalid output');
      }
      const outputBytes = Buffer.byteLength(result.stdout, 'utf8')
        + Buffer.byteLength(result.stderr, 'utf8');
      if (outputBytes > session.handle.profile.maxOutputBytes) {
        throw new Error('Sandbox backend exceeded output limit');
      }
      if (typeof result.timedOut !== 'boolean') {
        throw new Error('Sandbox backend returned invalid timeout state');
      }
      update(session, {});
      return Object.freeze({ ...result });
    },

    async close(owner, sandboxSessionId) {
      const session = owned(owner, sandboxSessionId);
      update(session, { state: 'CLOSING' });
      try {
        await session.backend.close();
        update(session, { state: 'CLOSED' });
      } catch (error) {
        update(session, { state: 'FAILED' });
        throw error;
      } finally {
        active.delete(key(session.handle.profile.profileId, session.handle.workspace.workspaceId));
      }
      return cloneHandle(session.handle);
    },
  };
}
