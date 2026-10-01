import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';

import type { RemoteRelayToolExecutionPort } from './remote-relay-device-session.js';

/**
 * Remote relay execution uses the exact MCP server factory that serves local stdio.
 * This is an in-process MCP client, not a second tool dispatch table.
 */
export class McpRemoteRelayExecutionPort implements RemoteRelayToolExecutionPort {
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  #closed = false;

  constructor(private readonly serverFactory: () => McpServer) {}

  async listToolManifest(): Promise<unknown> {
    const client = await this.#connect();
    const result = await client.listTools();
    return result.tools;
  }

  async callTool(input: { tool: string; arguments: unknown }): Promise<{
    ok: boolean;
    result?: unknown;
  }> {
    if (this.#closed) throw new Error('remote relay MCP execution port is closed');
    const client = await this.#connect();
    const result = await client.callTool({
      name: input.tool,
      arguments: (input.arguments ?? {}) as Record<string, unknown>,
    });
    // A returned MCP isError result is still a valid bounded MCP result. Preserve it exactly so
    // the relay-facing server can return the same semantic result as local stdio.
    return { ok: true, result };
  }

  async #connect(): Promise<Client> {
    if (this.#closed) throw new Error('remote relay MCP execution port is closed');
    if (this.#client) return this.#client;
    this.#connecting ??= (async () => {
      const server = this.serverFactory();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'wag-remote-relay-device', version: '1.0.0' },
        { capabilities: {} },
      );
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      this.#client = client;
      return client;
    })();
    try {
      return await this.#connecting;
    } catch (error) {
      this.#connecting = undefined;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const client = this.#client;
    this.#client = undefined;
    this.#connecting = undefined;
    await client?.close().catch(() => undefined);
  }
}
