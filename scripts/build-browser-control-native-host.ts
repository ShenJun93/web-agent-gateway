import { spawn } from 'node:child_process';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { normalizeNativeHostPeMetadata } from './native-host-pe-metadata.js';
import { createBrowserControlNativeHostManifest } from '../src/browser-adapter/native-host-manifest-browser-control.js';
import { BROWSER_ADAPTER_EXTENSION_ID } from '../src/browser-adapter/native-host-distribution.js';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function value(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (!v || v.startsWith('--')) throw new Error(flag + ' requires a value');
  return v;
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.once('error', reject);
    child.once('close', (code) => code === 0
      ? resolveRun()
      : reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || 'Command failed')));
  });
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Browser control native host requires Windows');
  const argv = process.argv.slice(2);
  const outputDir = resolve(value(argv, '--output') ?? join(repoRoot, 'artifacts', 'browser-control'));
  const extensionId = value(argv, '--extension-id') ?? BROWSER_ADAPTER_EXTENSION_ID;
  await mkdir(outputDir, { recursive: true });
  const pkg = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof pkg.version !== 'string') throw new Error('package.json version is required');

  const bundlePath = join(outputDir, 'wag-native-browser-control.cjs');
  const blobPath = join(outputDir, 'sea-prep.blob');
  const executablePath = join(outputDir, 'wag-native-browser-control.exe');
  const manifestPath = join(outputDir, 'com.openai.web_agent_gateway_browser_control.json');
  await build({
    entryPoints: [join(repoRoot, 'src', 'browser-adapter', 'native-host-browser-control-main.ts')],
    outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', sourcemap: false, minify: false,
  });
  await writeFile(join(outputDir, 'sea-config.json'), JSON.stringify({
    main: 'wag-native-browser-control.cjs',
    output: 'sea-prep.blob',
    disableExperimentalSEAWarning: true,
    useSnapshot: false, useCodeCache: false, execArgv: [], execArgvExtension: 'none',
  }, null, 2) + '\n', 'utf8');
  await run(process.execPath, ['--experimental-sea-config', 'sea-config.json'], outputDir);
  await copyFile(process.execPath, executablePath);
  await run('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    join(repoRoot, 'browser', 'native-host', 'remove-source-signature.ps1'),
    '-ExecutablePath', executablePath,
  ], outputDir);
  const postjectApi = fileURLToPath(import.meta.resolve('postject'));
  await run(process.execPath, [
    join(dirname(postjectApi), 'cli.js'), executablePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', SEA_FUSE,
  ], outputDir);
  await normalizeNativeHostPeMetadata(executablePath, pkg.version);
  await writeFile(manifestPath, JSON.stringify(createBrowserControlNativeHostManifest({
    executablePath, extensionId,
  }), null, 2) + '\n', 'utf8');
  process.stdout.write(executablePath + '\n' + manifestPath + '\n');
}

main().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
