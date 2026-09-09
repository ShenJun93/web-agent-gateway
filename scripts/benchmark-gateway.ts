import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';
import { MemoryTelemetry } from '../src/telemetry.js';
import { startPinnedDevspace } from '../test/devspace-fixture.js';

const execFileAsync = promisify(execFile);
const FIXTURE_HEAD = '57bcd8421936f3e44dba4eda80bbb98f583f8432';
const FILES = ['src-math.js', 'src-greet.js', 'src-clamp.js', 'src-version.js', 'src-even.js'];
const fixtureDirEnv = process.env.BENCHMARK_FIXTURE_DIR;
if (!fixtureDirEnv) throw new Error('BENCHMARK_FIXTURE_DIR is required');
const fixtureDir: string = fixtureDirEnv;

type HttpEvent = { method: string; status: number; requestId: string | null; durationMs: number };
type ToolEvent = { tool: string; durationMs: number; http: HttpEvent[] };

const httpEvents: HttpEvent[] = [];
const tracedFetch: typeof fetch = async (input, init) => {
  const started = performance.now();
  const response = await fetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  httpEvents.push({ method, status: response.status, requestId: response.headers.get('x-request-id'), durationMs: performance.now() - started });
  return response;
};

await assertFixture();
const devspace = await startPinnedDevspace({ workspaceRoot: fixtureDir });
const telemetry = new MemoryTelemetry();
const gateway = createGateway({
  executor: new DevspaceExecutor(devspace),
  allowedRoots: [fixtureDir],
  verifyProfiles: { test: { argv: ['npm', 'test'], timeoutMs: 30_000, maxOutputTokens: 4_000 } },
  telemetry,
});
const token = randomBytes(32).toString('hex');
const http = await startGatewayHttpServer({ gateway, bearerToken: token });
const tunnelStartedAt = performance.now();
const tunnel = process.env.CLOUDFLARED_BIN ? await startQuickTunnel(process.env.CLOUDFLARED_BIN, `http://${http.host}:${http.port}`) : undefined;
const tunnelSetupMs = tunnel ? performance.now() - tunnelStartedAt : 0;
const targetMcpUrl = tunnel ? `${tunnel.publicBaseUrl}/mcp` : http.mcpUrl;
const client = new Client({ name: 'gateway-benchmark', version: '1.0.0' }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(targetMcpUrl), {
  requestInit: { headers: { authorization: ['Bearer', token].join(' ') } },
  fetch: tracedFetch,
});

let workspaceId = '';
const connectStarted = performance.now();
await client.connect(transport);
const connectMs = performance.now() - connectStarted;
const connectHttpEvents = httpEvents.splice(0);
const runs: unknown[] = [];

try {
  await resetFixture();
  runs.push(await runScenario(true));
  for (let i = 0; i < 5; i += 1) {
    await resetFixture();
    runs.push(await runScenario(false));
  }
} finally {
  await client.close().catch(() => undefined);
  await tunnel?.stop().catch(() => undefined);
  await http.close().catch(() => undefined);
  await devspace.stop().catch(() => undefined);
  await resetFixture();
}

const warmTotals = (runs.slice(1) as Array<{ totalMs: number }>).map((run) => run.totalMs);
const output = {
  recordedAt: new Date().toISOString(),
  fixtureHead: FIXTURE_HEAD,
  transport: tunnel ? 'authenticated Cloudflare Quick Tunnel Streamable HTTP (provisional)' : 'authenticated loopback Streamable HTTP',
  publicTransportStable: false,
  tunnelSetupMs,
  connectMs,
  connectHttpEvents,
  runs,
  summary: {
    coldTotalMs: (runs[0] as { totalMs: number }).totalMs,
    warmRunCount: warmTotals.length,
    warmMedianMs: median(warmTotals),
    warmSampleP95Ms: percentile(warmTotals, 0.95),
    warmMinMs: Math.min(...warmTotals),
    warmMaxMs: Math.max(...warmTotals),
  },
};
console.log(JSON.stringify(output, null, 2));

