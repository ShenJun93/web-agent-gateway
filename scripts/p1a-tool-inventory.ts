/**
 * P1A tool inventory — measured over the MCP protocol, against the built artifact.
 *
 * Read-only. It connects a client to the v4 browser operator surface over an in-memory transport
 * and issues a real `tools/list`. It invokes no tool, and the coordinators it is handed throw on
 * every consequential call, so an accidental invocation would fail loudly rather than quietly do
 * something.
 *
 * It exists because a source-read gave the wrong answer. Counting `registerTool` calls in
 * `server.ts` produced eleven; the surface is twelve, because `verify.result` is registered in a
 * branch the grep did not cover. The lesson is the one this project keeps relearning: read the
 * artifact, not the description of it.
 *
 *   npm run p1a:tools
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { createBrowserOperatorAdmittedMcpServer } from '../src/server.js';
import { BROWSER_OPERATOR_ADAPTER_ID } from '../src/adapter-admission.js';

/** The five tools P1A forbids invoking. Present on the surface; never called. */
export const P1A_FORBIDDEN_TOOLS = [
  'mutation.preview', 'file.create', 'mutation.result', 'git.commit', 'git.commit.result',
] as const;

/** The read/verify workload P1A is allowed to exercise. */
export const P1A_PERMITTED_TOOLS = [
  'health', 'workspace.open', 'repo.search', 'repo.snapshot', 'file.read',
  'verify.preview', 'verify.result',
] as const;

/** Every context method throws: this inventory must not be able to cause anything. */
function refuse(name: string): never {
  throw new Error(`p1a-tool-inventory invoked ${name}; this diagnostic must never call a tool`);
}

export async function listOperatorTools(): Promise<string[]> {
  const caller = createGatewayCallerContext({
    ownerId: 'p1a-inventory', sessionId: 'p1a-inventory', adapterId: BROWSER_OPERATOR_ADAPTER_ID,
  });
  const server = createBrowserOperatorAdmittedMcpServer(
    { health: () => refuse('health') } as never,
    {
      callerContext: caller,
      workspaces: new Proxy({}, { get: (_t, p) => () => refuse(String(p)) }) as never,
      verify: new Proxy({}, { get: (_t, p) => () => refuse(String(p)) }) as never,
      mutation: new Proxy({}, { get: (_t, p) => () => refuse(String(p)) }) as never,
      commit: new Proxy({}, { get: (_t, p) => () => refuse(String(p)) }) as never,
    } as never,
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'p1a-tool-inventory', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

async function main(): Promise<number> {
  const observed = await listOperatorTools();
  const permitted = observed.filter((t) => (P1A_PERMITTED_TOOLS as readonly string[]).includes(t));
  const forbidden = observed.filter((t) => (P1A_FORBIDDEN_TOOLS as readonly string[]).includes(t));
  const unclassified = observed.filter(
    (t) => !permitted.includes(t) && !forbidden.includes(t),
  );

  console.log(JSON.stringify({
    type: 'p1a.toolInventory',
    adapter: BROWSER_OPERATOR_ADAPTER_ID,
    observedCount: observed.length,
    observed,
    permittedForP1A: permitted,
    presentButForbiddenForP1A: forbidden,
    unclassified,
  }, null, 2));

  // An unclassified tool means the surface changed and P1A's own classification is stale. That
  // is a stop, not a warning: P1A's whole claim is that it knows what it did not call.
  if (unclassified.length > 0) {
    console.error(`P1A: ${unclassified.length} tool(s) are on the surface but classified by neither list`);
    return 1;
  }
  return 0;
}

main().then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
