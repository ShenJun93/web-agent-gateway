import { randomUUID } from 'node:crypto';
import { McpServer } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';
import type { GatewayCallerContext } from './caller-context.js';
import type { DurableMutationCoordinator } from './durable-mutation.js';
import type { AdmittedWorkspaceService } from './admitted-workspace.js';
import { resolveVerifyProfile, type VerifyProfile } from './verify-profile.js';
export type { VerifyProfile } from './verify-profile.js';
import {
  DEVSPACE_PROTOCOL_VERSION,
  DevspaceReadLimitError,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceExecutor,
} from './executor/devspace.js';

interface WorkspaceBinding { devspaceWorkspaceId: string; canonicalRoot: string; }
import { DevspaceRepositoryInspectionBackend, type RepoSnapshotOptions } from './repository-inspection.js';

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
        try { content = await trace.phase('executorMs', () => executor.readFile(scoped.devspaceWorkspaceId, scoped.safePath, undefined, 2000)); }
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
        const value = await inspection.snapshot(workspace.devspaceWorkspaceId, options);
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

  };
}


export type GatewayApi = ReturnType<typeof createGateway>;

export interface BrowserAdmittedMcpContext {
  callerContext: GatewayCallerContext;
  workspaces: Pick<AdmittedWorkspaceService, 'open' | 'read'>;
}

export function createBrowserAdmittedMcpServer(
  gateway: Pick<GatewayApi, 'health'>,
  context: BrowserAdmittedMcpContext,
): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  server.registerTool('health', {
    description: 'Check gateway and executor compatibility.',
    annotations: { readOnlyHint: true },
  }, async () => toolResult(await gateway.health()));
  server.registerTool('workspace.open', {
    description: 'Open one approved local workspace and return an opaque workspace id.',
    inputSchema: z.object({ path: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ path }) => toolResult(await context.workspaces.open(context.callerContext, path)));
  server.registerTool('file.read', {
    description: 'Read bounded text from an opened workspace.',
    inputSchema: z.object({ workspace_id: z.string().min(1), path: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ workspace_id, path }) => toolResult(await context.workspaces.read(
    context.callerContext, workspace_id, path,
  )));
  return server;
}

export interface MutationMcpContext {
  callerContext: GatewayCallerContext;
  coordinator: Pick<DurableMutationCoordinator, 'preview' | 'result'>;
}

export function createGatewayMcpServer(gateway: GatewayApi, { mutationContext }: { mutationContext?: MutationMcpContext } = {}): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  server.registerTool('health', { description: 'Check gateway and executor compatibility.', annotations: { readOnlyHint: true } }, async () => toolResult(await gateway.health()));
  server.registerTool('workspace.open', { description: 'Open one approved local workspace and return an opaque workspace id.', inputSchema: z.object({ path: z.string().min(1) }), annotations: { readOnlyHint: true } }, async ({ path }) => toolResult(await gateway.openWorkspace(path)));
  server.registerTool('repo.snapshot', { description: 'Return bounded repository status, HEAD, diff summary, and tracked files.', inputSchema: z.object({ workspace_id: z.string().min(1), max_files: z.number().int().min(1).max(500).optional() }), annotations: { readOnlyHint: true } }, async ({ workspace_id, max_files }) => toolResult(await gateway.repoSnapshot(workspace_id, { maxFiles: max_files })));
  server.registerTool('file.read', { description: 'Read bounded text from an opened workspace.', inputSchema: z.object({ workspace_id: z.string().min(1), path: z.string().min(1) }), annotations: { readOnlyHint: true } }, async ({ workspace_id, path }) => toolResult(await gateway.readFile(workspace_id, path)));
  server.registerTool('verify.run', {
    description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.',
    inputSchema: z.object({ workspace_id: z.string().min(1), profile: z.string().min(1) }),
    annotations: { readOnlyHint: false },
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
    server.registerTool('mutation.result', {
      description: 'Read the durable state and bounded result metadata for one mutation.',
      inputSchema: z.object({ mutation_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ mutation_id }) => toolResult(mutationContext.coordinator.result(mutationContext.callerContext, mutation_id)));
  }


  return server;
}

function toolResult(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}