async function runScenario(cold: boolean) {
  const toolEvents: ToolEvent[] = [];
  const telemetryStart = telemetry.snapshot().length;
  const started = performance.now();
  if (cold) {
    const opened = await call('workspace.open', { path: fixtureDir }, toolEvents);
    workspaceId = String((opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId ?? '');
    if (!workspaceId.startsWith('ws_')) throw new Error('workspace.open returned no opaque workspace id');
  }
  const snapshot = await call('repo.snapshot', { workspace_id: workspaceId }, toolEvents);
  const firstUsefulActionMs = performance.now() - started;
  const initial = snapshot.structuredContent as { head?: string; dirty?: boolean } | undefined;
  if (initial?.head !== FIXTURE_HEAD || initial.dirty !== false) throw new Error('initial repo.snapshot did not match clean fixture');

  for (const path of FILES) {
    const read = await call('file.read', { workspace_id: workspaceId, path }, toolEvents);
    const content = (read.structuredContent as { content?: string } | undefined)?.content;
    if (typeof content !== 'string' || content.length === 0) throw new Error(`file.read failed for ${path}`);
  }

  const verify = await call('verify.run', { workspace_id: workspaceId, profile: 'test' }, toolEvents);
  const verifyResult = verify.structuredContent as { exitCode?: number } | undefined;
  if (verifyResult?.exitCode !== 0) throw new Error(`verify.run failed with exit ${verifyResult?.exitCode ?? 'unknown'}`);

  const finalSnapshot = await call('repo.snapshot', { workspace_id: workspaceId }, toolEvents);
  const final = finalSnapshot.structuredContent as { head?: string; dirty?: boolean } | undefined;
  if (final?.head !== FIXTURE_HEAD || final.dirty !== false) throw new Error('final repo.snapshot did not match clean fixture');

  const totalMs = performance.now() - started;
  const requests = toolEvents.flatMap((event) => event.http);
  if (requests.some((event) => !event.requestId)) throw new Error('HTTP response missing x-request-id');
  return {
    cold,
    totalMs,
    timeToFirstUsefulActionMs: firstUsefulActionMs,
    toolCallCount: toolEvents.length,
    httpRequestCount: requests.length,
    correlationIds: requests.map((event) => event.requestId),
    toolEvents,
    telemetry: telemetry.snapshot().slice(telemetryStart),
  };
}

async function call(name: string, args: Record<string, unknown>, toolEvents: ToolEvent[]) {
  const httpStart = httpEvents.length;
  const started = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const event: ToolEvent = {
    tool: name,
    durationMs: performance.now() - started,
    http: httpEvents.slice(httpStart),
  };
  toolEvents.push(event);
  if (result.isError) throw new Error(`${name} returned MCP tool error`);
  return result;
}

async function assertFixture(): Promise<void> {
  const { stdout } = await execFileAsync('git', ['-C', fixtureDir, 'rev-parse', 'HEAD']);
  if (stdout.trim() !== FIXTURE_HEAD) throw new Error(`fixture HEAD mismatch: ${stdout.trim()}`);
}

async function resetFixture(): Promise<void> {
  await execFileAsync('git', ['-C', fixtureDir, 'reset', '--hard', FIXTURE_HEAD]);
  await execFileAsync('git', ['-C', fixtureDir, 'clean', '-fd']);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
  return round(value);
}

function round(value: number): number { return Math.round(value * 1000) / 1000; }

interface QuickTunnel {
  publicBaseUrl: string;
  pid: number;
  stop(): Promise<void>;
}

async function startQuickTunnel(bin: string, origin: string): Promise<QuickTunnel> {
  const child = spawn(bin, ['tunnel', '--url', origin, '--no-autoupdate', '--loglevel', 'info'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout?.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr?.on('data', (chunk) => logs.push(String(chunk)));
  const publicBaseUrl = await waitForTunnelUrl(child, logs);
  await waitForPublicBoundary(publicBaseUrl);
  if (!child.pid) throw new Error('cloudflared process has no pid');
  return {
    publicBaseUrl,
    pid: child.pid,
    stop: async () => stopProcessTree(child),
  };
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
      const response = await fetch(`${publicBaseUrl}/mcp`, { method: 'POST' });
      if (response.status === 401) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('Timed out waiting for public gateway 401 boundary');
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
