import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';
import { MemoryTelemetry } from '../src/telemetry.js';
import { startPinnedDevspace } from '../test/devspace-fixture.js';

const execFileAsync = promisify(execFile);
const fixtureDirEnv = process.env.BENCHMARK_FIXTURE_DIR;
const cloudflaredBinEnv = process.env.CLOUDFLARED_BIN;
if (!fixtureDirEnv || !cloudflaredBinEnv) throw new Error('BENCHMARK_FIXTURE_DIR and CLOUDFLARED_BIN are required');
const fixtureDir: string = fixtureDirEnv;
const cloudflaredBin: string = cloudflaredBinEnv;
const fixtureHead = process.env.BENCHMARK_FIXTURE_HEAD ?? '57bcd8421936f3e44dba4eda80bbb98f583f8432';
await resetFixture();
await writeFile(join(fixtureDir, 'transport-job.mjs'), [
  "import { writeFile } from 'node:fs/promises';",
  "await new Promise((resolve) => setTimeout(resolve, 2000));",
  "await writeFile('transport-survived.txt', 'completed\\n');",
  "console.log('TRANSPORT_JOB_COMPLETED');",
].join('\n'));

const devspace = await startPinnedDevspace({ workspaceRoot: fixtureDir });
const telemetry = new MemoryTelemetry();
const gateway = createGateway({
  executor: new DevspaceExecutor(devspace),
  allowedRoots: [fixtureDir],
  verifyProfiles: { transport: { argv: ['node', 'transport-job.mjs'], timeoutMs: 10_000, maxOutputTokens: 1_000 } },
  telemetry,
});
const token = randomBytes(32).toString('hex');
const http = await startGatewayHttpServer({ gateway, bearerToken: token });
let firstTunnel: QuickTunnel | undefined;
let secondTunnel: QuickTunnel | undefined;
let firstClient: Client | undefined;
let secondClient: Client | undefined;
let workspaceId = '';
let taskId = '';
let recoveredStatus = '';
let recoveredProfile = '';
let recoveredExitCode: number | null = null;
let recoveredOutput = '';
let marker = '';
let failureStage = '';
let failureMessage = '';
let firstTunnelSetupMs: number | null = null;
let secondTunnelSetupMs: number | null = null;

