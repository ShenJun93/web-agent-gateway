import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultNativeHostInstallationDependencies,
  prepareNativeHostInstallation,
  type NativeHostInstallationDependencies,
} from '../src/browser-adapter/native-host-installation.js';

const OPTIONS = ['--distribution', '--local-app-data', '--repository'] as const;

function parseArguments(args: readonly string[]): Record<(typeof OPTIONS)[number], string> {
  if (args.length !== OPTIONS.length * 2) {
    throw new Error('CLI arguments must contain exactly --distribution, --local-app-data, and --repository');
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name || !OPTIONS.includes(name as (typeof OPTIONS)[number])) throw new Error(`Unknown CLI argument: ${name ?? ''}`);
    if (values.has(name)) throw new Error(`Duplicate CLI argument: ${name}`);
    if (!value || value.startsWith('--')) throw new Error(`Missing CLI argument value: ${name}`);
    values.set(name, value);
  }
  for (const name of OPTIONS) {
    if (!values.has(name)) throw new Error(`Missing CLI argument: ${name}`);
  }
  return Object.fromEntries(values) as Record<(typeof OPTIONS)[number], string>;
}

export async function runNativeHostInstallationCli(
  args: readonly string[],
  dependencies: NativeHostInstallationDependencies = defaultNativeHostInstallationDependencies,
): Promise<string> {
  const options = parseArguments(args);
  const receipt = await prepareNativeHostInstallation({
    distributionDirectory: options['--distribution'],
    localAppData: options['--local-app-data'],
    repository: options['--repository'],
  }, dependencies);
  return `${JSON.stringify({
    status: 'prepared',
    sourceSha: receipt.sourceSha,
    sha256: receipt.executableSha256,
  })}\n`;
}

async function main(): Promise<void> {
  process.stdout.write(await runNativeHostInstallationCli(process.argv.slice(2)));
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`wag-native-host-prepare: ${error instanceof Error ? error.message : 'failed'}\n`);
    process.exitCode = 1;
  });
}
