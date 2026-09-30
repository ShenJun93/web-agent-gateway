import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';
import type { GatewayCallerContext } from './caller-context.js';
import type { LocalMachineContext, LocalMachineImageRead } from './local-machine-runtime.js';
import type { ToolUsageCorrelation, ToolUsageDiagnostics } from './tool-usage-diagnostics.js';
import type { ProductMcpContext } from './product-ux.js';
import { RelayResultChunkStore } from './relay-result-chunks.js';
import type { BrowserMcpContext } from './browser-harness/browser-mcp-runtime.js';
import type { DesktopMcpContext } from './desktop-harness/desktop-mcp-runtime.js';
import {
  harnessEffectCorrelationFromError,
  harnessEffectCorrelationFromToolResult,
} from './effect-correlation.js';
import { detectRuntimeIdentity } from './runtime-identity.js';
import type { DurableMutationCoordinator } from './durable-mutation.js';
import type { DurableCommitCoordinator } from './git-commit.js';
import type { DurableRemoteGitPushCoordinator } from './remote-git-push.js';
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
import { assertGenericExecutionRemoteEffectPolicy } from './remote-effect-policy.js';

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
        const scoped = await trace.phase('policyMs', async () => {
          const profile = verifyProfiles[profileName];
          if (!profile) throw new Error('Gateway denied verify profile');
          const workspace = binding(workspaceId);
          await assertGenericExecutionRemoteEffectPolicy(profile.argv, workspace.canonicalRoot);
          return { profile: resolveVerifyProfile(profile), devspaceWorkspaceId: workspace.devspaceWorkspaceId };
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
          const executionCwd = cwd === '.' ? workspace.canonicalRoot : resolve(workspace.canonicalRoot, cwd);
          await assertGenericExecutionRemoteEffectPolicy(argv, executionCwd);
          const profile = resolveVerifyProfile({
            argv,
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
            ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
          }, cwd, workspace.canonicalRoot);
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

export interface RemoteGitPushMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableRemoteGitPushCoordinator, 'request' | 'result'>;
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
  { inspect, mutationContext, gitCommitContext, remoteGitPushContext, commandContext, capabilityContext, machineContext, diagnosticsContext, productContext, browserContext, desktopContext }: {
    inspect?: boolean;
    mutationContext?: MutationMcpContext;
    gitCommitContext?: GitCommitMcpContext;
    remoteGitPushContext?: RemoteGitPushMcpContext;
    commandContext?: CommandMcpContext;
    capabilityContext?: CapabilityMcpContext;
    machineContext?: LocalMachineContext;
    diagnosticsContext?: ToolUsageDiagnostics;
    productContext?: ProductMcpContext;
    browserContext?: BrowserMcpContext;
    desktopContext?: DesktopMcpContext;
  } = {},
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  const runtimeIdentity = detectRuntimeIdentity();
  const publishedToolNames: string[] = [];
  const relayChunks = new RelayResultChunkStore();
  const registerTool = ((name: string, config: unknown, handler: (...args: any[]) => unknown) => {
    publishedToolNames.push(name);
    const wrapped = async (...args: any[]) => {
      const finish = diagnosticsContext?.begin(name);
      try {
        const value = await handler(...args);
        finish?.(true, undefined, toolUsageCorrelationFromToolResult(value));
        // A chunk read is already the bounded transport envelope. Re-chunking it would turn
        // result.chunk into an infinite indirection rather than a stable page reader.
        const bounded = name === 'result.chunk' ? value : (relayChunks?.wrap(value) ?? value);
        return bounded === value ? value : toolResult(bounded as object);
      } catch (error) {
        finish?.(false, error, harnessEffectCorrelationFromError(error));
        throw error;
      }
    };
    return (server.registerTool as any)(name, config, wrapped);
  }) as McpServer['registerTool'];

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

  registerTool('health', {
    description: 'Check gateway/executor compatibility and report the live private-stdio surface.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const base = await gateway.health();
    const usage = diagnosticsContext?.usage();
    return toolResult({
      ...base,
      mcpToolCount: publishedToolNames.length,
      mcpTools: [...publishedToolNames],
      ...(machineContext === undefined ? {} : { authorityMode: 'AUTONOMOUS_LOCAL' }),
      runtime: runtimeIdentity,
      ...(usage === undefined ? {} : {
        diagnostics: {
          retained_events: usage.retained_events,
          capacity: usage.capacity,
          total_calls: usage.total_calls,
          successes: usage.successes,
          failures: usage.failures,
        },
      }),
    });
  });
  // Not read-only: this canonicalises a root, opens a DevSpace workspace and mints a durable
  // caller-owned workspace record. ADR-0020 records the provider's own warning that a read-only
  // annotation may cause a client's write confirmation to be skipped, so the surface that a
  // remote client discovers must not under-declare. `createBrowserVerifyAdmittedMcpServer`
  // already declares this correctly; this surface had disagreed with it.
  registerTool('workspace.open', {
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
    registerTool('capabilities.describe', {
      description: 'Describe the effective bounded authority for one opened workspace before attempting consequential tools.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id }) => toolResult(await capabilityContext.describe(workspace_id)));
  }

  if (machineContext) {
    registerTool('machine.open', {
      description: 'Open one local-machine directory in the trusted autonomous-local profile, independent of DevSpace allowedRoots.',
      inputSchema: z.object({ path: z.string().min(1).max(4096) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ path }) => toolResult(await machineContext.open(path)));

    registerTool('machine.describe', {
      description: 'Describe the autonomous-local authority state for one opened local-machine workspace.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id }) => toolResult(await machineContext.describe(workspace_id)));

    registerTool('machine.list', {
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

    registerTool('machine.read', {
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

    registerTool('machine.read_many', {
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

    registerTool('machine.image.read', {
      description: 'Read one bounded PNG/JPEG/WEBP/GIF as native MCP image content without exposing base64 in structured metadata.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path }) => imageToolResult(
      await machineContext.readImage(workspace_id, path),
    ));

    registerTool('machine.pdf.extract', {
      description: 'Extract bounded text from one local PDF in an isolated worker with page and character limits.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        start_page: z.number().int().min(1).max(1_000_000).optional(),
        max_pages: z.number().int().min(1).max(50).optional(),
        max_chars: z.number().int().min(1).max(256 * 1024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, start_page, max_pages, max_chars }) => toolResult(
      await machineContext.extractPdf(workspace_id, path, {
        ...(start_page === undefined ? {} : { startPage: start_page }),
        ...(max_pages === undefined ? {} : { maxPages: max_pages }),
        ...(max_chars === undefined ? {} : { maxChars: max_chars }),
      }),
    ));

    registerTool('machine.docx.inspect', {
      description: 'Inspect bounded DOCX text and structure inside one caller-owned local-machine workspace with secret redaction.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        max_paragraphs: z.number().int().min(1).max(1_000).optional(),
        max_chars: z.number().int().min(1).max(256 * 1024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, max_paragraphs, max_chars }) => toolResult(
      await machineContext.inspectDocx(workspace_id, path, {
        ...(max_paragraphs === undefined ? {} : { maxParagraphs: max_paragraphs }),
        ...(max_chars === undefined ? {} : { maxChars: max_chars }),
      }),
    ));

    registerTool('machine.docx.create', {
      description: 'Create one bounded DOCX at a new path inside a caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        paragraphs: z.array(z.string().max(64 * 1024)).min(1).max(1_000),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, paragraphs }) => toolResult(
      await machineContext.createDocx(workspace_id, path, paragraphs),
    ));

    registerTool('machine.docx.replace_text', {
      description: 'Replace bounded text in one DOCX using an exact SHA-256 precondition and atomic same-path replacement.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        find: z.string().min(1).max(8 * 1024),
        replacement: z.string().max(64 * 1024),
        replace_all: z.boolean().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, expected_sha256, find, replacement, replace_all }) => toolResult(
      await machineContext.replaceDocxText(
        workspace_id,
        path,
        expected_sha256,
        find,
        replacement,
        replace_all,
      ),
    ));

    registerTool('machine.xlsx.inspect', {
      description: 'Inspect bounded XLSX sheets/cells inside one caller-owned local-machine workspace with secret redaction.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        max_cells: z.number().int().min(1).max(5_000).optional(),
        max_chars: z.number().int().min(1).max(256 * 1024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, max_cells, max_chars }) => toolResult(
      await machineContext.inspectXlsx(workspace_id, path, {
        ...(max_cells === undefined ? {} : { maxCells: max_cells }),
        ...(max_chars === undefined ? {} : { maxChars: max_chars }),
      }),
    ));

    registerTool('machine.xlsx.create', {
      description: 'Create one bounded XLSX at a new path inside a caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        sheets: z.array(z.object({
          name: z.string().min(1).max(31),
          cells: z.array(z.object({
            cell: z.string().min(2).max(10),
            value: z.union([z.string().max(32 * 1024), z.number().finite(), z.boolean(), z.null()]),
          }).strict()).max(5_000).optional(),
        }).strict()).min(1).max(100),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, sheets }) => toolResult(
      await machineContext.createXlsx(workspace_id, path, sheets),
    ));

    registerTool('machine.xlsx.set_cells', {
      description: 'Set bounded XLSX cell values using an exact SHA-256 precondition and atomic same-path replacement.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        sheet: z.string().min(1).max(31),
        cells: z.array(z.object({
          cell: z.string().min(2).max(10),
          value: z.union([z.string().max(32 * 1024), z.number().finite(), z.boolean(), z.null()]),
        }).strict()).min(1).max(5_000),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, expected_sha256, sheet, cells }) => toolResult(
      await machineContext.setXlsxCells(workspace_id, path, expected_sha256, sheet, cells),
    ));

    registerTool('machine.pdf.create', {
      description: 'Create one bounded text PDF at a new path inside a caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        pages: z.array(z.string().max(1024 * 1024)).min(1).max(100),
        font_size: z.number().min(6).max(48).optional(),
        margin: z.number().min(18).max(144).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, pages, font_size, margin }) => toolResult(
      await machineContext.createPdf(workspace_id, path, pages, {
        ...(font_size === undefined ? {} : { fontSize: font_size }),
        ...(margin === undefined ? {} : { margin }),
      }),
    ));

    registerTool('machine.pdf.overlay_text', {
      description: 'Overlay bounded text onto one PDF using an exact SHA-256 precondition and atomic same-path replacement.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
        expected_sha256: z.string().regex(/^[a-f0-9]{64}$/),
        page: z.number().int().min(1).max(1_000_000),
        text: z.string().max(64 * 1024),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        font_size: z.number().min(6).max(48).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, expected_sha256, page, text, x, y, font_size }) => toolResult(
      await machineContext.overlayPdfText(workspace_id, path, expected_sha256, {
        page,
        text,
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        ...(font_size === undefined ? {} : { fontSize: font_size }),
      }),
    ));

    registerTool('machine.search', {
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

    registerTool('machine.search_continue', {
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

    registerTool('machine.search_list', {
      description: 'List bounded active/paused search sessions owned by one caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id }) => toolResult(
      await machineContext.searchList(workspace_id),
    ));

    registerTool('machine.search_cancel', {
      description: 'Cancel one caller-owned local-machine search session without touching filesystem or external process authority.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        search_id: z.string().min(8).max(128),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, search_id }) => toolResult(
      await machineContext.searchCancel(workspace_id, search_id),
    ));

    registerTool('machine.info', {
      description: 'Read bounded filesystem metadata for one local-machine path.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await machineContext.info(workspace_id, path)));

    registerTool('machine.mkdir', {
      description: 'Create exactly one directory inside a caller-owned local-machine workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(4096),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await machineContext.mkdir(workspace_id, path)));

    registerTool('machine.move', {
      description: 'Move one existing local-machine path to one new path inside the same caller-owned workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        from: z.string().min(1).max(4096),
        to: z.string().min(1).max(4096),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, from, to }) => toolResult(await machineContext.move(workspace_id, from, to)));

    registerTool('machine.delete', {
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

    registerTool('machine.command.run', {
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

    registerTool('machine.process.start', {
      description: 'Start one detached local-machine argv process in the trusted autonomous-local profile; GUI processes may opt into a visible normal window.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        argv: z.array(z.string().min(1).max(4096)).min(1).max(32),
        cwd: z.string().min(1).max(4096).optional(),
        window_mode: z.enum(['hidden', 'normal']).optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, argv, cwd, window_mode }) => toolResult(
      await machineContext.processStart(workspace_id, argv, {
        ...(cwd === undefined ? {} : { cwd }),
        ...(window_mode === undefined ? {} : { windowMode: window_mode }),
      }),
    ));

    registerTool('machine.process.list', {
      description: 'List local processes with WAG-owned process records marked when available.',
      inputSchema: z.object({ workspace_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id }) => toolResult(await machineContext.processList(workspace_id)));

    registerTool('machine.process.inspect', {
      description: 'Inspect one local PID or WAG-owned process id with credential-shaped command-line values redacted.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        id_or_pid: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id, id_or_pid }) => toolResult(
      await machineContext.processInspect(workspace_id, id_or_pid),
    ));

    registerTool('machine.process.terminate', {
      description: 'Terminate one WAG-owned process record after live PID-identity revalidation.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        process_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, process_id }) => toolResult(
      await machineContext.processTerminate(workspace_id, process_id),
    ));

    registerTool('machine.terminal.open', {
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

    registerTool('machine.terminal.list', {
      description: 'List WAG-owned interactive terminal sessions for one caller-owned workspace.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async ({ workspace_id }) => toolResult(
      await machineContext.terminalList(workspace_id),
    ));

    registerTool('machine.terminal.output', {
      description: 'Drain bounded redacted output from one WAG-owned interactive terminal session.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        terminal_id: z.string().min(1).max(256),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ workspace_id, terminal_id }) => toolResult(
      await machineContext.terminalOutput(workspace_id, terminal_id),
    ));

    registerTool('machine.terminal.input', {
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

    registerTool('machine.terminal.close', {
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

  if (browserContext) {
    const browserSessionId = z.string().regex(/^browser_[0-9a-f-]{36}$/);
    const effectId = z.string().regex(/^effect_[0-9a-f-]{36}$/);
    const browserAction = z.discriminatedUnion('type', [
      z.object({ type: z.literal('navigate'), url: z.string().url().max(4096) }).strict(),
      z.object({ type: z.literal('click'), ref: z.string().min(1).max(256) }).strict(),
      z.object({
        type: z.literal('fill'),
        ref: z.string().min(1).max(256),
        text: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 64 * 1024),
      }).strict(),
      z.object({
        type: z.literal('press'),
        key: z.enum(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']),
      }).strict(),
    ]);

    registerTool('browser.open', {
      description: 'Open or recover one WAG-owned dedicated Edge profile on loopback CDP.',
      inputSchema: z.object({
        profile_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ profile_id }) => toolResult(await browserContext.open(profile_id)));

    registerTool('browser.describe', {
      description: 'Describe one caller-owned BrowserPort session without exposing authority identifiers.',
      inputSchema: z.object({ browser_session_id: browserSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ browser_session_id }) => toolResult(await browserContext.describe(browser_session_id)));

    registerTool('browser.snapshot', {
      description: 'Return a bounded semantic accessibility snapshot with opaque action refs.',
      inputSchema: z.object({ browser_session_id: browserSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ browser_session_id }) => toolResult(await browserContext.snapshot(browser_session_id)));

    registerTool('browser.exec', {
      description: 'Execute one exact-once semantic browser action. Raw CDP methods and host shell execution are not accepted.',
      inputSchema: z.object({
        browser_session_id: browserSessionId,
        idempotency_key: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
        action: browserAction,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, async ({ browser_session_id, idempotency_key, action }) => toolResult(
      await browserContext.exec(browser_session_id, idempotency_key, action),
    ));

    registerTool('browser.effect.get', {
      description: 'Read the durable exact-once state for one caller-owned browser effect after a response-stream interruption; this never replays the effect.',
      inputSchema: z.object({ effect_id: effectId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ effect_id }) => toolResult(await browserContext.effect(effect_id)));

    registerTool('browser.screenshot', {
      description: 'Capture a bounded PNG screenshot from one caller-owned BrowserPort session.',
      inputSchema: z.object({ browser_session_id: browserSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, async ({ browser_session_id }) => {
      const image = await browserContext.screenshot(browser_session_id);
      const metadata = { mime_type: image.mimeType };
      return {
        content: [
          { type: 'image' as const, data: image.dataBase64, mimeType: image.mimeType },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ],
        structuredContent: metadata,
      };
    });

    registerTool('browser.close', {
      description: 'Close the exact WAG-owned browser target and its owned Edge process.',
      inputSchema: z.object({ browser_session_id: browserSessionId }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ browser_session_id }) => toolResult(await browserContext.close(browser_session_id)));
  }

  if (desktopContext) {
    const desktopSessionId = z.string().regex(/^desktop_[0-9a-f-]{36}$/);
    const desktopEffectId = z.string().regex(/^effect_[0-9a-f-]{36}$/);
    const desktopRef = z.string().regex(/^desktop_node_[0-9a-f-]{36}_[0-9]+$/);
    const desktopAction = z.discriminatedUnion('type', [
      z.object({ type: z.literal('invoke'), ref: desktopRef }).strict(),
      z.object({
        type: z.literal('setValue'),
        ref: desktopRef,
        value: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 64 * 1024),
      }).strict(),
      z.object({ type: z.literal('toggle'), ref: desktopRef }).strict(),
      z.object({ type: z.literal('select'), ref: desktopRef }).strict(),
    ]);

    registerTool('desktop.open', {
      description: 'Open a DesktopPort session for one running WAG-owned process and its single visible top-level window.',
      inputSchema: z.object({
        workspace_id: z.string().regex(/^ws_[0-9a-f-]{36}$/),
        process_id: z.string().regex(/^proc_[0-9a-f-]{36}$/),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, process_id }) => toolResult(await desktopContext.open(workspace_id, process_id)));

    registerTool('desktop.describe', {
      description: 'Describe one caller-owned DesktopPort session after live process/window identity revalidation.',
      inputSchema: z.object({ desktop_session_id: desktopSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ desktop_session_id }) => toolResult(await desktopContext.describe(desktop_session_id)));

    registerTool('desktop.snapshot', {
      description: 'Return a bounded Windows UI Automation Control View snapshot with ephemeral semantic refs.',
      inputSchema: z.object({ desktop_session_id: desktopSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ desktop_session_id }) => toolResult(await desktopContext.snapshot(desktop_session_id)));

    registerTool('desktop.exec', {
      description: 'Execute one exact-once semantic Windows UI Automation action. Raw screen coordinates and arbitrary keyboard input are not accepted.',
      inputSchema: z.object({
        desktop_session_id: desktopSessionId,
        idempotency_key: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
        action: desktopAction,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ desktop_session_id, idempotency_key, action }) => toolResult(
      await desktopContext.exec(desktop_session_id, idempotency_key, action),
    ));

    registerTool('desktop.effect.get', {
      description: 'Read the durable exact-once state for one caller-owned desktop effect after a response-stream interruption; this never replays the effect.',
      inputSchema: z.object({ effect_id: desktopEffectId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ effect_id }) => toolResult(await desktopContext.effect(effect_id)));

    registerTool('desktop.screenshot', {
      description: 'Capture a bounded PNG image of the exact caller-owned DesktopPort window.',
      inputSchema: z.object({ desktop_session_id: desktopSessionId }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ desktop_session_id }) => {
      const image = await desktopContext.screenshot(desktop_session_id);
      const metadata = { mime_type: image.mimeType };
      return {
        content: [
          { type: 'image' as const, data: image.dataBase64, mimeType: image.mimeType },
          { type: 'text' as const, text: JSON.stringify(metadata) },
        ],
        structuredContent: metadata,
      };
    });

    registerTool('desktop.close', {
      description: 'Release one caller-owned DesktopPort automation session without terminating the application process.',
      inputSchema: z.object({ desktop_session_id: desktopSessionId }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ desktop_session_id }) => toolResult(await desktopContext.close(desktop_session_id)));
  }

  if (inspect === true) {
    registerTool('repo.list', {
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

    registerTool('repo.search', {
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
  registerTool('repo.snapshot', {
    description: 'Return bounded repository status, HEAD, diff summary, and tracked files.',
    inputSchema: z.object({ workspace_id: z.string().min(1), max_files: z.number().int().min(1).max(500).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, max_files }) => toolResult(await gateway.repoSnapshot(workspace_id, { maxFiles: max_files })));
  if (inspect === true) {
    registerTool('repo.diff', {
      description: 'Return the bounded unified diff of the working tree against HEAD.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(1024).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path }) => toolResult(await gateway.repoDiff(workspace_id, { path })));
  }
  registerTool('file.read', {
    description: 'Read bounded text from an opened workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1), path: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ workspace_id, path }) => {
    if (await isLocalMachineWorkspace(workspace_id)) {
      try {
        return toolResult(await machineContext!.read(workspace_id, path));
      } catch (readError) {
        try {
          return imageToolResult(await machineContext!.readImage(workspace_id, path));
        } catch {
          throw readError;
        }
      }
    }
    return toolResult(await gateway.readFile(workspace_id, path));
  });
  // `openWorldHint: false` is a claim about the *tool*, not about any one profile's argv: the
  // profile set is local configuration and the model cannot choose or extend it (ADR-0025), so
  // the domain of interaction is closed even though a profile may run a substantial command.
  // Not idempotent, and not read-only: it executes.
  registerTool('verify.run', {
    description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.',
    inputSchema: z.object({ workspace_id: z.string().min(1), profile: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, profile }) => toolResult(await gateway.verifyRun(workspace_id, profile)));

  if (commandContext) {
    registerTool('command.run', {
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
    registerTool('mutation.preview', {
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

    registerTool('file.replace', {
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

    registerTool('file.edit_block', {
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

    registerTool('file.append', {
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

    registerTool('file.create', {
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

    registerTool('mutation.result', {
      description: 'Read the durable state and bounded result metadata for one mutation.',
      inputSchema: z.object({ mutation_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ mutation_id }) => directMutationToolResult(
      mutationContext.coordinator.result(mutationContext.callerContext, mutation_id),
    ));
  }

  if (gitCommitContext) {
    registerTool('git.commit', {
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

    registerTool('git.commit.result', {
      description: 'Read the durable state and bounded result of one proposed commit.',
      inputSchema: z.object({ commit_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ commit_id }) => toolResult(gitCommitContext.coordinator.result(gitCommitContext.callerContext, commit_id)));
  }

  if (remoteGitPushContext) {
    registerTool('git.push', {
      description: 'Request one exact bounded remote feature-branch push. A local standing autonomous policy may execute an allowlisted target immediately; otherwise the request follows the Human-gated proposal path. MCP arguments cannot widen local remote authority.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        remote: z.string().min(1).max(128),
        source_oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
        destination_ref: z.string().min(1).max(256),
        reviewed_oid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
        review_receipt_sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    }, async ({ workspace_id, remote, source_oid, destination_ref, reviewed_oid, review_receipt_sha256 }) => toolResult(
      await remoteGitPushContext.coordinator.request(
        remoteGitPushContext.callerContext,
        workspace_id,
        {
          remote,
          sourceOid: source_oid,
          destinationRef: destination_ref,
          ...(reviewed_oid === undefined ? {} : { reviewedOid: reviewed_oid }),
          ...(review_receipt_sha256 === undefined ? {} : { reviewReceiptDigest: review_receipt_sha256 }),
        },
      ),
    ));

    registerTool('git.push.result', {
      description: 'Read the caller-owned durable state/result of one bounded remote Git push proposal/grant.',
      inputSchema: z.object({
        push_id: z.string().min(1).max(256).regex(/^push_[A-Za-z0-9-]+$/),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    }, async ({ push_id }) => toolResult(
      remoteGitPushContext.coordinator.result(remoteGitPushContext.callerContext, push_id),
    ));
  }

  {
    registerTool('result.chunk', {
      description: 'Read one in-memory chunk of a relay-bounded oversized tool result. Concatenate decoded chunks by index, verify sha256, then parse the reconstructed JSON. This never replays the original tool.',
      inputSchema: z.object({
        result_id: z.string().regex(/^result_[0-9a-f-]{36}$/),
        chunk_index: z.number().int().min(0).max(1_000_000),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ result_id, chunk_index }) => toolResult(relayChunks.get(result_id, chunk_index)));
  }

  if (diagnosticsContext) {
    // These two readers intentionally bypass the diagnostics wrapper so observation does not
    // recursively change what is being observed. They still belong to the published MCP surface.
    publishedToolNames.push('diagnostics.recent', 'diagnostics.usage');
    server.registerTool('diagnostics.recent', {
      description: 'Return recent sanitized WAG MCP tool-call timing/outcome records. Arguments, paths, content and output are never stored.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        after_sequence: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ limit, after_sequence }) => toolResult(diagnosticsContext.recent({
      ...(limit === undefined ? {} : { limit }),
      ...(after_sequence === undefined ? {} : { afterSequence: after_sequence }),
    })));

    server.registerTool('diagnostics.usage', {
      description: 'Return sanitized rolling WAG tool usage totals grouped by tool name.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => toolResult(diagnosticsContext.usage()));
  }

  if (productContext) {
    registerTool('product.config.get', {
      description: 'Return safe WAG product settings and capability summaries without paths, credentials, secret references, or raw authority configuration.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => toolResult(productContext.configGet()));

    registerTool('product.config.update', {
      description: 'CAS-update only safe WAG product preferences. This cannot widen roots, execution, Git, browser, credential, or remote authority.',
      inputSchema: z.object({
        expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
        update_channel: z.enum(['stable', 'beta', 'development']).optional(),
        auto_check_updates: z.boolean().optional(),
      }).strict().refine(
        (value) => value.update_channel !== undefined || value.auto_check_updates !== undefined,
        { message: 'At least one product setting change is required' },
      ),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ expected_revision, update_channel, auto_check_updates }) => toolResult(
      productContext.configUpdate({
        expectedRevision: expected_revision,
        ...(update_channel === undefined ? {} : { updateChannel: update_channel }),
        ...(auto_check_updates === undefined ? {} : { autoCheckUpdates: auto_check_updates }),
      }),
    ));

    registerTool('product.activity.recent', {
      description: 'Return bounded sanitized recent WAG tool activity. Arguments, paths, file content, command text, output, and credentials are not retained.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional(),
        after_sequence: z.number().int().min(0).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ limit, after_sequence }) => toolResult(productContext.activityRecent({
      ...(limit === undefined ? {} : { limit }),
      ...(after_sequence === undefined ? {} : { afterSequence: after_sequence }),
    })));

    registerTool('product.usage', {
      description: 'Return bounded sanitized rolling WAG usage totals grouped by tool name.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => toolResult(productContext.usage()));

    registerTool('product.update.check', {
      description: 'Check the configured signed WAG update feed without downloading, staging, switching, or mutating the installed runtime.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, async () => toolResult(await productContext.updateCheck()));

    registerTool('product.help', {
      description: 'Return concise WAG Local workflow discovery without performing any local, remote, browser, process, Git, or filesystem action.',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async () => toolResult(productContext.help()));
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

function toolUsageCorrelationFromToolResult(value: unknown): ToolUsageCorrelation | undefined {
  const effect = harnessEffectCorrelationFromToolResult(value);
  if (!value || typeof value !== 'object') return effect;
  const structured = (value as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return effect;
  const row = structured as { mutationId?: unknown; commitId?: unknown };
  const mutationId = typeof row.mutationId === 'string' ? row.mutationId : undefined;
  const commitId = typeof row.commitId === 'string' ? row.commitId : undefined;
  if (!effect && mutationId === undefined && commitId === undefined) return undefined;
  return {
    ...(effect ?? {}),
    ...(mutationId === undefined ? {} : { mutationId }),
    ...(commitId === undefined ? {} : { commitId }),
  };
}

function toolResult(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function imageToolResult(value: LocalMachineImageRead) {
  const { data_base64, ...metadata } = value;
  return {
    content: [
      { type: 'image' as const, data: data_base64, mimeType: value.mime_type },
      { type: 'text' as const, text: JSON.stringify(metadata) },
    ],
    structuredContent: metadata as Record<string, unknown>,
  };
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
