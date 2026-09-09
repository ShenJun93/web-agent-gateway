export const DEVSPACE_PROTOCOL_VERSION = '2026-07-28';
export const REQUIRED_DEVSPACE_TOOLS = [
  'open_workspace', 'read', 'apply_patch', 'exec_command', 'write_stdin', 'show_changes',
] as const;

export interface DevspaceTool { name: string; inputSchema: unknown; }
export interface DevspaceExecutorOptions { baseUrl: string; accessToken: string; }
export interface ExecResult { output: string; exitCode?: number; running: boolean; sessionId?: number; }
export class DevspaceReadLimitError extends Error {}

export class DevspaceExecutor {
  constructor(private readonly options: DevspaceExecutorOptions) {}

  async listTools(): Promise<DevspaceTool[]> {
    const body = await this.request('tools/list', {});
    if (!Array.isArray(body.result?.tools)) throw new Error('DevSpace tools/list returned no tools array');
    return body.result.tools as DevspaceTool[];
  }

  async openWorkspace(path: string): Promise<string> {
    const result = await this.callTool('open_workspace', { path }) as { structuredContent?: { workspaceId?: string } };
    const workspaceId = result.structuredContent?.workspaceId;
    if (!workspaceId) throw new Error('DevSpace open_workspace returned no workspaceId');
    return workspaceId;
  }

  async readFile(workspaceId: string, path: string, offset?: number, limit?: number): Promise<string> {
    const result = await this.callTool('read', { workspaceId, path, ...(offset ? { offset } : {}), ...(limit ? { limit } : {}) }) as {
      structuredContent?: { result?: string };
    };
    const content = result.structuredContent?.result;
    if (typeof content !== 'string') throw new Error('DevSpace read returned no structured result');
    if (/^\[(?:Line \d+|File).*exceeds .* limit\./i.test(content)) throw new DevspaceReadLimitError(content);
    return content;
  }

  async execCommand(workspaceId: string, cmd: string, maxOutputTokens = 8000, yieldTimeMs = 30_000): Promise<ExecResult> {
    const result = await this.callTool('exec_command', { workspaceId, cmd, yieldTimeMs, maxOutputTokens }) as {
      structuredContent?: { result?: string; exitCode?: number; running?: boolean; sessionId?: number };
    };
    const rawOutput = result.structuredContent?.result;
    if (typeof rawOutput !== 'string') throw new Error('DevSpace exec_command returned no structured result');
    const output = rawOutput.replace(/\r?\nProcess (?:exited|running)[^\r\n]*\.?$/, '');
    return { output, exitCode: result.structuredContent?.exitCode, running: result.structuredContent?.running === true, sessionId: result.structuredContent?.sessionId };
  }

  async interruptCommand(workspaceId: string, sessionId: number, maxOutputTokens = 1000): Promise<void> {
    await this.callTool('write_stdin', { workspaceId, sessionId, chars: '\u0003', yieldTimeMs: 2_000, maxOutputTokens });
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const body = await this.request('tools/call', { name, arguments: args }, name);
    const result = body.result;
    if (!result || typeof result !== 'object') throw new Error(`DevSpace ${name} returned no result`);
    if ((result as { isError?: boolean }).isError) throw new Error(`DevSpace ${name} reported tool error: ${JSON.stringify(result)}`);
    return result;
  }

  private async request(method: string, params: Record<string, unknown>, mcpName?: string): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
    const response = await fetch(`${this.options.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.accessToken}`,
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': DEVSPACE_PROTOCOL_VERSION,
        ...(mcpName ? { 'mcp-name': mcpName } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: `gateway-${method}`, method, params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': DEVSPACE_PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'web-agent-gateway', version: '0.0.0' },
        },
      } }),
    });
    if (!response.ok) throw new Error(`DevSpace ${method} failed: HTTP ${response.status} ${await response.text()}`);
    const body = await response.json() as { result?: Record<string, unknown>; error?: unknown };
    if (body.error) throw new Error(`DevSpace ${method} returned JSON-RPC error: ${JSON.stringify(body.error)}`);
    return body;
  }
}
