import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPrivateGatewayConfig } from '../src/private-config.js';
import { bootstrapPrivateGateway } from '../src/private-runtime.js';
import { PatchApprovalStore } from '../src/patch-approval.js';
import { startGatewayHttpServer } from '../src/http-server.js';

const TOKEN_ENV = 'WAG_FILE_PATCH_SPIKE_TOKEN';

export function handleApprovalLine(line: string, approvals: PatchApprovalStore) {
  const parts = line.trim().split(/\s+/).filter(Boolean);
  if (parts.length !== 3 || parts[0] !== 'approve' || !/^pa_/.test(parts[1]) || !/^[a-f0-9]{64}$/.test(parts[2])) {
    return { status: 'invalid_command' as const };
  }
  const approvalId = parts[1];
  const approved = approvals.approveLocal(approvalId, parts[2]);
  return approved
    ? { status: 'approved' as const, approvalId }
    : { status: 'rejected' as const, approvalId };
}

export function renderPendingApprovals(approvals: PatchApprovalStore): string[] {
  return approvals.listPending(20).map((request) => JSON.stringify({
    type: 'file-patch-spike.pending',
    approvalId: request.approvalId,
    fingerprint: request.fingerprint,
    expiresAt: request.expiresAt,
    path: request.summary.path,
    additions: request.summary.additions,
    removals: request.summary.removals,
    approved: request.approved,
  }));
}

export interface BrowserSpikeRuntime {
  mcpUrl: string;
  approvals: PatchApprovalStore;
  close(): Promise<void>;
}

export async function startFilePatchBrowserSpike(options: {
  configPath: string;
  env?: NodeJS.ProcessEnv;
  input?: Readable;
  stderr?: Writable;
}): Promise<BrowserSpikeRuntime> {
  if (!isAbsolute(options.configPath)) throw new Error('Spike config path must be absolute');
  const env = options.env ?? process.env;
  const bearerToken = env[TOKEN_ENV];
  if (!bearerToken || Buffer.byteLength(bearerToken) < 32) throw new Error(`${TOKEN_ENV} must be at least 32 bytes`);
  delete env[TOKEN_ENV];

  const approvals = new PatchApprovalStore();
  const config = await loadPrivateGatewayConfig(options.configPath);
  const runtime = await bootstrapPrivateGateway(config, { env, patchApprovals: approvals });
  let http;
  try {
    http = await startGatewayHttpServer({
      gateway: runtime.gateway,
      bearerToken,
      enableFilePatch: true,
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const stderr = options.stderr ?? process.stderr;
  const input = options.input ?? process.stdin;
  const reporter = createPendingReporter(approvals, stderr);
  const approvalConsole = attachApprovalConsole(input, stderr, approvals);
  stderr.write(`${JSON.stringify({ type: 'file-patch-spike.ready', mcpUrl: http.mcpUrl })}\n`);

  let closed = false;
  return {
    mcpUrl: http.mcpUrl,
    approvals,
    async close() {
      if (closed) return;
      closed = true;
      reporter.close();
      approvalConsole.close();
      await http.close();
      await runtime.close();
    },
  };
}

function attachApprovalConsole(input: Readable, stderr: Writable, approvals: PatchApprovalStore): Interface {
  const rl = createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    if (line.trim() === 'list') {
      for (const pending of renderPendingApprovals(approvals)) stderr.write(`${pending}\n`);
      return;
    }
    stderr.write(`${JSON.stringify({ type: 'file-patch-spike.approval', ...handleApprovalLine(line, approvals) })}\n`);
  });
  return rl;
}

function createPendingReporter(approvals: PatchApprovalStore, stderr: Writable) {
  const seen = new Set<string>();
  const timer = setInterval(() => {
    for (const request of approvals.listPending(20)) {
      if (seen.has(request.approvalId)) continue;
      seen.add(request.approvalId);
      const line = renderPendingApprovals(approvals)
        .find((value) => value.includes(request.approvalId));
      if (line) stderr.write(`${line}\n`);
    }
  }, 250);
  timer.unref();
  return { close: () => clearInterval(timer) };
}

async function runCli(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--config') {
    process.stderr.write('Usage: file-patch-browser-spike --config <absolute-path>\n');
    return 1;
  }
  let spike: BrowserSpikeRuntime | undefined;
  try {
    spike = await startFilePatchBrowserSpike({ configPath: args[1] });
    await waitForShutdown(process.stdin);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ type: 'file-patch-spike.error', errorClass: error instanceof Error ? error.constructor.name : typeof error })}\n`);
    return 1;
  } finally {
    await spike?.close();
  }
}

async function waitForShutdown(input: Readable): Promise<void> {
  if (input.readableEnded || input.destroyed) return;
  await new Promise<void>((resolvePromise) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      input.off('end', finish);
      input.off('close', finish);
      process.off('SIGINT', finish);
      process.off('SIGTERM', finish);
      resolvePromise();
    };
    input.once('end', finish);
    input.once('close', finish);
    process.once('SIGINT', finish);
    process.once('SIGTERM', finish);
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().then((code) => { process.exitCode = code; });
}
