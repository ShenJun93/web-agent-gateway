import { connectNativeHostLink, parseNativeHostInvocation, runNativeHost } from './native-host.js';

async function main(): Promise<void> {
  const invocation = parseNativeHostInvocation(process.argv, process.env);
  const link = await connectNativeHostLink(invocation.discoveryPath);
  await runNativeHost({
    input: process.stdin,
    output: process.stdout,
    link,
    expectedOrigin: invocation.expectedOrigin,
  });
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native host failed';
  process.stderr.write(`wag-native-host: ${message}\n`);
  process.exitCode = 1;
});
