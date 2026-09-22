/**
 * Running a staged candidate, through the surface the browser already had (ADR-0029).
 *
 * The executor needs to call a WAG tool. There were two ways to give it one, and the choice matters
 * more than it looks:
 *
 *   1. build a second dispatch table — a `switch` over tool names calling the coordinators direct;
 *   2. call the **same MCP server the v4 browser calls**, over an in-process transport.
 *
 * This is (2), and the reason is the property being claimed. ADR-0029 says a delegated Run produces
 * exactly what a clicked Run produces — same tools, same argument schemas, same proposal records,
 * same review path. A second dispatch table would make that a promise maintained by hand, and the
 * first tool whose behaviour diverged would diverge silently. Going through the registered server
 * means there is nothing to keep in sync: if `mutation.preview` changes, the delegated path changes
 * with it, because it is the same function.
 *
 * It also bounds the surface honestly. The client here can call any tool the server exposes — but
 * the server is the *browser operator* server, built for one admitted caller context, so its tools
 * are the proposal-only profile. There is no approval route on it to reach, and the executor is only
 * ever handed a tool name that came from a staged row the delegation already admitted.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, type McpServer } from '@modelcontextprotocol/server';
import type { DelegatedToolExecutionPort } from './delegated-run-executor.js';

/**
 * An execution port backed by one MCP server, connected lazily and reused.
 *
 * One connection per admitted bearer rather than one per call: the handshake is not free, and the
 * server is stateless between calls anyway. It is closed when the connection is released.
 */
export class McpDelegatedToolExecutionPort implements DelegatedToolExecutionPort {
  #client: Client | undefined;
  #connecting: Promise<Client> | undefined;
  #closed = false;

  constructor(private readonly serverFactory: () => McpServer) {}

  async callTool(input: { tool: string; arguments: unknown }): Promise<{
    ok: boolean;
    structuredContent?: unknown;
  }> {
    if (this.#closed) throw new Error('delegated tool execution port is closed');
    const client = await this.#connect();
    const result = await client.callTool({
      name: input.tool,
      arguments: (input.arguments ?? {}) as Record<string, unknown>,
    });
    // The same two conditions the v4 link treats as failure, so a delegated Run and a clicked Run
    // agree about what "the tool failed" means.
    if (result.isError || result.structuredContent === undefined) return { ok: false };
    return { ok: true, structuredContent: result.structuredContent };
  }

  async #connect(): Promise<Client> {
    if (this.#client) return this.#client;
    // Guarded against a second caller arriving mid-handshake: two connects would leave one client
    // orphaned and connected, holding a transport nobody closes.
    this.#connecting ??= (async () => {
      const server = this.serverFactory();
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'wag-delegated-run-executor', version: '1.0.0' }, { capabilities: {} });
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
