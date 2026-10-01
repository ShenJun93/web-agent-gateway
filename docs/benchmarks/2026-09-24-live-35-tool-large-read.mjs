import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const runtimeRoot = 'E:/WAG-Runtime/827b2583fee0';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const machineRoot = 'E:/WAG-Acceptance';
const scratch = 'machine-large-read-live';

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');
const { bootstrapPrivateGateway } = await mod('private-runtime.js');
const { createGatewayMcpServer } = await mod('server.js');

const config = await loadPrivateGatewayConfig(configPath);
const engineering = await startRepositoryEngineeringRuntime(config, {
  startOperatorServer: async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=large-read-live',
    close: async () => {},
  }),
});

let privateRuntime;
let server;
let client;
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(name + ' failed: ' + JSON.stringify(result.content));
  return result.structuredContent ?? {};
};

try {
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
  client = new Client({ name: 'wag-live-35-large-read', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  console.error(JSON.stringify({
    profile: engineering.profile,
    contexts: {
      mutation: Boolean(engineering.mutationContext),
      commit: Boolean(engineering.gitCommitContext),
      command: Boolean(engineering.commandContext),
      capability: Boolean(engineering.capabilityContext),
      machine: Boolean(engineering.machineContext),
    },
    toolCount: tools.length,
    tools,
  }));
  if (tools.length !== 35 || !tools.includes('machine.read_many')) {
    throw new Error('unexpected deployed tool surface: ' + tools.length + ' ' + tools.join(','));
  }

  const opened = await call('machine.open', { path: machineRoot });
  const workspaceId = opened.workspace_id;

  await call('machine.mkdir', { workspace_id: workspaceId, path: scratch });
  await call('machine.mkdir', { workspace_id: workspaceId, path: scratch + '/tree' });
  await call('machine.mkdir', { workspace_id: workspaceId, path: scratch + '/tree/deep' });

  const writer = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const root=process.argv[1]",
    "const lines=Array.from({length:1200},(_,i)=>'line-'+String(i).padStart(4,'0')+' '+('x'.repeat(80)))",
    "fs.writeFileSync(path.join(root,'large.txt'),lines.join('\\n')+'\\n','utf8')",
    "fs.writeFileSync(path.join(root,'tree','a.txt'),'alpha\\n','utf8')",
    "fs.writeFileSync(path.join(root,'tree','deep','b.txt'),'bravo\\n','utf8')",
  ].join(';');
  const write = await call('machine.command.run', {
    workspace_id: workspaceId,
    argv: [process.execPath, '-e', writer, machineRoot + '/' + scratch],
    timeout_ms: 10000,
    max_output_tokens: 2000,
  });
  if (write.exitCode !== 0) throw new Error('large read fixture creation failed');

  const plain = await client.callTool({
    name: 'machine.read',
    arguments: { workspace_id: workspaceId, path: scratch + '/large.txt' },
  });
  if (!plain.isError || !JSON.stringify(plain.content).includes('offset/length pagination')) {
    throw new Error('plain large read was not bounded');
  }

  const page = await call('machine.read', {
    workspace_id: workspaceId,
    path: scratch + '/large.txt',
    offset: 100,
    length: 3,
  });
  if (!String(page.content).startsWith('line-0100 ') || page.length !== 3 || page.has_more !== true) {
    throw new Error('paged read mismatch: ' + JSON.stringify(page));
  }

  const many = await call('machine.read_many', {
    workspace_id: workspaceId,
    paths: [
      scratch + '/tree/a.txt',
      scratch + '/tree/deep/b.txt',
      scratch + '/missing.txt',
    ],
  });
  if (many.files?.[0]?.result?.content !== 'alpha' || many.files?.[1]?.result?.content !== 'bravo') {
    throw new Error('read_many content mismatch: ' + JSON.stringify(many));
  }
  if (!String(many.files?.[2]?.error ?? '').includes('missing path')) {
    throw new Error('read_many partial error missing');
  }

  const tree = await call('machine.list', {
    workspace_id: workspaceId,
    path: scratch + '/tree',
    max_entries: 20,
    depth: 3,
  });
  if (!tree.entries?.some((entry) =>
    entry.path === scratch + '/tree/deep/b.txt' && entry.depth === 2)) {
    throw new Error('recursive list mismatch: ' + JSON.stringify(tree));
  }

  console.log(JSON.stringify({
    runtimeRoot,
    sourceHead: '827b2583fee066a4dd55918c2a29d0bde3bd7b37',
    toolCount: tools.length,
    readManyTool: tools.includes('machine.read_many'),
    authority: opened.authority,
    plainLargeReadBounded: true,
    page: {
      offset: page.offset,
      length: page.length,
      total_lines: page.total_lines,
      has_more: page.has_more,
      raw_sha256: page.raw_sha256,
      first_line: String(page.content).split('\n')[0],
    },
    readMany: {
      first: many.files?.[0]?.result?.content,
      second: many.files?.[1]?.result?.content,
      partialError: many.files?.[2]?.error,
    },
    recursiveListHit: tree.entries?.find((entry) => entry.path === scratch + '/tree/deep/b.txt'),
  }, null, 2));
} finally {
  try {
    if (client) {
      const opened = await client.callTool({ name: 'machine.open', arguments: { path: machineRoot } });
      if (!opened.isError) {
        const workspaceId = opened.structuredContent?.workspace_id;
        if (workspaceId) {
          await client.callTool({
            name: 'machine.delete',
            arguments: { workspace_id: workspaceId, path: scratch, recursive: true },
          }).catch(() => undefined);
        }
      }
    }
  } finally {
    await client?.close().catch(() => undefined);
    await server?.close().catch(() => undefined);
    await engineering.close().catch(() => undefined);
    await privateRuntime?.close().catch(() => undefined);
  }
}
