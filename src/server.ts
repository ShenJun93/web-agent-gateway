import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTaskStore, type TaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import { assertReadTarget, canonicalWorkspace, validateReadPath } from './path-policy.js';
import { FilePatchController, type FilePatchBinding, type FilePatchInput } from './file-patch.js';
import type { PatchApprovalStore } from './patch-approval.js';
import type { DurableMutationCoordinator, MutationCaller } from './durable-mutation.js';
import {
  DEVSPACE_PROTOCOL_VERSION,
  DevspaceReadLimitError,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceExecutor,
} from './executor/devspace.js';

interface WorkspaceBinding { devspaceWorkspaceId: string; canonicalRoot: string; }
interface SnapshotOptions { maxFiles?: number; }
export interface VerifyProfile { argv: readonly string[]; timeoutMs?: number; maxOutputTokens?: number; env?: Readonly<Record<string, string>>; }

const SNAPSHOT_COMMAND = [
  'git --no-optional-locks -c core.fsmonitor=false status --short --branch --ignore-submodules=all',
  'echo __WAG_HEAD__',
  'git --no-optional-locks -c core.fsmonitor=false rev-parse HEAD',
  'echo __WAG_DIFF__',
  'git --no-optional-locks -c core.fsmonitor=false diff --no-ext-diff --no-textconv --ignore-submodules=all --stat -- .',
  'echo __WAG_FILES__',
  'git --no-optional-locks -c core.fsmonitor=false ls-files',
].join(' && ');

export function createGateway({ executor, allowedRoots, verifyProfiles = {}, telemetry = NOOP_TELEMETRY, patchApprovals }: { executor: DevspaceExecutor; allowedRoots: readonly string[]; verifyProfiles?: Readonly<Record<string, VerifyProfile>>; telemetry?: TelemetrySink; patchApprovals?: PatchApprovalStore }) {
  const workspaces = new Map<string, WorkspaceBinding>();
  const filePatch = patchApprovals ? new FilePatchController({ executor, approvals: patchApprovals }) : undefined;

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
        const result = await trace.phase('aggregationMs', () => {
          const workspaceId = `ws_${randomUUID()}`;
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
          return { profile, devspaceWorkspaceId: binding(workspaceId).devspaceWorkspaceId };
        });
        const command = buildVerifyCommand(scoped.profile);
        const timeoutMs = Math.min(Math.max(scoped.profile.timeoutMs ?? 10_000, 100), 30_000);
        const maxOutputTokens = Math.min(Math.max(scoped.profile.maxOutputTokens ?? 4_000, 100), 10_000);
        const result = await trace.phase('executorMs', () => executor.execCommand(scoped.devspaceWorkspaceId, command, maxOutputTokens, timeoutMs));
        if (result.running) {
          if (result.sessionId !== undefined) await trace.phase('executorMs', () => executor.interruptCommand(scoped.devspaceWorkspaceId, result.sessionId!, maxOutputTokens));
          throw new Error('Gateway verification timed out');
        }
        const value = await trace.phase('aggregationMs', () => ({ profile: profileName, exitCode: result.exitCode ?? -1, output: result.output.trimEnd() }));
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async filePatchPreview(workspaceId: string, input: FilePatchInput) {
      if (!filePatch) throw new Error('Gateway file.patch is disabled');
      const workspace = binding(workspaceId);
      const patchBinding: FilePatchBinding = { workspaceId, ...workspace };
      return filePatch.preview(patchBinding, input);
    },

    async filePatchApply(workspaceId: string, input: FilePatchInput & { approvalId: string }) {
      if (!filePatch) throw new Error('Gateway file.patch is disabled');
      const workspace = binding(workspaceId);
      const patchBinding: FilePatchBinding = { workspaceId, ...workspace };
      return filePatch.apply(patchBinding, input);
    },

    async repoSnapshot(workspaceId: string, options: SnapshotOptions = {}) {
      const trace = startTrace('repo.snapshot', telemetry); trace.markIngress();
      try {
        const scoped = await trace.phase('policyMs', () => ({
          maxFiles: Math.min(Math.max(options.maxFiles ?? 100, 1), 500),
          devspaceWorkspaceId: binding(workspaceId).devspaceWorkspaceId,
        }));
        const result = await trace.phase('executorMs', () => executor.execCommand(scoped.devspaceWorkspaceId, SNAPSHOT_COMMAND));
        const value = await trace.phase('aggregationMs', () => {
          if (result.running) throw new Error('repo.snapshot command unexpectedly remained running');
          if (result.exitCode !== 0) throw new Error(`repo.snapshot command failed with exit code ${result.exitCode ?? 'unknown'}`);
          const parsed = parseSnapshot(result.output);
          const files = parsed.files.slice(0, scoped.maxFiles);
          return { ...parsed, files, filesTruncated: parsed.files.length > files.length };
        });
        trace.finish(true); return value;
      } catch (error) { trace.finish(false, error); throw error; }
    },

  };
}


