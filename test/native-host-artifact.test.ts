import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startGatewayHttpServer } from '../src/http-server.js';
import { createGateway } from '../src/server.js';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';

const root = process.cwd();
const extensionOrigin = 'chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/';

function run(command: string, args: string[], cwd = root): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8') }));
  });
}
test('Windows SEA native host speaks framed protocol against local WAG', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows v1 artifact');
  const temp = await mkdtemp(join(tmpdir(), 'wag-native-host-artifact-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const outputDir = join(temp, 'artifact');
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  const build = await run(process.execPath, [tsxCli, 'scripts/build-native-host.ts', '--output', outputDir]);
  assert.equal(build.code, 0, build.stderr);

  const executable = join(outputDir, 'wag-native-host.exe');
  const seaConfig = JSON.parse(await readFile(join(outputDir, 'sea-config.json'), 'utf8')) as { execArgvExtension?: string };
  assert.equal(seaConfig.execArgvExtension, 'none');

  const bearerToken = randomBytes(32).toString('hex');
  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [root] });
  const http = await startGatewayHttpServer({ gateway, bearerToken });
  t.after(() => http.close());

  const discoveryPath = join(temp, 'browser-adapter.json');
  await writeFile(discoveryPath, JSON.stringify({ mcpUrl: http.mcpUrl, bearerToken }), 'utf8');
  const child = spawn(executable, [extensionOrigin, '--discovery', discoveryPath], {
    cwd: outputDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

  const sessionId = 'session_artifact_01';
  for (const message of [
    { version: 1, type: 'hello', requestId: 'req_artifact_hello' },
    { version: 1, type: 'session.bind', requestId: 'req_artifact_bind', sessionId, provider: 'chatgpt', origin: 'https://chatgpt.com' },
    { version: 1, type: 'tools.list', requestId: 'req_artifact_tools', sessionId },
  ]) child.stdin.write(encodeNativeMessage(message));
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const responses = new NativeMessageDecoder().push(Buffer.concat(stdout)) as Array<{ requestId?: string; result?: { tools?: string[] } }>;
  assert.deepEqual(responses.map((response) => response.requestId), ['req_artifact_hello', 'req_artifact_bind', 'req_artifact_tools']);
  assert.deepEqual(responses[2]?.result?.tools, ['health', 'workspace.open', 'file.read']);
});
