import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const runtimeRoot = 'E:/WAG-Runtime/3687bf3b5c18';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const root = 'E:/WAG-Acceptance/live-38-safe-append';
const target = root + '/append.txt';

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await writeFile(target, 'API_KEY=fixture-secret-value\nmarker=end\n', 'utf8');

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { bootstrapPrivateGateway } = await mod('private-runtime.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');
const { createGatewayMcpServer } = await mod('server.js');

const config = await loadPrivateGatewayConfig(configPath);
let engineering;
let privateRuntime;
let server;
let client;

const must = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(name + ' failed: ' + JSON.stringify(response.content));
  return response.structuredContent ?? {};
};

try {
  engineering = await startRepositoryEngineeringRuntime(config, {
    startOperatorServer: async () => ({
      origin: 'http://127.0.0.1:1',
      bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=live-append',
      close: async () => {},
    }),
  });
  privateRuntime = await bootstrapPrivateGateway(config, {
    env: process.env,
    openWorkspaceId: engineering.openWorkspaceId,
    bindWorkspaceIdentity: engineering.bindWorkspaceIdentity,
  });
  await engineering.attach(privateRuntime.executor);

  server = createGatewayMcpServer(privateRuntime.gateway, {
    inspect: engineering.profile.inspect,
    mutationContext: engineering.mutationContext,
    gitCommitContext: engineering.gitCommitContext,
    commandContext: engineering.commandContext,
    capabilityContext: engineering.capabilityContext,
    machineContext: engineering.machineContext,
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'wag-live-38-safe-append', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const toolNames = (await client.listTools()).tools.map((tool) => tool.name);
  if (toolNames.length !== 38 || !toolNames.includes('file.append')) {
    throw new Error('unexpected production tool surface: ' + JSON.stringify(toolNames));
  }

  const opened = await must('machine.open', { path: root });
  const workspaceId = opened.workspace_id;

  const appended = await must('file.append', {
    workspace_id: workspaceId,
    path: 'append.txt',
    expected_suffix: 'marker=end\n',
    content: 'next=value\n',
  });
  if (appended.state !== 'SUCCEEDED') throw new Error('append not terminal success');

  const redacted = await must('machine.read', { workspace_id: workspaceId, path: 'append.txt' });
  const raw = await readFile(target, 'utf8');
  if (!raw.endsWith('marker=end\nnext=value\n')) throw new Error('append content missing');
  if (!raw.includes('fixture-secret-value')) throw new Error('raw secret changed');
  if (String(redacted.content).includes('fixture-secret-value')) throw new Error('machine.read exposed raw secret');

  const stale = await client.callTool({
    name: 'file.append',
    arguments: {
      workspace_id: workspaceId,
      path: 'append.txt',
      expected_suffix: 'marker=end\n',
      content: 'should-not-land\n',
    },
  });
  if (!stale.isError || !JSON.stringify(stale.content).includes('not the current file tail')) {
    throw new Error('stale append suffix was not rejected');
  }

  console.log(JSON.stringify({
    toolCount: toolNames.length,
    fileAppend: 'live',
    mutationId: appended.mutationId,
    state: appended.state,
    redactionObserved: !String(redacted.content).includes('fixture-secret-value'),
    rawSecretPreserved: raw.includes('fixture-secret-value'),
    staleSuffixRejected: true,
    finalSha256: redacted.raw_sha256,
  }, null, 2));
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await engineering?.close().catch(() => undefined);
  await privateRuntime?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}
