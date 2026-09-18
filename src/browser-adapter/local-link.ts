import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { BROWSER_INSPECT_ADAPTER_ID } from '../adapter-admission.js';
import {
  parseBrowserAdapterResponse,
  BROWSER_ADAPTER_PROTOCOL_VERSION,
  type BrowserAdapterRequest,
  type BrowserAdapterResponse,
  type BrowserToolName,
} from './protocol.js';

export interface AdapterDiscovery {
  admissionUrl: string;
  bootstrapToken: string;
  protocolVersion: typeof BROWSER_ADAPTER_PROTOCOL_VERSION;
  adapterId: typeof BROWSER_INSPECT_ADAPTER_ID;
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

const BROWSER_TOOLS: readonly BrowserToolName[] = ['health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read'];
type ToolCallRequest = Extract<BrowserAdapterRequest, { type: 'tool.call' }>;
export class McpLocalAdapterLink implements LocalAdapterLink {
  #closed = false;
  private constructor(
    private readonly client: Client,
    private readonly mcpUrl: string,
    private admittedBearer: string | undefined,
  ) {}

  static async admit(discoveryValue: unknown, correlationId: string): Promise<McpLocalAdapterLink> {
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
    let actual: string[];
    try {
      const result = await this.client.listTools();
      actual = result.tools.map((tool) => tool.name).sort();
    } catch {
      throw new Error('Local WAG tool discovery failed');
    }
    const expected = [...BROWSER_TOOLS].sort();
    if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
      throw new Error('browser tool profile mismatch');
    }
    return [...BROWSER_TOOLS];
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
      return parseBrowserAdapterResponse({ version: BROWSER_ADAPTER_PROTOCOL_VERSION, type: 'result', requestId: request.requestId, result: result.structuredContent });
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
    version: BROWSER_ADAPTER_PROTOCOL_VERSION, type: 'error', requestId,
    error: { code: 'LOCAL_WAG_FAILED', message: 'Local WAG request failed' },
  });
}

export function parseAdapterDiscovery(value: unknown): AdapterDiscovery {
  if (!value || typeof value !== 'object') throw new Error('Invalid browser adapter discovery');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'adapterId,admissionUrl,bootstrapToken,protocolVersion') {
    throw new Error('Invalid browser adapter discovery');
  }
  if (typeof record.admissionUrl !== 'string' || typeof record.bootstrapToken !== 'string') {
    throw new Error('Invalid browser adapter discovery');
  }
  if (record.protocolVersion !== BROWSER_ADAPTER_PROTOCOL_VERSION || record.adapterId !== BROWSER_INSPECT_ADAPTER_ID) {
    throw new Error('Invalid browser adapter discovery');
  }
  if (Buffer.byteLength(record.bootstrapToken, 'utf8') < 32) {
    throw new Error('Invalid browser adapter discovery');
  }
  let url: URL;
  try { url = parseLoopbackUrl(record.admissionUrl, '/adapter/admit'); }
  catch { throw new Error('Invalid browser adapter discovery'); }
  return { admissionUrl: url.toString(), bootstrapToken: record.bootstrapToken, protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION, adapterId: BROWSER_INSPECT_ADAPTER_ID };
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
