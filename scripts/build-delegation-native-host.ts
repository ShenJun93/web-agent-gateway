/**
 * Build the delegated-dispatch native host (ADR-0029).
 *
 * A parallel script to `build-native-host.ts`, not a flag on it, for the reason the whole v5 line
 * is parallel: the v4 artifact is signed, attested and recorded by digest in an accepted receipt,
 * and a shared script is a shared opportunity to change its bytes. Nothing here can alter what
 * `build:native-host` produces.
 *
 * ## Why this exists at all
 *
 * A review found that `browser/extension/service-worker.js` connects to
 * `com.openai.web_agent_gateway_v5` and **nothing in the repository built or registered such a
 * host**. The consequence was not a hole — `connectNative` fails, `tryDelegatedRun` gives up, and
 * every proposal falls through to the human queue, which is the right direction — but it made the
 * ADR's claim that the two human steps were now sufficient false. They were not: without this
 * binary, a delegated Run cannot happen in a browser at all.
 *
 * ## What it does not do
 *
 * It does not sign, register, or install anything. The output is an unsigned executable and a
 * native-messaging manifest; putting the manifest in the registry is a separate act, and on this
 * machine a deliberate one. See the receipt for the exact steps.
 *
 *   npx tsx scripts/build-delegation-native-host.ts [--output <dir>] [--extension-id <id>]
 */
import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { normalizeNativeHostPeMetadata } from './native-host-pe-metadata.js';
import { createDelegationNativeHostManifest } from '../src/browser-adapter/native-host-manifest-v5.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `Command failed with exit code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Delegation native-host artifact requires Windows');
  const argv = process.argv.slice(2);
  const outputDir = resolve(argValue(argv, '--output') ?? join(repoRoot, 'artifacts', 'delegation-adapter'));
  const extensionId = argValue(argv, '--extension-id') ?? BROWSER_ADAPTER_EXTENSION_ID;
  await mkdir(outputDir, { recursive: true });

  const packageJson = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof packageJson.version !== 'string') throw new Error('package.json version is required');

  const bundlePath = join(outputDir, 'wag-native-host-v5.cjs');
  const configPath = join(outputDir, 'sea-config.json');
  const blobPath = join(outputDir, 'sea-prep.blob');
  const executablePath = join(outputDir, 'wag-native-host-v5.exe');
  const manifestPath = join(outputDir, 'com.openai.web_agent_gateway_v5.json');

  await build({
    entryPoints: [join(repoRoot, 'src', 'browser-adapter', 'native-host-delegation-main.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    minify: false,
  });

  // Written rather than copied: the v4 SEA config names `wag-native-host.cjs`, and sharing it
  // would mean this build silently packaging the operator host's bundle under the v5 name.
  await writeFile(configPath, `${JSON.stringify({
    main: 'wag-native-host-v5.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false,
    execArgv: [],
    execArgvExtension: 'none',
  }, null, 2)}\n`, 'utf8');

  await run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], outputDir);
  await copyFile(process.execPath, executablePath);
  await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    join(repoRoot, 'browser', 'native-host', 'remove-source-signature.ps1'),
    '-ExecutablePath', executablePath,
  ], outputDir);

  const postjectApi = fileURLToPath(import.meta.resolve('postject'));
  const postjectCli = join(dirname(postjectApi), 'cli.js');
  await run(process.execPath, [
    postjectCli, executablePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', SEA_FUSE,
  ], outputDir);
  await normalizeNativeHostPeMetadata(executablePath, packageJson.version);

  // The manifest names the executable by absolute path, which is what Chrome reads. It is written
  // beside the binary and registered separately — this script installs nothing.
  await writeFile(manifestPath, `${JSON.stringify(
    createDelegationNativeHostManifest({ executablePath, extensionId }), null, 2,
  )}\n`, 'utf8');

  process.stdout.write(`${executablePath}\n${manifestPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
