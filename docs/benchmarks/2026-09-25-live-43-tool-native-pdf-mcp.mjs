import { pathToFileURL } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';

const runtimeRoot = 'E:/WAG-Runtime/5b6ab4aab5ef';
const configPath = 'E:/AI-BROWSER/wag-acceptance/wag-live.config.json';
const root = 'E:/WAG-Acceptance/pdf-live-86c99e8275ca';

const mod = async (name) => import(pathToFileURL(runtimeRoot + '/dist/' + name).href);
const { loadPrivateGatewayConfig } = await mod('private-config.js');
const { startRepositoryEngineeringRuntime } = await mod('repository-engineering-runtime.js');
const { createGatewayMcpServer } = await mod('server.js');

const config = await loadPrivateGatewayConfig(configPath);
const engineering = await startRepositoryEngineeringRuntime(config, {
  startOperatorServer: async () => ({
    origin: 'http://127.0.0.1:1',
    bootstrapUrl: 'http://127.0.0.1:1/bootstrap?token=live-pdf-mcp-unused',
    close: async () => {},
  }),
});

const unused = async () => { throw new Error('unused gateway method'); };
const gateway = {
  health: async () => ({ status: 'ok', executor: 'live-pdf-mcp', protocolVersion: '2026-07-28', toolCount: 43 }),
  openWorkspace: unused,
  repoList: unused,
  repoSearch: unused,
  repoSnapshot: unused,
  repoDiff: unused,
  readFile: unused,
  verifyRun: unused,
  commandRun: unused,
};

let server;
let client;
try {
  if (!engineering.machineContext) throw new Error('machineContext missing');
  server = createGatewayMcpServer(gateway, {
    inspect: engineering.profile.inspect,
    mutationContext: engineering.mutationContext,
    gitCommitContext: engineering.gitCommitContext,
    commandContext: engineering.commandContext,
    capabilityContext: engineering.capabilityContext,
    machineContext: engineering.machineContext,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'wag-live-pdf-mcp', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const names = (await client.listTools()).tools.map((tool) => tool.name);
  if (!names.includes('machine.pdf.extract')) {
    throw new Error('machine.pdf.extract absent from deployed MCP assembly');
  }
  const open = await client.callTool({ name: 'machine.open', arguments: { path: root } });
  if (open.isError) throw new Error('machine.open failed: ' + JSON.stringify(open.content));
  const workspaceId = open.structuredContent?.workspace_id;
  if (typeof workspaceId !== 'string') throw new Error('machine.open returned no workspace id');

  const extracted = await client.callTool({
    name: 'machine.pdf.extract',
    arguments: {
      workspace_id: workspaceId,
      path: 'sample.pdf',
      start_page: 1,
      max_pages: 2,
      max_chars: 4096,
    },
  });
  if (extracted.isError) throw new Error('machine.pdf.extract failed: ' + JSON.stringify(extracted.content));
  const value = extracted.structuredContent;
  if (value?.mime_type !== 'application/pdf'
    || value?.page_count !== 2
    || value?.extracted_pages !== 2
    || !String(value?.content ?? '').includes('Live PDF page two needle')
    || !String(value?.content ?? '').includes('secret=<REDACTED>')) {
    throw new Error('MCP PDF result mismatch: ' + JSON.stringify(value));
  }

  console.log(JSON.stringify({
    state: 'PASS',
    runtimeRoot,
    sourceHead: '5b6ab4aab5ef7d398e97009e3c3d3e9dbefbe920',
    toolCount: names.length,
    hasPdfTool: true,
    workspaceId,
    result: value,
  }, null, 2));
} finally {
  await client?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  await engineering.close();
}
