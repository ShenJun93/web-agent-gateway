/**
 * Prepare — and refuse to overstate — the direct ChatGPT -> WAG MCP path.
 *
 * WAG needs no new transport to be reachable from ChatGPT. OpenAI's Secure MCP Tunnel runs a
 * customer-side client that launches a **stdio** MCP server as a subprocess and carries JSON-RPC
 * to it over an outbound-only HTTPS long poll. WAG's private stdio surface (ADR-0020) is already
 * exactly that server, and it is already the accepted DC-replacement surface. So the composition
 * is a profile, not a subsystem:
 *
 *   ChatGPT connector -> OpenAI tunnel endpoint -> tunnel-client (this machine)
 *     -> node dist/cli.js serve-stdio --config <local config>   [stdio, no listening port]
 *     -> DevSpace / durable store / autonomous-local policy
 *
 * This script verifies the local half and prints the exact invocation for the remote half. It
 * deliberately stops at every boundary that needs a person:
 *
 *   - it creates no tunnel, no API key and no connector;
 *   - it never reads, prints or requires a credential, and names the environment variable only;
 *   - it starts nothing and opens no port.
 *
 * Read-only apart from its own stdout.
 *
 *   npm run mcp:tunnel-profile -- --config E:/path/to/wag-direct.config.json
 */
import { access, constants } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createGatewayCallerContext } from '../src/caller-context.js';
import { loadPrivateGatewayConfig, type PrivateGatewayConfig } from '../src/private-config.js';
import { createGatewayMcpServer } from '../src/server.js';
import { ToolUsageDiagnostics } from '../src/tool-usage-diagnostics.js';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

/** The loop the mission requires a direct client to complete without a human relaying results. */
const REQUIRED_LOOP = ['read', 'mutation', 'verify', 'commit'] as const;

interface Readiness {
  configPath: string;
  cliPath: string;
  tools: string[];
  missing: string[];
  stableSession: boolean;
  delegationNamed?: string;
}

function parseArgs(argv: readonly string[]): { configPath: string; allowPartial: boolean } {
  let configPath: string | undefined;
  let allowPartial = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--config') { configPath = argv[index + 1]; index += 1; continue; }
    if (arg === '--allow-partial') { allowPartial = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!configPath) throw new Error('Usage: --config <absolute path to the private gateway config>');
  const absolute = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath);
  return { configPath: absolute, allowPartial };
}

/** Every stub method throws: this instrument must not be able to cause anything. */
function refuse(name: string): never {
  throw new Error(`prepare-direct-mcp-tunnel invoked ${name}; this instrument must never call a tool`);
}

const refusing = () => new Proxy({}, { get: (_target, property) => () => refuse(String(property)) }) as never;

/**
 * Measure the surface rather than describe it.
 *
 * The profile is a local opt-in, so which tools exist depends on configuration — but *what* those
 * tools are is `createGatewayMcpServer`'s business, and a second copy of that list here would be
 * free to drift from it. So this builds the real server from the real config and issues a real
 * `tools/list` over an in-memory transport, handing it contexts whose every method throws. It
 * invokes nothing; an accidental call would fail loudly rather than quietly do something.
 *
 * `scripts/p1a-tool-inventory.ts` exists because a source-read of this same file gave the wrong
 * answer once already.
 */