export type GatewayApi = ReturnType<typeof createGateway>;

export interface MutationMcpContext {
  caller: MutationCaller;
  coordinator: Pick<DurableMutationCoordinator, 'preview' | 'result'>;
}

export function createGatewayMcpServer(gateway: GatewayApi, { taskStore = new InMemoryTaskStore(), enableFilePatch = false, mutationContext }: { taskStore?: TaskStore; enableFilePatch?: boolean; mutationContext?: MutationMcpContext } = {}): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' }, {
    taskStore,
    capabilities: { tasks: { requests: { tools: { call: {} } } } },
  });
  server.registerTool('health', { description: 'Check gateway and executor compatibility.', annotations: { readOnlyHint: true } }, async () => toolResult(await gateway.health()));
  server.registerTool('workspace.open', { description: 'Open one approved local workspace and return an opaque workspace id.', inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true } }, async ({ path }) => toolResult(await gateway.openWorkspace(path)));
  server.registerTool('repo.snapshot', { description: 'Return bounded repository status, HEAD, diff summary, and tracked files.', inputSchema: { workspace_id: z.string().min(1), max_files: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } }, async ({ workspace_id, max_files }) => toolResult(await gateway.repoSnapshot(workspace_id, { maxFiles: max_files })));
  server.registerTool('file.read', { description: 'Read bounded text from an opened workspace.', inputSchema: { workspace_id: z.string().min(1), path: z.string().min(1) }, annotations: { readOnlyHint: true } }, async ({ workspace_id, path }) => toolResult(await gateway.readFile(workspace_id, path)));
  server.experimental.tasks.registerToolTask('verify.run', {
    description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.',
    inputSchema: { workspace_id: z.string().min(1), profile: z.string().min(1) },
    annotations: { readOnlyHint: false },
    execution: { taskSupport: 'optional' },
  }, {
    async createTask({ workspace_id, profile }, extra) {
      if (!extra.taskStore) throw new Error('MCP task store unavailable');
      const store = extra.taskStore;
      const task = await store.createTask({ ttl: 300_000, pollInterval: 100 });
      void gateway.verifyRun(workspace_id, profile).then(
        (value) => taskStore.storeTaskResult(task.taskId, 'completed', toolResult(value)),
        (error) => taskStore.storeTaskResult(task.taskId, 'failed', toolErrorResult(error)),
      );
      return { task };
    },
    async getTask(_args, extra) {
      if (!extra.taskStore || !extra.taskId) throw new Error('MCP task context unavailable');
      return extra.taskStore.getTask(extra.taskId);
    },
    async getTaskResult(_args, extra) {
      if (!extra.taskStore || !extra.taskId) throw new Error('MCP task context unavailable');
      return extra.taskStore.getTaskResult(extra.taskId) as Promise<CallToolResult>;
    },
  });
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
      mutationContext.caller,
      workspace_id,
      { path, baseSha256: base_sha256, before, after },
    )));
    server.registerTool('mutation.result', {
      description: 'Read the durable state and bounded result metadata for one mutation.',
      inputSchema: z.object({ mutation_id: z.string().min(1) }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ mutation_id }) => toolResult(mutationContext.coordinator.result(mutationContext.caller, mutation_id)));
  }
  if (enableFilePatch) {
    const patchInput = z.object({
      phase: z.enum(['preview', 'apply']),
      workspace_id: z.string().min(1),
      path: z.string().min(1),
      base_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      before: z.string().min(1).refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      after: z.string().refine((value) => Buffer.byteLength(value, 'utf8') <= 32 * 1024),
      approval_id: z.string().min(1).optional(),
    }).strict().superRefine((value, ctx) => {
      if (value.phase === 'apply' && !value.approval_id) ctx.addIssue({ code: 'custom', path: ['approval_id'], message: 'approval_id is required for apply' });
      if (value.phase === 'preview' && value.approval_id !== undefined) ctx.addIssue({ code: 'custom', path: ['approval_id'], message: 'approval_id is only valid for apply' });
    });
    server.registerTool('file.patch', {
      description: 'Preview or apply one approval-gated update to an existing workspace text file.',
      inputSchema: patchInput,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async ({ phase, workspace_id, path, base_sha256, before, after, approval_id }) => {
      const input = { path, baseSha256: base_sha256, before, after };
      if (phase === 'preview') return toolResult(await gateway.filePatchPreview(workspace_id, input));
      return toolResult(await gateway.filePatchApply(workspace_id, { ...input, approvalId: approval_id! }));
    });
  }

  return server;
}

