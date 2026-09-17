import { spawn } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function outputDirectory(argv: readonly string[]): string {
  const index = argv.indexOf('--output');
  if (index < 0) return join(repoRoot, 'artifacts', 'browser-adapter');
  const value = argv[index + 1];
  if (!value) throw new Error('--output requires a directory');
  return resolve(value);
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
  if (process.platform !== 'win32') throw new Error('Browser native-host artifact v1 requires Windows');
  const outputDir = outputDirectory(process.argv.slice(2));
  await mkdir(outputDir, { recursive: true });

  const bundlePath = join(outputDir, 'wag-native-host.cjs');
  const configPath = join(outputDir, 'sea-config.json');
  const blobPath = join(outputDir, 'sea-prep.blob');
  const executablePath = join(outputDir, 'wag-native-host.exe');

  await build({
    entryPoints: [join(repoRoot, 'src', 'browser-adapter', 'native-host-main.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    minify: false,
  });

  await copyFile(join(repoRoot, 'browser', 'native-host', 'sea-config.json'), configPath);
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

  process.stdout.write(`${executablePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
