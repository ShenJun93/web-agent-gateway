import { McpLocalVerifyAdapterLink } from './local-link-v3.js';
import {
  loadVerifyAdapterDiscovery,
  parseNativeVerifyHostInvocation,
  runNativeVerifyHost,
} from './native-host-v3.js';

async function main(): Promise<void> {
  const invocation = parseNativeVerifyHostInvocation(process.argv, process.env);
  const discovery = await loadVerifyAdapterDiscovery(invocation.discoveryPath);
  await runNativeVerifyHost({
    input: process.stdin,
    output: process.stdout,
    expectedOrigin: invocation.expectedOrigin,
    linkFactory: (correlationId) => McpLocalVerifyAdapterLink.admit(discovery, correlationId),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native host failed';
  process.stderr.write(`wag-native-host: ${message}\n`);
  process.exitCode = 1;
});
