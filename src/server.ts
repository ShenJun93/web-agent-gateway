import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';
import type { GatewayCallerContext } from './caller-context.js';
import type { LocalMachineContext } from './local-machine-runtime.js';
import type { DurableMutationCoordinator } from './durable-mutation.js';
import type { DurableCommitCoordinator } from './git-commit.js';
import type { BrowserVerifyRequestCoordinator } from './browser-verify-request.js';
import type { AdmittedWorkspaceService } from './admitted-workspace.js';
import { resolveVerifyProfile, type VerifyProfile } from './verify-profile.js';
export type { VerifyProfile } from './verify-profile.js';
import {
  DEVSPACE_PROTOCOL_VERSION,
  DevspaceReadLimitError,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceExecutor,
} from './executor/devspace.js';

/** Base hash that marks a mutation record as a creation (ADR-0022). */
const EMPTY_FILE_SHA256 = createHash('sha256').update('', 'utf8').digest('hex');

interface WorkspaceBinding { devspaceWorkspaceId: string; canonicalRoot: string; }
import { DevspaceRepositoryInspectionBackend, type RepoDiffOptions, type RepoListOptions, type RepoSearchOptions, type RepoSnapshotOptions } from './repository-inspection.js';
import { readDevspaceText } from './executor/devspace-read.js';
import { readDevspaceRawFileIdentity } from './executor/devspace-file-identity.js';
import { describeReadableUtf8Text } from './file-read-metadata.js';

