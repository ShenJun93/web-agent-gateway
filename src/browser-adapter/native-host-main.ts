import { McpLocalAdapterLink } from './local-link.js';
import { loadAdapterDiscovery, parseNativeHostInvocation, runNativeHost } from './native-host.js';

async function main(): Promise<void> {
  const invocation = parseNativeHostInvocation(process.argv, process.env);
  const discovery = await loadAdapterDiscovery(invocation.discoveryPath);
  await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    expectedOrigin: invocation.expectedOrigin,
    linkFactory: (correlationId) => McpLocalAdapterLink.admit(discovery, correlationId),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native host failed';
  process.stderr.write(`wag-native-host: ${message}\n`);
  process.exitCode = 1;
});
