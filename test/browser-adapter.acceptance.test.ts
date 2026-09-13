import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';
import { startBrowserAdapterRuntime } from '../scripts/browser-adapter-runtime.js';
import { DEVSPACE_TEST_OWNER_TOKEN, startPinnedDevspace } from './devspace-fixture.js';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const extensionOrigin = 'chrome-extension://nnhhhppkpogkedpjnijeagcbfjaoogec/';
const sessionId = 'session_acceptance_01';

type Response = { type: string; requestId: string; result?: unknown; error?: unknown };

async function buildNativeHost(outputDir: string): Promise<string> {
  const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
  await execFileAsync(process.execPath, [tsxCli, 'scripts/build-native-host.ts', '--output', outputDir], { cwd: root });
  return join(outputDir, 'wag-native-host.exe');
}

async function runHost(executable: string, discoveryPath: string, messages: unknown[]): Promise<Response[]> {
  const child = spawn(executable, [extensionOrigin, '--discovery', discoveryPath], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  for (const message of messages) child.stdin.write(encodeNativeMessage(message));
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  return new NativeMessageDecoder().push(Buffer.concat(stdout)) as Response[];
}

function result<T>(responses: Response[], requestId: string): T {
  const response = responses.find((value) => value.requestId === requestId);
  assert.ok(response, `missing response ${requestId}`);
  assert.equal(response.type, 'result', JSON.stringify(response));
  return response.result as T;
}

test('browser adapter local path survives native-host reconnect', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows v1 acceptance');
  const temp = await mkdtemp(join(tmpdir(), 'wag-browser-acceptance-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspaceRoot = join(temp, 'repo');
  await execFileAsync('git', ['init', workspaceRoot]);
  const note = 'alpha\nbeta\ngamma\n';
  await writeFile(join(workspaceRoot, 'note.txt'), note, 'utf8');
  await execFileAsync('git', ['-C', workspaceRoot, 'add', 'note.txt']);
  await execFileAsync('git', ['-C', workspaceRoot, '-c', 'user.name=WAG Test', '-c', 'user.email=wag@example.invalid', 'commit', '-m', 'fixture']);

  const devspace = await startPinnedDevspace({ workspaceRoot });
  t.after(() => devspace.stop());
  const configPath = join(temp, 'private.json');
  const discoveryPath = join(temp, 'state', 'browser-adapter.json');
  await writeFile(configPath, JSON.stringify({
    allowedRoots: [workspaceRoot],
    devspace: { baseUrl: devspace.baseUrl, resourceUrl: devspace.resourceUrl },
    verifyProfiles: {},
  }), 'utf8');
  const env = { DEVSPACE_OAUTH_OWNER_TOKEN: DEVSPACE_TEST_OWNER_TOKEN };
  const runtime = await startBrowserAdapterRuntime({ configPath, discoveryPath, env });
  t.after(() => runtime.close());

  const discovery = JSON.parse(await readFile(discoveryPath, 'utf8')) as { mcpUrl: string; bearerToken: string };
  const executable = await buildNativeHost(join(temp, 'artifact'));
  const firstMessages = [
    { version: 1, type: 'hello', requestId: 'req_accept_hello_1' },
    { version: 1, type: 'session.bind', requestId: 'req_accept_bind_1', sessionId, provider: 'chatgpt', origin: 'https://chatgpt.com' },
    { version: 1, type: 'tool.call', requestId: 'req_accept_health_1', sessionId, tool: 'health', arguments: {} },
    { version: 1, type: 'tool.call', requestId: 'req_accept_open_1', sessionId, tool: 'workspace.open', arguments: { path: workspaceRoot } },
  ];
  const first = await runHost(executable, discoveryPath, firstMessages);
  assert.equal(result<{ status?: string }>(first, 'req_accept_health_1').status, 'ok');
  const workspaceId = result<{ workspaceId?: string }>(first, 'req_accept_open_1').workspaceId;
  assert.match(workspaceId ?? '', /^ws_/);

  const secondMessages = [
    { version: 1, type: 'hello', requestId: 'req_accept_hello_2' },
    { version: 1, type: 'session.bind', requestId: 'req_accept_bind_2', sessionId, provider: 'chatgpt', origin: 'https://chatgpt.com' },
    { version: 1, type: 'tool.call', requestId: 'req_accept_read_2', sessionId, tool: 'file.read', arguments: { workspace_id: workspaceId, path: 'note.txt' } },
  ];
  const second = await runHost(executable, discoveryPath, secondMessages);
  assert.equal(result<{ content?: string }>(second, 'req_accept_read_2').content, note.trimEnd());

  const wire = JSON.stringify([...firstMessages, ...first, ...secondMessages, ...second]);
  const responsesOnly = JSON.stringify([...first, ...second]);
  assert.equal(wire.includes(discovery.mcpUrl), false);
  assert.equal(wire.includes(discovery.bearerToken), false);
  assert.equal(/operator|bootstrap|approval/i.test(wire), false);
  assert.equal((firstMessages[3] as { arguments: { path: string } }).arguments.path, workspaceRoot);
  assert.equal(responsesOnly.includes(JSON.stringify(workspaceRoot).slice(1, -1)), false, 'responses must not echo absolute root');

  const { stdout: gitStatus } = await execFileAsync('git', ['-C', workspaceRoot, 'status', '--porcelain']);
  assert.equal(gitStatus, '');
});