export function createGateway({ executor, allowedRoots, verifyProfiles = {}, telemetry = NOOP_TELEMETRY, openWorkspaceId, bindWorkspaceIdentity }: { executor: DevspaceExecutor; allowedRoots: readonly string[]; verifyProfiles?: Readonly<Record<string, VerifyProfile>>; telemetry?: TelemetrySink; openWorkspaceId?: (canonicalRoot: string) => string | Promise<string>; bindWorkspaceIdentity?: (workspaceId: string, canonicalRoot: string, devspaceWorkspaceId: string) => Promise<void> }) {
  const workspaces = new Map<string, WorkspaceBinding>();
  const inspection = new DevspaceRepositoryInspectionBackend(executor);

  function binding(workspaceId: string): WorkspaceBinding {
    const value = workspaces.get(workspaceId);
    if (!value) throw new Error('Unknown workspace_id');
    return value;
  }

  return {
    async health() {
      const trace = startTrace('health', telemetry); trace.markIngress();
      try {
        const tools = await trace.phase('executorMs', () => executor.listTools());
        const result = await trace.phase('aggregationMs', () => {
          const names = tools.map((tool) => tool.name);
          const compatible = names.length === REQUIRED_DEVSPACE_TOOLS.length
            && REQUIRED_DEVSPACE_TOOLS.every((name, index) => names[index] === name);
          if (!compatible) throw new Error(`Incompatible DevSpace tool contract: ${names.join(', ')}`);
          return { status: 'ok' as const, executor: 'devspace' as const, protocolVersion: DEVSPACE_PROTOCOL_VERSION, toolCount: tools.length };
        });
        trace.finish(true); return result;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async openWorkspace(path: string) {
      const trace = startTrace('workspace.open', telemetry); trace.markIngress();
      try {
        const canonicalRoot = await trace.phase('policyMs', () => canonicalWorkspace(path, allowedRoots));
        const devspaceWorkspaceId = await trace.phase('executorMs', () => executor.openWorkspace(canonicalRoot));
        const result = await trace.phase('aggregationMs', async () => {
          const workspaceId = openWorkspaceId ? await openWorkspaceId(canonicalRoot) : `ws_${randomUUID()}`;
          if (bindWorkspaceIdentity) {
            await bindWorkspaceIdentity(workspaceId, canonicalRoot, devspaceWorkspaceId);
          }
          workspaces.set(workspaceId, { devspaceWorkspaceId, canonicalRoot });
          return { workspaceId };
        });
        trace.finish(true); return result;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async readFile(workspaceId: string, path: string) {
      const trace = startTrace('file.read', telemetry); trace.markIngress();
      try {
        const scoped = await trace.phase('policyMs', async () => {
          const workspace = binding(workspaceId);
          const safePath = validateReadPath(path);
          await assertReadTarget(workspace.canonicalRoot, safePath);
          return { safePath, devspaceWorkspaceId: workspace.devspaceWorkspaceId };
        });
        let content: string;
        let rawIdentity: Awaited<ReturnType<typeof readDevspaceRawFileIdentity>>;
        try {
          rawIdentity = await trace.phase('executorMs', () => readDevspaceRawFileIdentity(
            executor,
            scoped.devspaceWorkspaceId,
            scoped.safePath,
          ));
          content = await trace.phase('executorMs', () => readDevspaceText(
            executor,
            scoped.devspaceWorkspaceId,
            scoped.safePath,
            { maxBytes: 64 * 1024, oversizedMessage: 'Gateway rejected oversized content' },
          ));
        }
        catch (error) { if (error instanceof DevspaceReadLimitError) throw new Error('Gateway rejected oversized content'); throw error; }
        const result = await trace.phase('aggregationMs', () => {
          const decoded = describeReadableUtf8Text(content);
          if (
            decoded.raw_sha256 !== rawIdentity.rawSha256
            || decoded.size_bytes !== rawIdentity.sizeBytes
            || decoded.bom !== rawIdentity.bom
            || decoded.newline_mode !== rawIdentity.newlineMode
          ) {
            throw new Error('Gateway rejected raw/text identity mismatch');
          }
          return {
            ...decoded,
            raw_sha256: rawIdentity.rawSha256,
            size_bytes: rawIdentity.sizeBytes,
            bom: rawIdentity.bom,
            newline_mode: rawIdentity.newlineMode,
          };
        });
        trace.finish(true); return result;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async verifyRun(workspaceId: string, profileName: string) {
      const trace = startTrace('verify.run', telemetry); trace.markIngress();
      try {
        const scoped = await trace.phase('policyMs', () => {
          const profile = verifyProfiles[profileName];
          if (!profile) throw new Error('Gateway denied verify profile');
          return { profile: resolveVerifyProfile(profile), devspaceWorkspaceId: binding(workspaceId).devspaceWorkspaceId };
        });
        const result = await trace.phase('executorMs', () => executor.execCommand(
          scoped.devspaceWorkspaceId,
          scoped.profile.command,
          scoped.profile.maxOutputTokens,
          scoped.profile.timeoutMs,
        ));
        if (result.running) {
          if (result.sessionId !== undefined) await trace.phase('executorMs', () => executor.interruptCommand(scoped.devspaceWorkspaceId, result.sessionId!, scoped.profile.maxOutputTokens));
          throw new Error('Gateway verification timed out');
        }
        const value = await trace.phase('aggregationMs', () => ({ profile: profileName, exitCode: result.exitCode ?? -1, output: result.output.trimEnd() }));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async commandRun(
      workspaceId: string,
      argv: readonly string[],
      options: { cwd?: string; timeoutMs?: number; maxOutputTokens?: number; beforeExecute?: () => void | Promise<void> } = {},
    ) {
      const trace = startTrace('command.run', telemetry); trace.markIngress();
      const startedAt = Date.now();
      try {
        const scoped = await trace.phase('policyMs', async () => {
          const workspace = binding(workspaceId);
          const requestedCwd = (options.cwd ?? '.')
            .replace(/\\/g, '/')
            .replace(/^\.\/+/, '')
            .replace(/\/+$/, '');
          const cwd = requestedCwd === '' || requestedCwd === '.'
            ? '.'
            : validateReadPath(requestedCwd);
          if (cwd !== '.') await assertReadTarget(workspace.canonicalRoot, cwd);
          const profile = resolveVerifyProfile({
            argv,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
          }, cwd);
          return { profile, devspaceWorkspaceId: workspace.devspaceWorkspaceId };
        });
        if (options.beforeExecute) {
          await trace.phase('policyMs', async () => { await options.beforeExecute!(); });
        }
        const result = await trace.phase('executorMs', () => executor.execCommand(
          scoped.devspaceWorkspaceId,
          scoped.profile.command,
          scoped.profile.maxOutputTokens,
          scoped.profile.timeoutMs,
        ));
        if (result.running) {
          const sessionId = result.sessionId;
          if (sessionId !== undefined) {
            await trace.phase('executorMs', () => executor.interruptCommand(
              scoped.devspaceWorkspaceId,
              sessionId,
              scoped.profile.maxOutputTokens,
            ));
          }
          const value = await trace.phase('aggregationMs', () => ({
            exitCode: -1,
            output: result.output.trimEnd(),
            timedOut: true,
            durationMs: Date.now() - startedAt,
            cwd: scoped.profile.cwd,
          }));
          trace.finish(true); return value;
        }
        const value = await trace.phase('aggregationMs', () => ({
          exitCode: result.exitCode ?? -1,
          output: result.output.trimEnd(),
          timedOut: false,
          durationMs: Date.now() - startedAt,
          cwd: scoped.profile.cwd,
        }));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async repoSnapshot(workspaceId: string, options: RepoSnapshotOptions = {}) {
      const trace = startTrace('repo.snapshot', telemetry); trace.markIngress();
      try {
        const workspace = binding(workspaceId);
        const value = await trace.phase('executorMs', () => inspection.snapshot(workspace.devspaceWorkspaceId, workspace.canonicalRoot, options));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async repoList(workspaceId: string, options: RepoListOptions = {}) {
      const trace = startTrace('repo.list', telemetry); trace.markIngress();
      try {
        const workspace = await trace.phase('policyMs', async () => {
          const value = binding(workspaceId);
          await assertScopedTarget(value.canonicalRoot, options.path);
          return value;
        });
        const value = await trace.phase('executorMs', () => inspection.list(workspace.devspaceWorkspaceId, workspace.canonicalRoot, options));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async repoDiff(workspaceId: string, options: RepoDiffOptions = {}) {
      const trace = startTrace('repo.diff', telemetry); trace.markIngress();
      try {
        const workspace = await trace.phase('policyMs', async () => {
          const value = binding(workspaceId);
          await assertScopedTarget(value.canonicalRoot, options.path);
          return value;
        });
        const value = await trace.phase('executorMs', () => inspection.diff(workspace.devspaceWorkspaceId, workspace.canonicalRoot, options));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async repoSearch(workspaceId: string, query: string, options: RepoSearchOptions = {}) {
      const trace = startTrace('repo.search', telemetry); trace.markIngress();
      try {
        const workspace = binding(workspaceId);
        const value = await trace.phase('executorMs', () => inspection.search({
          devspaceWorkspaceId: workspace.devspaceWorkspaceId,
          canonicalRoot: workspace.canonicalRoot,
          query,
          ignoreCase: options.ignoreCase ?? false,
          maxResults: Math.min(Math.max(options.maxResults ?? 20, 1), 50),
          contextLines: Math.min(Math.max(options.contextLines ?? 1, 0), 2),
        }));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

  };
}


export type GatewayApi = ReturnType<typeof createGateway>;

export interface BrowserAdmittedMcpContext {
  callerContext: GatewayCallerContext;
  workspaces: Pick<AdmittedWorkspaceService, 'open' | 'read' | 'search' | 'snapshot'>;
}

/**
 * Applies the same realpath confinement to a scoped inspection subtree that `file.read` applies
 * to a file, so the workspace boundary is asserted by WAG rather than inherited from whatever
 * the underlying tool happens to do with a symlink.
 */
async function assertScopedTarget(canonicalRoot: string, path: string | undefined): Promise<void> {
  if (path === undefined || path === '' || path === '.') return;
  await assertReadTarget(canonicalRoot, validateReadPath(path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')));
}

function validSearchQuery(query: string): boolean {
  if (query.includes('\0') || query.includes('\r') || query.includes('\n')) return false;
  if (Buffer.byteLength(query, 'utf8') > 256) return false;
  return true;
}

export function createBrowserAdmittedMcpServer(
  gateway: Pick<GatewayApi, 'health'>,
  context: BrowserAdmittedMcpContext,
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  server.registerTool('health', {
    description: 'Check gateway and executor compatibility.',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async () => toolResult(await gateway.health()));
  server.registerTool('workspace.open', {
    description: 'Open one approved local workspace and return an opaque workspace id.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ path }) => toolResult(await context.workspaces.open(context.callerContext, path)));

  server.registerTool('repo.search', {
    description: 'Search tracked repository files for a literal string.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      query: z.string().min(1).refine(validSearchQuery),
      ignore_case: z.boolean().optional(),
      max_results: z.number().int().min(1).max(50).optional(),
      context_lines: z.number().int().min(0).max(2).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspace_id, query, ignore_case, max_results, context_lines }) => {
    if (!validSearchQuery(query)) throw new Error('Gateway denied search query');
    return toolResult(await context.workspaces.search(
      context.callerContext, workspace_id, query, { ignoreCase: ignore_case, maxResults: max_results, contextLines: context_lines }
    ));
  });

  server.registerTool('repo.snapshot', {
    description: 'Return bounded repository status, HEAD, diff summary, and tracked files.',
    inputSchema: z.object({
      workspace_id: z.string().min(1),
      max_files: z.number().int().min(1).max(200).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspace_id, max_files }) => toolResult(await context.workspaces.snapshot(
    context.callerContext, workspace_id, { maxFiles: max_files }
  )));

  server.registerTool('file.read', {
    description: 'Read bounded text from an opened workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1), path: z.string().min(1) }),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ workspace_id, path }) => toolResult(await context.workspaces.read(
    context.callerContext, workspace_id, path,
  )));
  return server;
}

export interface BrowserVerifyAdmittedMcpContext {
  callerContext: GatewayCallerContext;
  workspaces: Pick<AdmittedWorkspaceService, 'open' | 'read' | 'search' | 'snapshot'>;
  verify: Pick<BrowserVerifyRequestCoordinator, 'preview' | 'result'>;
}

export function createBrowserVerifyAdmittedMcpServer(
  gateway: Pick<GatewayApi, 'health'>,
  context: BrowserVerifyAdmittedMcpContext,
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  server.registerTool('health', {
    description: 'Check gateway and executor compatibility.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(await gateway.health()));

  server.registerTool('workspace.open', {
    description: 'Open one approved local workspace and return an opaque caller-owned workspace id.',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path }) => toolResult(await context.workspaces.open(context.callerContext, path)));

  server.registerTool('repo.search', {
    description: 'Search tracked repository files for a literal string.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      query: z.string().min(1).refine(validSearchQuery),
      ignore_case: z.boolean().optional(),
      max_results: z.number().int().min(1).max(50).optional(),
      context_lines: z.number().int().min(0).max(2).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, query, ignore_case, max_results, context_lines }) => {
    if (!validSearchQuery(query)) throw new Error('Gateway denied search query');
    return toolResult(await context.workspaces.search(
      context.callerContext,
      workspace_id,
      query,
      { ignoreCase: ignore_case, maxResults: max_results, contextLines: context_lines },
    ));
  });

  server.registerTool('repo.snapshot', {
    description: 'Return bounded repository status, HEAD, diff summary, and tracked files.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      max_files: z.number().int().min(1).max(200).optional(),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, max_files }) => toolResult(await context.workspaces.snapshot(
    context.callerContext,
    workspace_id,
    { maxFiles: max_files },
  )));

  server.registerTool('file.read', {
    description: 'Read bounded text from an opened workspace.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      path: z.string().min(1).max(4096),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, path }) => toolResult(await context.workspaces.read(
    context.callerContext,
    workspace_id,
    path,
  )));

  server.registerTool('verify.preview', {
    description: 'Create one bounded caller-owned verification proposal for separate local operator review.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      profile: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, profile }) => toolResult(context.verify.preview(
    context.callerContext,
    workspace_id,
    profile,
  )));

  server.registerTool('verify.result', {
    description: 'Read bounded state or result evidence for one caller-owned verification proposal.',
    inputSchema: z.object({
      request_id: z.string().min(1).max(256).regex(/^verifyreq_[A-Za-z0-9-]+$/),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ request_id }) => toolResult(context.verify.result(
    context.callerContext,
    request_id,
  )));

  return server;
}

export interface GitCommitMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableCommitCoordinator, 'preview' | 'result' | 'admitByPolicy' | 'rejectLocal'>;
  /** Direct private stdio executes immediately under the trusted autonomous-local profile. */
  autonomous?: boolean;
}

export interface MutationMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableMutationCoordinator, 'preview' | 'replace' | 'editBlock' | 'append' | 'result' | 'admitByPolicy' | 'rejectLocal'>;
  /** Same trusted autonomous-local boundary as GitCommitMcpContext. */
  autonomous?: boolean;
}

/**
 * Runtime-owned authority for model-chosen argv execution.
 *
 * The server never derives this from mutation/commit presence: the trusted private runtime
 * must explicitly authorize the caller's exact workspace
 * before any argv reaches the executor.
 */
export interface CommandMcpContext {
  authorize(workspaceId: string): void | Promise<void>;
}

export interface CapabilityMcpContext {
  describe(workspaceId: string): object | Promise<object>;
}

export function createGatewayMcpServer(
  gateway: GatewayApi,
  { inspect, mutationContext, gitCommitContext, commandContext, capabilityContext, machineContext }: {
    inspect?: boolean;
    mutationContext?: MutationMcpContext;
    gitCommitContext?: GitCommitMcpContext;
    commandContext?: CommandMcpContext;
    capabilityContext?: CapabilityMcpContext;
    machineContext?: LocalMachineContext;
  } = {},
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });

  // Compatibility bridge for ChatGPT workspaces that still hold a frozen 16-tool snapshot.
  // The live server also exposes machine.* tools, but published/custom-app metadata is not
  // refreshed automatically. Reusing the existing workspace.open/repo.list/file.read/command.run
  // schemas lets those older snapshots reach the same autonomous-local backend without a manual
  // connector refresh. A workspace id is never client-selected authority: machine.describe
  // revalidates that it belongs to this caller and is a local-machine record.
  async function isLocalMachineWorkspace(workspaceId: string): Promise<boolean> {
    if (!machineContext) return false;
    try {
      await machineContext.describe(workspaceId);
      return true;
    } catch {
      return false;
    }
  }

  server.registerTool('health', {
    description: 'Check gateway and executor compatibility.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => toolResult(await gateway.health()));
  // Not read-only: this canonicalises a root, opens a DevSpace workspace and mints a durable
  // caller-owned workspace record. ADR-0020 records the provider's own warning that a read-only
  // annotation may cause a client's write confirmation to be skipped, so the surface that a
  // remote client discovers must not under-declare. `createBrowserVerifyAdmittedMcpServer`
  // already declares this correctly; this surface had disagreed with it.
  server.registerTool('workspace.open', {
    description: 'Open one approved local workspace and return an opaque workspace id.',
    inputSchema: z.object({ path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ path }) => {
    try {
      const opened = await gateway.openWorkspace(path);
      return toolResult(capabilityContext
        ? { ...opened, authority: await capabilityContext.describe(opened.workspaceId) }
        : opened);
    } catch (error) {
      if (!machineContext) throw error;
      const local = await machineContext.open(path) as { workspace_id?: unknown };
      if (typeof local.workspace_id !== 'string' || local.workspace_id.length === 0) {
        throw new Error('Gateway local-machine workspace did not return an id');
      }
      const opened = { workspaceId: local.workspace_id };
      return toolResult(capabilityContext
        ? { ...opened, authority: await capabilityContext.describe(opened.workspaceId) }
        : opened);
    }
  });

  if (capabilityContext) {
    server.registerTool('capabilities.describe', {
      description: 'Describe the effective bounded authority for one opened workspace before attempting consequential tools.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id }) => toolResult(await capabilityContext.describe(workspace_id)));
  }

  if (machineContext) {
    server.registerTool('machine.open', {
      description: 'Open one local-machine directory in the trusted autonomous-local profile, independent of DevSpace allowedRoots.',
      inputSchema: z.object({ path: z.string().min(1).max(4096) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ path }) => toolResult(await machineContext.open(path)));

    server.registerTool('machine.describe', {
      description: 'Describe the autonomous-local authority state for one opened local-machine workspace.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id }) => toolResult(await machineContext.describe(workspace_id)));

    server.registerTool('machine.list', {
      description: 'List bounded directory entries inside one caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096).optional(),
        max_entries: z.number().int().min(1).max(1_000).optional(),
        depth: z.number().int().min(1).max(8).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, max_entries, depth }) => toolResult(
      await machineContext.list(workspace_id, path, max_entries, depth),
    ));

    server.registerTool('machine.read', {
      description: 'Read bounded UTF-8 text inside one caller-owned local-machine workspace with optional line pagination and secret redaction.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        offset: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        length: z.number().int().min(1).max(1_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, offset, length }) => toolResult(
      await machineContext.read(workspace_id, path, {
        ...(offset === undefined ? {} : { offset }),
        ...(length === undefined ? {} : { length }),
      }),
    ));

    server.registerTool('machine.read_many', {
      description: 'Read up to 20 bounded UTF-8 files from one caller-owned local-machine workspace; one failed file does not fail the batch.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        paths: z.array(z.string().min(1).max(4096)).min(1).max(20),
        offset: z.number().int().min(-1_000_000).max(1_000_000).optional(),
        length: z.number().int().min(1).max(1_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, paths, offset, length }) => toolResult(
      await machineContext.readMany(workspace_id, paths, {
        ...(offset === undefined ? {} : { offset }),
        ...(length === undefined ? {} : { length }),
      }),
    ));

    server.registerTool('machine.search', {
      description: 'Search bounded UTF-8 files recursively inside one caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        query: z.string().min(1).max(256),
        path: z.string().min(1).max(4096).optional(),
        ignore_case: z.boolean().optional(),
        max_results: z.number().int().min(1).max(50).optional(),
        context_lines: z.number().int().min(0).max(2).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, query, path, ignore_case, max_results, context_lines }) => toolResult(
      await machineContext.search(workspace_id, query, {
        ...(path === undefined ? {} : { path }),
        ...(ignore_case === undefined ? {} : { ignoreCase: ignore_case }),
        ...(max_results === undefined ? {} : { maxResults: max_results }),
        ...(context_lines === undefined ? {} : { contextLines: context_lines }),
      }),
    ));

    server.registerTool('machine.search_continue', {
      description: 'Continue one bounded local-machine search from an opaque WAG cursor.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        cursor: z.string().min(1).max(4096),
        max_results: z.number().int().min(1).max(50).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, cursor, max_results }) => toolResult(
      await machineContext.searchContinue(workspace_id, cursor, max_results),
    ));

    server.registerTool('machine.info', {
      description: 'Read bounded filesystem metadata for one local-machine path.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await machineContext.info(workspace_id, path)));

    server.registerTool('machine.mkdir', {
      description: 'Create exactly one directory inside a caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await machineContext.mkdir(workspace_id, path)));

    server.registerTool('machine.move', {
      description: 'Move one existing local-machine path to one new path inside the same caller-owned workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        from: z.string().min(1).max(4096),
        to: z.string().min(1).max(4096),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, from, to }) => toolResult(await machineContext.move(workspace_id, from, to)));

    server.registerTool('machine.delete', {
      description: 'Delete one local-machine path inside a caller-owned workspace; recursive directory deletion requires explicit recursive=true.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        recursive: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, recursive }) => toolResult(
      await machineContext.delete(workspace_id, path, recursive),
    ));

    server.registerTool('machine.command.run', {
      description: 'Run one bounded local-machine argv command in the trusted autonomous-local profile; no caller-supplied environment or shell string is accepted.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
        cwd: z.string().min(1).max(4096).optional(),
        timeout_ms: z.number().int().min(100).max(120_000).optional(),
        max_output_tokens: z.number().int().min(100).max(20_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, argv, cwd, timeout_ms, max_output_tokens }) => toolResult(
      await machineContext.commandRun(workspace_id, argv, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
        ...(max_output_tokens === undefined ? {} : { maxOutputTokens: max_output_tokens }),
      }),
    ));

    server.registerTool('machine.process.start', {
      description: 'Start one detached local-machine argv process in the trusted autonomous-local profile and sanitized environment.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
        cwd: z.string().min(1).max(4096).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, argv, cwd }) => toolResult(
      await machineContext.processStart(workspace_id, argv, {
        ...(cwd === undefined ? {} : { cwd }),
      }),
    ));

    server.registerTool('machine.process.list', {
      description: 'List local processes with WAG-owned process records marked when available.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id }) => toolResult(await machineContext.processList(workspace_id)));

    server.registerTool('machine.process.inspect', {
      description: 'Inspect one local PID or WAG-owned process id with credential-shaped command-line values redacted.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        id_or_pid: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id, id_or_pid }) => toolResult(
      await machineContext.processInspect(workspace_id, id_or_pid),
    ));

    server.registerTool('machine.process.terminate', {
      description: 'Terminate one WAG-owned process record after live PID-identity revalidation.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        process_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, process_id }) => toolResult(
      await machineContext.processTerminate(workspace_id, process_id),
    ));

    server.registerTool('machine.terminal.open', {
      description: 'Open one interactive local terminal session in a caller-owned workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        shell: z.enum(['powershell', 'cmd', 'bash']).optional(),
        cwd: z.string().min(1).max(4096).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, shell, cwd }) => toolResult(
      await machineContext.terminalOpen(workspace_id, shell, cwd),
    ));

    server.registerTool('machine.terminal.list', {
      description: 'List WAG-owned interactive terminal sessions for one caller-owned workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id }) => toolResult(
      await machineContext.terminalList(workspace_id),
    ));

    server.registerTool('machine.terminal.output', {
      description: 'Drain bounded redacted output from one WAG-owned interactive terminal session.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        terminal_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, terminal_id }) => toolResult(
      await machineContext.terminalOutput(workspace_id, terminal_id),
    ));

    server.registerTool('machine.terminal.input', {
      description: 'Write bounded base64-decoded bytes to one WAG-owned interactive terminal session.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        terminal_id: z.string().min(1).max(256),
        base64: z.string().min(1).max(6_000),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, terminal_id, base64 }) => toolResult(
      await machineContext.terminalInput(workspace_id, terminal_id, base64),
    ));

    server.registerTool('machine.terminal.close', {
      description: 'Close one WAG-owned interactive terminal session.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        terminal_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, terminal_id }) => toolResult(
      await machineContext.terminalClose(workspace_id, terminal_id),
    ));
  }

  if (inspect === true) {
    server.registerTool('repo.list', {
      description: 'List the immediate tracked and untracked entries of one workspace directory.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(1024).optional(),
        max_entries: z.number().int().min(1).max(1_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, max_entries }) => {
      if (await isLocalMachineWorkspace(workspace_id)) {
        return toolResult(await machineContext!.list(workspace_id, path, max_entries));
      }
      return toolResult(await gateway.repoList(workspace_id, { path, maxEntries: max_entries }));
    });

    server.registerTool('repo.search', {
      description: 'Search tracked repository files for a literal string.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        query: z.string().min(1).refine(validSearchQuery),
        ignore_case: z.boolean().optional(),
        max_results: z.number().int().min(1).max(50).optional(),
        context_lines: z.number().int().min(0).max(2).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, query, ignore_case, max_results, context_lines }) => {
      if (!validSearchQuery(query)) throw new Error('Gateway denied search query');
      if (await isLocalMachineWorkspace(workspace_id)) {
        return toolResult(await machineContext!.search(workspace_id, query, {
          ...(ignore_case === undefined ? {} : { ignoreCase: ignore_case }),
          ...(max_results === undefined ? {} : { maxResults: max_results }),
          ...(context_lines === undefined ? {} : { contextLines: context_lines }),
        }));
      }
      return toolResult(await gateway.repoSearch(workspace_id, query, {
        ignoreCase: ignore_case, maxResults: max_results, contextLines: context_lines,
      }));
    });
  }
  server.registerTool('repo.snapshot', {
    description: 'Return bounded repository status, HEAD, diff summary, and tracked files.',
    inputSchema: z.object({ workspace_id: z.string().min(1), max_files: z.number().int().min(1).max(500).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, max_files }) => toolResult(await gateway.repoSnapshot(workspace_id, { maxFiles: max_files })));
  if (inspect === true) {
    server.registerTool('repo.diff', {
      description: 'Return the bounded unified diff of the working tree against HEAD.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(1024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await gateway.repoDiff(workspace_id, { path })));
  }
  server.registerTool('file.read', {
    description: 'Read bounded text from an opened workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1), path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, path }) => {
    if (await isLocalMachineWorkspace(workspace_id)) {
      return toolResult(await machineContext!.read(workspace_id, path));
    }
    return toolResult(await gateway.readFile(workspace_id, path));
  });
  // `openWorldHint: false` is a claim about the *tool*, not about any one profile's argv: the
  // profile set is local configuration and the model cannot choose or extend it (ADR-0025), so
  // the domain of interaction is closed even though a profile may run a substantial command.
  // Not idempotent, and not read-only: it executes.
  server.registerTool('verify.run', {
    description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.',
    inputSchema: z.object({ workspace_id: z.string().min(1), profile: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, profile }) => toolResult(await gateway.verifyRun(workspace_id, profile)));

  if (commandContext) {
    server.registerTool('command.run', {
      description: 'Run one bounded argv command in the caller-owned workspace under the trusted autonomous-local profile; shell strings and caller-supplied environment are not accepted.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        argv: z.array(z.string().min(1).max(512)).min(1).max(16),
        cwd: z.string().min(1).max(1024).optional(),
        timeout_ms: z.number().int().min(100).max(30_000).optional(),
        max_output_tokens: z.number().int().min(100).max(10_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, argv, cwd, timeout_ms, max_output_tokens }) => {
      await commandContext.authorize(workspace_id);
      if (await isLocalMachineWorkspace(workspace_id)) {
        // Frozen connector schemas may still know only command.run. Preserve its bounded argv,
        // timeout and output schema, but route it directly to the trusted local-machine backend
        // so local automation does not depend on a client-side tool-catalog refresh.
        return toolResult(await machineContext!.commandRun(workspace_id, argv, {
          ...(cwd === undefined ? {} : { cwd }),
          ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
          ...(max_output_tokens === undefined ? {} : { maxOutputTokens: max_output_tokens }),
        }));
      }
      return toolResult(await gateway.commandRun(workspace_id, argv, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(timeout_ms === undefined ? {} : { timeoutMs: timeout_ms }),
        ...(max_output_tokens === undefined ? {} : { maxOutputTokens: max_output_tokens }),
        beforeExecute: () => commandContext.authorize(workspace_id),
      }));
    });
  }

  if (mutationContext) {
    const previewInput = z.object({
      workspace_id: z.string().min(1),
      path: z.string().min(1),
      base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      before: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      after: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
    }).strict();
    server.registerTool('mutation.preview', {
      description: mutationContext.autonomous
        ? 'Execute one bounded existing-file update immediately under the trusted autonomous-local profile.'
        : 'Persist an immutable preview of one bounded existing-file update for local human review.',
      inputSchema: previewInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, base_sha256, before, after }) => directMutationExecution(
      mutationContext,
      () => mutationContext.coordinator.preview(
        mutationContext.callerContext,
        workspace_id,
        { path, baseSha256: base_sha256, before, after },
      ),
    ));

    server.registerTool('file.replace', {
      description: mutationContext.autonomous
        ? 'Replace one existing text file immediately under the trusted autonomous-local profile and exact base SHA-256.'
        : 'Propose replacing one existing text file by exact base SHA-256; no raw patch text is accepted.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        content: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, base_sha256, content }) => directMutationExecution(
      mutationContext,
      () => mutationContext.coordinator.replace(
        mutationContext.callerContext,
        workspace_id,
        { path, baseSha256: base_sha256, content },
      ),
    ));

    server.registerTool('file.edit_block', {
      description: mutationContext.autonomous
        ? 'Replace one exact unique text block immediately without requiring a full-file read or exposing unrelated secret-bearing content.'
        : 'Propose replacing one exact unique text block for local human review.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        old_string: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
        new_string: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, old_string, new_string }) => directMutationExecution(
      mutationContext,
      () => mutationContext.coordinator.editBlock(
        mutationContext.callerContext,
        workspace_id,
        { path, oldString: old_string, newString: new_string },
      ),
    ));

    server.registerTool('file.append', {
      description: mutationContext.autonomous
        ? 'Append bounded text immediately after verifying one exact unique expected file suffix; unrelated file content is not exposed.'
        : 'Propose a bounded suffix-guarded append for local human review.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        expected_suffix: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
        content: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, expected_suffix, content }) => directMutationExecution(
      mutationContext,
      () => mutationContext.coordinator.append(
        mutationContext.callerContext,
        workspace_id,
        { path, expectedSuffix: expected_suffix, content },
      ),
    ));

    server.registerTool('file.create', {
      description: mutationContext.autonomous
        ? 'Create one new file immediately under the trusted autonomous-local profile.'
        : 'Propose creating one new file for local human review; nothing is written until approved.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        path: z.string().min(1),
        content: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: mutationContext.autonomous === true,
        idempotentHint: false,
        openWorldHint: false,
      },
    }, async ({ workspace_id, path, content }) => directMutationExecution(
      mutationContext,
      () => mutationContext.coordinator.preview(
        mutationContext.callerContext,
        workspace_id,
        // A creation is an empty-base mutation (ADR-0022): the base is the empty file, so the
        // stored plan, fingerprint, approval and restart semantics are the accepted ones.
        { path, baseSha256: EMPTY_FILE_SHA256, before: '', after: content },
      ),
    ));

    server.registerTool('mutation.result', {
      description: 'Read the durable state and bounded result metadata for one mutation.',
      inputSchema: z.object({ mutation_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ mutation_id }) => directMutationToolResult(
      mutationContext.coordinator.result(mutationContext.callerContext, mutation_id),
    ));
  }

  if (gitCommitContext) {
    server.registerTool('git.commit', {
      description: gitCommitContext.autonomous
        ? 'Create one exact-path commit immediately under the trusted autonomous-local profile and branch/HEAD CAS.'
        : 'Propose one commit of an exact path set for local human review; nothing is committed until approved.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
        message: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 8 * 1024),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: gitCommitContext.autonomous === true,
        idempotentHint: false,
        openWorldHint: false,
      },
    }, async ({ workspace_id, paths, message }) => directCommitExecution(
      gitCommitContext,
      () => gitCommitContext.coordinator.preview(
        gitCommitContext.callerContext, workspace_id, { paths, message },
      ),
    ));

    server.registerTool('git.commit.result', {
      description: 'Read the durable state and bounded result of one proposed commit.',
      inputSchema: z.object({ commit_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ commit_id }) => toolResult(gitCommitContext.coordinator.result(gitCommitContext.callerContext, commit_id)));
  }

  return server;
}

async function directMutationExecution<T extends object & {
  mutationId: string;
  baseSha256: string;
  resultSha256: string;
}>(
  context: MutationMcpContext,
  create: () => Promise<T>,
) {
  const preview = await create();
  if (context.autonomous !== true) return directMutationToolResult(preview);

  const decision = await context.coordinator.admitByPolicy(preview.mutationId);
  if (!decision.admitted) {
    // Direct private stdio has no per-change human-review fallback. Terminalize a refused
    // autonomous record so it never appears on the operator page.
    context.coordinator.rejectLocal(preview.mutationId);
    throw new Error(`Gateway denied mutation: ${decision.code}`);
  }
  return directMutationToolResult(
    context.coordinator.result(context.callerContext, preview.mutationId),
  );
}

async function directCommitExecution<T extends object & { commitId: string }>(
  context: GitCommitMcpContext,
  create: () => Promise<T>,
) {
  const preview = await create();
  if (context.autonomous !== true) return toolResult(preview);

  const decision = await context.coordinator.admitByPolicy(preview.commitId);
  if (!decision.admitted) {
    context.coordinator.rejectLocal(preview.commitId);
    throw new Error(`Gateway denied commit: ${decision.code}`);
  }
  return toolResult(context.coordinator.result(context.callerContext, preview.commitId));
}

function directMutationToolResult<T extends object & { baseSha256: string; resultSha256: string }>(value: T) {
  return toolResult({
    ...value,
    before_sha256: value.baseSha256,
    after_sha256: value.resultSha256,
  });
}

function toolResult(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

/**
 * The browser operator surface (ADR-0026): the accepted v3 read and verify tools, plus proposals
 * for the three reviewed changes and their bounded results.
 *
 * Every consequential tool here is a *proposal*. `mutation.preview`, `file.create` and
 * `git.commit` persist a caller-owned record and cause no effect; the local operator is still
 * the only authority that can turn one into a change. The coordinators are the same ones the
 * private stdio surface uses, so there is one review contract rather than a browser-shaped copy.
 */
export interface BrowserOperatorAdmittedMcpContext extends BrowserVerifyAdmittedMcpContext {
  mutation: Pick<DurableMutationCoordinator, 'preview' | 'result'>;
  commit: Pick<DurableCommitCoordinator, 'preview' | 'result'>;
}

export function createBrowserOperatorAdmittedMcpServer(
  gateway: Pick<GatewayApi, 'health'>,
  context: BrowserOperatorAdmittedMcpContext,
): McpServer {
  const server = createBrowserVerifyAdmittedMcpServer(gateway, context);

  server.registerTool('mutation.preview', {
    description: 'Propose one bounded reviewed edit for separate local operator review; nothing is written until approved.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      path: z.string().min(1).max(4096),
      base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      before: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      after: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, path, base_sha256, before, after }) => toolResult(
    await context.mutation.preview(context.callerContext, workspace_id, {
      path, baseSha256: base_sha256, before, after,
    }),
  ));

  server.registerTool('file.create', {
    description: 'Propose creating one new file for separate local operator review; an existing path is refused.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      path: z.string().min(1).max(4096),
      content: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, path, content }) => toolResult(
    await context.mutation.preview(context.callerContext, workspace_id, {
      path, baseSha256: EMPTY_FILE_SHA256, before: '', after: content,
    }),
  ));

  server.registerTool('mutation.result', {
    description: 'Read the durable state and bounded result of one caller-owned reviewed edit.',
    inputSchema: z.object({
      mutation_id: z.string().min(1).max(256).regex(/^mut_[A-Za-z0-9-]+$/),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ mutation_id }) => toolResult(context.mutation.result(context.callerContext, mutation_id)));

  server.registerTool('git.commit', {
    description: 'Propose one commit of an exact path set for separate local operator review; nothing is committed until approved.',
    inputSchema: z.object({
      workspace_id: z.string().min(1).max(256),
      paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
      message: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 8 * 1024),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, paths, message }) => toolResult(
    await context.commit.preview(context.callerContext, workspace_id, { paths, message }),
  ));

  server.registerTool('git.commit.result', {
    description: 'Read the durable state and bounded result of one caller-owned proposed commit.',
    inputSchema: z.object({
      commit_id: z.string().min(1).max(256).regex(/^cmt_[A-Za-z0-9-]+$/),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ commit_id }) => toolResult(context.commit.result(context.callerContext, commit_id)));

  return server;
}
