export const DEVSPACE_PROTOCOL_VERSION = '2026-07-28';
export const REQUIRED_DEVSPACE_TOOLS = [
  'open_workspace',
  'read',
  'apply_patch',
  'exec_command',
  'write_stdin',
  'show_changes',
] as const;

export interface DevspaceTool {
  name: string;
  inputSchema: unknown;
}

export interface DevspaceExecutorOptions {
  baseUrl: string;
  accessToken: string;
}

export class DevspaceExecutor {
  constructor(private readonly options: DevspaceExecutorOptions) {}

  async listTools(): Promise<DevspaceTool[]> {
    const response = await this.postModernMcp('tools/list', {});
    if (!response.ok) throw new Error(`DevSpace tools/list failed: HTTP ${response.status} ${await response.text()}`);
    const body = await response.json() as { error?: unknown; result?: { tools?: DevspaceTool[] } };
    if (body.error) throw new Error(`DevSpace tools/list returned JSON-RPC error: ${JSON.stringify(body.error)}`);
    if (!Array.isArray(body.result?.tools)) throw new Error('DevSpace tools/list returned no tools array');
    return body.result.tools;
  }

  private postModernMcp(method: string, params: Record<string, unknown>): Promise<Response> {
    return fetch(`${this.options.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': DEVSPACE_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `gateway-${method}`,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': DEVSPACE_PROTOCOL_VERSION,
            'io.modelcontextprotocol/clientCapabilities': {},
            'io.modelcontextprotocol/clientInfo': { name: 'web-agent-gateway', version: '0.0.0' },
          },
        },
      }),
    });
  }
}
