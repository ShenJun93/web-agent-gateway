import { HttpLocalDelegationAdapterLink } from './local-link-v5.js';
import {
  loadDelegationAdapterDiscovery,
  parseNativeDelegationHostInvocation,
  runNativeDelegationHost,
} from './native-host-v5.js';

/**
 * The delegated-dispatch native host (ADR-0029).
 *
 * Shipped as its own binary rather than a flag on the operator host, because the two admit into
 * different adapter identities and a delegation binds one of them. One executable with a mode
 * switch would be one argument away from admitting a v5 session into v4's identity, or the reverse.
 *
 * It is a relay with no authority of its own: it pins the extension origin, validates the framing,
 * and forwards whole envelopes to WAG's v5 route. Its discovery file is versioned, so a v5 runtime
 * cannot overwrite a v4 runtime's.
 */
async function main(): Promise<void> {
  const invocation = parseNativeDelegationHostInvocation(process.argv, process.env);
  const discovery = await loadDelegationAdapterDiscovery(invocation.discoveryPath);
  await runNativeDelegationHost({
    input: process.stdin,
    output: process.stdout,
    expectedOrigin: invocation.expectedOrigin,
    linkFactory: (correlationId) => HttpLocalDelegationAdapterLink.admit(discovery, correlationId),
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native host failed';
  process.stderr.write(`wag-native-host-v5: ${message}\n`);
  process.exitCode = 1;
});
