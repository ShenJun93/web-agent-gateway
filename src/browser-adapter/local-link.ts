import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  parseBrowserAdapterResponse,
  type BrowserAdapterRequest,
  type BrowserAdapterResponse,
  type BrowserToolName,
} from './protocol.js';

export interface AdapterDiscovery {
  mcpUrl: string;
  bearerToken: string;
}

export interface LocalAdapterLink {
  listTools(): Promise<readonly BrowserToolName[]>;
  call(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse>;
  close(): Promise<void>;
}

const BROWSER_TOOLS: readonly BrowserToolName[] = ['health', 'workspace.open', 'file.read'];
type ToolCallRequest = Extract<BrowserAdapterRequest, { type: 'tool.call' }>;

export class McpLocalAdapterLink implements LocalAdapterLink {
  #closed = false;

  private constructor(private readonly client: Client) {}

  static async connect(discovery: AdapterDiscovery): Promise<McpLocalAdapterLink> {
    const validated = validateDiscovery(discovery);
    const client = new Client({ name: 'wag-browser-native-host', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(validated.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${validated.bearerToken}` } },
    });
    try {
      await client.connect(transport);
      return new McpLocalAdapterLink(client);
    } catch {
      await client.close().catch(() => undefined);
      throw new Error('Local WAG connection failed');
    }
  }

  async listTools(): Promise<readonly BrowserToolName[]> {
    this.#assertOpen();
    try {
      const result = await this.client.listTools();
      const names = new Set(result.tools.map((tool) => tool.name));
      if (!BROWSER_TOOLS.every((name) => names.has(name))) {
        throw new Error('required browser tool missing');
      }
      return [...BROWSER_TOOLS];
    } catch {
      throw new Error('Local WAG tool discovery failed');
    }
  }

  async call(request: BrowserAdapterRequest): Promise<BrowserAdapterResponse> {
    this.#assertOpen();
    if (request.type !== 'tool.call') throw new Error('LocalAdapterLink requires tool.call request');
    return this.#callTool(request);
  }

  async #callTool(request: ToolCallRequest): Promise<BrowserAdapterResponse> {
    try {
      const result = await this.client.callTool({
        name: request.tool,
        arguments: request.arguments,
      });
      if (result.isError || result.structuredContent === undefined) {
        return localError(request.requestId);
      }
      return parseBrowserAdapterResponse({
        version: 1,
        type: 'result',
        requestId: request.requestId,
        result: result.structuredContent,
      });
    } catch {
      return localError(request.requestId);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.client.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('LocalAdapterLink is closed');
  }
}

function localError(requestId: string): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({
    version: 1,
    type: 'error',
    requestId,
    error: { code: 'LOCAL_WAG_FAILED', message: 'Local WAG request failed' },
  });
}

function validateDiscovery(discovery: AdapterDiscovery): AdapterDiscovery {
  if (Buffer.byteLength(discovery.bearerToken, 'utf8') < 32) {
    throw new Error('Invalid browser adapter discovery');
  }
  let url: URL;
  try {
    url = new URL(discovery.mcpUrl);
  } catch {
    throw new Error('Invalid browser adapter discovery');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'http:' || !loopback || url.pathname !== '/mcp' || url.username || url.password) {
    throw new Error('Invalid browser adapter discovery');
  }
  return { mcpUrl: url.toString(), bearerToken: discovery.bearerToken };
}