try {
  failureStage = 'first_tunnel_setup';
  const firstSetupStarted = performance.now();
  firstTunnel = await startQuickTunnel(cloudflaredBin, `http://${http.host}:${http.port}`);
  firstTunnelSetupMs = performance.now() - firstSetupStarted;
  failureStage = 'first_client_connect';
  firstClient = await connectClient(`${firstTunnel.publicBaseUrl}/mcp`, token);
  const opened = await firstClient.callTool({ name: 'workspace.open', arguments: { path: fixtureDir } });
  workspaceId = String((opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId ?? '');
  if (!workspaceId.startsWith('ws_')) throw new Error('workspace.open failed');

  failureStage = 'task_create';
  const stream = firstClient.experimental.tasks.callToolStream(
    { name: 'verify.run', arguments: { workspace_id: workspaceId, profile: 'transport' } },
    CallToolResultSchema,
    { task: { ttl: 60_000 } },
  );
  const created = await stream.next();
  if (created.done || created.value?.type !== 'taskCreated') throw new Error('verify.run did not return taskCreated');
  taskId = created.value.task.taskId;

  failureStage = 'transport_cut';
  await firstTunnel.stop();
  await sleep(3000);

  failureStage = 'second_tunnel_setup';
  const secondSetupStarted = performance.now();
  secondTunnel = await startQuickTunnel(cloudflaredBin, `http://${http.host}:${http.port}`);
  secondTunnelSetupMs = performance.now() - secondSetupStarted;
  failureStage = 'second_client_connect';
  secondClient = await connectClient(`${secondTunnel.publicBaseUrl}/mcp`, token);

  failureStage = 'task_recovery';
  let task = await secondClient.experimental.tasks.getTask(taskId);
  for (let attempt = 0; attempt < 40 && task.status !== 'completed' && task.status !== 'failed'; attempt += 1) {
    await sleep(100);
    task = await secondClient.experimental.tasks.getTask(taskId);
  }
  recoveredStatus = task.status;
  const result = await secondClient.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
  const value = result.structuredContent as { profile?: string; exitCode?: number; output?: string } | undefined;
  recoveredProfile = String(value?.profile ?? '');
  recoveredExitCode = typeof value?.exitCode === 'number' ? value.exitCode : null;
  recoveredOutput = String(value?.output ?? '');

  const read = await secondClient.callTool({ name: 'file.read', arguments: { workspace_id: workspaceId, path: 'transport-survived.txt' } });
  marker = String((read.structuredContent as { content?: string } | undefined)?.content ?? '').trim();
  failureStage = '';
} catch (error) {
  failureMessage = error instanceof Error ? error.message : String(error);
} finally {
  await firstClient?.close().catch(() => undefined);
  await secondClient?.close().catch(() => undefined);
  await firstTunnel?.stop().catch(() => undefined);
  await secondTunnel?.stop().catch(() => undefined);
  await http.close().catch(() => undefined);
  await devspace.stop().catch(() => undefined);
  await resetFixture();
}

const verifyEvent = telemetry.snapshot().find((event) => event.tool === 'verify.run');
const resultRecoverySupported = recoveredStatus === 'completed'
  && recoveredProfile === 'transport'
  && recoveredExitCode === 0
  && recoveredOutput === 'TRANSPORT_JOB_COMPLETED';
console.log(JSON.stringify({
  recordedAt: new Date().toISOString(),
  fixtureHead,
  taskId,
  failureStage: failureMessage ? failureStage : '',
  failureMessage,
  firstTunnelSetupMs,
  secondTunnelSetupMs,
  localVerifyTelemetrySuccess: verifyEvent?.success ?? false,
  localVerifyTotalMs: verifyEvent?.totalMs ?? null,
  recoveredStatus,
  recoveredProfile,
  recoveredExitCode,
  recoveredOutput,
  markerRecoveredThroughGateway: marker,
  resultRecoverySupported,
}, null, 2));
if (!resultRecoverySupported) process.exitCode = 1;
interface QuickTunnel { publicBaseUrl: string; pid: number; stop(): Promise<void>; }

async function connectClient(url: string, bearerToken: string): Promise<Client> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const client = new Client({ name: 'gateway-interruption-test', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${bearerToken}` } },
    });
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
      if (!isTransientNetworkError(error)) throw error;
      await sleep(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Timed out reconnecting MCP client');
}

function isTransientNetworkError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED';
}

async function startQuickTunnel(bin: string, origin: string): Promise<QuickTunnel> {
  const child = spawn(bin, ['tunnel', '--url', origin, '--no-autoupdate', '--loglevel', 'info'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const publicBaseUrl = await waitForTunnelUrl(child, logs);
  await waitForPublicBoundary(publicBaseUrl);
  if (!child.pid) throw new Error('cloudflared process has no pid');
  return { publicBaseUrl, pid: child.pid, stop: async () => stopProcessTree(child) };
}
async function waitForTunnelUrl(child: ChildProcess, logs: string[]): Promise<string> {
  for (let i = 0; i < 120; i += 1) {
    if (child.exitCode !== null) throw new Error(`cloudflared exited early (${child.exitCode})`);
    const match = logs.join('').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (match) return match[0];
    await sleep(250);
  }
  throw new Error('Timed out waiting for Quick Tunnel URL');
}

async function waitForPublicBoundary(publicBaseUrl: string): Promise<void> {
  for (let i = 0; i < 120; i += 1) {
    try {
      const response = await fetch(`${publicBaseUrl}/mcp`, { method: 'POST', signal: AbortSignal.timeout(3000) });
      if (response.status === 401) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for public gateway boundary');
}
async function stopProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    try { await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']); }
    catch { if (child.exitCode === null) child.kill(); }
  } else child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    sleep(3000),
  ]);
}

async function resetFixture(): Promise<void> {
  await execFileAsync('git', ['-C', fixtureDir, 'reset', '--hard', fixtureHead]);
  await execFileAsync('git', ['-C', fixtureDir, 'clean', '-fd']);
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