function toolResult(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

function toolErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}



function buildVerifyCommand(profile: VerifyProfile): string {
  if (profile.argv.length < 1 || profile.argv.length > 16) throw new Error('Invalid verify profile argv');
  const safeArg = /^[A-Za-z0-9_./:\\+=@-]{1,512}$/;
  if (!profile.argv.every((arg) => safeArg.test(arg))) throw new Error('Invalid verify profile argv');
  const env = Object.entries(profile.env ?? {});
  if (env.length > 16) throw new Error('Invalid verify profile env');
  if (env.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !safeArg.test(value) || /(TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL)/i.test(key))) throw new Error('Invalid verify profile env');
  const scrub = process.platform === 'win32' ? 'set "DEVSPACE_OAUTH_OWNER_TOKEN="' : 'unset DEVSPACE_OAUTH_OWNER_TOKEN';
  const profileEnv = process.platform === 'win32'
    ? env.map(([key, value]) => 'set "' + key + '=' + value + '"').join(' && ')
    : env.map(([key, value]) => key + '=' + value).join(' ');
  return [scrub, profileEnv, profile.argv.join(' ')].filter(Boolean).join(process.platform === 'win32' ? ' && ' : ' ');
}

function parseSnapshot(output: string) {
  const normalized = output.replace(/\r\n/g, '\n').split('\n').map((line) => line.trimEnd()).join('\n');
  const [statusPart, afterHead] = normalized.split('__WAG_HEAD__\n');
  const [headPart, afterDiff] = (afterHead ?? '').split('__WAG_DIFF__\n');
  const [diffPart, filesPart = ''] = (afterDiff ?? '').split('__WAG_FILES__\n');
  if (afterHead === undefined || afterDiff === undefined) throw new Error('repo.snapshot markers missing from executor output');
  const statusLines = statusPart.trimEnd().split('\n').filter(Boolean);
  const branchLine = statusLines[0] ?? '';
  const branch = branchLine.startsWith('## ') ? branchLine.slice(3).split('...')[0].trim() : '';
  const files = filesPart.split('\n').map((line) => line.trim()).filter(Boolean).sort();
  return {
    branch,
    head: headPart.trim(),
    dirty: statusLines.slice(branchLine.startsWith('## ') ? 1 : 0).length > 0,
    status: statusLines,
    diffStat: diffPart.trim(),
    files,
  };
}
