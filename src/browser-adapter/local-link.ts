import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  parseBrowserAdapterResponse,
  type BrowserAdapterRequest,
  type BrowserAdapterResponse,
  type BrowserToolName,
} from './protocol.js';

export interface AdapterDiscovery {
  admissionUrl: string;
  bootstrapToken: string;
}

interface AdmissionResponse {
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
  private constructor(
    private readonly client: Client,
    private readonly mcpUrl: string,
    private admittedBearer: string | undefined,
  ) {}

  static async admit(discoveryValue: AdapterDiscovery, correlationId: string): Promise<McpLocalAdapterLink> {
    const discovery = parseAdapterDiscovery(discoveryValue);
    let admitted: AdmissionResponse;
    try {
      const response = await fetch(discovery.admissionUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${discovery.bootstrapToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ correlation_id: correlationId }),
      });
      if (!response.ok) throw new Error('admission rejected');
      admitted = parseAdmissionResponse(await response.json(), discovery.admissionUrl);
    } catch {
      throw new Error('Local WAG admission failed');
    }

    const client = new Client({ name: 'wag-browser-native-host', version: '1.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(admitted.mcpUrl), {
      requestInit: { headers: { authorization: `Bearer ${admitted.bearerToken}` } },
    });
    try {
      await client.connect(transport);
      return new McpLocalAdapterLink(client, admitted.mcpUrl, admitted.bearerToken);
    } catch {
      await client.close().catch(() => undefined);
      await releaseBearer(admitted.mcpUrl, admitted.bearerToken);
      throw new Error('Local WAG connection failed');
    }
  }

  async listTools(): Promise<readonly BrowserToolName[]> {
    this.#assertOpen();
    try {
      const result = await this.client.listTools();
      const names = new Set(result.tools.map((tool) => tool.name));
      if (!BROWSER_TOOLS.every((name) => names.has(name))) throw new Error('required browser tool missing');
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
      const result = await this.client.callTool({ name: request.tool, arguments: request.arguments });
      if (result.isError || result.structuredContent === undefined) return localError(request.requestId);
      return parseBrowserAdapterResponse({ version: 1, type: 'result', requestId: request.requestId, result: result.structuredContent });
    } catch {
      return localError(request.requestId);
    }
  }


  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const bearer = this.admittedBearer;
    await this.client.close().catch(() => undefined);
    if (bearer !== undefined) await releaseBearer(this.mcpUrl, bearer);
    this.admittedBearer = undefined;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('LocalAdapterLink is closed');
  }
}

function localError(requestId: string): BrowserAdapterResponse {
  return parseBrowserAdapterResponse({
    version: 1, type: 'error', requestId,
    error: { code: 'LOCAL_WAG_FAILED', message: 'Local WAG request failed' },
  });
}

function parseAdapterDiscovery(value: AdapterDiscovery): AdapterDiscovery {
  const record = value as unknown as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'admissionUrl,bootstrapToken') {
    throw new Error('Invalid browser adapter discovery');
  }
  if (typeof record.admissionUrl !== 'string' || typeof record.bootstrapToken !== 'string') {
    throw new Error('Invalid browser adapter discovery');
  }
  if (Buffer.byteLength(record.bootstrapToken, 'utf8') < 32) {
    throw new Error('Invalid browser adapter discovery');
  }
  let url: URL;
  try { url = parseLoopbackUrl(record.admissionUrl, '/adapter/admit'); }
  catch { throw new Error('Invalid browser adapter discovery'); }
  return { admissionUrl: url.toString(), bootstrapToken: record.bootstrapToken };
}

function parseAdmissionResponse(value: unknown, admissionUrl: string): AdmissionResponse {
  if (!value || typeof value !== 'object') throw new Error('Invalid admission response');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'bearer_token,mcp_url') throw new Error('Invalid admission response');
  if (typeof record.mcp_url !== 'string' || typeof record.bearer_token !== 'string') throw new Error('Invalid admission response');
  if (Buffer.byteLength(record.bearer_token, 'utf8') < 32) throw new Error('Invalid admission response');
  const mcpUrl = parseLoopbackUrl(record.mcp_url, '/mcp');
  if (mcpUrl.origin !== new URL(admissionUrl).origin) throw new Error('Invalid admission response');
  return { mcpUrl: mcpUrl.toString(), bearerToken: record.bearer_token };
}

function parseLoopbackUrl(value: string, pathname: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('Invalid browser adapter URL'); }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if (url.protocol !== 'http:' || !loopback || url.pathname !== pathname || url.search || url.hash || url.username || url.password) {
    throw new Error('Invalid browser adapter URL');
  }
  return url;
}

async function releaseBearer(mcpUrl: string, bearer: string): Promise<void> {
  try {
    const url = new URL('/adapter/release', mcpUrl);
    await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
    });
  } catch {
    // Best-effort only; WAG restart also invalidates every admitted bearer.
  }
}
