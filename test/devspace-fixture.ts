import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { sanitizeDevspaceEnvironment } from '../src/environment-policy.js';

const execFileAsync = promisify(execFile);

export const DEVSPACE_TEST_OWNER_TOKEN = 'web-agent-gateway-test-owner-token-long-enough';

export interface DevspaceFixture {
  baseUrl: string;
  accessToken: string;
  resourceUrl: string;
  workspaceRoot: string;
  pid: number;
  stop(): Promise<void>;
}

export interface StartPinnedDevspaceOptions {
  workspaceRoot?: string;
  startupTimeoutMs?: number;
  onSpawn?: (pid: number) => void;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
}

export async function startPinnedDevspace(options: StartPinnedDevspaceOptions = {}): Promise<DevspaceFixture> {
  const pin = JSON.parse(await readFile(new URL('../docs/benchmarks/devspace-pin.json', import.meta.url), 'utf8')) as { revision: string };
  const pinDir = process.env.DEVSPACE_PIN_DIR ?? join(tmpdir(), 'web-agent-gateway-devspace-33d6d0b');
  const { stdout } = await execFileAsync('git', ['-C', pinDir, 'rev-parse', 'HEAD']);
  if (stdout.trim() !== pin.revision) throw new Error(`DevSpace pin mismatch: expected ${pin.revision}, got ${stdout.trim()}`);

  const root = await mkdtemp(join(tmpdir(), 'web-agent-gateway-test-'));
  const workspaceRoot = options.workspaceRoot ?? join(root, 'workspace');
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  if (!options.workspaceRoot) await mkdir(workspaceRoot, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const resourceUrl = `${baseUrl}/mcp`;
  const ownerToken = DEVSPACE_TEST_OWNER_TOKEN;
  const config = {
    configVersion: 1,
    server: { host: '127.0.0.1', port, publicBaseUrl: baseUrl, allowedHosts: [], trustProxy: false },
    workspaces: { allowedRoots: [workspaceRoot], worktreeRoot: join(root, 'worktrees') },
    storage: { stateDir },
    tools: { mode: 'codex' },
    ui: { enabled: false },
    artifacts: { enabled: false, maxFileBytes: 104857600 },
    skills: { enabled: false, paths: [], agentDir: join(root, 'agent') },
    subagents: { enabled: false, instructions: 'on-demand', providers: [] },
    logging: { level: 'error', format: 'json', requests: false, assets: false, toolCalls: false, shellCommands: false },
    oauth: {
      accessTokenTtlSeconds: options.accessTokenTtlSeconds ?? 3600,
      refreshTokenTtlSeconds: options.refreshTokenTtlSeconds ?? 2592000,
      scopes: ['devspace'],
      allowedResourceUrls: [],
      allowedRedirectHosts: ['localhost', '127.0.0.1'],
    },
  };
  await writeFile(join(configDir, 'config.jsonc'), JSON.stringify(config, null, 2));

  const child = spawn(process.execPath, ['dist/cli.js', 'serve'], {
    cwd: pinDir,
    env: sanitizeDevspaceEnvironment(process.env, { DEVSPACE_CONFIG_DIR: configDir, DEVSPACE_OAUTH_OWNER_TOKEN: ownerToken }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: string[] = [];
  child.stdout.on('data', (chunk) => logs.push(String(chunk)));
  child.stderr.on('data', (chunk) => logs.push(String(chunk)));
  const childPid = child.pid;
  if (!childPid) {
    await rm(root, { recursive: true, force: true });
    throw new Error('DevSpace child has no pid');
  }
  options.onSpawn?.(childPid);
  let accessToken: string;
  try {
    await waitForServer(baseUrl, child, logs, options.startupTimeoutMs ?? 15_000);
    accessToken = await issueAccessToken(baseUrl, ownerToken, resourceUrl);
  } catch (error) {
    await stopDevspaceProcess(child).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    baseUrl,
    accessToken,
    resourceUrl,
    workspaceRoot,
    pid: childPid,
    async stop() {
      await stopDevspaceProcess(child);
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function stopDevspaceProcess(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode === null) {
    if (process.platform === 'win32') {
      try { await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']); }
      catch { if (child.exitCode === null) child.kill(); }
    } else child.kill('SIGTERM');
  }
  await waitForExit(child, 3000);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out stopping DevSpace test process')), timeoutMs)),
  ]);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForServer(baseUrl: string, child: ReturnType<typeof spawn>, logs: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`DevSpace exited early (${child.exitCode}): ${logs.join('')}`);
    try {
      const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
      if (response.ok) return;
    } catch {}
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
  }
  throw new Error(`Timed out waiting for DevSpace: ${logs.join('')}`);
}
async function issueAccessToken(baseUrl: string, ownerToken: string, resourceUrl: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1/callback';
  const verifier = 'web-agent-gateway-test-verifier-0123456789';
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const registration = await fetch(`${baseUrl}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Web Agent Gateway test', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
  });
  if (registration.status !== 201) throw new Error(`OAuth registration failed: ${registration.status} ${await registration.text()}`);
  const client = await registration.json() as { client_id?: string };
  if (!client.client_id) throw new Error('OAuth registration returned no client_id');

  const approval = await fetch(`${baseUrl}/authorize`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual',
    body: new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge: challenge, code_challenge_method: 'S256', scope: 'devspace', resource: resourceUrl, state: 'gateway-test', owner_token: ownerToken }),
  });
  const location = approval.headers.get('location');
  if (approval.status !== 302 || !location) throw new Error(`OAuth approval failed: ${approval.status} ${await approval.text()}`);
  const code = new URL(location).searchParams.get('code');
  if (!code) throw new Error('OAuth approval returned no code');

  const exchange = await fetch(`${baseUrl}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code, code_verifier: verifier, redirect_uri: redirectUri, resource: resourceUrl }),
  });
  if (!exchange.ok) throw new Error(`OAuth exchange failed: ${exchange.status} ${await exchange.text()}`);
  const token = await exchange.json() as { access_token?: string };
  if (!token.access_token) throw new Error('OAuth exchange returned no access token');
  return token.access_token;
}