export async function projectedTools(
  config: PrivateGatewayConfig,
): Promise<{ tools: string[]; missing: string[] }> {
  const engineering = config.repositoryEngineering;
  const callerContext = createGatewayCallerContext({
    ownerId: 'direct-mcp-inventory', sessionId: 'direct-mcp-inventory', adapterId: 'private.stdio.v1',
  });
  // `gitCommit` is gated on `mutation` here for the same reason the runtime gates it: commit
  // review reuses the store, caller context and operator server that mutation builds, and
  // `loadPrivateGatewayConfig` refuses the combination outright. Deriving it independently would
  // let this instrument over-report a surface the gateway would never start.
  const server = createGatewayMcpServer(refusing(), {
    inspect: engineering?.inspect === true,
    ...(engineering?.mutation === undefined ? {} : {
      mutationContext: { callerContext, coordinator: refusing() },
      capabilityContext: refusing(),
      machineContext: refusing(),
      diagnosticsContext: new ToolUsageDiagnostics(),
      ...(engineering.browser === undefined ? {} : { browserContext: refusing() }),
      ...(engineering.gitCommit === undefined
        ? {}
        : {
          gitCommitContext: { callerContext, coordinator: refusing() },
          ...(engineering.inspect === true
            ? { commandContext: { authorize: async () => undefined } }
            : {}),
        }),
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'direct-mcp-inventory', version: '1.0.0' }, { capabilities: {} });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  let tools: string[];
  try {
    tools = (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }

  const missing: string[] = [];
  if (Object.keys(config.verifyProfiles).length === 0) missing.push('verify');
  if (!engineering?.mutation) missing.push('mutation');
  if (!engineering?.gitCommit) missing.push('commit');
  if (!(engineering?.inspect === true
    && engineering?.mutation !== undefined
    && engineering?.gitCommit !== undefined)) {
    missing.push('command');
  }
  return { tools, missing };
}

async function readable(path: string): Promise<boolean> {
  try { await access(path, constants.R_OK); return true; } catch { return false; }
}

export async function prepare(configPath: string): Promise<Readiness> {
  const cliPath = join(repoRoot, 'dist', 'cli.js');
  if (!await readable(cliPath)) {
    throw new Error(`Built CLI not found at ${cliPath}; run "npm run build" first`);
  }
  const config = await loadPrivateGatewayConfig(configPath);
  const { tools, missing } = await projectedTools(config);
  return {
    configPath,
    cliPath,
    tools,
    missing,
    stableSession: config.repositoryEngineering?.mutation?.sessionCorrelation !== undefined,
    ...(config.repositoryEngineering?.mutation?.goalUiDelegationId === undefined
      ? {} : { delegationNamed: config.repositoryEngineering.mutation.goalUiDelegationId }),
  };
}

/**
 * Forward slashes, because this string is pasted into a shell.
 *
 * Node accepts them on Windows, and they keep the printed line identical in bash and PowerShell:
 * a Windows path would otherwise be JSON-escaped to doubled backslashes, which bash unescapes and
 * PowerShell does not. The emitted invocation is this script's whole product, so it has to survive
 * being pasted rather than merely look right here.
 */
const forwardSlashes = (path: string): string => path.split('\\').join('/');

function report(readiness: Readiness, allowPartial: boolean): number {
  const cli = forwardSlashes(readiness.cliPath);
  const config = forwardSlashes(readiness.configPath);
  const command = `node ${cli} serve-stdio --config ${config}`;
  const spaced = [cli, config].filter((path) => path.includes(' '));

  console.log('=== WAG direct-MCP readiness ===');
  console.log(`  built CLI        ${readiness.cliPath}`);
  console.log(`  config           ${readiness.configPath}`);
  console.log(`  projected tools  ${readiness.tools.length}: ${readiness.tools.join(', ')}`);

  if (readiness.missing.length > 0) {
    console.log(`\n  INCOMPLETE LOOP  missing ${readiness.missing.join(', ')}`);
    console.log(`  the mission's loop is ${REQUIRED_LOOP.join(' -> ')}; a direct client cannot`);
    console.log('  finish it through this config. Configure repositoryEngineering, or pass');
    console.log('  --allow-partial to emit a read-only tunnel profile deliberately.');
  }

  console.log('\n  authority        trusted private-local profile + caller-owned workspace identity');
  console.log('                   + immediate kill-switch revalidation; no per-goal authority step exists.');
  if (readiness.stableSession) {
    console.log('  session          stable, resolved from the configured correlation.');
    console.log('                   stableSessionId is reconnect/audit identity only; it grants no');
    console.log('                   execution authority and needs no out-of-band issuance.');
  }
  if (readiness.delegationNamed) {
    console.log(`  delegation       ${readiness.delegationNamed}`);
    console.log('                   lifts Run on the browser path only; no effect on this surface');
  }

  console.log('\n=== what the tunnel client inherits, and what that means ===');
  console.log('  WAG is spawned as tunnel-client\'s child, so it inherits that process\'s');
  console.log('  environment — and `serve-stdio` refuses to start without DEVSPACE_OAUTH_OWNER_TOKEN.');
  console.log('  That token must therefore be exported in the vendor client\'s environment. WAG');
  console.log('  deletes it from its own env once the OAuth exchange is done, and never passes it');
  console.log('  to any child it spawns, but the parent still holds it. Decide that deliberately.');
  console.log('  WAG\'s stderr also goes to that parent: it carries the loopback operator origin');
  console.log('  and the path of the operator credential file — not the credential, which is');
  console.log('  written to a 0600 file instead.');

  console.log('\n=== tunnel-client profile (stdio; WAG opens no port) ===');
  console.log('  export CONTROL_PLANE_API_KEY=...        # your runtime key; never stored here');
  console.log('  tunnel-client init \\');
  console.log('    --sample sample_mcp_stdio_local \\');
  console.log('    --profile wag-direct \\');
  console.log('    --tunnel-id <tunnel_...> \\');
  console.log(`    --mcp-command ${JSON.stringify(command)}`);
  console.log('  tunnel-client doctor --profile wag-direct --explain');
  console.log('  tunnel-client run --profile wag-direct');

  // Refuse to imply a form that has not been verified. `--mcp-command` is one string that the
  // client splits into argv, and how it tokenises an embedded quote is the vendor's business, not
  // something this script can assert from WAG's side.
  if (spaced.length > 0) {
    console.log('\n  !! a path above contains a space:');
    for (const path of spaced) console.log(`       ${path}`);
    console.log('     --mcp-command is one string the client splits into argv, so an unquoted');
    console.log('     space will split the path. This script does not guess the client\'s quoting');
    console.log('     rules. Use a path without spaces, or check `tunnel-client doctor` output');
    console.log('     before trusting the invocation above.');
  }

  console.log('\n=== not done by this script: each needs your account authority ===');
  console.log('  1. create the tunnel and a runtime API key in the OpenAI platform settings');
  console.log('  2. install tunnel-client from the openai/tunnel-client releases');
  console.log('  3. add the connector in ChatGPT settings, on a plan that permits custom MCP');
  console.log('  4. choose the connector permission mode you want in ChatGPT; WAG Local itself');
  console.log('     requires no per-change Goal Lease or operator approval');

  const blocked = readiness.missing.length > 0 && !allowPartial;
  console.log(`\nDIRECT_MCP_LOCAL_READINESS = ${blocked ? 'INCOMPLETE' : 'READY'}`);
  return blocked ? 1 : 0;
}

async function main(): Promise<number> {
  let parsed: { configPath: string; allowPartial: boolean };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    return report(await prepare(parsed.configPath), parsed.allowPartial);
  } catch (error) {
    console.error(`direct-MCP preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Guarded, because a test imports `projectedTools` to prove this script's projection still
// matches the surface `createGatewayMcpServer` actually registers, and importing a module must
// not run a report. `npm run mcp:tunnel-profile` still behaves exactly as before.
if (process.argv[1]?.split('\\').join('/').endsWith('prepare-direct-mcp-tunnel.ts')) {
  process.exitCode = await main();
}
