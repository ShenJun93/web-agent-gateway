import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  BROWSER_OPERATOR_ADAPTER_ID,
  BrowserAdmissionRegistry,
  OPERATOR_CORRELATION_PATTERN,
} from '../src/adapter-admission.js';
import { SqliteDurableStore } from '../src/durable-store.js';
import { DevspaceExecutor } from '../src/executor/devspace.js';
import { startBrowserAdmissionHttpServer } from '../src/http-server.js';
import { createBrowserOperatorAdmittedMcpServer, createGateway } from '../src/server.js';
import { encodeNativeMessage, NativeMessageDecoder } from '../src/browser-adapter/native-framing.js';
import { BROWSER_OPERATOR_PROTOCOL_VERSION } from '../src/browser-adapter/protocol-v4.js';

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

async function resolveArtifactUnderTest(tempRoot: string, override = process.env.WAG_NATIVE_HOST_BUILD_DIR) {
  let outputDir: string;
  let builtLocally = false;
  if (override) {
    if (!isAbsolute(override)) throw new Error('WAG_NATIVE_HOST_BUILD_DIR must be absolute');
    outputDir = override;
    for (const name of ['wag-native-host.exe', 'sea-config.json']) {
      const info = await stat(join(outputDir, name));
      if (!info.isFile()) throw new Error(`Prebuilt artifact is missing ${name}`);
    }
  } else {
    outputDir = join(tempRoot, 'artifact');
    const tsxCli = fileURLToPath(import.meta.resolve('tsx/cli'));
    const build = await run(process.execPath, [tsxCli, 'scripts/build-native-host.ts', '--output', outputDir]);
    assert.equal(build.code, 0, build.stderr);
    builtLocally = true;
  }
  return { outputDir, executable: join(outputDir, 'wag-native-host.exe'), builtLocally };
}

test('artifact harness selects a supplied prebuilt directory without rebuilding', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows v1 artifact');
  const temp = await mkdtemp(join(tmpdir(), 'wag-native-host-prebuilt-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(join(temp, 'wag-native-host.exe'), 'fixture');
  await writeFile(join(temp, 'sea-config.json'), JSON.stringify({ execArgvExtension: 'none' }));

  const resolved = await resolveArtifactUnderTest(temp, temp);
  assert.equal(resolved.outputDir, temp);
  assert.equal(resolved.executable, join(temp, 'wag-native-host.exe'));
  assert.equal(resolved.builtLocally, false);
});

/**
 * The shipped SEA binary is the operator host now, so this exercises it against an operator
 * runtime. What it proves is unchanged: the real built executable, spawned as a real process,
 * really speaks the framed protocol to a real local WAG and leaks neither credential.
 */
test('Windows SEA native host speaks framed protocol against local WAG', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows v1 artifact');
  const temp = await mkdtemp(join(tmpdir(), 'wag-native-host-artifact-'));
  t.after(() => rm(temp, { recursive: true, force: true }));

  const artifact = await resolveArtifactUnderTest(temp);
  const { outputDir, executable } = artifact;
  const seaConfig = JSON.parse(await readFile(join(outputDir, 'sea-config.json'), 'utf8')) as { execArgvExtension?: string };
  assert.equal(seaConfig.execArgvExtension, 'none');

  const bootstrapToken = randomBytes(32).toString('hex');
  const executor = new DevspaceExecutor({ baseUrl: 'http://127.0.0.1:1', accessToken: 'unused' });
  const gateway = createGateway({ executor, allowedRoots: [root] });
  const store = new SqliteDurableStore(':memory:');
  const admission = new BrowserAdmissionRegistry(
    BROWSER_OPERATOR_ADAPTER_ID, store, Date.now, OPERATOR_CORRELATION_PATTERN,
  );
  const workspaces = {
    open: async () => ({ workspaceId: 'ws_unused' }),
    read: async () => ({ content: 'unused' }),
    search: async () => ({ matches: [], truncated: false }),
    snapshot: async () => ({ branch: 'main', head: '1234', dirty: false, status: [], diffStat: '', files: [], filesTruncated: false }),
  };
  const verify = {
    preview: () => ({ status: 'approval_required' as const, request_id: 'verifyreq_unused', profile: 'unit', fingerprint: '0'.repeat(64), expires_at: 1 }),
    result: () => ({ request_id: 'verifyreq_unused', profile: 'unit', state: 'REJECTED' as const, expires_at: 1 }),
  };
  const unreachable = () => { throw new Error('this artifact test never reaches a coordinator'); };
  const mutation = { preview: unreachable, result: unreachable };
  const commit = { preview: unreachable, result: unreachable };
  const http = await startBrowserAdmissionHttpServer({
    gateway,
    browserAdmission: {
      bootstrapToken, admission,
      browserMcp: (caller) => createBrowserOperatorAdmittedMcpServer(
        gateway, { callerContext: caller, workspaces, verify, mutation, commit } as never,
      ),
    },
  });
  t.after(async () => { await http.close(); admission.close(); store.close(); });
  assert.ok(http.admissionUrl);

  const discoveryPath = join(temp, 'browser-adapter.json');
  await writeFile(discoveryPath, JSON.stringify({
    admissionUrl: http.admissionUrl,
    bootstrapToken,
    protocolVersion: BROWSER_OPERATOR_PROTOCOL_VERSION,
    adapterId: BROWSER_OPERATOR_ADAPTER_ID,
  }), 'utf8');
  const child = spawn(executable, [extensionOrigin, '--discovery', discoveryPath], {
    cwd: outputDir,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

  // The operator adapter requires a server-minted correlation, not a chosen label.
  const sessionId = 'session_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  for (const message of [
    { version: BROWSER_OPERATOR_PROTOCOL_VERSION, type: 'hello', requestId: 'req_artifact_hello' },
    { version: BROWSER_OPERATOR_PROTOCOL_VERSION, type: 'session.bind', requestId: 'req_artifact_bind', sessionId, provider: 'chatgpt', origin: 'https://chatgpt.com' },
    { version: BROWSER_OPERATOR_PROTOCOL_VERSION, type: 'tools.list', requestId: 'req_artifact_tools', sessionId },
  ]) child.stdin.write(encodeNativeMessage(message));
  child.stdin.end();
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8'));
  const responses = new NativeMessageDecoder().push(Buffer.concat(stdout)) as Array<{ requestId?: string; result?: { tools?: string[] } }>;
  assert.deepEqual(responses.map((response) => response.requestId), ['req_artifact_hello', 'req_artifact_bind', 'req_artifact_tools']);
  assert.deepEqual(responses[2]?.result?.tools, [
    'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
    'verify.preview', 'verify.result',
    'mutation.preview', 'file.create', 'mutation.result',
    'git.commit', 'git.commit.result',
  ]);
  const rendered = JSON.stringify(responses);
  assert.equal(rendered.includes(bootstrapToken), false);
  assert.equal(rendered.includes(http.admissionUrl), false);
});
