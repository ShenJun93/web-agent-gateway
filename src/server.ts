import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { NOOP_TELEMETRY, startTrace, type TelemetrySink } from './telemetry.js';
import {
  DEVSPACE_PROTOCOL_VERSION,
  DevspaceReadLimitError,
  REQUIRED_DEVSPACE_TOOLS,
  type DevspaceExecutor,
} from './executor/devspace.js';

interface WorkspaceBinding { devspaceWorkspaceId: string; }
interface SnapshotOptions { maxFiles?: number; }
export interface VerifyProfile { argv: readonly string[]; timeoutMs?: number; maxOutputTokens?: number; env?: Readonly<Record<string, string>>; }

const SNAPSHOT_COMMAND = [
  'git status --short --branch',
  'echo __WAG_HEAD__',
  'git rev-parse HEAD',
  'echo __WAG_DIFF__',
  'git diff --stat -- .',
  'echo __WAG_FILES__',
  'git ls-files',
].join(' && ');

export function createGateway({ executor, verifyProfiles = {}, telemetry = NOOP_TELEMETRY }: { executor: DevspaceExecutor; verifyProfiles?: Readonly<Record<string, VerifyProfile>>; telemetry?: TelemetrySink }) {
  const workspaces = new Map<string, WorkspaceBinding>();

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
        const requestedPath = await trace.phase('policyMs', () => {
          if (!path.trim()) throw new Error('Gateway denied empty workspace path');
          return path;
        });
        const devspaceWorkspaceId = await trace.phase('executorMs', () => executor.openWorkspace(requestedPath));
        const result = await trace.phase('aggregationMs', () => {
          const workspaceId = `ws_${randomUUID()}`;
          workspaces.set(workspaceId, { devspaceWorkspaceId });
          return { workspaceId };
        });
        trace.finish(true); return result;
      } catch (error) { trace.finish(false, error); throw error; }
    },

    async readFile(workspaceId: string, path: string) {
      const trace = startTrace('file.read', telemetry); trace.markIngress();
      try {
        const scoped = await trace.phase('policyMs', () => ({ safePath: validateReadPath(path), devspaceWorkspaceId: binding(workspaceId).devspaceWorkspaceId }));
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

export function createGatewayMcpServer(gateway: GatewayApi): McpServer {
  const server = new McpServer({ name: 'web-agent-gateway', version: '0.0.0' });
  server.registerTool('health', { description: 'Check gateway and executor compatibility.', annotations: { readOnlyHint: true } }, async () => toolResult(await gateway.health()));
  server.registerTool('workspace.open', { description: 'Open one approved local workspace and return an opaque workspace id.', inputSchema: { path: z.string().min(1) }, annotations: { readOnlyHint: true } }, async ({ path }) => toolResult(await gateway.openWorkspace(path)));
  server.registerTool('repo.snapshot', { description: 'Return bounded repository status, HEAD, diff summary, and tracked files.', inputSchema: { workspace_id: z.string().min(1), max_files: z.number().int().min(1).max(500).optional() }, annotations: { readOnlyHint: true } }, async ({ workspace_id, max_files }) => toolResult(await gateway.repoSnapshot(workspace_id, { maxFiles: max_files })));
  server.registerTool('file.read', { description: 'Read bounded text from an opened workspace.', inputSchema: { workspace_id: z.string().min(1), path: z.string().min(1) }, annotations: { readOnlyHint: true } }, async ({ workspace_id, path }) => toolResult(await gateway.readFile(workspace_id, path)));
  server.registerTool('verify.run', { description: 'Run one locally configured verification profile; arbitrary shell input is not accepted.', inputSchema: { workspace_id: z.string().min(1), profile: z.string().min(1) }, annotations: { readOnlyHint: false } }, async ({ workspace_id, profile }) => toolResult(await gateway.verifyRun(workspace_id, profile)));
  return server;
}

function toolResult(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

const SENSITIVE_PATH_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg', '.azure', '.kube']);

function validateReadPath(input: string): string {
  const normalized = input.replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    throw new Error('Gateway denied workspace-relative path');
  }
  const segments = normalized.split('/').filter((segment) => segment && segment !== '.');
  if (segments.some((segment) => segment === '..')) throw new Error('Gateway denied workspace-relative path');
  if (segments.some((segment) => SENSITIVE_PATH_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error('Gateway denied sensitive path');
  }
  return segments.join('/');
}

function buildVerifyCommand(profile: VerifyProfile): string {
  if (profile.argv.length < 1 || profile.argv.length > 16) throw new Error('Invalid verify profile argv');
  const safeArg = /^[A-Za-z0-9_./:\\+=@-]{1,512}$/;
  if (!profile.argv.every((arg) => safeArg.test(arg))) throw new Error('Invalid verify profile argv');
  const env = Object.entries(profile.env ?? {});
  if (env.length > 16) throw new Error('Invalid verify profile env');
  if (env.some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !safeArg.test(value))) throw new Error('Invalid verify profile env');
  const prefix = process.platform === 'win32'
    ? env.map(([key, value]) => 'set "' + key + '=' + value + '"').join(' && ')
    : env.map(([key, value]) => key + '=' + value).join(' ');
  return [prefix, profile.argv.join(' ')].filter(Boolean).join(process.platform === 'win32' ? ' && ' : ' ');
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
