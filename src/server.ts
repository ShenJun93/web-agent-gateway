import { createHash, randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';
import type { GatewayCallerContext } from './caller-context.js';
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

export function createGateway({ executor, allowedRoots, verifyProfiles = {}, telemetry = NOOP_TELEMETRY, openWorkspaceId }: { executor: DevspaceExecutor; allowedRoots: readonly string[]; verifyProfiles?: Readonly<Record<string, VerifyProfile>>; telemetry?: TelemetrySink; openWorkspaceId?: (canonicalRoot: string) => string | Promise<string> }) {
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
        try {
          content = await trace.phase('executorMs', () => readDevspaceText(
            executor,
            scoped.devspaceWorkspaceId,
            scoped.safePath,
            { maxBytes: 64 * 1024, oversizedMessage: 'Gateway rejected oversized content' },
          ));
        }
        catch (error) { if (error instanceof DevspaceReadLimitError) throw new Error('Gateway rejected oversized content'); throw error; }
        const result = await trace.phase('aggregationMs', () => {
          const normalized = content.replace(/\r\n/g, '\n').replace(/\n$/, '');
          if (normalized.includes('\0')) throw new Error('Gateway rejected binary content');
          if (Buffer.byteLength(normalized, 'utf8') > 64 * 1024) throw new Error('Gateway rejected oversized content');
          return { content: normalized };
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
  coordinator: Pick<DurableCommitCoordinator, 'preview' | 'result'>;
}

export interface MutationMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableMutationCoordinator, 'preview' | 'result'>;
}

export function createGatewayMcpServer(
  gateway: GatewayApi,
  { inspect, mutationContext, gitCommitContext }: { inspect?: boolean; mutationContext?: MutationMcpContext; gitCommitContext?: GitCommitMcpContext } = {},
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
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
  }, async ({ path }) => toolResult(await gateway.openWorkspace(path)));
  if (inspect === true) {
    server.registerTool('repo.list', {
      description: 'List the immediate tracked and untracked entries of one workspace directory.',
      inputSchema: z.object({
        workspace_id: z.string().min(1).max(256),
        path: z.string().min(1).max(1024).optional(),
        max_entries: z.number().int().min(1).max(1_000).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ workspace_id, path, max_entries }) => toolResult(
      await gateway.repoList(workspace_id, { path, maxEntries: max_entries }),
    ));

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
  }, async ({ workspace_id, path }) => toolResult(await gateway.readFile(workspace_id, path)));
  // `openWorldHint: false` is a claim about the *tool*, not about any one profile's argv: the
  // profile set is local configuration and the model cannot choose or extend it (ADR-0025), so
  // the domain of interaction is closed even though a profile may run a substantial command.
  // Not idempotent, and not read-only: it executes.
  server.registerTool('verify.run', {
    description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.',
    inputSchema: z.object({ workspace_id: z.string().min(1), profile: z.string().min(1) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async ({ workspace_id, profile }) => toolResult(await gateway.verifyRun(workspace_id, profile)));
  if (mutationContext) {
    const previewInput = z.object({
      workspace_id: z.string().min(1),
      path: z.string().min(1),
      base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      before: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      after: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
    }).strict();
    server.registerTool('mutation.preview', {
      description: 'Persist an immutable preview of one bounded existing-file update for local human review.',
      inputSchema: previewInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, base_sha256, before, after }) => toolResult(await mutationContext.coordinator.preview(
      mutationContext.callerContext,
      workspace_id,
      { path, baseSha256: base_sha256, before, after },
    )));
    server.registerTool('file.create', {
      description: 'Propose creating one new file for local human review; nothing is written until approved.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        path: z.string().min(1),
        content: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, path, content }) => toolResult(await mutationContext.coordinator.preview(
      mutationContext.callerContext,
      workspace_id,
      // A creation is an empty-base mutation (ADR-0022): the base is the empty file, so the
      // stored plan, fingerprint, approval and restart semantics are the accepted ones.
      { path, baseSha256: EMPTY_FILE_SHA256, before: '', after: content },
    )));

    server.registerTool('mutation.result', {
      description: 'Read the durable state and bounded result metadata for one mutation.',
      inputSchema: z.object({ mutation_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ mutation_id }) => toolResult(mutationContext.coordinator.result(mutationContext.callerContext, mutation_id)));
  }

  if (gitCommitContext) {
    server.registerTool('git.commit', {
      description: 'Propose one commit of an exact path set for local human review; nothing is committed until approved.',
      inputSchema: z.object({
        workspace_id: z.string().min(1),
        paths: z.array(z.string().min(1).max(1024)).min(1).max(64),
        message: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 8 * 1024),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, async ({ workspace_id, paths, message }) => toolResult(await gitCommitContext.coordinator.preview(
      gitCommitContext.callerContext, workspace_id, { paths, message },
    )));

    server.registerTool('git.commit.result', {
      description: 'Read the durable state and bounded result of one proposed commit.',
      inputSchema: z.object({ commit_id: z.string().min(1).max(256) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ commit_id }) => toolResult(gitCommitContext.coordinator.result(gitCommitContext.callerContext, commit_id)));
  }

  return server;
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
