import { isAbsolute } from 'node:path';
import { verifyNativeHostDistributionDirectory } from '../src/browser-adapter/native-host-distribution.js';

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const directory = option(args, '--directory');
  const expectedRepository = option(args, '--repository');
  const expectedSourceSha = option(args, '--source-sha');
  if (!isAbsolute(directory)) throw new Error('Distribution directory must be absolute');

  const receipt = await verifyNativeHostDistributionDirectory({
    directory,
    expectedRepository,
    expectedSourceSha,
  });
  process.stdout.write(`${JSON.stringify({ status: 'verified', sourceSha: receipt.sourceSha, sha256: receipt.artifact.sha256 })}\n`);
}

main().catch((error) => {
  process.stderr.write(`wag-native-host-verify: ${error instanceof Error ? error.message : 'failed'}\n`);
  process.exitCode = 1;
});
