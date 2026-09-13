import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { createNativeHostManifest } from '../src/browser-adapter/native-host-manifest.js';

function option(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outputPath = option(args, '--output');
  const executablePath = option(args, '--executable');
  const extensionId = option(args, '--extension-id');
  if (!isAbsolute(outputPath)) throw new Error('Manifest output path must be absolute');

  const manifest = createNativeHostManifest({ executablePath, extensionId });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Manifest generation failed';
  process.stderr.write(`wag-native-host-manifest: ${message}\n`);
  process.exitCode = 1;
});
