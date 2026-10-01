import {
  parseNativeBrowserControlHostInvocation,
  runNativeBrowserControlHost,
} from './native-host-browser-control.js';

async function main(): Promise<void> {
  const invocation = parseNativeBrowserControlHostInvocation(process.argv, process.env);
  const host = await runNativeBrowserControlHost({
    input: process.stdin,
    output: process.stdout,
    expectedOrigin: invocation.expectedOrigin,
    discoveryPath: invocation.discoveryPath,
  });

  const close = async () => { await host.close().catch(() => undefined); };
  process.once('SIGINT', () => { void close().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void close().finally(() => process.exit(0)); });

  await new Promise<void>((resolve) => process.stdin.once('end', resolve));
  await close();
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Native browser control host failed';
  process.stderr.write(`wag-native-browser-control: ${message}\n`);
  process.exitCode = 1;
});
