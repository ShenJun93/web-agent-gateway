import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  DEVSPACE_TEST_OWNER_TOKEN,
  startPinnedDevspace,
} from './devspace-fixture.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const builtCli = join(repoRoot, 'dist', 'cli.js');
const fiveTools = ['health', 'workspace.open', 'repo.snapshot', 'file.read', 'verify.run'];

async function connectBuiltCli(configPath: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [builtCli, 'serve-stdio', '--config', configPath],
    env: { ...getDefaultEnvironment(), DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN },
    stderr: 'pipe',
    cwd: repoRoot,
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client(
    { name: 'business-stdio-acceptance', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return {
    client,
    transport,
    stderrText: () => stderr,
    close: async () => { await client.close(); },
  };
}

async function waitUntilProcessGone(pid: number): Promise<boolean> {
  for (let index = 0; index < 40; index += 1) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  return false;
}

async function runBuiltCli(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [builtCli, ...args], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const exitCode = await new Promise<number | null>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', resolvePromise);
  });
  return { exitCode, stdout, stderr };
}

test('built Business stdio path works with exact-pinned DevSpace and rotating OAuth', async (t) => {
  const fixture = await startPinnedDevspace({
    accessTokenTtlSeconds: 1,
    refreshTokenTtlSeconds: 60,
  });
  t.after(() => fixture.stop());
  const tempRoot = await mkdtemp(join(tmpdir(), 'wag-business-stdio-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  await writeFile(join(fixture.workspaceRoot, 'sample.txt'), 'sample\n');
  const configPath = join(tempRoot, 'private.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [fixture.workspaceRoot],
    devspace: { baseUrl: fixture.baseUrl, resourceUrl: fixture.resourceUrl },
    verifyProfiles: {
      version: { argv: ['node', '--version'], timeoutMs: 5_000, maxOutputTokens: 1_000 },
    },
  }));
  const first = await connectBuiltCli(configPath);
  const firstPid = first.transport.pid;
  assert.ok(firstPid, 'stdio client transport must expose the Gateway child pid');

  const tools = await first.client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name), fiveTools);
  const opened = await first.client.callTool({
    name: 'workspace.open',
    arguments: { path: fixture.workspaceRoot },
  });
  const workspaceId = (opened.structuredContent as { workspaceId?: string } | undefined)?.workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);

  const read = await first.client.callTool({
    name: 'file.read',
    arguments: { workspace_id: workspaceId, path: 'sample.txt' },
  });
  assert.equal((read.structuredContent as { content?: string } | undefined)?.content, 'sample');

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  assert.notEqual((await first.client.callTool({ name: 'health', arguments: {} })).isError, true);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 700));
  assert.notEqual((await first.client.callTool({ name: 'health', arguments: {} })).isError, true);
  const verify = await first.client.callTool({
    name: 'verify.run',
    arguments: { workspace_id: workspaceId, profile: 'version' },
  });
  assert.notEqual(verify.isError, true);
  assert.equal((verify.structuredContent as { exitCode?: number } | undefined)?.exitCode, 0);
  assert.equal(first.stderrText().includes(DEVSPACE_TEST_OWNER_TOKEN), false);
  assert.equal(first.stderrText().includes(fixture.workspaceRoot), false);
  assert.match(first.stderrText(), /gateway\.(ready|telemetry)/);

  await first.close();
  assert.equal(await waitUntilProcessGone(firstPid), true, 'first Gateway stdio child must exit');

  const second = await connectBuiltCli(configPath);
  const secondPid = second.transport.pid;
  assert.ok(secondPid, 'replacement stdio child must expose pid');
  assert.notEqual((await second.client.callTool({ name: 'health', arguments: {} })).isError, true);
  await second.close();
  assert.equal(await waitUntilProcessGone(secondPid), true, 'replacement Gateway stdio child must exit');

  const doctorEnv = {
    ...getDefaultEnvironment(),
    DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN,
  };
  const doctor = await runBuiltCli(['doctor', '--config', configPath], doctorEnv);
  assert.equal(doctor.exitCode, 0);
  assert.equal(JSON.parse(doctor.stdout).status, 'ok');
  assert.equal(doctor.stderr.includes(DEVSPACE_TEST_OWNER_TOKEN), false);
  assert.equal(doctor.stderr.includes(fixture.workspaceRoot), false);
  const missingOwner = await runBuiltCli(
    ['doctor', '--config', configPath],
    { ...getDefaultEnvironment() },
  );
  assert.notEqual(missingOwner.exitCode, 0);
  assert.match(missingOwner.stderr, /DEVSPACE_OWNER_TOKEN_MISSING/);
  assert.equal(missingOwner.stderr.includes(configPath), false);
  assert.equal(missingOwner.stderr.includes(fixture.workspaceRoot), false);
  assert.equal(missingOwner.stderr.includes(DEVSPACE_TEST_OWNER_TOKEN), false);
});
