import { McpLocalOperatorAdapterLink } from './local-link-v4.js';
import {
  loadOperatorAdapterDiscovery,
  parseNativeOperatorHostInvocation,
  runNativeOperatorHost,
} from './native-host-v4.js';

/**
 * The shipped native host, now the operator adapter (ADR-0026).
 *
 * The host is a relay, not an authority: it validates the framing, pins the exact extension
 * origin, and hands each request to a link that can only reach the admitted proposal surface.
 * Its discovery file is versioned, so a v4 runtime cannot overwrite a v3 runtime's.
 */
async function main(): Promise<void> {
  const invocation = parseNativeOperatorHostInvocation(process.argv, process.env);
  const discovery = await loadOperatorAdapterDiscovery(invocation.discoveryPath);
  await runNativeOperatorHost({
    input: process.stdin,
    output: process.stdout,
    expectedOrigin: invocation.expectedOrigin,
    linkFactory: (correlationId) => McpLocalOperatorAdapterLink.admit(discovery, correlationId),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native host failed';
  process.stderr.write(`wag-native-host: ${message}\n`);
  process.exitCode = 1;
});
